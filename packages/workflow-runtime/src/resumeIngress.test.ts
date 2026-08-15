import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { knownEventTypes } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { ResumeRefusedError } from "./types";
import type { FlowRunner, RegisteredFlow, ResumeAuthenticator, ResumeEvent } from "./types";

// ── The resume ingress gate (#304 / #305) ────────────────────────────────────
//
// `eventType` is caller-controlled all the way from an ingress adapter — A2A
// `provideInput` and the wire-ABI `execution.resume` both hand a network-supplied
// ResumeEvent to `runtime.resume` — and it used to be appended into the log verbatim.
// Two guards were missing, and each one is a distinct exploit:
//
//  1. a kernel event NAME folded as the kernel's own fact (a resume typed
//     STEP_COMPLETED forged a step outcome the completed short-circuit then served
//     WITHOUT running the effect; EXECUTION_MIGRATED rewrote the K11 code pin);
//  2. `suspendedOn.on` was folded and read by nothing, so any name resumed any gate —
//     which also skipped the ADR 0077 `resumeSchemas` lookup, because that keys off
//     the caller's eventType. A declared shape gate was evaded by renaming the event.
//
// Every test here asserts the refusal AND that the log is byte-unchanged: "refused"
// and "refused after writing something" are the same green tick otherwise, and the
// whole point of refusing before the append is that a resume payload cannot be
// rejected retroactively once it is a permanent fold input.

const io = z.object({}).passthrough();

const gate = step$({
  id: "gate",
  name: "gate",
  toolId: "t-gate",
  inputSchema: io,
  outputSchema: io,
});
const apply = step$({
  id: "apply",
  name: "apply",
  toolId: "t-apply",
  inputSchema: io,
  outputSchema: io,
});

interface Harness {
  runtime: WorkflowRuntime;
  flow: RegisteredFlow;
  eventStore: InMemoryAsyncEventStore;
  applyCalls: () => number;
}

function makeRuntime(
  opts: {
    resumeSchemas?: Record<string, z.ZodType>;
    resumeAuthenticator?: ResumeAuthenticator;
    on?: string;
  } = {}
): Harness {
  let applyCalls = 0;
  const effects = new EffectRuntime();
  effects.register("t-gate", new ToolEffect(async () => ({ ok: true })));
  effects.register(
    "t-apply",
    new ToolEffect(async () => {
      applyCalls++;
      return { real: true };
    })
  );

  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    ...(opts.resumeAuthenticator !== undefined && {
      resumeAuthenticator: opts.resumeAuthenticator,
    }),
  });

  const definition = {
    _tag: "FlowDefinition" as const,
    id: "f",
    name: "f",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [gate, apply],
    ...(opts.resumeSchemas !== undefined && { resumeSchemas: opts.resumeSchemas }),
  };
  const runner = (async (ctx) => {
    await ctx.run(gate, {});
    await ctx.suspend({ on: opts.on ?? "ApprovalGranted" });
    return ctx.run(apply, {});
  }) as FlowRunner<unknown, unknown>;

  runtime.registerFlow(definition, runner);
  return { runtime, flow: { definition, runner }, eventStore, applyCalls: () => applyCalls };
}

/** Start and park at the gate; returns the id and the log exactly as it stands there. */
async function parked(h: Harness) {
  const handle = await h.runtime.start(h.flow, {});
  await handle.waitForSuspend();
  const before = await h.eventStore.read(handle.executionId);
  return { executionId: handle.executionId, before };
}

/** Refused, and not one byte reached the log. */
async function expectRefused(h: Harness, id: string, before: unknown[], event: ResumeEvent) {
  const err = await h.runtime.resume(id, event).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err, `resume with "${event.eventType}" was NOT refused`).toBeInstanceOf(
    ResumeRefusedError
  );
  expect(await h.eventStore.read(id)).toEqual(before);
  return err as ResumeRefusedError;
}

