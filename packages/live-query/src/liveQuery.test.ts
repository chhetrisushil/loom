import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  ContentMissingError,
  ContentResolvingEventStore,
  InMemoryContentStore,
} from "@loom/plugin-content";
import {
  PostgresEventStore,
  PostgresSnapshotStore,
  migratePostgresStores,
} from "@loom/plugin-postgres";
import { foldEvents } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  type FlowRunner,
  LogLifecycle,
  type RegisteredFlow,
  WorkflowRuntime,
} from "@loom/workflow-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

/**
 * Appends `n` sequential events to a fresh liveQuery subscription (settling — via
 * `tick()` — between each, so every wake-up is its own pump) and returns the total rows
 * `read`/`readFrom` returned across the whole run. Small N by design: the PROPERTY under
 * test is the growth ratio between two sizes, not an absolute count, so it stays fast and
 * needs no raised timeout.
 */
async function rowsOverNEvents(n: number): Promise<number> {
  const inner = new InMemoryAsyncEventStore();
  const { store, rows } = countingStore(inner);
  const reader = noSnapshotReader(store);
  const lq = liveQuery({ eventStore: store, reader });

  const unsub = await lq.subscribe("x1", () => {});
  for (let i = 0; i < n; i++) {
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
  return rows();
}

/**
 * The OLD behaviour, measured directly (independent of `liveQuery`): a full re-fold
 * (`reader.loadState`, i.e. `store.read` + `foldEvents` from genesis) on every one of `n`
 * sequential wake-ups — exactly what `subscribe`'s pump called before this fix.
 */
async function rowsOverNEventsOldStyle(n: number): Promise<number> {
  const inner = new InMemoryAsyncEventStore();
  const { store, rows } = countingStore(inner);
  const reader = noSnapshotReader(store);

  for (let i = 0; i < n; i++) {
    await store.append({
      id: `e${i}`,
      executionId: "x1",
      workflowId: "w",
      eventType: "STEP_COMPLETED",
      sequence: i,
      timestamp: i,
      payload: { stepId: `s${i}` },
    });
    await reader.loadState("x1"); // the old subscribe's re-fold-from-genesis per wake-up
  }
  return rows();
}

describe("liveQuery — incremental fold (O(N), not O(N²))", () => {
  it("rows(2N) ≤ 2·rows(N) + slack — linear growth, not quadratic", async () => {
    const N = 100;
    const rowsN = await rowsOverNEvents(N);
    const rows2N = await rowsOverNEvents(2 * N);
    expect(rows2N).toBeLessThanOrEqual(2 * rowsN + 10);
  });

  it("the negative: the OLD per-wake-up full re-fold grows quadratically, not linearly", async () => {
    const N = 100;
    const rowsN = await rowsOverNEventsOldStyle(N);
    const rows2N = await rowsOverNEventsOldStyle(2 * N);
    // Quadratic: rows(2N) ≈ 4·rows(N). Decisively more than the ≤2x+slack a linear
    // implementation keeps — this is why the fix was needed.
    expect(rows2N).toBeGreaterThan(3 * rowsN);
  });
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

// ── LogLifecycle.compact racing a live subscription (P1) ──────────────────────
//
// `readFrom(id, tip + 1)` assumes it returns EVERY event since `tip`. `LogLifecycle.compact`
// (K10.4) breaks that assumption: it truncates `(0..throughSequence]` out of the log after
// checkpointing a snapshot, so a subscriber still holding a `tip` behind the compaction
// boundary reads a NON-CONTIGUOUS (or empty) delta and would silently fold a truncated
// remainder onto stale state — wrong `ExecutionState`, no error. The fix detects the gap
// (the first returned event's sequence isn't `tip + 1`, or the delta is empty while the
// store's own `head` has moved BEHIND `tip`) and recovers with a full `reader.loadState`
// (snapshot + tail) instead of patching the gap onto stale state.

/**
 * Wraps a store's `subscribe` so real notifications queue up while `held` and are only
 * forwarded to the handler once `release()` runs — lets a test freeze exactly when a live
 * subscription "sees" new events, to deterministically race it against a compaction that
 * runs on the real (unfrozen) log in between. `head` is forwarded so the fix's eager
 * empty-delta check has something to consult.
 */
function withHoldableSubscribe(inner: EventStore & Required<Pick<EventStore, "head">>): {
  store: EventStore;
  hold: () => void;
  release: () => void;
} {
  let held = false;
  let deliver: ((e: EventEnvelope) => void) | undefined;
  const queued: EventEnvelope[] = [];
  const store: EventStore = {
    append: (e) => inner.append(e),
    read: (id) => inner.read(id),
    readFrom: (id, from) => inner.readFrom(id, from),
    head: (id) => inner.head(id),
    subscribe: (id, handler) => {
      deliver = handler;
      return inner.subscribe(id, (event) => {
        if (held) queued.push(event);
        else handler(event);
      });
    },
  };
  return {
    store,
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      const q = queued.splice(0);
      for (const e of q) deliver?.(e);
    },
  };
}

/**
 * Same hold/release freeze as {@link withHoldableSubscribe}, but deliberately WITHOUT
 * `head` — proves the empty-delta eager-recovery check tolerates its absence rather than
 * falling back to an unbounded read (which would break the O(N) bound) or fabricating a
 * signal it doesn't have.
 */
function withHoldableSubscribeNoHead(inner: InMemoryAsyncEventStore): {
  store: EventStore;
  hold: () => void;
  release: () => void;
} {
  let held = false;
  let deliver: ((e: EventEnvelope) => void) | undefined;
  const queued: EventEnvelope[] = [];
  const store: EventStore = {
    append: (e) => inner.append(e),
    read: (id) => inner.read(id),
    readFrom: (id, from) => inner.readFrom(id, from),
    // no `head` — deliberately omitted
    subscribe: (id, handler) => {
      deliver = handler;
      return inner.subscribe(id, (event) => {
        if (held) queued.push(event);
        else handler(event);
      });
    },
  };
  return {
    store,
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      const q = queued.splice(0);
      for (const e of q) deliver?.(e);
    },
  };
}

const COMPACT_TICKS = 6;

function buildCompactFlow(): RegisteredFlow<IO, IO> {
  const loopRunner: FlowRunner<IO, IO> = async (ctx, input) => {
    for (let i = 0; i < COMPACT_TICKS; i++) {
      await ctx.suspend({ on: "TICK" });
    }
    return input;
  };
  return {
    definition: { ...flow.definition, id: "lq-compact-flow", name: "lq-compact-flow" },
    runner: loopRunner,
  } as RegisteredFlow<IO, IO>;
}

describe("liveQuery — LogLifecycle.compact races a live subscription", () => {
  it("a subscriber lagging behind a compaction recovers via a full load when a new event follows (non-contiguous delta)", async () => {
    const loopFlow = buildCompactFlow();
    const rawEventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const { store, hold, release } = withHoldableSubscribe(rawEventStore);

    const runtime = new WorkflowRuntime({
      eventStore: store,
      snapshotStore,
      effectRuntime: new EffectRuntime(),
    });
    runtime.registerFlow(loopFlow.definition, loopFlow.runner);

    const lq = liveQuery({ eventStore: store, reader: runtime });
    const seen: ExecutionState[] = [];

    await (await runtime.start(loopFlow, { n: 1 }, { executionId: "e1" })).waitForSuspend();
    const unsub = await lq.subscribe("e1", (s) => seen.push(s));
    await tick();

    hold(); // freeze delivery — the subscription's cached tip stops advancing here
    for (let i = 0; i < 3; i++) {
      await (await runtime.resume("e1", { eventType: "TICK", payload: {} })).waitForSuspend();
    }

    // Compact through the CURRENT tip — far ahead of the frozen subscriber's.
    await new LogLifecycle(rawEventStore, snapshotStore).compact("e1");

    // One more real event after compaction: the eventual delta is non-empty but starts
    // well past the subscriber's stale `tip + 1` (a gap — events in between were
    // truncated).
    await (await runtime.resume("e1", { eventType: "TICK", payload: {} })).waitForSuspend();

    release(); // deliver every queued (now-stale) wake-up
    await tick();

    expect(seen.at(-1)).toEqual(await runtime.loadState("e1"));
    unsub();
  });

  it("a subscriber lagging behind a compaction recovers even with no later event (empty delta, head behind tip)", async () => {
    const loopFlow = buildCompactFlow();
    const rawEventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const { store, hold, release } = withHoldableSubscribe(rawEventStore);

    const runtime = new WorkflowRuntime({
      eventStore: store,
      snapshotStore,
      effectRuntime: new EffectRuntime(),
    });
    runtime.registerFlow(loopFlow.definition, loopFlow.runner);

    const lq = liveQuery({ eventStore: store, reader: runtime });
    const seen: ExecutionState[] = [];

    await (await runtime.start(loopFlow, { n: 1 }, { executionId: "e1" })).waitForSuspend();
    const unsub = await lq.subscribe("e1", (s) => seen.push(s));
    await tick();

    hold();
    for (let i = 0; i < 3; i++) {
      await (await runtime.resume("e1", { eventType: "TICK", payload: {} })).waitForSuspend();
    }
    await new LogLifecycle(rawEventStore, snapshotStore).compact("e1");

    release(); // no new event after compaction — the eventual delta is EMPTY
    await tick();

    expect(seen.at(-1)).toEqual(await runtime.loadState("e1"));
    unsub();
  });

  it("without `head`, an empty-delta compaction gap leaves the subscriber silent/stale — never a wrong state — and self-heals on the next real event", async () => {
    const loopFlow = buildCompactFlow();
    const rawEventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    // Deliberately no `head` on this wrapper: the empty-delta eager-recovery check has
    // nothing to consult, so it must not fire (and must not fabricate a read to get one).
    const { store, hold, release } = withHoldableSubscribeNoHead(rawEventStore);

    const runtime = new WorkflowRuntime({
      eventStore: store,
      snapshotStore,
      effectRuntime: new EffectRuntime(),
    });
    runtime.registerFlow(loopFlow.definition, loopFlow.runner);

    const lq = liveQuery({ eventStore: store, reader: runtime });
    const seen: ExecutionState[] = [];

    await (await runtime.start(loopFlow, { n: 1 }, { executionId: "e1" })).waitForSuspend();
    const unsub = await lq.subscribe("e1", (s) => seen.push(s));
    await tick();
    const staleState = seen.at(-1);
    const countBeforeLag = seen.length;

    hold();
    for (let i = 0; i < 3; i++) {
      await (await runtime.resume("e1", { eventType: "TICK", payload: {} })).waitForSuspend();
    }
    const compactedThrough = await new LogLifecycle(rawEventStore, snapshotStore).compact("e1");

    release(); // no new event after compaction, and no `head` to detect the gap either way
    await tick();

    // No `head`: the empty-delta check can't run, so nothing is emitted at all — the
    // subscriber stays exactly where it was (stale), never a silently-wrong state.
    expect(seen.length).toBe(countBeforeLag);
    expect(seen.at(-1)).toEqual(staleState);

    // Self-heals regardless: append one more real event directly (a compaction-truncated
    // execution still accepts new appends at the next sequence — resuming the FLOW here
    // would race WorkflowRuntime's own in-memory sequencer against the truncation this
    // test just forced, which is a different, unrelated interaction; a direct append
    // keeps this test to exactly the gap-detection contract under test). Its delta is
    // non-contiguous (everything between the stale tip and here was truncated), which the
    // primary gap check catches independent of `head`.
    await rawEventStore.append({
      id: "e1-heal",
      executionId: "e1",
      workflowId: "lq-compact-flow",
      eventType: "STEP_COMPLETED",
      sequence: (compactedThrough ?? 0) + 1,
      timestamp: Date.now(),
      payload: { stepId: "heal" },
    });
    await tick();

    expect(seen.at(-1)).toEqual(await runtime.loadState("e1"));
    unsub();
  });

  it("a no-gap delta still folds incrementally — the compaction check costs nothing on the common path", async () => {
    const inner = new InMemoryAsyncEventStore();
    let headCalls = 0;
    const store: EventStore = {
      append: (e) => inner.append(e),
      read: (id) => inner.read(id),
      readFrom: (id, from) => inner.readFrom(id, from),
      head: (id) => {
        headCalls++;
        return inner.head(id);
      },
      subscribe: (id, handler) => inner.subscribe(id, handler),
    };
    const reader = noSnapshotReader(store); // only the one-time initial load ever calls it
    const lq = liveQuery({ eventStore: store, reader });
    const unsub = await lq.subscribe("x1", () => {});

    for (let i = 0; i < 20; i++) {
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

    // Every delta was contiguous (no compaction happened), so `head` is never consulted —
    // the eager recovery check only runs when a wake-up's delta comes back EMPTY.
    expect(headCalls).toBe(0);
  });
});

// ── Same race, against a real Postgres store ──────────────────────────────────
//
// The in-memory tests above prove the fix's LOGIC; this proves it against the backend
// `LogLifecycle.compact` is actually used with in production. Gated on
// `LOOM_TEST_POSTGRES_URL` (see `reference-local-postgres-for-tests`) — skips cleanly
// without a database, same as every other Postgres suite in this repo.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const pgSuite = PG_URL ? describe : describe.skip;

/**
 * Postgres round-trips are real I/O, unlike the in-memory stores' near-instant
 * microtask resolution — a single `tick()` is not a reliable wait for the recovery
 * fold's several sequential queries to land. Polls instead of guessing a sleep
 * duration, re-fetching `expected` each pass since it is itself an async read.
 */
async function waitUntilEqual(
  getActual: () => ExecutionState | undefined,
  getExpected: () => Promise<ExecutionState | null>,
  timeoutMs = 5000
): Promise<{ actual: ExecutionState | undefined; expected: ExecutionState | null }> {
  const start = Date.now();
  for (;;) {
    const expected = await getExpected();
    const actual = getActual();
    if (JSON.stringify(actual) === JSON.stringify(expected)) return { actual, expected };
    if (Date.now() - start > timeoutMs) return { actual, expected };
    await new Promise((r) => setTimeout(r, 20));
  }
}

pgSuite("liveQuery — LogLifecycle.compact races a live subscription (Postgres)", () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_URL });
    await migratePostgresStores(admin);
  });

  afterAll(async () => {
    await admin.end();
  });

  beforeEach(async () => {
    await admin.query(
      "TRUNCATE events, snapshots, refs, lineage, fences, timers, leases, durable_state, read_model_rows, read_model_watermarks, memory_entries"
    );
  });

  it("a subscriber lagging behind a compaction recovers via a full load when a new event follows (non-contiguous delta)", async () => {
    const loopFlow = buildCompactFlow();
    const rawEventStore = new PostgresEventStore(PG_URL as string);
    const snapshotStore = new PostgresSnapshotStore(PG_URL as string);
    try {
      const { store, hold, release } = withHoldableSubscribe(rawEventStore);

      const runtime = new WorkflowRuntime({
        eventStore: store,
        snapshotStore,
        effectRuntime: new EffectRuntime(),
      });
      runtime.registerFlow(loopFlow.definition, loopFlow.runner);

      const lq = liveQuery({ eventStore: store, reader: runtime });
      const seen: ExecutionState[] = [];

      await (await runtime.start(loopFlow, { n: 1 }, { executionId: "e1" })).waitForSuspend();
      const unsub = await lq.subscribe("e1", (s) => seen.push(s));
      await tick();

      hold();
      for (let i = 0; i < 3; i++) {
        await (await runtime.resume("e1", { eventType: "TICK", payload: {} })).waitForSuspend();
      }

      await new LogLifecycle(rawEventStore, snapshotStore).compact("e1");
      await (await runtime.resume("e1", { eventType: "TICK", payload: {} })).waitForSuspend();

      release();

      const { actual, expected } = await waitUntilEqual(
        () => seen.at(-1),
        () => runtime.loadState("e1")
      );
      expect(actual).toEqual(expected);
      unsub();
    } finally {
      await rawEventStore.close();
      await snapshotStore.close();
    }
  }, 20_000);
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
