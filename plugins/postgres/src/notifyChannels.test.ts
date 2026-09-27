import { describe, expect, it } from "vitest";
import { PostgresEventStore } from "./PostgresEventStore";
import { NOTIFY_CHANNEL } from "./schema";

// Pure and DB-independent, unlike the rest of this package's suites (gated on
// LOOM_TEST_POSTGRES_URL) — this always runs, including in CI with no Postgres service.
//
// `notifyChannels()` is an INSTANCE method (P1 fix: a bench or any other external
// LISTENer must read a store's channel list off the instance it actually writes through,
// not a hard-coded literal it hopes stays in sync with the store's default). Testing it
// still needs no database: the method only reads `this.notifyBuckets`, set synchronously
// in the constructor. `offlinePool()` below never resolves `connect`/`query`, so the
// constructor's background `migrate()` call just hangs, harmlessly — nothing here ever
// awaits it, and nothing ever rejects, so there is no unhandled-rejection noise.

/** A pool-shaped object whose `connect`/`query` never resolve. See the note above. */
function offlinePool() {
  return {
    query: () => new Promise(() => {}),
    connect: () => new Promise(() => {}),
    end: () => Promise.resolve(),
  };
}

describe("PostgresEventStore#notifyChannels", () => {
  it("is the single legacy channel when notifyBuckets is 1", () => {
    const store = new PostgresEventStore(offlinePool() as never, { notifyBuckets: 1 });
    expect(store.notifyChannels()).toEqual([NOTIFY_CHANNEL]);
  });

  it("clamps a non-positive notifyBuckets to the legacy channel, matching the store's own floor", () => {
    const zero = new PostgresEventStore(offlinePool() as never, { notifyBuckets: 0 });
    const negative = new PostgresEventStore(offlinePool() as never, { notifyBuckets: -5 });
    expect(zero.notifyChannels()).toEqual([NOTIFY_CHANNEL]);
    expect(negative.notifyChannels()).toEqual([NOTIFY_CHANNEL]);
  });

  it("enumerates every bucket channel a multi-bucket store publishes on", () => {
    const store = new PostgresEventStore(offlinePool() as never, { notifyBuckets: 16 });
    const channels = store.notifyChannels();
    expect(channels).toHaveLength(16);
    expect(new Set(channels).size).toBe(16); // all distinct
    for (let i = 0; i < 16; i++) {
      expect(channels[i]).toBe(`${NOTIFY_CHANNEL}_${i}`);
    }
  });

  it("never includes the bare legacy channel name once bucketed", () => {
    const store = new PostgresEventStore(offlinePool() as never, { notifyBuckets: 16 });
    expect(store.notifyChannels()).not.toContain(NOTIFY_CHANNEL);
  });

  it("reflects the DEFAULT notifyBuckets (16) when none is given, matching the constructor default exactly", () => {
    // Pins the actual default without hard-coding "16" a second time anywhere but the
    // constructor's own `options.notifyBuckets ?? 16` — this test would fail the moment
    // that default changed, unlike a bench-side literal that has no way to notice.
    const store = new PostgresEventStore(offlinePool() as never);
    expect(store.notifyChannels()).toHaveLength(16);
  });

  it("each instance answers for its OWN configured notifyBuckets, not a shared default", () => {
    const eight = new PostgresEventStore(offlinePool() as never, { notifyBuckets: 8 });
    const three = new PostgresEventStore(offlinePool() as never, { notifyBuckets: 3 });
    expect(eight.notifyChannels()).toHaveLength(8);
    expect(three.notifyChannels()).toHaveLength(3);
  });
});
