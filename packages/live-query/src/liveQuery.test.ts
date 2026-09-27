import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  ContentMissingError,
  ContentResolvingEventStore,
  InMemoryContentStore,
} from "@loom/plugin-content";
import { foldEvents } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type StateReader, liveQuery } from "./liveQuery";

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ n: z.number() });
type IO = { n: number };

const runner: FlowRunner<IO, IO> = async (ctx, input) => {
  await ctx.suspend({ on: "GO" });
  return input;
};

const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: "lq-flow",
    name: "lq-flow",
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [],
  } satisfies FlowDefinition<IO, IO>,
  runner,
} as RegisteredFlow<IO, IO>;

function build() {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  runtime.registerFlow(flow.definition, runner);
  return { eventStore, runtime };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("liveQuery", () => {
  it("snapshot folds the current state on demand", async () => {
    const { eventStore, runtime } = build();
    const lq = liveQuery({ eventStore, reader: runtime });
    expect(await lq.snapshot("missing")).toBeNull();

    await (await runtime.start(flow, { n: 3 }, { executionId: "e1" })).waitForSuspend();
    expect((await lq.snapshot("e1"))?.status).toBe("suspended");
  });

  it("subscribe pushes the current state, then again as events land", async () => {
    const { eventStore, runtime } = build();
    const lq = liveQuery({ eventStore, reader: runtime });

    await (await runtime.start(flow, { n: 3 }, { executionId: "e1" })).waitForSuspend();

    const seen: ExecutionState[] = [];
    const unsub = await lq.subscribe("e1", (s) => seen.push(s));
    expect(seen.at(-1)?.status).toBe("suspended"); // immediate current state

    await (await runtime.resume("e1", { eventType: "GO", payload: {} })).waitForCompletion();
    await tick();
    expect(seen.at(-1)?.status).toBe("completed"); // pushed on the resume/complete events
    unsub();
  });

  it("stops delivering after unsubscribe", async () => {
    const { eventStore, runtime } = build();
    const lq = liveQuery({ eventStore, reader: runtime });
    await (await runtime.start(flow, { n: 3 }, { executionId: "e1" })).waitForSuspend();

    const seen: ExecutionState[] = [];
    const unsub = await lq.subscribe("e1", (s) => seen.push(s));
    const countAtUnsub = seen.length;
    unsub();

    await (await runtime.resume("e1", { eventType: "GO", payload: {} })).waitForCompletion();
    await tick();
    expect(seen.length).toBe(countAtUnsub); // no further deliveries
  });
});

// ── Incremental fold: O(N) rows read over N events, not O(N²) ────────────────
//
// The old implementation re-folds from genesis (`reader.loadState`) on every wake-up:
// after N sequential events the total rows read across all folds is exactly N(N+1)/2 —
// O(N²) over the subscription's lifetime. The fix reads only the delta since the last
// fold (`eventStore.readFrom(id, tip + 1)`) and folds it onto the kept state with the
// kernel's own `foldEvents` — no new fold, no new version.

/** Wraps a store's `read`/`readFrom` to count every row they return. */
function countingStore(inner: EventStore): { store: EventStore; rows: () => number } {
  let rows = 0;
  const store: EventStore = {
    append: (e) => inner.append(e),
    read: async (id) => {
      const events = await inner.read(id);
      rows += events.length;
      return events;
    },
    readFrom: async (id, from) => {
      const events = await inner.readFrom(id, from);
      rows += events.length;
      return events;
    },
    subscribe: (id, handler) => inner.subscribe(id, handler),
  };
  return { store, rows: () => rows };
}

/**
 * A `StateReader` equivalent to `WorkflowRuntime.foldState`'s no-snapshot path: read the
 * whole log and fold it from genesis. This is exactly what `liveQuery.subscribe` calls on
 * every wake-up today (via `snapshot` = `reader.loadState`) — the O(N²) re-fold the fix
 * removes.
 */
function noSnapshotReader(store: EventStore): StateReader {
  return {
    loadState: async (id: string): Promise<ExecutionState | null> => {
      const events = await store.read(id);
      if (events.length === 0) return null;
      return foldEvents(events, { executionId: id, workflowId: "w", workflowVersion: "1" });
    },
  };
}

describe("liveQuery — incremental fold (O(N), not O(N²))", () => {
  it("reads O(N) rows over N sequential events, not O(N²) — the negative: a full re-fold per wake-up fails this", async () => {
    const inner = new InMemoryAsyncEventStore();
    const { store, rows } = countingStore(inner);
    const reader = noSnapshotReader(store);
    const lq = liveQuery({ eventStore: store, reader });

    const unsub = await lq.subscribe("x1", () => {});

    const N = 500;
    for (let i = 0; i < N; i++) {
      await store.append({
        id: `e${i}`,
        executionId: "x1",
        workflowId: "w",
        eventType: "STEP_COMPLETED",
        sequence: i,
        timestamp: i,
        payload: { stepId: `s${i}` },
      });
      await tick();
    }
    unsub();

    // O(N): a small constant over N, never N(N+1)/2 (≈125,250 at N=500).
    expect(rows()).toBeLessThanOrEqual(N + 5);
    // 500 settled (awaited) sequential appends can be slow under a fully-loaded CI
    // runner — hence the generous 15s timeout below. The assertion itself is a
    // deterministic row count, not a time budget.
  }, 15_000);

  // The audit's probe (one event per tick, no coalescing) measured EXACTLY N²/2 rows
  // folded at N=4000 — 8,002,000 — and 10.6s wall-clock on SQLite. This bench asserts
  // the row COUNT (deterministic across machines), not the time: even without forcing a
  // settle between every append (so bursts coalesce, which only helps the old code), the
  // old re-fold-from-genesis path is still off by more than 1000x from linear.
  it("bench line: at N=4000, rows folded is ≈N, not the audit's measured N²/2 (8,002,000)", async () => {
    const inner = new InMemoryAsyncEventStore();
    const { store, rows } = countingStore(inner);
    const reader = noSnapshotReader(store);
    const lq = liveQuery({ eventStore: store, reader });

    const unsub = await lq.subscribe("x1", () => {});

    const N = 4000;
    for (let i = 0; i < N; i++) {
      await store.append({
        id: `e${i}`,
        executionId: "x1",
        workflowId: "w",
        eventType: "STEP_COMPLETED",
        sequence: i,
        timestamp: i,
        payload: { stepId: `s${i}` },
      });
    }
    await tick();
    unsub();

    expect(rows()).toBeLessThan(N * 2); // O(N): nowhere near the audit's N²/2 = 8,002,000
    // 4000 sequential appends can be slow under a fully-loaded CI runner — hence the
    // generous 30s timeout below. The assertion itself is a deterministic row count,
    // not a time budget.
  }, 30_000);
});

// ── Equivalence: the incremental state always matches loadState ──────────────

/** Wraps a store's `subscribe` so every real notification also delivers a synchronous
 * duplicate and a deferred (out-of-order relative to any event appended in between) stale
 * re-delivery. `liveQuery` must treat the delivered envelope as a pure wake-up — these
 * perturbations must never change what it folds. */
function withChaosSubscribe(inner: EventStore): EventStore {
  return {
    append: (e) => inner.append(e),
    read: (id) => inner.read(id),
    readFrom: (id, from) => inner.readFrom(id, from),
    subscribe: (id, handler) =>
      inner.subscribe(id, (event: EventEnvelope) => {
        handler(event); // real delivery
        handler(event); // duplicate delivery (same tick)
        void Promise.resolve().then(() => handler(event)); // deferred, possibly-stale re-delivery
      }),
  };
}

describe("liveQuery — incremental state matches loadState (equivalence)", () => {
  it("stays equal to loadState after every event, across a snapshot boundary, under duplicate/out-of-order wake-ups", async () => {
    const TICKS = 12; // > snapshotEvery (7): crosses at least one snapshot boundary
    const loopRunner: FlowRunner<IO, IO> = async (ctx, input) => {
      for (let i = 0; i < TICKS; i++) {
        await ctx.suspend({ on: "TICK" });
      }
      return input;
    };
    const loopFlow = {
      definition: {
        ...flow.definition,
        id: "lq-loop-flow",
        name: "lq-loop-flow",
      },
      runner: loopRunner,
    } as RegisteredFlow<IO, IO>;

    const rawEventStore = new InMemoryAsyncEventStore();
    const chaosStore = withChaosSubscribe(rawEventStore);

    const runtime = new WorkflowRuntime({
      eventStore: chaosStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      snapshotEvery: 7,
    });
    runtime.registerFlow(loopFlow.definition, loopRunner);

    const lq = liveQuery({ eventStore: chaosStore, reader: runtime });
    const seen: ExecutionState[] = [];

    await (await runtime.start(loopFlow, { n: 1 }, { executionId: "e1" })).waitForSuspend();
    const unsub = await lq.subscribe("e1", (s) => seen.push(s));
    await tick();
    expect(seen.at(-1)).toEqual(await runtime.loadState("e1"));

    for (let i = 0; i < TICKS; i++) {
      const handle = await runtime.resume("e1", { eventType: "TICK", payload: {} });
      if (i < TICKS - 1) {
        await handle.waitForSuspend();
      } else {
        await handle.waitForCompletion();
      }
      await tick();
      expect(seen.at(-1)).toEqual(await runtime.loadState("e1"));
    }
    unsub();
  });
});

// ── ContentResolvingEventStore: a failed resolve throws loudly, never a raw ref ──

describe("liveQuery — through ContentResolvingEventStore, a failed resolve surfaces via onError", () => {
  it("never delivers a __loomContent ref; the failure comes from the read path, not the delivered envelope", async () => {
    const inner = new InMemoryAsyncEventStore();
    const emptyContentStore = new InMemoryContentStore(); // nothing ever `put` ⇒ every `get` misses
    const store = new ContentResolvingEventStore(inner, emptyContentStore, { externalize: {} });

    const baseState = (): ExecutionState =>
      ({
        executionId: "x1",
        workflowId: "w",
        workflowVersion: "1",
        status: "running",
        frames: {},
        variables: {},
        sequence: -1,
        startedAt: 0,
        updatedAt: 0,
      }) as ExecutionState;
    const reader: StateReader = { loadState: async () => baseState() };

    const errors: unknown[] = [];
    const seen: ExecutionState[] = [];
    const lq = liveQuery({ eventStore: store, reader, onError: (e) => errors.push(e) });
    const unsub = await lq.subscribe("x1", (s) => seen.push(s));

    await inner.append({
      id: "e1",
      executionId: "x1",
      workflowId: "w",
      eventType: "STEP_COMPLETED",
      sequence: 0,
      timestamp: 1,
      payload: { stepId: "s1", output: { __loomContent: "sha256:deadbeef", codec: "json" } },
    });
    await tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ContentMissingError);
    for (const s of seen) {
      expect(JSON.stringify(s)).not.toContain("__loomContent");
    }
    unsub();
  });
});

