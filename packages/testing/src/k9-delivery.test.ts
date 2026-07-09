import { step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { EFFECT_INDOUBT_RESOLVED, WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { crashingEventStore } from "./crash";

// ── K9 — effect delivery contract: idempotency keys & in-doubt parking ────────
//
// The dangerous window: a worker performs a side effect, then dies before the
// STEP_COMPLETED append reaches the log. Recovery re-runs the in-flight step —
// effects are at-least-once. These tests inject exactly that crash and prove:
//  - the idempotency key is stable across the recovery re-run (provider dedup
//    converges to one logical mutation);
//  - undeclared tools keep the legacy automatic re-run byte-identically (G2);
//  - `idempotent: false` tools park at EFFECT_INDOUBT instead of re-running,
//    and resume only via an explicit operator verdict.

const FLOW = "payment-flow";
const EXEC = "k9-exec-1";

const payStep = step$({
  id: "pay",
  name: "Charge the customer",
  toolId: "pay-tool",
  inputSchema: z.object({ amountUsd: z.number() }),
  outputSchema: z.object({ txId: z.string() }),
});

const runner: FlowRunner<{ amountUsd: number }, { txId: string }> = async (ctx, input) => {
  return await ctx.run(payStep, { amountUsd: input.amountUsd });
};

const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    inputSchema: z.object({ amountUsd: z.number() }),
    outputSchema: z.object({ txId: z.string() }),
    steps: [payStep],
  },
  runner,
} as RegisteredFlow<{ amountUsd: number }, { txId: string }>;

/** A provider that dedupes by idempotency key — one logical charge per key. */
function makeLedger() {
  const charges = new Map<string, { txId: string }>();
  const keysSeen: Array<string | undefined> = [];
  const chargeFn = async (_input: unknown, ctx: EffectContext) => {
    keysSeen.push(ctx.idempotencyKey);
    const key = ctx.idempotencyKey ?? `no-key-${keysSeen.length}`;
    if (!charges.has(key)) {
      charges.set(key, { txId: `tx-${charges.size + 1}` });
    }
    return charges.get(key) as { txId: string };
  };
  return { charges, keysSeen, chargeFn };
}

function boot(
  eventStore: InMemoryAsyncEventStore | ReturnType<typeof crashingEventStore>["store"],
  snapshotStore: InMemoryAsyncSnapshotStore,
  payEffect: ToolEffect
) {
  const effects = new EffectRuntime();
  effects.register("pay-tool", payEffect);
  const runtime = new WorkflowRuntime({
    eventStore: eventStore as never,
    snapshotStore,
    effectRuntime: effects,
  });
  runtime.registerFlow(flow.definition, runner);
  return runtime;
}

/** Run once with a crash injected between the pay effect and its completion append. */
async function crashAfterPayEffect(payEffect: ToolEffect) {
  const inner = new InMemoryAsyncEventStore();
  const snapshots = new InMemoryAsyncSnapshotStore();
  const crash = crashingEventStore(inner, {
    dropFrom: (e: EventEnvelope) =>
      e.eventType === "STEP_COMPLETED" && (e.payload as { stepId?: string }).stepId === "pay",
  });

  const runtime1 = boot(crash.store, snapshots, payEffect);
  const handle = await runtime1.start(flow, { amountUsd: 42 }, { executionId: EXEC });
  await handle.waitForCompletion(); // in-memory run finishes; the durable tail was lost
  expect(crash.crashed).toBe(true);

  crash.restore(); // reboot: recovery writes persist normally
  return { eventStore: crash.store, inner, snapshots };
}

const RECOVERY = { eventType: "EXECUTION_RECOVERED", payload: {} };

describe("K9 — idempotency key (K9.2)", () => {
  it("is stable across a crash-recovery re-run, so provider dedup converges to one charge", async () => {
    const ledger = makeLedger();
    const { eventStore, snapshots } = await crashAfterPayEffect(new ToolEffect(ledger.chargeFn));

    const runtime2 = boot(eventStore, snapshots, new ToolEffect(ledger.chargeFn));
    const handle = await runtime2.resume(EXEC, RECOVERY);
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    // The effect ran twice (at-least-once), with the SAME deterministic key…
    expect(ledger.keysSeen).toEqual([`${EXEC}:pay`, `${EXEC}:pay`]);
    // …so the provider deduped to exactly one logical mutation.
    expect(ledger.charges.size).toBe(1);
  });
});

