import { step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { type EffectContext, ToolEffect } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ALL_INVARIANTS } from "./invariants";
import { type DstProperty, checkProperty, replaySchedule } from "./property";
import { simWorld } from "./simWorld";

// ══ 1. Machinery: DST finds, shrinks, and replays a real bug ══════════════════
//
// A synthetic "system under test" that IGNORES append failures and forges ahead —
// a realistic bug (a write is rejected, the code proceeds anyway) that leaves a GAP
// in the durable log. DST should find a seed that triggers it, shrink the fault
// schedule to the essential rejection, and reproduce it bit-for-bit on replay.

const SYNTH = "synth-exec";

async function appendEvent(
  store: EventStore,
  seq: number,
  eventType: string,
  payload: unknown
): Promise<void> {
  await store.append({
    id: `${SYNTH}-${seq}`,
    workflowId: "synth-flow",
    executionId: SYNTH,
    eventType,
    sequence: seq,
    timestamp: seq,
    payload,
  });
}

const SYNTH_LOG: Array<[number, string, unknown]> = [
  [0, "EXECUTION_STARTED", {}],
  [1, "STEP_STARTED", { stepId: "pay" }],
  [2, "STEP_COMPLETED", { stepId: "pay" }],
  [3, "EXECUTION_COMPLETED", {}],
];

/** BUGGY: swallows write errors and keeps appending → a gap when a middle append fails. */
const buggyProperty: DstProperty = {
  name: "buggy-sut-ignores-write-failures",
  faults: { appendReject: 0.4 },
  registerFlows: () => {},
  scenario: async (world) => {
    for (const [seq, type, payload] of SYNTH_LOG) {
      try {
        await appendEvent(world.eventStore, seq, type, payload);
      } catch {
        // The bug under test: ignore the failed durable write and forge ahead.
      }
    }
    return SYNTH;
  },
};

/** CORRECT: stops on the first write error, so the durable log is always a clean prefix. */
const correctProperty: DstProperty = {
  ...buggyProperty,
  name: "correct-sut-stops-on-write-failure",
  scenario: async (world) => {
    for (const [seq, type, payload] of SYNTH_LOG) {
      try {
        await appendEvent(world.eventStore, seq, type, payload);
      } catch {
        break; // correct: a failed write halts progress
      }
    }
    return SYNTH;
  },
};

describe("checkProperty — find, shrink, replay", () => {
  it("finds the gap bug, minimizes the schedule, and reproduces it deterministically", async () => {
    const report = await checkProperty(buggyProperty, { seeds: 60 });

    expect(report.ok).toBe(false);
    expect(report.violation?.invariant).toBe("logPrefixConsistency");
    expect(report.seed).toBeDefined();
    expect(report.minimizedSchedule).toBeDefined();

    const min = report.minimizedSchedule ?? [];
    // The minimal witness is a single essential rejection (of a non-final append).
    expect(min.length).toBeGreaterThanOrEqual(1);
    expect(min.every((d) => d.kind === "appendReject")).toBe(true);

    // Replaying the MINIMIZED schedule with the failing seed reproduces the violation…
    const replay = await replaySchedule(buggyProperty, min, report.seed ?? 0n);
    expect(replay.ok).toBe(false);
    expect(replay.violation?.invariant).toBe("logPrefixConsistency");

    // …and replay is stable: a second replay yields the identical verdict.
    const again = await replaySchedule(buggyProperty, min, report.seed ?? 0n);
    expect(again).toEqual(replay);
  });

  it("reports ok for a correct SUT across the same seed space", async () => {
    const report = await checkProperty(correctProperty, { seeds: 60 });
    expect(report.ok).toBe(true);
    expect(report.violation).toBeUndefined();
  });
});

// ══ 2. Flagship: the K9 crash-recovery contract as a seeded DST property ═══════
//
// Generalizes @loom/testing's single-point crash test: instead of one hard-coded
// crash predicate, DST crashes the real WorkflowRuntime at seed-chosen points and
// asserts the kernel's invariants survive AND an idempotent tool still converges to
// one logical mutation — across a whole space of crash schedules, not one.

const payStep = step$({
  id: "pay",
  name: "Charge the customer",
  toolId: "pay-tool",
  inputSchema: z.object({ amountUsd: z.number() }),
  outputSchema: z.object({ txId: z.string() }),
});

const runner: FlowRunner<{ amountUsd: number }, { txId: string }> = async (ctx, input) =>
  ctx.run(payStep, { amountUsd: input.amountUsd });

const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: "payment-flow",
    name: "payment-flow",
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
  const chargeFn = async (_input: unknown, ctx: EffectContext) => {
    const key = ctx.idempotencyKey ?? `no-key-${charges.size}`;
    if (!charges.has(key)) charges.set(key, { txId: `tx-${charges.size + 1}` });
    return charges.get(key) as { txId: string };
  };
  return { charges, chargeFn };
}

const EXEC = "k9-dst";

const registerWith =
  (ledger: ReturnType<typeof makeLedger>): DstProperty["registerFlows"] =>
  (runtime, effects) => {
    effects.register("pay-tool", new ToolEffect(ledger.chargeFn));
    runtime.registerFlow(flow.definition, runner);
  };

/** Drive: run once (a crash may land), then reboot + recover if the tail was lost. */
async function crashRecoverScenario(world: ReturnType<typeof simWorld>): Promise<string> {
  const rt1 = world.spawn();
  const h1 = await rt1.start(flow, { amountUsd: 42 }, { executionId: EXEC });
  await h1.waitForCompletion(); // in-memory finishes even if the durable tail was swallowed

  const durable = await world.logOf(EXEC);
  const hasTerminal = durable.some((e: EventEnvelope) => e.eventType === "EXECUTION_COMPLETED");
  if (durable.length > 0 && !hasTerminal) {
    world.faults.restore(); // reboot: recovery writes persist normally
    const rt2 = world.spawn();
    const h2 = await rt2.resume(EXEC, { eventType: "EXECUTION_RECOVERED", payload: {} });
    await h2.waitForCompletion();
  }
  return EXEC;
}

describe("flagship — kernel crash-recovery invariants under seeded faults", () => {
  it("checkProperty finds no violation across the crash-schedule space", async () => {
    const ledger = makeLedger();
    const property: DstProperty = {
      name: "k9-crash-recovery-converges",
      faults: { crashBeforeAppend: 0.15 },
      registerFlows: registerWith(ledger),
      scenario: crashRecoverScenario,
    };
    const report = await checkProperty(property, { seeds: 30 });
    expect(report.ok).toBe(true);
  });

  it("actually crashes on some seeds, and idempotency + invariants still hold", async () => {
    let sawCrash = false;
    for (let s = 1n; s <= 40n; s++) {
      const ledger = makeLedger();
      const world = simWorld({
        seed: s,
        faults: { crashBeforeAppend: 0.2 },
        registerFlows: registerWith(ledger),
      });
      const execId = await crashRecoverScenario(world);
      if (world.faults.crashed) sawCrash = true;

      const log = await world.logOf(execId);
      for (const inv of ALL_INVARIANTS) {
        expect(inv.check({ log }).ok, `${inv.name} violated @seed ${s}`).toBe(true);
      }
      // At-least-once effect delivery collapses to exactly one logical charge.
      expect(ledger.charges.size).toBeLessThanOrEqual(1);
    }
    expect(sawCrash).toBe(true); // the fault model really exercised crashes
  });
});