// ── A background re-fold that fails must not take the process down ───────────
//
// `subscribe` re-folds on every event from inside the store's subscribe callback. Nothing
// awaits that call, so a rejection escaping it is UNHANDLED — and Node terminates the
// process by default. A store read that fails, or an `onState` callback that throws, is an
// ordinary bad day; it must cost one update, not the node.
//
// Only the FIRST fold (the one-time full `reader.loadState`) can still be made to fail via
// a flaky reader — every fold after it is incremental (`eventStore.readFrom`), so a
// background failure now has to be injected into the STORE, not the reader.

/** Wraps a store so `readFrom` throws while `fail.now` is true, else delegates normally. */
function flakyReadFromStore(inner: EventStore, fail: { now: boolean }): EventStore {
  return {
    append: (e) => inner.append(e),
    read: (id) => inner.read(id),
    readFrom: async (id, from) => {
      if (fail.now) throw new Error("store unavailable");
      return inner.readFrom(id, from);
    },
    subscribe: (id, handler) => inner.subscribe(id, handler),
  };
}

describe("liveQuery — a failing background re-fold", () => {
  it("reports the failure and stays subscribed instead of rejecting", async () => {
    const inner = new InMemoryAsyncEventStore();
    const fail = { now: false };
    const store = flakyReadFromStore(inner, fail);
    // A reader that always succeeds — the initial (one-time) full load never fails here;
    // only the incremental background reads do, via the store above.
    const reader: StateReader = {
      loadState: async (id) =>
        ({
          executionId: id,
          workflowId: "w",
          workflowVersion: "1",
          status: "running",
          frames: {},
          variables: {},
          sequence: -1,
          startedAt: 0,
          updatedAt: 0,
        }) as ExecutionState,
    };
    const errors: unknown[] = [];
    const lq = liveQuery({ eventStore: store, reader, onError: (e) => errors.push(e) });

    const seen: ExecutionState[] = [];
    const unsubscribe = await lq.subscribe("x1", (s) => seen.push(s));
    expect(seen).toHaveLength(1); // the initial fold, awaited by us

    fail.now = true;
    await inner.append({
      id: "e1",
      workflowId: "w",
      executionId: "x1",
      eventType: "STEP_COMPLETED",
      sequence: 0,
      timestamp: 1,
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 0)); // let the background fold settle

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("store unavailable");

    // Still live: a later wake-up folds again once the store recovers — and because the
    // failed read never advanced the tip, the recovered fold picks up BOTH events.
    fail.now = false;
    await inner.append({
      id: "e2",
      workflowId: "w",
      executionId: "x1",
      eventType: "STEP_COMPLETED",
      sequence: 1,
      timestamp: 2,
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.length).toBeGreaterThan(1);
    unsubscribe();
  });

  it("still surfaces a first-fold failure to the caller, who awaited it", async () => {
    // The distinction the fix rests on: only the BACKGROUND fold is caught. The initial
    // one is awaited by `subscribe`'s caller and stays theirs to handle.
    const lq = liveQuery({
      eventStore: new InMemoryAsyncEventStore(),
      reader: {
        loadState: async (): Promise<ExecutionState | null> => {
          throw new Error("store unavailable");
        },
      },
    });
    await expect(lq.subscribe("x1", () => {})).rejects.toThrow("store unavailable");
  });
});
