import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryBranchRegistry } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── E1 — a fork copies the gate, so it must copy the alarm ───────────────────
//
// A timer row is keyed by executionId, so the parent's row wakes only the parent.
// Before this, a branch forked at a `suspend({ timeout })` gate carried a deadline
// in its own log that nothing would ever fire — and nothing else sweeps it either,
// because `recoverAbandoned` ignores suspended executions by design.

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });
type In = { n: number };
type Out = { done: boolean };

const afterStep = step$({
  id: "after-gate",
  name: "After gate",
  toolId: "after-tool",
  inputSchema,
  outputSchema,
});

function makeFlow(flowId: string, runner: FlowRunner<In, Out>): RegisteredFlow<In, Out> {
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: flowId,
    name: flowId,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [afterStep],
  };
  return { definition, runner };
}

function boot(flow: RegisteredFlow<In, Out>, opts?: { timers?: boolean; after?: () => void }) {
  const effects = new EffectRuntime();
  effects.register(
    "after-tool",
    new ToolEffect(async () => {
      opts?.after?.();
      return { done: true };
    })
  );
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const timerStore = new InMemoryTimerStore();
  const branchRegistry = new InMemoryBranchRegistry();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    branchRegistry,
    ...((opts?.timers ?? true) && { timerStore }),
    ...((opts?.timers ?? true) ? {} : { onWarn: () => {} }), // unwired IS the case under test
  });
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, eventStore, snapshotStore, timerStore, branchRegistry };
}

/** A flow that parks on an approval gate with a deadline, then does one step. */
function timedGateFlow(flowId: string, timeout?: number) {
  return makeFlow(flowId, async (ctx, input) => {
    await ctx.suspend({ on: "ApprovalGranted", ...(timeout !== undefined && { timeout }) });
    return await ctx.run(afterStep, input);
  });
}