describe("#304 — a caller may not write the kernel's own event types", () => {
  it("refuses a forged STEP_COMPLETED instead of serving it as a step outcome", async () => {
    const h = makeRuntime();
    const { executionId, before } = await parked(h);

    const err = await expectRefused(h, executionId, before, {
      eventType: "STEP_COMPLETED",
      payload: { stepId: "apply", output: { forged: true } },
    });
    expect(err.reason).toBe("kernel-event-type");

    // The exploit was not "the resume succeeds" but "the effect never runs and the
    // flow returns the attacker's value" — so assert the honest resume still does
    // the real work.
    const handle = await h.runtime.resume(executionId, {
      eventType: "ApprovalGranted",
      payload: {},
    });
    const state = await handle.waitForCompletion();
    expect(h.applyCalls()).toBe(1);
    expect(state.frames.apply?.output).toEqual({ real: true });
  });

  it("refuses a forged EXECUTION_MIGRATED — the K11 code pin and _input stay put", async () => {
    const h = makeRuntime();
    const { executionId, before } = await parked(h);

    const err = await expectRefused(h, executionId, before, {
      eventType: "EXECUTION_MIGRATED",
      payload: { toFlowId: "f", toHash: "attacker-chosen-hash", migratedInput: { pwned: true } },
    });
    expect(err.reason).toBe("kernel-event-type");

    const state = await h.runtime.loadState(executionId);
    expect(state?.variables._flowHash).not.toBe("attacker-chosen-hash");
    expect(state?.variables._migratedTo).toBeUndefined();
    expect(state?.variables._input).not.toEqual({ pwned: true });
  });

  it("refuses a forged APPROVAL_GRANTED — K12.2 evidence stays evidence", async () => {
    // An authenticator that rejects anything unsigned. The forgery bypassed it by
    // writing the fact the authenticator exists to produce.
    const h = makeRuntime({
      resumeAuthenticator: {
        verify: (event) =>
          event.eventType !== "ApprovalGranted"
            ? { status: "not-applicable" }
            : (event.payload as { sig?: string }).sig === "good"
              ? { status: "verified", actor: "alice", verifiedBy: "hmac" }
              : { status: "rejected", reason: "bad signature" },
      },
    });
    const { executionId, before } = await parked(h);

    const err = await expectRefused(h, executionId, before, {
      eventType: "APPROVAL_GRANTED",
      payload: { actor: "alice", verifiedBy: "hmac", on: "ApprovalGranted" },
    });
    expect(err.reason).toBe("kernel-event-type");
    expect((await h.runtime.loadState(executionId))?.variables._approvals).toBeUndefined();
  });

  it("refuses a forged DECISION_RECORDED — the ADR 0079 learning substrate is not writable", async () => {
    const h = makeRuntime();
    const { executionId, before } = await parked(h);

    const err = await expectRefused(h, executionId, before, {
      eventType: "DECISION_RECORDED",
      payload: { key: "route", choice: "cheap-model", propensity: 1 },
    });
    expect(err.reason).toBe("kernel-event-type");
    expect((await h.runtime.loadState(executionId))?.variables._decisions).toBeUndefined();
  });

  it("refuses EVERY kernel event type, so a new one is covered the day it is added", async () => {
    // Bound to the K5-governed list rather than a hand-written sample: this is the
    // test that keeps the guard honest when EVENT_SCHEMA grows.
    const h = makeRuntime();
    const { executionId, before } = await parked(h);

    for (const eventType of knownEventTypes()) {
      if (eventType === "TIMER_FIRED") continue; // governed wake; covered below
      const err = await expectRefused(h, executionId, before, { eventType, payload: {} });
      expect(err.reason, `${eventType} was refused for the wrong reason`).toBe("kernel-event-type");
    }
  });

  it("still allows TIMER_FIRED — the one governed wake the kernel raises itself", async () => {
    const h = makeRuntime({ on: "TIMER_FIRED" });
    const { executionId } = await parked(h);
    const handle = await h.runtime.resume(executionId, {
      eventType: "TIMER_FIRED",
      payload: { wakeAt: 1 },
    });
    expect((await handle.waitForCompletion()).status).toBe("completed");
  });
});

describe("#305 — a resume must name the gate the execution is parked on", () => {
  it("refuses an event the execution is not suspended on", async () => {
    const h = makeRuntime();
    const { executionId, before } = await parked(h);

    const err = await expectRefused(h, executionId, before, {
      eventType: "TotallyDifferent",
      payload: {},
    });
    expect(err.reason).toBe("gate-mismatch");
    expect(err.message).toContain("ApprovalGranted");
    expect(h.applyCalls()).toBe(0);
  });

  it("closes the rename bypass of a declared resumeSchemas gate (ADR 0077)", async () => {
    // The gate rejects this payload by name. Before the fix, calling the SAME payload
    // something else meant `parseResumePayload` never found an entry and passed it
    // through untouched — the declared shape gate evaded by renaming the event.
    const h = makeRuntime({
      resumeSchemas: { ApprovalGranted: z.object({ approver: z.string(), ticket: z.string() }) },
    });
    const { executionId, before } = await parked(h);

    await expect(
      h.runtime.resume(executionId, { eventType: "ApprovalGranted", payload: { junk: 1 } })
    ).rejects.toThrow(/resumeSchemas/);
    expect(await h.eventStore.read(executionId)).toEqual(before);

    const err = await expectRefused(h, executionId, before, {
      eventType: "whatever",
      payload: { junk: 1 },
    });
    expect(err.reason).toBe("gate-mismatch");

    // …and the gate still admits a payload that satisfies it.
    const handle = await h.runtime.resume(executionId, {
      eventType: "ApprovalGranted",
      payload: { approver: "alice", ticket: "OPS-1" },
    });
    expect((await handle.waitForCompletion()).status).toBe("completed");
  });

  it("refuses a resume of an execution that already completed", async () => {
    const h = makeRuntime();
    const { executionId } = await parked(h);
    const handle = await h.runtime.resume(executionId, {
      eventType: "ApprovalGranted",
      payload: {},
    });
    await handle.waitForCompletion();

    const before = await h.eventStore.read(executionId);
    const err = await expectRefused(h, executionId, before, {
      eventType: "ApprovalGranted",
      payload: {},
    });
    expect(err.reason).toBe("not-suspended");
    expect(h.applyCalls()).toBe(1); // not re-run
  });

  it("refuses a recovery re-drive of a parked execution", async () => {
    // EXECUTION_RECOVERED is the dispatcher's re-drive of a CRASHED (running) execution,
    // not a gate. It is the one resume that legitimately addresses a non-suspended
    // execution — which is exactly why it must not be usable on a suspended one.
    const h = makeRuntime();
    const { executionId, before } = await parked(h);

    const err = await expectRefused(h, executionId, before, {
      eventType: "EXECUTION_RECOVERED",
      payload: {},
    });
    expect(err.reason).toBe("not-suspended");
  });
});
