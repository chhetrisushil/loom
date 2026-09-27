import { describe, expect, it } from "vitest";
import { VacuousDeliveryError, assertDelivered, partitionDisjoint } from "./scenarios";

// The bug this pins: section C of the bench attached listeners to the pre-bucketing
// `loom_events` channel while `PostgresEventStore` (ADR 0074 D4) publishes on
// `loom_events_<bucket>`, so the section always reported "0 delivered" while still
// quoting a writer-throughput cost from the SAME run — a self-contradicting, vacuous
// measurement that a green bench run could not catch. `assertDelivered` is the guard: a
// listener set that was supposed to receive something but received nothing must fail the
// section outright, not print a number and move on.

describe("assertDelivered — the bench cannot go vacuous again", () => {
  it("fails when delivery was expected but nothing arrived at all (the historical bug)", () => {
    // A fake listener set standing in for `attachListeners`: connected, but wired to the
    // wrong channel entirely — exactly the pre-fix state of section C.
    const expectedChannels = Array.from({ length: 16 }, (_, i) => `loom_events_${i}`);
    const receivedNothing = new Set<string>();
    expect(() =>
      assertDelivered(
        "C. real bucket channels",
        expectedChannels,
        receivedNothing,
        /* listenerCount */ 16,
        /* expectDelivery */ true
      )
    ).toThrow(VacuousDeliveryError);
  });

  it("fails on PARTIAL coverage even though the aggregate total would read nonzero", () => {
    // The gap a plain `delivered > 0` check cannot see: a store built with fewer buckets
    // than the caller expected (a hard-coded literal drifting out of sync with the
    // instance's real `notifyBuckets`, say) still delivers plenty on the buckets that DO
    // exist — the aggregate count is nonzero — while every channel beyond that silently
    // delivers nothing. Per-channel coverage is the only check that catches this.
    const expectedChannels = Array.from({ length: 16 }, (_, i) => `loom_events_${i}`);
    const receivedOnlyHalf = new Set(expectedChannels.slice(0, 8)); // buckets 8-15 silent
    expect(() =>
      assertDelivered(
        "C. real bucket channels",
        expectedChannels,
        receivedOnlyHalf,
        /* listenerCount */ 16,
        /* expectDelivery */ true
      )
    ).toThrow(VacuousDeliveryError);
  });

  it("does not fire when delivery is genuinely not expected (the unrelated-channel row)", () => {
    // Listeners on a channel nobody publishes to: an empty received-channels set is the
    // CORRECT reading, not a vacuous one, so the assertion must not treat it as a bug.
    expect(() =>
      assertDelivered(
        "C. unrelated channel",
        ["loom_events_bench_unrelated_channel"],
        new Set(),
        /* listenerCount */ 16,
        /* expectDelivery */ false
      )
    ).not.toThrow();
  });

  it("does not fire when there are no listeners at all", () => {
    expect(() =>
      assertDelivered(
        "C. baseline, no listeners",
        Array.from({ length: 16 }, (_, i) => `loom_events_${i}`),
        new Set(),
        /* listenerCount */ 0,
        /* expectDelivery */ true
      )
    ).not.toThrow();
  });

  it("passes once every expected channel delivered something (full coverage)", () => {
    const expectedChannels = Array.from({ length: 16 }, (_, i) => `loom_events_${i}`);
    expect(() =>
      assertDelivered(
        "C. real bucket channels",
        expectedChannels,
        new Set(expectedChannels),
        /* listenerCount */ 16,
        /* expectDelivery */ true
      )
    ).not.toThrow();
  });
});

describe("partitionDisjoint — scenario H's disjoint-interest variant", () => {
  it("splits ids into nodeCount shares whose union is the input with no overlap", () => {
    const ids = Array.from({ length: 9 }, (_, i) => `exec-${i}`);
    const shares = partitionDisjoint(ids, 3);
    expect(shares).toHaveLength(3);
    const seen = new Set<string>();
    for (const share of shares) {
      for (const id of share) {
        expect(seen.has(id)).toBe(false); // no id appears in two nodes' interest
        seen.add(id);
      }
    }
    expect(seen.size).toBe(ids.length); // every id is SOMEONE's interest
  });

  it("returns no shares for nodeCount 0", () => {
    expect(partitionDisjoint(["a", "b"], 0)).toEqual([]);
  });
});