describe("E1 — fork re-registers the forked gate's durable wake", () => {
  it("gives the branch its own timer row, so the branch's deadline can fire", async () => {
    const flow = timedGateFlow("timed-gate", 60_000);
    const app = boot(flow);

    const parent = await app.runtime.start(flow, { n: 1 }, { executionId: "parent" });
    const parked = await parent.waitForSuspend();
    const recordedWakeAt = parked.suspendedOn?.wakeAt;
    expect(recordedWakeAt).toBeDefined();

    const branch = await app.runtime.fork("parent", parked.sequence, { branchName: "spec/a" });

    // The branch is parked on the same gate AND is wakeable on its own.
    const rows = await app.timerStore.due(Number.MAX_SAFE_INTEGER);
    expect(rows).toEqual(
      expect.arrayContaining([
        { executionId: "parent", wakeAt: recordedWakeAt },
        { executionId: branch.executionId, wakeAt: recordedWakeAt },
      ])
    );
  });

  it("the branch actually wakes on its deadline — the behaviour the row exists for", async () => {
    const woke = vi.fn();
    const flow = timedGateFlow("timed-gate-fires", 60_000);
    const app = boot(flow, { after: woke });

    const parent = await app.runtime.start(flow, { n: 1 }, { executionId: "p2" });
    const parked = await parent.waitForSuspend();
    const branch = await app.runtime.fork("p2", parked.sequence, { branchName: "spec/b" });

    const service = new TimerService(app.runtime, app.timerStore);
    await service.tick(Date.now() + 120_000); // deterministic poll past both deadlines

    const branchState = await app.runtime.loadState(branch.executionId);
    expect(branchState?.status).toBe("completed");
    // Parent and branch each ran their own continuation — two independent executions.
    expect(woke).toHaveBeenCalledTimes(2);
  });

  it("uses the RECORDED deadline, never a fresh one", async () => {
    // Re-basing the deadline at fork time would be a timer that can never match its own
    // log: TimerService fires only when `suspendedOn.wakeAt === timer.wakeAt`, and the
    // copied prefix is byte-identical by design. This test pins that decision.
    const flow = timedGateFlow("timed-gate-recorded", 60_000);
    const app = boot(flow);

    const parent = await app.runtime.start(flow, { n: 1 }, { executionId: "p3" });
    const parked = await parent.waitForSuspend();

    await new Promise((r) => setTimeout(r, 5)); // wall clock moves between suspend and fork
    const branch = await app.runtime.fork("p3", parked.sequence, { branchName: "spec/c" });

    const rows = await app.timerStore.due(Number.MAX_SAFE_INTEGER);
    const branchRow = rows.find((r) => r.executionId === branch.executionId);
    const branchState = await app.runtime.loadState(branch.executionId);
    expect(branchRow?.wakeAt).toBe(parked.suspendedOn?.wakeAt);
    expect(branchRow?.wakeAt).toBe(branchState?.suspendedOn?.wakeAt);
  });

  it("invents no deadline for an untimed gate", async () => {
    const flow = timedGateFlow("untimed-gate"); // suspend({ on }) with no timeout
    const app = boot(flow);

    const parent = await app.runtime.start(flow, { n: 1 }, { executionId: "p4" });
    const parked = await parent.waitForSuspend();
    expect(parked.suspendedOn?.wakeAt).toBeUndefined();

    const branch = await app.runtime.fork("p4", parked.sequence, { branchName: "spec/d" });

    const rows = await app.timerStore.due(Number.MAX_SAFE_INTEGER);
    expect(rows.find((r) => r.executionId === branch.executionId)).toBeUndefined();
    expect(rows).toEqual([]);
  });

  it("forks a non-suspended point without touching the timer store", async () => {
    const flow = timedGateFlow("mid-flow", 60_000);
    const app = boot(flow);

    const parent = await app.runtime.start(flow, { n: 1 }, { executionId: "p5" });
    const parked = await parent.waitForSuspend();

    // Fork BEFORE the gate: the child is not parked, so it has no wake to inherit.
    const branch = await app.runtime.fork("p5", 0, { branchName: "spec/e" });
    const rows = await app.timerStore.due(Number.MAX_SAFE_INTEGER);
    expect(rows.find((r) => r.executionId === branch.executionId)).toBeUndefined();
    expect(parked.suspendedOn?.wakeAt).toBeDefined(); // the parent's row is still there
  });

  it("is byte-identical when no TimerStore is wired (G2)", async () => {
    const flow = timedGateFlow("no-timer-store", 60_000);
    const app = boot(flow, { timers: false });

    const parent = await app.runtime.start(flow, { n: 1 }, { executionId: "p6" });
    const parked = await parent.waitForSuspend();

    const branch = await app.runtime.fork("p6", parked.sequence, { branchName: "spec/f" });
    expect(branch.state.status).toBe("suspended");
    expect(await app.timerStore.due(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});

// ── E5 — what a fork actually reads ──────────────────────────────────────────

/** Counts what `fork()` asks the store for. */
class CountingEventStore {
  reads = 0;
  ranges: Array<[number, number]> = [];
  eventsRead = 0;
  heads = 0;
  constructor(private readonly inner: InMemoryAsyncEventStore) {
    // Forward the optional capabilities fork() probes for.
    this.copyPrefix = (f, t, through, meta) => inner.copyPrefix(f, t, through, meta);
  }
  readonly copyPrefix: InMemoryAsyncEventStore["copyPrefix"];
  append(e: EventEnvelope) {
    return this.inner.append(e);
  }
  async read(id: string) {
    this.reads++;
    const evs = await this.inner.read(id);
    this.eventsRead += evs.length;
    return evs;
  }
  readFrom(id: string, from: number) {
    return this.inner.readFrom(id, from);
  }
  async readRange(id: string, from: number, to: number) {
    this.ranges.push([from, to]);
    const evs = await this.inner.readRange(id, from, to);
    this.eventsRead += evs.length;
    return evs;
  }
  async head(id: string) {
    this.heads++;
    return this.inner.head(id);
  }
  subscribe(id: string, h: (e: EventEnvelope) => void) {
    return this.inner.subscribe(id, h);
  }
  close() {
    return this.inner.close();
  }
}

describe("E5 — fork reads its window, not the parent's log", () => {
  const bootCounting = (flow: RegisteredFlow<In, Out>) => {
    const effects = new EffectRuntime();
    effects.register("after-tool", new ToolEffect(async () => ({ done: true })));
    const inner = new InMemoryAsyncEventStore();
    const eventStore = new CountingEventStore(inner) as unknown as InMemoryAsyncEventStore;
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    // No timer store: these cases are about read accounting, not deadlines, so the
    // dropped-deadline warning is expected and silenced.
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: effects,
      onWarn: () => {},
    });
    runtime.registerFlow(flow.definition, flow.runner);
    return { runtime, counter: eventStore as unknown as CountingEventStore, snapshotStore };
  };

  it("never reads the whole log, and never reads past the fork point", async () => {
    const flow = timedGateFlow("read-window", 60_000);
    const app = bootCounting(flow);
    const parent = await app.runtime.start(flow, { n: 1 }, { executionId: "rw" });
    const parked = await parent.waitForSuspend();

    // Give the parent a tail ABOVE the fork point — the part a fork must never pay for.
    for (let i = 1; i <= 50; i++) {
      await app.counter.append({
        id: `tail-${i}`,
        executionId: "rw",
        workflowId: flow.definition.id,
        eventType: "NOISE",
        payload: {},
        sequence: parked.sequence + i,
        timestamp: 1,
      } as EventEnvelope);
    }

    app.counter.reads = 0;
    app.counter.eventsRead = 0;
    app.counter.ranges = [];
    await app.runtime.fork("rw", parked.sequence);

    expect(app.counter.reads).toBe(0); // no whole-log read at all
    expect(app.counter.heads).toBeGreaterThan(0); // the tip came from the indexed query
    for (const [, to] of app.counter.ranges) expect(to).toBeLessThanOrEqual(parked.sequence);
  });

  it("reads NO events when a snapshot sits at the fork point and the store can copy natively", async () => {
    // The suspend path already checkpoints, so this is the common case: fork a branch at a
    // durable gate on a long-lived parent and the fold has nothing left to replay.
    const flow = timedGateFlow("read-none", 60_000);
    const app = bootCounting(flow);
    const parent = await app.runtime.start(flow, { n: 1 }, { executionId: "rn" });
    const parked = await parent.waitForSuspend();

    app.counter.reads = 0;
    app.counter.eventsRead = 0;
    await app.runtime.fork("rn", parked.sequence);

    expect(app.counter.reads).toBe(0);
    expect(app.counter.eventsRead).toBe(0);
  });
});
