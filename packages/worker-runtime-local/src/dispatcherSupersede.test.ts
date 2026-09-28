import { step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { LocalDispatcher, SupervisingDispatcher } from "@loom/dispatcher";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type ExecutionPackage, isSupersededRefusal } from "@loom/worker-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalWorkerRuntime } from "./LocalWorkerRuntime";

// L20 — a retrying dispatcher must not treat "another holder owns this execution" as a failed
// attempt. `allocate` fences every dispatch, so a redispatch after a lost race or a fenced-out
// attempt supersedes the healthy holder, which is then fenced out and redispatches in turn:
// the two ping-pong, and every bounce re-runs the in-flight step. ADR 0004 allows the ONE
// interrupted step to run at most twice, whatever `maxAttempts` is.
//
// Deterministic, no timing: every effect invocation is held open until either a LATER
// invocation begins (someone superseded it) or one of the two dispatches has settled. With the
// ping-pong each redispatch starts a new invocation, which releases the previous one; without
// it the superseded dispatch settles and releases the survivor.

const FLOW = "one-step";
const io = z.object({ n: z.number() });
const slow = step$({
  id: "slow",
  name: "Slow",
  toolId: "slow-tool",
  inputSchema: io,
  outputSchema: io,
});
const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) =>
  ctx.run(slow, { n: input.n });

const pkg: ExecutionPackage = {
  executionId: "l20-exec",
  workflowId: FLOW,
  flowId: FLOW,
  input: { n: 1 },
};

interface Harness {
  eventStore: InMemoryAsyncEventStore;
  effects: () => number;
  fences: number[];
  node: (
    wrap?: (d: LocalDispatcher) => ExecutionDispatcher,
    maxAttempts?: number
  ) => ExecutionDispatcher;
  /** Mark a dispatch as settled (releases the invocation currently held open). */
  settled: () => void;
  /** Resolves when effect invocation `n` (1-based) has begun. */
  invoked: (n: number) => Promise<void>;
}

function harness(): Harness {
  const eventStore = new InMemoryAsyncEventStore();
  const snapshots = new InMemoryAsyncSnapshotStore();
  const fences: number[] = [];
  let calls = 0;
  let anySettled = false;
  const waiters: Array<() => void> = [];
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  const startWaiters = new Map<number, () => void>();

  const effect = async (i: { n: number }) => {
    const me = ++calls;
    startWaiters.get(me)?.();
    wake();
    while (calls === me && !anySettled) {
      await new Promise<void>((r) => waiters.push(r));
    }
    return { n: i.n + 1 };
  };

  return {
    eventStore,
    effects: () => calls,
    fences,
    settled: () => {
      anySettled = true;
      wake();
    },
    invoked: (n) =>
      calls >= n ? Promise.resolve() : new Promise<void>((r) => startWaiters.set(n, r)),
    node: (wrap, maxAttempts = 3) => {
      const effects = new EffectRuntime();
      effects.register("slow-tool", new ToolEffect(effect));
      const runtime = new WorkflowRuntime({
        eventStore,
        snapshotStore: snapshots,
        effectRuntime: effects,
      });
      runtime.registerFlow(
        {
          _tag: "FlowDefinition",
          id: FLOW,
          name: FLOW,
          version: "1.0.0",
          inputSchema: io,
          outputSchema: io,
          steps: [slow],
        } as never,
        runner as never
      );
      const worker = new LocalWorkerRuntime(runtime);
      const allocate = worker.allocate.bind(worker);
      worker.allocate = async (req) => {
        const lease = await allocate(req);
        if (lease.fence !== undefined) fences.push(lease.fence);
        return lease;
      };
      const local = new LocalDispatcher(worker, { maxAttempts });
      return wrap ? wrap(local) : local;
    },
  };
}

async function settle(h: Harness, p: Promise<unknown>) {
  try {
    return { ok: true as const, value: await p };
  } catch (err) {
    return { ok: false as const, err };
  } finally {
    h.settled();
  }
}

async function assertOneHistory(h: Harness) {
  const events = await h.eventStore.read(pkg.executionId);
  const count = (t: string) => events.filter((e: EventEnvelope) => e.eventType === t).length;
  expect(count("EXECUTION_STARTED")).toBe(1);
  expect(count("STEP_COMPLETED")).toBe(1);
  expect(count("EXECUTION_COMPLETED")).toBe(1);
}

