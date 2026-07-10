import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type {
  ExecutionAuthorizer,
  ExecutionAuthzRequest,
  FlowRunner,
  RegisteredFlow,
} from "./types";

// ── C.1 — execution-lifecycle authorization ───────────────────────────────────

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ echoed: z.number() });
type In = { n: number };
type Out = { echoed: number };

const echoStep = step$({ id: "echo", name: "Echo", toolId: "echo", inputSchema, outputSchema });

const runner: FlowRunner<In, Out> = async (ctx, input) => {
  // Suspend so we can exercise resume; a signal resumes it to completion.
  await ctx.suspend({ on: "GO" });
  return ctx.run(echoStep, { n: input.n });
};

const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: "authz-flow",
    name: "authz-flow",
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [echoStep],
  } satisfies FlowDefinition<In, Out>,
  runner,
} as RegisteredFlow<In, Out>;

function build(
  authorizer?: ExecutionAuthorizer,
  onDenied?: (r: ExecutionAuthzRequest, reason?: string) => void
) {
  const eventStore = new InMemoryAsyncEventStore();
  const effects = new EffectRuntime();
  effects.register("echo", new ToolEffect(async (i: unknown) => ({ echoed: (i as In).n })));
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    ...(authorizer !== undefined && { executionAuthorizer: authorizer }),
    ...(onDenied !== undefined && { onExecutionDenied: onDenied }),
  });
  runtime.registerFlow(flow.definition, runner);
  return { runtime, eventStore };
}

const alice: PrincipalChain = { tenant: "acme", actor: "alice" };
const mallory: PrincipalChain = { tenant: "evil", actor: "mallory" };

/** Allows only tenant "acme"; denies everyone else. */
const acmeOnly: ExecutionAuthorizer = {
  authorize(req) {
    return req.principal?.tenant === "acme"
      ? { allowed: true }
      : { allowed: false, reason: `tenant ${req.principal?.tenant ?? "<none>"} not permitted` };
  },
};

describe("C.1 — no authorizer wired (G2: unaffected)", () => {
  it("permits every lifecycle op, byte-identically", async () => {
    const { runtime } = build();
    const h = await runtime.start(flow, { n: 7 }, { executionId: "e1" });
    await h.waitForSuspend();
    const state = await runtime.loadState("e1");
    expect(state?.status).toBe("suspended");
    const r = await runtime.resume("e1", { eventType: "GO", payload: {} });
    const done = await r.waitForCompletion();
    expect(done.status).toBe("completed");
  });
});

describe("C.1 — authorizer wired, principal present", () => {
  it("allows a permitted principal through start → query → resume", async () => {
    const { runtime } = build(acmeOnly);
    const h = await runtime.start(flow, { n: 7 }, { executionId: "e1", principal: alice });
    await h.waitForSuspend();
    expect((await runtime.loadState("e1", { principal: alice }))?.status).toBe("suspended");
    const r = await runtime.resume("e1", { eventType: "GO", payload: {} }, { principal: alice });
    expect((await r.waitForCompletion()).status).toBe("completed");
  });

  it("denies start for an unpermitted principal (no execution created)", async () => {
    const { runtime, eventStore } = build(acmeOnly);
    await expect(
      runtime.start(flow, { n: 7 }, { executionId: "e1", principal: mallory })
    ).rejects.toThrow(/denied/);
    expect(await eventStore.read("e1")).toEqual([]); // nothing was written
  });

  it("denies resume and records a durable EXECUTION_DENIED audit fact", async () => {
    const { runtime, eventStore } = build(acmeOnly);
    await (
      await runtime.start(flow, { n: 7 }, { executionId: "e1", principal: alice })
    ).waitForSuspend();

    await expect(
      runtime.resume("e1", { eventType: "GO", payload: {} }, { principal: mallory })
    ).rejects.toThrow(/denied/);

    const events = await eventStore.read("e1");
    const denied = events.filter((e) => e.eventType === "EXECUTION_DENIED");
    expect(denied.length).toBe(1);
    expect(denied[0]?.payload).toMatchObject({ op: "resume", actor: "mallory" });
    // The execution is NOT disrupted — a permitted resume still completes.
    const ok = await runtime.resume("e1", { eventType: "GO", payload: {} }, { principal: alice });
    expect((await ok.waitForCompletion()).status).toBe("completed");
  });

  it("denies cancel and query for an unpermitted principal", async () => {
    const denials: ExecutionAuthzRequest[] = [];
    const { runtime } = build(acmeOnly, (r) => denials.push(r));
    await (
      await runtime.start(flow, { n: 7 }, { executionId: "e1", principal: alice })
    ).waitForSuspend();

    await expect(runtime.cancel("e1", "nope", { principal: mallory })).rejects.toThrow(/denied/);
    await expect(runtime.loadState("e1", { principal: mallory })).rejects.toThrow(/denied/);
    expect(denials.map((d) => d.op).sort()).toEqual(["cancel"]); // query has no callback record path here
  });
});

describe("C.1 — principal-less calls bypass the gate (trust-boundary model)", () => {
  it("an authorizer that would deny is not consulted without a principal", async () => {
    const denyAll: ExecutionAuthorizer = { authorize: () => ({ allowed: false, reason: "no" }) };
    const { runtime } = build(denyAll);
    // No principal on any call ⇒ kernel-internal path ⇒ permitted.
    const h = await runtime.start(flow, { n: 1 }, { executionId: "e1" });
    await h.waitForSuspend();
    expect((await runtime.loadState("e1"))?.status).toBe("suspended");
  });
});