describe("K9 — undeclared tools (G2)", () => {
  it("keeps the legacy automatic re-run: no parking, no EFFECT_INDOUBT fact", async () => {
    const ledger = makeLedger();
    const { eventStore, inner, snapshots } = await crashAfterPayEffect(
      new ToolEffect(ledger.chargeFn) // no idempotent declaration
    );

    const runtime2 = boot(eventStore, snapshots, new ToolEffect(ledger.chargeFn));
    const handle = await runtime2.resume(EXEC, RECOVERY);
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(ledger.keysSeen.length).toBe(2); // re-ran automatically
    const events = await inner.read(EXEC);
    expect(events.filter((e) => e.eventType === "EFFECT_INDOUBT").length).toBe(0);
  });
});

describe("K9 — in-doubt parking (K9.3, idempotent: false)", () => {
  async function parkedAfterCrash() {
    const ledger = makeLedger();
    const mkEffect = () => new ToolEffect(ledger.chargeFn, { idempotent: false });
    const { eventStore, inner, snapshots } = await crashAfterPayEffect(mkEffect());

    const runtime2 = boot(eventStore, snapshots, mkEffect());
    const handle = await runtime2.resume(EXEC, RECOVERY);
    const state = await handle.waitForSuspend();
    return { ledger, mkEffect, eventStore, inner, snapshots, state };
  }

  it("refuses the silent re-run: parks at EFFECT_INDOUBT + suspends for a verdict", async () => {
    const { ledger, inner, state } = await parkedAfterCrash();

    expect(state.status).toBe("suspended");
    expect(state.suspendedOn?.on).toBe(EFFECT_INDOUBT_RESOLVED);
    expect(state.suspendedOn?.correlationKey).toBe("pay");
    expect(ledger.keysSeen.length).toBe(1); // the tool did NOT re-run

    const events = await inner.read(EXEC);
    const indoubt = events.filter((e) => e.eventType === "EFFECT_INDOUBT");
    expect(indoubt.length).toBe(1);
    expect(indoubt[0]?.payload).toMatchObject({
      stepId: "pay",
      toolId: "pay-tool",
      idempotencyKey: `${EXEC}:pay`,
    });
  });

  it("re-parks on a non-verdict redispatch without duplicating the audit fact", async () => {
    const { mkEffect, eventStore, inner, snapshots } = await parkedAfterCrash();

    const runtime3 = boot(eventStore, snapshots, mkEffect());
    const handle = await runtime3.resume(EXEC, RECOVERY);
    const state = await handle.waitForSuspend();

    expect(state.status).toBe("suspended");
    const events = await inner.read(EXEC);
    expect(events.filter((e) => e.eventType === "EFFECT_INDOUBT").length).toBe(1);
  });

  it('verdict "completed-with-result" adopts the operator output without re-running the tool', async () => {
    const { ledger, mkEffect, eventStore, snapshots } = await parkedAfterCrash();

    const runtime3 = boot(eventStore, snapshots, mkEffect());
    const handle = await runtime3.resume(EXEC, {
      eventType: EFFECT_INDOUBT_RESOLVED,
      payload: { stepId: "pay", resolution: "completed-with-result", output: { txId: "manual-1" } },
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(state.variables._output).toEqual({ txId: "manual-1" });
    expect(ledger.keysSeen.length).toBe(1); // never re-ran
  });

  it('verdict "retry-fresh" re-runs the tool as a NEW logical attempt (fresh key)', async () => {
    const { ledger, mkEffect, eventStore, snapshots } = await parkedAfterCrash();

    const runtime3 = boot(eventStore, snapshots, mkEffect());
    const handle = await runtime3.resume(EXEC, {
      eventType: EFFECT_INDOUBT_RESOLVED,
      payload: { stepId: "pay", resolution: "retry-fresh" },
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(ledger.keysSeen).toEqual([`${EXEC}:pay`, `${EXEC}:pay:r1`]);
    expect(ledger.charges.size).toBe(2); // a deliberate, operator-sanctioned second charge
  });

  it('verdict "fail" settles the step and execution as failed', async () => {
    const { ledger, mkEffect, eventStore, inner, snapshots } = await parkedAfterCrash();

    const runtime3 = boot(eventStore, snapshots, mkEffect());
    const handle = await runtime3.resume(EXEC, {
      eventType: EFFECT_INDOUBT_RESOLVED,
      payload: { stepId: "pay", resolution: "fail", error: "charge state unverifiable" },
    });
    await expect(handle.waitForCompletion()).rejects.toThrow(/charge state unverifiable/);

    expect(ledger.keysSeen.length).toBe(1); // never re-ran
    const events = await inner.read(EXEC);
    const failed = events.filter((e) => e.eventType === "STEP_FAILED");
    expect(failed.length).toBe(1);
    expect(failed[0]?.payload).toMatchObject({ stepId: "pay" });
  });
});