function expectOneWinnerOneSuperseded(
  results: Array<{ ok: true; value: unknown } | { ok: false; err: unknown }>
) {
  const won = results.filter((r) => r.ok);
  const lost = results.filter((r) => !r.ok);
  expect(won).toHaveLength(1);
  expect(won[0]).toMatchObject({ value: { status: "completed", output: { n: 2 } } });
  expect(lost).toHaveLength(1);
  // The loser surfaces a typed "someone else owns this" refusal, not a generic failure.
  expect(isSupersededRefusal((lost[0] as { err: unknown }).err, pkg.executionId)).toBe(true);
}

describe("L20 — a superseded dispatch is not a failed attempt", () => {
  it("duplicate FIRST dispatch (sequence-0 race), maxAttempts=3 on both: at most one extra run", async () => {
    const h = harness();
    const a = h.node();
    const b = h.node();
    const results = await Promise.all([settle(h, a.dispatch(pkg)), settle(h, b.dispatch(pkg))]);

    expectOneWinnerOneSuperseded(results);
    // ADR 0004: the single interrupted step runs at most twice.
    expect(h.effects()).toBeLessThanOrEqual(2);
    expect(h.fences.length).toBeLessThanOrEqual(2);
    await assertOneHistory(h);
  });

  it("duplicate dispatch AFTER the bootstrap (no sequence-0 race), maxAttempts=3: at most one extra run", async () => {
    const h = harness();
    const a = h.node();
    const b = h.node();
    const pa = settle(h, a.dispatch(pkg));
    await h.invoked(1); // A's bootstrap is durable and its step is in flight
    const pb = settle(h, b.dispatch(pkg)); // B takes over by ADR 0004's redispatch rule
    const results = await Promise.all([pa, pb]);

    expectOneWinnerOneSuperseded(results);
    expect(h.effects()).toBeLessThanOrEqual(2);
    expect(h.fences).toEqual([1, 2]);
    await assertOneHistory(h);
  });

  it("SupervisingDispatcher(maxRestarts=2) over LocalDispatcher(maxAttempts=3): no restart of a superseded dispatch", async () => {
    const h = harness();
    const supervised = (d: LocalDispatcher) =>
      new SupervisingDispatcher(d, {
        policy: { maxRestarts: 2, circuit: { threshold: 1, cooldownMs: 60_000 } },
      });
    const a = h.node(supervised);
    const b = h.node(supervised);
    const pa = settle(h, a.dispatch(pkg));
    await h.invoked(1);
    const pb = settle(h, b.dispatch(pkg));
    const results = await Promise.all([pa, pb]);

    expectOneWinnerOneSuperseded(results);
    expect(h.effects()).toBeLessThanOrEqual(2);
    await assertOneHistory(h);
    // Losing to another holder is not a fault of the target: the circuit stays closed.
    expect((await a.health()).healthy).toBe(true);
    expect((await b.health()).healthy).toBe(true);
  });

  it("takeover still works: a retrying dispatcher recovers an execution whose holder is dead", async () => {
    const h = harness();
    // A "crashes": its dispatch is abandoned mid-step and never settles on its own.
    const a = h.node(undefined, 1);
    const abandoned = a.dispatch(pkg).catch((err: unknown) => err);
    await h.invoked(1);

    const b = h.node(undefined, 3);
    const pb = b.dispatch(pkg);
    await h.invoked(2); // B resumed the crashed execution and re-runs the interrupted step
    h.settled(); // the dead holder never comes back; let B's run finish
    await expect(pb).resolves.toMatchObject({ status: "completed", output: { n: 2 } });
    expect(h.effects()).toBe(2); // the original interrupted run + exactly one re-run
    await assertOneHistory(h);

    // The zombie wakes: its write is fenced out, and it does NOT redispatch.
    const zombie = await abandoned;
    expect(isSupersededRefusal(zombie, pkg.executionId)).toBe(true);
    expect(h.effects()).toBe(2);
    expect(h.fences).toEqual([1, 2]);
  });
});
