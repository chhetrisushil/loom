import { step$ } from "@loom/core";
import type { ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, headOf } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LogLifecycle, highestMissing } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { until } from "./__tests__/r2Harness";
import type { FlowRunner } from "./types";

// ADR 0134 — `LogLifecycle.pruneSnapshots`. The contract: a snapshot is a cache over the log, so
// pruning may make a fork slower but never wrong, and never prunes what a compaction checkpoint or
// the latest snapshot stands for. Every case compares against what the same execution returned
// BEFORE pruning, and counts effect calls (a resume must not re-run a step).

const io = z.object({ n: z.number() });
const mk = (i: number) =>
  step$({ id: `s${i}`, name: `s${i}`, toolId: `t${i}`, inputSchema: io, outputSchema: io });
const steps = [mk(1), mk(2), mk(3), mk(4), mk(5)];

const FLOW = "prune-flow";
const definition: FlowDefinition<{ n: number }, { n: number }> = {
  _tag: "FlowDefinition",
  id: FLOW,
  name: FLOW,
  version: "1.0.0",
  inputSchema: io,
  outputSchema: io,
  steps,
};

const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) => {
  let v = input;
  for (let i = 0; i < steps.length; i++) {
    v = await ctx.run(steps[i]!, v);
    if (i < steps.length - 1) await ctx.suspend({ on: `go${i + 1}` });
  }
  return { n: v.n };
};

function boot(snapshotEvery = 1) {
  const calls: Record<string, number> = {};
  const effects = new EffectRuntime();
  for (let i = 1; i <= steps.length; i++) {
    effects.register(
      `t${i}`,
      new ToolEffect(async (x: { n: number }) => {
        calls[`t${i}`] = (calls[`t${i}`] ?? 0) + 1;
        return { n: x.n + 1 };
      })
    );
  }
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    now: () => 1_000,
    snapshotEvery,
    onWarn: () => {},
  });
  runtime.registerFlow(definition, runner);
  const lifecycle = new LogLifecycle(eventStore, snapshotStore);
  return { runtime, eventStore, snapshotStore, lifecycle, calls };
}
type App = ReturnType<typeof boot>;

/** Run to the n-th gate (1-based): start, then resume the first n-1 gates. */
async function toGate(app: App, id: string, gate: number): Promise<void> {
  const h = await app.runtime.start({ definition, runner }, { n: 1 }, { executionId: id });
  await h.waitForSuspend();
  for (let g = 1; g < gate; g++) await resumeGate(app, id, g);
}

async function resumeGate(app: App, id: string, gate: number): Promise<void> {
  const r = await app.runtime.resume(id, {
    eventType: `go${gate}`,
    payload: { answer: `go${gate}` },
  });
  await r.waitForSuspend();
}

/** Resume a gate and wait for the log to move past it and park again (or finish) - by condition. */
async function resumeAndWait(app: App, id: string, gate: number): Promise<void> {
  const head = headOf(app.eventStore, id);
  const from = (await head) ?? -1;
  await app.runtime.resume(id, { eventType: `go${gate}`, payload: { answer: `go${gate}` } });
  await until(async () => {
    const st = await app.runtime.loadState(id);
    return (st?.status === "suspended" || st?.status === "completed") && st.sequence > from + 1;
  });
}

async function finish(app: App, id: string, gate: number): Promise<void> {
  const r = await app.runtime.resume(id, {
    eventType: `go${gate}`,
    payload: { answer: `go${gate}` },
  });
  await r.waitForCompletion();
}

async function snapshotSequences(app: App, id: string): Promise<number[]> {
  const top = (await app.snapshotStore.loadLatest(id))?.sequence ?? -1;
  const out: number[] = [];
  for (let s = 0; s <= top; s++) if ((await app.snapshotStore.loadAt(id, s)) !== null) out.push(s);
  return out;
}

/** The highest missing sequence of an event list (-1 when gap-free), as the kernel computes it. */
function highestGap(events: readonly { sequence: number }[]): number {
  return highestMissing(events as never);
}

type ForkOutcome = { ok: ExecutionState } | { refused: string };

