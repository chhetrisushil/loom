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
  it("fails when delivery was expected but nothing arrived (the historical bug)", () => {
    // A fake listener set standing in for `attachListeners`: connected, but wired to the
    // wrong channel — exactly the pre-fix state of section C.
    const fakeListenersThatHeardNothing = { count: 16, delivered: 0 };
    expect(() =>
      assertDelivered(
        "C. real bucket channels",
        fakeListenersThatHeardNothing.delivered,
        fakeListenersThatHeardNothing.count,
        /* expectDelivery */ true
      )
    ).toThrow(VacuousDeliveryError);
  });

  it("does not fire when delivery is genuinely not expected (the unrelated-channel row)", () => {
    // Listeners on a channel nobody publishes to: 0 delivered is the CORRECT reading, not
    // a vacuous one, so the assertion must not treat every zero as a bug.
    expect(() =>
      assertDelivered("C. unrelated channel", 0, 16, /* expectDelivery */ false)
    ).not.toThrow();
  });

  it("does not fire when there are no listeners at all", () => {
    expect(() =>
      assertDelivered("C. baseline, no listeners", 0, 0, /* expectDelivery */ true)
    ).not.toThrow();
  });

  it("passes once real delivery is observed", () => {
    expect(() =>
      assertDelivered("C. real bucket channels", 128, 16, /* expectDelivery */ true)
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
