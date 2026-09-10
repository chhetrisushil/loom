import type { EventEnvelope } from "@loom/core";
import { bench, describe } from "vitest";
import { CoalescingEventStore } from "./CoalescingEventStore";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { ShardedEventStore } from "./ShardedEventStore";
import type { EventStore } from "./types";

// ── What the scale-out decorators cost and buy (ADR 0074) ────────────────────
//
// `scaleDecorators.test.ts` already proves round-trips are SAVED — it counts them. What a
// count cannot say is what that is worth, because the answer depends entirely on what one
// round-trip costs: over a free in-memory store, coalescing is pure overhead, and over a
// network backend it is the difference between 18k and 78k events/sec (`docs/benchmarks.md`,
// measured against real Postgres).
//
// So this bench prices a round-trip EXPLICITLY, spinning rather than sleeping — a timer
// would put scheduler granularity into a measurement whose whole point is the number of
// calls. `ROUND_TRIP_US` is the one assumption; every result below is a function of it, and
// a reader who thinks their backend is cheaper or dearer can move it and re-run.
//
// The second half is the honest counterweight: what the decorators cost when there is
// nothing to save. A decorator that is free on a free backend is a decorator that can be
// left in place.

const ROUND_TRIP_US = 20;

const evt = (executionId: string, sequence: number): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType: "STEP_COMPLETED",
  sequence,
  timestamp: 1000 + sequence,
  payload: { sequence },
});

/** Burn `us` microseconds of CPU. Deterministic; no timer, no scheduler. */
function spin(us: number): void {
  const until = performance.now() + us / 1000;
  while (performance.now() < until) {
    /* deliberately empty */
  }
}

/**
 * A backend that charges `ROUND_TRIP_US` per CALL, not per envelope — which is what a
 * network backend does, and the entire reason batching exists. It keeps nothing: the
 * measurement is the round-trips, not the storage.
 */
function pricedStore(): EventStore {
  return {
    append: async () => {
      spin(ROUND_TRIP_US);
    },
    appendBatch: async () => {
      spin(ROUND_TRIP_US);
    },
    read: async () => [],
    readFrom: async () => [],
    subscribe: async () => () => {},
    close: async () => {},
  };
}

/** One envelope from each of N distinct executions, appended concurrently — the real shape:
 *  N journals, each holding a single pending envelope, all flushing into one turn. */
const N = 512;
const wave = Array.from({ length: N }, (_, i) => evt(`x${i}`, 0));

async function appendAll(store: EventStore): Promise<void> {
  await Promise.all(wave.map((e) => store.append(e)));
}

describe(`${N} cross-execution appends, one round-trip priced at ${ROUND_TRIP_US}µs`, () => {
  bench("per-event append (no decorator)", async () => {
    await appendAll(pricedStore());
  });

  bench("CoalescingEventStore (default maxBatch: 16)", async () => {
    await appendAll(new CoalescingEventStore(pricedStore(), { maxBatch: 16 }));
  });

  bench("CoalescingEventStore (maxBatch: 64)", async () => {
    await appendAll(new CoalescingEventStore(pricedStore(), { maxBatch: 64 }));
  });
});

describe(`${N} cross-execution appends against a FREE backend (what the decorators cost)`, () => {
  // The counterweight. Over an in-memory store there are no round-trips worth saving, so
  // these numbers are the price of leaving a decorator wired where it buys nothing.
  bench("InMemoryAsyncEventStore (no decorator)", async () => {
    await appendAll(new InMemoryAsyncEventStore());
  });

  bench("CoalescingEventStore over in-memory", async () => {
    await appendAll(new CoalescingEventStore(new InMemoryAsyncEventStore(), { maxBatch: 16 }));
  });

  bench("ShardedEventStore over 4 in-memory shards", async () => {
    // Routing only — hash the id, pick a shard, delegate. What sharding actually buys is
    // parallelism across backends, which a single-process bench cannot show and this
    // deliberately does not claim.
    await appendAll(
      new ShardedEventStore(Array.from({ length: 4 }, () => new InMemoryAsyncEventStore()))
    );
  });
});