/** fork(id, at) for every point in the folded range, as comparable outcomes. */
async function forkEverywhere(
  app: App,
  id: string,
  tag: string
): Promise<Map<number, ForkOutcome>> {
  const top = Math.max(
    (await headOf(app.eventStore, id)) ?? 0,
    (await app.snapshotStore.loadLatest(id))?.sequence ?? 0
  );
  const out = new Map<number, ForkOutcome>();
  for (let at = 0; at <= top; at++) {
    try {
      const child = await app.runtime.fork(id, at, { executionId: `${tag}-${at}` });
      out.set(at, { ok: { ...child.state, executionId: "_" } });
    } catch (err) {
      out.set(at, { refused: (err as Error).name });
    }
  }
  return out;
}

describe("ADR 0134 — LogLifecycle.pruneSnapshots", () => {
  it("DEFAULT OFF: a run, a compaction and forks never delete a snapshot", async () => {
    const app = boot();
    let pruneCalls = 0;
    const inner = app.snapshotStore.pruneSnapshots.bind(app.snapshotStore);
    app.snapshotStore.pruneSnapshots = async (...a) => {
      pruneCalls++;
      return inner(...a);
    };
    await toGate(app, "e1", 4);
    const before = await snapshotSequences(app, "e1");
    expect(before.length).toBeGreaterThan(3);
    await app.lifecycle.compact("e1");
    await forkEverywhere(app, "e1", "f");
    const after = await snapshotSequences(app, "e1");
    for (const s of before) expect(after).toContain(s); // compact only ADDS its checkpoint
    expect(pruneCalls).toBe(0);
  });

  it("gap-free log: prunes everything below the latest, every fork point is unchanged, no step re-runs", async () => {
    const app = boot();
    await toGate(app, "e1", 4);
    const before = await snapshotSequences(app, "e1");
    const latest = before[before.length - 1]!;
    const forksBefore = await forkEverywhere(app, "e1", "a");
    const callsBefore = { ...app.calls };

    const deleted = await app.lifecycle.pruneSnapshots("e1");

    expect(deleted).toBeGreaterThanOrEqual(before.length - 1); // a suspend can share a cadence slot
    expect(await snapshotSequences(app, "e1")).toEqual([latest]);
    // Equivalence: the log folded on the surviving snapshot (or from zero) is the same state.
    expect(await forkEverywhere(app, "e1", "b")).toEqual(forksBefore);
    expect(forksBefore.get(latest)).toMatchObject({ ok: expect.anything() });
    // Idempotent.
    expect(await app.lifecycle.pruneSnapshots("e1")).toBe(0);
    // Resume after pruning completes; every step ran exactly once overall.
    await finish(app, "e1", 4);
    expect(app.calls).toEqual({ ...callsBefore, t5: 1 });
    expect((await app.runtime.loadState("e1"))?.status).toBe("completed");
  });

  it("keepLatest and keepSequences keep exactly what they name", async () => {
    const app = boot();
    await toGate(app, "e1", 4);
    const before = await snapshotSequences(app, "e1");
    const pinned = before[1]!;
    await app.lifecycle.pruneSnapshots("e1", { keepLatest: 2, keepSequences: [pinned] });
    expect(await snapshotSequences(app, "e1")).toEqual([pinned, ...before.slice(-2)]);
    // More requested than exist: everything is kept.
    const small = boot();
    await toGate(small, "e2", 2);
    const n = (await snapshotSequences(small, "e2")).length;
    expect(await small.lifecycle.pruneSnapshots("e2", { keepLatest: n + 5 })).toBe(0);
  });

  it("a COMPACTED log keeps its checkpoint and the snapshots below the gap; forks are unchanged", async () => {
    const app = boot();
    await toGate(app, "e1", 3);
    const checkpoint = await app.lifecycle.compact("e1");
    expect(checkpoint).not.toBeNull();
    await resumeGate(app, "e1", 3);
    const before = await snapshotSequences(app, "e1");
    expect(before.filter((s) => s > checkpoint!).length).toBeGreaterThan(1);
    const forksBefore = await forkEverywhere(app, "e1", "a");
    const callsBefore = { ...app.calls };

    const deleted = await app.lifecycle.pruneSnapshots("e1");
    const after = await snapshotSequences(app, "e1");

    expect(deleted).toBeGreaterThan(0);
    expect(after).toContain(checkpoint); // the checkpoint survives
    for (const s of before.filter((s) => s <= checkpoint!)) expect(after).toContain(s);
    expect(after).toContain(before[before.length - 1]);
    expect(await forkEverywhere(app, "e1", "b")).toEqual(forksBefore);
    // Resume after pruning a compacted log: no step re-runs.
    await finish(app, "e1", 4);
    expect(app.calls).toEqual({ ...callsBefore, t5: 1 });
  });

  it("NEGATIVE CONTROL: the same delete WITHOUT the anchor guard breaks a fork, proving the guard fires", async () => {
    const app = boot();
    await toGate(app, "e1", 3);
    const checkpoint = (await app.lifecycle.compact("e1"))!;
    await resumeGate(app, "e1", 3);
    const forksBefore = await forkEverywhere(app, "e1", "a");
    const latest = (await app.snapshotStore.loadLatest("e1"))!.sequence;
    // Naive prune: everything below the latest, ignoring the gap.
    await app.snapshotStore.pruneSnapshots("e1", { after: -1, before: latest });
    expect(await app.snapshotStore.loadAt("e1", checkpoint)).toBeNull();
    expect(await forkEverywhere(app, "e1", "b")).not.toEqual(forksBefore);
    // ...whereas the guarded operation on a twin leaves every fork point as it was.
    const twin = boot();
    await toGate(twin, "e1", 3);
    await twin.lifecycle.compact("e1");
    await resumeGate(twin, "e1", 3);
    const twinBefore = await forkEverywhere(twin, "e1", "a");
    await twin.lifecycle.pruneSnapshots("e1");
    expect(await forkEverywhere(twin, "e1", "b")).toEqual(twinBefore);
  });

  it("a log compacted through its tip ([0]) prunes nothing: the checkpoint is the only record", async () => {
    const app = boot();
    await toGate(app, "e1", 3);
    await app.lifecycle.compact("e1");
    expect((await app.eventStore.read("e1")).map((e) => e.sequence)).toEqual([0]);
    const before = await snapshotSequences(app, "e1");
    expect(await app.lifecycle.pruneSnapshots("e1", { keepLatest: 1 })).toBe(0);
    expect(await snapshotSequences(app, "e1")).toEqual(before);
  });

  it("a compactionExempt execution (a hold) is not pruned; a store without the method returns 0", async () => {
    const held = boot();
    await toGate(held, "e1", 4);
    const exempt = new LogLifecycle(held.eventStore, held.snapshotStore, {
      compactionExempt: () => true,
    });
    const before = await snapshotSequences(held, "e1");
    expect(await exempt.pruneSnapshots("e1")).toBe(0);
    expect(await snapshotSequences(held, "e1")).toEqual(before);

    const bare = boot();
    await toGate(bare, "e1", 3);
    const noPrune = new LogLifecycle(bare.eventStore, {
      save: (s) => bare.snapshotStore.save(s),
      loadLatest: (i) => bare.snapshotStore.loadLatest(i),
      loadAt: (i, s) => bare.snapshotStore.loadAt(i, s),
      loadLatestBefore: (i, s) => bare.snapshotStore.loadLatestBefore(i, s),
      close: () => bare.snapshotStore.close(),
    });
    expect(await noPrune.pruneSnapshots("e1")).toBe(0);
  });

  it("refuses a bad keepLatest and a reserved id", async () => {
    const app = boot();
    await expect(app.lifecycle.pruneSnapshots("e1", { keepLatest: 0 })).rejects.toThrow(RangeError);
    await expect(app.lifecycle.pruneSnapshots("")).rejects.toThrow(TypeError);
    await expect(app.lifecycle.pruneSnapshots("__loom_lifecycle__")).rejects.toThrow(TypeError);
    expect(await app.lifecycle.pruneSnapshots("never-existed")).toBe(0);
  });

  // ---- ADR 0134 D6 — prune racing compact -------------------------------------------------------

  /** Run to completion: the latest snapshot is the terminal one (compact checkpoints at T-1). */
  async function completed(app: App, id: string): Promise<void> {
    await toGate(app, id, 4);
    await finish(app, id, 4);
  }

  /** Let every already-queued microtask (an in-memory store's whole compaction) run. */
  async function drain(): Promise<void> {
    for (let i = 0; i < 400; i++) await Promise.resolve();
  }

  it("RACE (cross-process): a compaction landing between prune's log read and its delete aborts the prune; the checkpoint survives", async () => {
    const app = boot();
    await completed(app, "e1");
    const compactor = new LogLifecycle(app.eventStore, app.snapshotStore); // a "different process"
    let checkpoint: number | null = null;
    let injected = false;
    const racing = new Proxy(app.eventStore, {
      get(t, k) {
        if (k === "read")
          return async (id: string) => {
            const evs = await t.read(id);
            if (!injected) {
              injected = true;
              checkpoint = await compactor.compact(id); // lands AFTER prune saw a gap-free log
            }
            return evs;
          };
        const v = (t as unknown as Record<PropertyKey, unknown>)[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const deleted = await new LogLifecycle(racing, app.snapshotStore).pruneSnapshots("e1");
    expect(checkpoint).not.toBeNull();
    expect(deleted).toBe(0);
    expect(await app.snapshotStore.loadAt("e1", checkpoint!)).not.toBeNull();
    // Nothing a sequential compact-then-prune would serve is lost: prune again, now it sees the gap.
    await app.lifecycle.pruneSnapshots("e1");
    expect(await app.snapshotStore.loadAt("e1", checkpoint!)).not.toBeNull();
  });

  it("RACE (same process): compact and pruneSnapshots on one execution are serialized, in call order", async () => {
    const app = boot();
    await completed(app, "e1");
    // The twin runs them back to back.
    const twin = boot();
    await completed(twin, "e1");
    await twin.lifecycle.pruneSnapshots("e1");
    const twinCp = await twin.lifecycle.compact("e1");
    const twinForks = await forkEverywhere(twin, "e1", "t");
    const twinSnaps = await snapshotSequences(twin, "e1");

    // Hold prune's delete until the concurrent compact has had every chance to finish: with no
    // exclusion the compact completes inside the window and the delete then removes its checkpoint.
    const inner = app.snapshotStore.pruneSnapshots.bind(app.snapshotStore);
    app.snapshotStore.pruneSnapshots = async (...a) => {
      await drain();
      return inner(...a);
    };
    const [, cp] = await Promise.all([
      app.lifecycle.pruneSnapshots("e1"),
      app.lifecycle.compact("e1"),
    ]);
    expect(cp).toBe(twinCp);
    expect(await snapshotSequences(app, "e1")).toEqual(twinSnaps);
    expect(await forkEverywhere(app, "e1", "r")).toEqual(twinForks);
    expect(await app.snapshotStore.loadAt("e1", cp!)).not.toBeNull();
  });

  it("the per-execution exclusion drains: a failed operation does not wedge the chain", async () => {
    const app = boot();
    await completed(app, "e1");
    const inner = app.snapshotStore.pruneSnapshots.bind(app.snapshotStore);
    app.snapshotStore.pruneSnapshots = async () => {
      throw new Error("boom");
    };
    await expect(app.lifecycle.pruneSnapshots("e1")).rejects.toThrow("boom");
    app.snapshotStore.pruneSnapshots = inner;
    expect(await app.lifecycle.pruneSnapshots("e1")).toBeGreaterThan(0);
    expect(await app.lifecycle.compact("e1")).not.toBeNull();
  });

  // ---- the anchor fallbacks (ADR 0134 D2/D3) ----------------------------------------------------

  it("a BRANCH of a compacted parent: the fork seed is the anchor and survives; forks are unchanged", async () => {
    const app = boot();
    await toGate(app, "p", 2);
    const parentCheckpoint = (await app.lifecycle.compact("p"))!;
    await resumeGate(app, "p", 2);
    const parentTip = (await app.eventStore.read("p")).at(-1)!.sequence;
    expect(parentTip).toBeGreaterThan(parentCheckpoint + 1); // the seed sits ABOVE the gap
    await app.runtime.fork("p", parentTip, { executionId: "c" });
    await resumeAndWait(app, "c", 3);
    await resumeAndWait(app, "c", 4);
    const child = await app.eventStore.read("c");
    expect(highestGap(child)).toBe(parentCheckpoint);
    const before = await snapshotSequences(app, "c");
    expect(before).toContain(parentTip);
    expect(before.filter((s) => s > parentTip).length).toBeGreaterThan(1);
    const forksBefore = await forkEverywhere(app, "c", "a");

    const deleted = await app.lifecycle.pruneSnapshots("c");

    expect(deleted).toBeGreaterThan(0);
    const after = await snapshotSequences(app, "c");
    expect(after).toContain(parentTip); // the seed (anchor) survives
    for (const s of before.filter((s) => s <= parentTip)) expect(after).toContain(s);
    expect(await forkEverywhere(app, "c", "b")).toEqual(forksBefore);
  });

  it("a gapped log with NO snapshot at its gap: the lowest snapshot above the gap is the anchor", async () => {
    const app = boot();
    await toGate(app, "e1", 3);
    const checkpoint = (await app.lifecycle.compact("e1"))!;
    await resumeAndWait(app, "e1", 3);
    await resumeAndWait(app, "e1", 4);
    // Lose the snapshot at the gap itself (only the walk-down can find an anchor now).
    await app.snapshotStore.pruneSnapshots("e1", { after: checkpoint - 1, before: checkpoint + 1 });
    expect(await app.snapshotStore.loadAt("e1", checkpoint)).toBeNull();
    const before = await snapshotSequences(app, "e1");
    const above = before.filter((s) => s > checkpoint);
    expect(above.length).toBeGreaterThan(2);
    const forksBefore = await forkEverywhere(app, "e1", "a");

    const deleted = await app.lifecycle.pruneSnapshots("e1");

    expect(deleted).toBeGreaterThan(0);
    const after = await snapshotSequences(app, "e1");
    expect(after).toContain(above[0]); // the anchor: lowest snapshot at or above the gap
    expect(after).toContain(above[above.length - 1]);
    expect(await forkEverywhere(app, "e1", "b")).toEqual(forksBefore);
  });

  // ---- validation (SPI: bounds and keep entries are safe integers) ------------------------------

  it("refuses non-integer keepSequences and bounds BEFORE any delete", async () => {
    const app = boot();
    await toGate(app, "e1", 4);
    let calls = 0;
    const inner = app.snapshotStore.pruneSnapshots.bind(app.snapshotStore);
    app.snapshotStore.pruneSnapshots = async (...a) => {
      calls++;
      return inner(...a);
    };
    const before = await snapshotSequences(app, "e1");
    for (const bad of [3.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, null as unknown as number]) {
      await expect(
        app.lifecycle.pruneSnapshots("e1", { keepSequences: [1, bad] })
      ).rejects.toThrow(RangeError);
    }
    expect(calls).toBe(0);
    expect(await snapshotSequences(app, "e1")).toEqual(before);

    // A store reporting a non-integer snapshot sequence is refused too (the bound is computed).
    const liar = new LogLifecycle(app.eventStore, {
      ...app.snapshotStore,
      loadLatest: async (id: string) => {
        const s = await app.snapshotStore.loadLatest(id);
        return s === null ? null : { ...s, sequence: s.sequence + 0.5 };
      },
      pruneSnapshots: app.snapshotStore.pruneSnapshots,
    } as typeof app.snapshotStore);
    await expect(liar.pruneSnapshots("e1")).rejects.toThrow(RangeError);
    expect(calls).toBe(0);
  });

  // ---- workflowVersion (ADR 0134 D3 exception) --------------------------------------------------

  it("a flow re-registered at a new version: a fork served by a kept snapshot keeps its version; a fold-from-zero fork takes the registered one (documented exception)", async () => {
    const app = boot();
    await toGate(app, "e1", 3);
    // A deploy: the same stores, the flow now registered as 2.0.0.
    const effects = new EffectRuntime();
    for (let i = 1; i <= steps.length; i++)
      effects.register(`t${i}`, new ToolEffect(async (x: { n: number }) => ({ n: x.n + 1 })));
    const v2 = new WorkflowRuntime({
      eventStore: app.eventStore,
      snapshotStore: app.snapshotStore,
      effectRuntime: effects,
      now: () => 1_000,
      snapshotEvery: 1,
      onWarn: () => {},
    });
    v2.registerFlow({ ...definition, version: "2.0.0" }, runner);
    const snaps = await snapshotSequences(app, "e1");
    const mid = snaps[1]!;
    const latest = snaps[snaps.length - 1]!;
    const versionAt = async (at: number, id: string) =>
      (await v2.fork("e1", at, { executionId: id })).state.workflowVersion;
    expect(await versionAt(mid, "b1")).toBe("1.0.0"); // served by a v1 snapshot
    expect(await versionAt(latest, "b2")).toBe("1.0.0");

    await app.lifecycle.pruneSnapshots("e1");

    // workflowVersion is not an event fact (no envelope or payload records it), so a fold from the
    // log alone can only use the registered version. The kept snapshot still carries v1.
    expect(await versionAt(latest, "a2")).toBe("1.0.0");
    expect(await versionAt(mid, "a1")).toBe("2.0.0");
  });
});
