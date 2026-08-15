import { flow$, step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { ResumePayloadValidationError, ResumeRefusedError } from "./types";
import type { FlowRunner, RegisteredFlow, ResumeEvent } from "./types";

// ── TR (ADR 0077) — typed resume payloads ─────────────────────────────────────
//
// A resume payload cannot be rejected retroactively: once appended it is a permanent fold
// input. So the contract is enforced BEFORE the append, and the assertions here check the
// durable log rather than only the thrown error — a refusal that still wrote is not a refusal.

const APPROVAL = z.object({
  approved: z.boolean(),
  approvedBy: z.string(),
  tier: z.number().default(1),
});
const ESCALATION = z.object({ toTier: z.number() });

function buildFlow(resumeSchemas?: Record<string, z.ZodTypeAny>) {
  const noop = step$({
    id: "noop",
    name: "noop",
    toolId: "t",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
  });
  return flow$({
    id: "approval-flow",
    name: "Approval",
    version: "1.0.0",
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({}),
    steps: [noop],
    ...(resumeSchemas !== undefined && { resumeSchemas }),
  });
}

/** Suspends on `on`, then returns whatever the gate delivered. */
function gateRunner(on: string): FlowRunner<{ id: string }, Record<string, never>> {
  return async (ctx, input) => {
    await ctx.suspend({ on, correlationKey: input.id });
    return {};
  };
}

function setup(resumeSchemas?: Record<string, z.ZodTypeAny>, on = "ApprovalGranted") {
  const eventStore = new InMemoryAsyncEventStore();
  const effects = new EffectRuntime();
  effects.register("t", new ToolEffect(async () => ({})));
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const definition = buildFlow(resumeSchemas);
  const flow: RegisteredFlow<{ id: string }, Record<string, never>> = {
    definition,
    runner: gateRunner(on),
  };
  runtime.registerFlow(definition, flow.runner as FlowRunner<unknown, unknown>);
  return { runtime, eventStore, flow };
}

async function startAndSuspend(s: ReturnType<typeof setup>) {
  const handle = await s.runtime.start(s.flow, { id: "e-1" });
  await handle.waitForSuspend();
  return handle.executionId;
}

const resumeWith = (payload: unknown, eventType = "ApprovalGranted"): ResumeEvent => ({
  eventType,
  payload,
});

describe("resumeSchemas — typed resume payloads (TR, ADR 0077)", () => {
  it("refuses a wrongly-shaped payload BEFORE appending anything", async () => {
    const s = setup({ ApprovalGranted: APPROVAL });
    const executionId = await startAndSuspend(s);
    const before = await s.eventStore.read(executionId);

    await expect(
      s.runtime.resume(executionId, resumeWith({ approved: "yes please" }))
    ).rejects.toThrow(ResumePayloadValidationError);

    // The log is byte-identical: no resume event, no EXECUTION_RESUMED, no partial write.
    expect(await s.eventStore.read(executionId)).toEqual(before);
  });

  it("leaves the execution resumable — a corrected payload still lands", async () => {
    const s = setup({ ApprovalGranted: APPROVAL });
    const executionId = await startAndSuspend(s);

    await expect(s.runtime.resume(executionId, resumeWith({ approved: true }))).rejects.toThrow(
      ResumePayloadValidationError
    );

    const handle = await s.runtime.resume(
      executionId,
      resumeWith({ approved: true, approvedBy: "ops" })
    );
    const result = await handle.waitForCompletion();
    expect(result.status).toBe("completed");
  });

  it("records the PARSED value — Zod defaults land in the log, not the raw payload", async () => {
    const s = setup({ ApprovalGranted: APPROVAL });
    const executionId = await startAndSuspend(s);

    const handle = await s.runtime.resume(
      executionId,
      resumeWith({ approved: true, approvedBy: "ops" }) // no `tier` — default is 1
    );
    await handle.waitForCompletion();

    const gate = (await s.eventStore.read(executionId)).filter(
      (e) => e.eventType === "ApprovalGranted" || e.eventType === "EXECUTION_RESUMED"
    );
    expect(gate.length).toBeGreaterThan(0);
    for (const e of gate) {
      expect(e.payload).toEqual({ approved: true, approvedBy: "ops", tier: 1 });
    }
  });

  it("names the offending field, so the caller can fix it", async () => {
    const s = setup({ ApprovalGranted: APPROVAL });
    const executionId = await startAndSuspend(s);
    let err: unknown;
    try {
      await s.runtime.resume(executionId, resumeWith({ approved: true, approvedBy: 7 }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ResumePayloadValidationError);
    const typed = err as ResumePayloadValidationError;
    expect(typed.eventType).toBe("ApprovalGranted");
    expect(typed.executionId).toBe(executionId);
    expect(typed.message).toContain("approvedBy");
  });

  it("enforces each gate's OWN contract when a flow declares several", async () => {
    // The case the feature exists for: two gates, two genuinely different shapes.
    const schemas = { ApprovalGranted: APPROVAL, Escalated: ESCALATION };
    const approvalPayload = { approved: true, approvedBy: "ops" };

    const a = setup(schemas, "ApprovalGranted");
    const aId = await startAndSuspend(a);
    // The OTHER gate's payload must not satisfy this gate.
    await expect(a.runtime.resume(aId, resumeWith({ toTier: 2 }))).rejects.toThrow(
      ResumePayloadValidationError
    );
    await expect(a.runtime.resume(aId, resumeWith(approvalPayload))).resolves.toBeDefined();

    const b = setup(schemas, "Escalated");
    const bId = await startAndSuspend(b);
    await expect(b.runtime.resume(bId, resumeWith(approvalPayload, "Escalated"))).rejects.toThrow(
      ResumePayloadValidationError
    );
    await expect(
      b.runtime.resume(bId, resumeWith({ toTier: 2 }, "Escalated"))
    ).resolves.toBeDefined();
  });

  it("is inert for an event type with no declared entry", async () => {
    // Declaring a contract for one gate must not implicitly close every other gate.
    const s = setup({ SomeOtherGate: ESCALATION });
    const executionId = await startAndSuspend(s);
    const handle = await s.runtime.resume(executionId, resumeWith({ anything: "goes" }));
    await handle.waitForCompletion();
    const resumed = (await s.eventStore.read(executionId)).find(
      (e) => e.eventType === "ApprovalGranted"
    );
    expect(resumed?.payload).toEqual({ anything: "goes" });
  });

  it("is byte-identical when no resumeSchemas are declared at all (G2)", async () => {
    const s = setup();
    const executionId = await startAndSuspend(s);
    const handle = await s.runtime.resume(executionId, resumeWith({ shape: "unchecked", n: 1 }));
    await handle.waitForCompletion();
    const resumed = (await s.eventStore.read(executionId)).find(
      (e) => e.eventType === "ApprovalGranted"
    );
    expect(resumed?.payload).toEqual({ shape: "unchecked", n: 1 });
  });

  it("STRIPS unknown keys — a strict schema changes what is durably recorded", async () => {
    // The sharp edge of "the parsed value is what is recorded": `z.object` strips by default,
    // so a field the schema does not name is dropped from the log PERMANENTLY. Nothing warns.
    // Declaring a contract is therefore a decision about what gets persisted, not only about
    // what is accepted.
    const s = setup({ ApprovalGranted: z.object({ approvedBy: z.string() }) });
    const executionId = await startAndSuspend(s);
    const handle = await s.runtime.resume(
      executionId,
      resumeWith({ approvedBy: "ops", envelope: { callId: "c-1", surfaceId: "ui:1" } })
    );
    await handle.waitForCompletion();

    const gate = (await s.eventStore.read(executionId)).find(
      (e) => e.eventType === "ApprovalGranted"
    );
    expect(gate?.payload).toEqual({ approvedBy: "ops" }); // `envelope` is gone, for good
  });

  it("keeps unknown keys under `.passthrough()` — the fix for open envelopes", async () => {
    const s = setup({ ApprovalGranted: z.object({ approvedBy: z.string() }).passthrough() });
    const executionId = await startAndSuspend(s);
    const payload = { approvedBy: "ops", envelope: { callId: "c-1", surfaceId: "ui:1" } };
    const handle = await s.runtime.resume(executionId, resumeWith(payload));
    await handle.waitForCompletion();

    const gate = (await s.eventStore.read(executionId)).find(
      (e) => e.eventType === "ApprovalGranted"
    );
    expect(gate?.payload).toEqual(payload);
  });

  it("delivers the payload through the generic form, no cast at the call site", async () => {
    // `ctx.suspend<T>` names what the gate delivers. The type argument is erased, so this
    // asserts the RUNTIME half — the value really does arrive; the type-level half is proven
    // where a type-checker sees real source (the examples repo, whose `pnpm build` runs tsc
    // over the flows). Test files here are excluded from tsc, so a type assertion in this file
    // would pass vacuously.
    const eventStore = new InMemoryAsyncEventStore();
    const effects = new EffectRuntime();
    effects.register("t", new ToolEffect(async () => ({})));
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
    });
    const definition = buildFlow({ ApprovalGranted: APPROVAL });
    const runner: FlowRunner<{ id: string }, Record<string, never>> = async (ctx, input) => {
      // No `as unknown as` — the payload's fields are reachable directly.
      const decision = await ctx.suspend<z.infer<typeof APPROVAL>>({
        on: "ApprovalGranted",
        correlationKey: input.id,
      });
      seen = { by: decision.approvedBy, tier: decision.tier, ok: decision.approved };
      return {};
    };
    let seen: { by: string; tier: number; ok: boolean } | undefined;
    runtime.registerFlow(definition, runner as FlowRunner<unknown, unknown>);

    const started = await runtime.start({ definition, runner } as never, { id: "g-1" });
    await started.waitForSuspend();
    const resumed = await runtime.resume(started.executionId, {
      eventType: "ApprovalGranted",
      payload: { approved: true, approvedBy: "ops" },
    });
    await resumed.waitForCompletion();

    // The Zod default landed too — the runner sees the PARSED value, not the raw payload.
    expect(seen).toEqual({ by: "ops", tier: 1, ok: true });
  });

  it("does not resolve a gate contract up the prototype chain", async () => {
    // `eventType` is caller-controlled and reaches the map as a key. Plain indexing would find
    // `Object.prototype.constructor` — a function with no `safeParse` — turning a hostile event
    // type into a TypeError instead of an ordinary un-gated resume.
    //
    // The ingress gate (#305) now refuses a name that is not the gate BEFORE the lookup runs,
    // so reaching `parseResumePayload` with a hostile key means parking the execution on that
    // name — which a flow author is free to do, and which is the only route left to the
    // hazard. The map deliberately does NOT declare it: `hasOwn` false is the un-gated path.
    for (const hostile of ["constructor", "__proto__", "toString"]) {
      const s = setup({ ApprovalGranted: APPROVAL }, hostile);
      const executionId = await startAndSuspend(s);
      const attempt = s.runtime.resume(executionId, resumeWith({ x: 1 }, hostile));
      // Whatever happens, it must not be a crash from calling a non-schema.
      await expect(attempt).resolves.toBeDefined();
    }
  });

  it("refuses a hostile event type outright when it is not the gate (#305)", async () => {
    // The prototype-chain guard above is the second line of defence. The first is that a
    // caller-supplied name reaches the map at all only when it names the parked gate.
    const s = setup({ ApprovalGranted: APPROVAL });
    const executionId = await startAndSuspend(s);
    const before = await s.eventStore.read(executionId);

    for (const hostile of ["constructor", "__proto__", "toString"]) {
      await expect(
        s.runtime.resume(executionId, resumeWith({ x: 1 }, hostile))
      ).rejects.toThrowError(ResumeRefusedError);
      expect(await s.eventStore.read(executionId)).toEqual(before);
    }
  });
});
