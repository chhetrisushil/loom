import type { ExecutionState } from "@loom/core";
import { describe, expect, it } from "vitest";
import { build } from "./__tests__/r2Harness";
import { DISCARD_WAIT_ID, type QuarantineEntry, inboxDeliverable, staleInboxBatch } from "./inbox";
import { assertQuarantineMax, readsAsRedacted, retainedSpan } from "./quarantine";

// ADR 0130 residuals D9 - the pure pieces of the delivery rule and the stale-batch guard.

const entry = (
  key: string,
  inboxSeq: number,
  state: "held" | "released",
  heldAt = 0
): QuarantineEntry => ({
  key,
  inboxSeq,
  heldAt,
  state,
});
const stateOf = (
  queues: Record<string, QuarantineEntry[]>,
  cursors: Record<string, number> = {},
  dedupe: string[] = []
): ExecutionState =>
  ({
    variables: {
      _inbox: { cursors, dedupe },
      ...(Object.keys(queues).length > 0 && { _quarantined: queues }),
    },
  }) as never;
const consumed = (topic: string, inboxSeq: number, messageId: string, waitId = "#0") => ({
  eventType: "MESSAGE_CONSUMED",
  payload: { waitId, topic, inboxSeq, messageId },
});
const released = (topic: string, key: string, extra: object = { auto: true }) => ({
  eventType: "INBOX_RELEASED",
  payload: { topic, key, messageId: "m", disposition: "deliver", ...extra },
});

describe("inboxDeliverable (the one delivery rule)", () => {
  const vars = (q: Record<string, QuarantineEntry[]>) => stateOf(q).variables;
  it("no queue (or an empty one) => open", () => {
    expect(inboxDeliverable(vars({}), "a", true)).toBe("open");
    expect(inboxDeliverable(vars({ a: [] }), "a", false)).toBe("open");
    expect(inboxDeliverable(vars({ b: [entry("k", 0, "held")] }), "a", false)).toBe("open");
  });
  it("a released head is delivered whatever this node can open (the delivery itself refuses a sealed copy)", () => {
    const q = vars({ a: [entry("k", 3, "released"), entry("j", 5, "held")] });
    expect(inboxDeliverable(q, "a", false)).toEqual({ released: entry("k", 3, "released") });
    expect(inboxDeliverable(q, "a", true)).toEqual({ released: entry("k", 3, "released") });
  });
  it("a held head: auto-release only for a node that can open it, else blocked", () => {
    const q = vars({ a: [entry("k", 3, "held")] });
    expect(inboxDeliverable(q, "a", true)).toEqual({ autoRelease: entry("k", 3, "held") });
    expect(inboxDeliverable(q, "a", false)).toBe("blocked");
  });
  it("is keyed by OWN property: a prototype-named topic reads as open", () => {
    expect(inboxDeliverable(vars({ a: [entry("k", 0, "held")] }), "toString", false)).toBe("open");
    expect(inboxDeliverable(vars({ a: [entry("k", 0, "held")] }), "constructor", false)).toBe(
      "open"
    );
  });
});

describe("staleInboxBatch - the extended clauses", () => {
  it("is unchanged for state without holds (a log that never quarantines)", () => {
    const s = stateOf({}, { t: 4 });
    expect(staleInboxBatch(s, [consumed("t", 5, "k5")])).toBe(false);
    expect(staleInboxBatch(s, [consumed("t", 4, "k4")])).toBe(true);
    expect(staleInboxBatch(s, [consumed("t", 5, "k5"), consumed("t", 5, "k5b")])).toBe(true);
  });
  it("a delivery for a HELD topic is stale (built before the hold), even above the cursor", () => {
    const s = stateOf({ a: [entry("k1", 0, "held")] }, { a: 0 });
    expect(staleInboxBatch(s, [consumed("a", 1, "k2")])).toBe(true);
    expect(staleInboxBatch(s, [consumed("a", 0, "k1")])).toBe(true); // the held message itself, not yet released
  });
  it("...except the topic's first RELEASED entry (matched by key), whose original inboxSeq is at/below the cursor", () => {
    const s = stateOf({ a: [entry("k1", 0, "released"), entry("k2", 1, "held")] }, { a: 1 });
    expect(staleInboxBatch(s, [consumed("a", 0, "k1")])).toBe(false);
    expect(staleInboxBatch(s, [consumed("a", 0, "other")])).toBe(true);
    expect(staleInboxBatch(s, [consumed("a", 1, "k2")])).toBe(true); // k2 is still held
  });
  it("a reserved discard fact for a message ABOVE the cursor of a held topic stays allowed", () => {
    const s = stateOf({ a: [entry("k1", 0, "held")] }, { a: 0 });
    expect(staleInboxBatch(s, [consumed("a", 2, "expired", DISCARD_WAIT_ID)])).toBe(false);
    expect(staleInboxBatch(s, [consumed("a", 0, "x", DISCARD_WAIT_ID)])).toBe(true); // at/below the cursor
  });
  it("an auto-release batch is stale when the topic's first entry is no longer that HELD key", () => {
    const held = stateOf({ a: [entry("k1", 0, "held")] }, { a: 0 });
    const batch = [released("a", "k1"), consumed("a", 0, "k1")];
    expect(staleInboxBatch(held, batch)).toBe(false); // the release then the delivery, in order, on the state it was built from
    expect(staleInboxBatch(stateOf({}, { a: 0 }), batch)).toBe(true); // gone (delivered or discarded)
    expect(staleInboxBatch(stateOf({ a: [entry("k1", 0, "released")] }, { a: 0 }), batch)).toBe(
      true
    ); // a manual release won
    expect(
      staleInboxBatch(
        stateOf({ a: [entry("k0", 0, "held"), entry("k1", 1, "held")] }, { a: 1 }),
        batch
      )
    ).toBe(true); // not the oldest
  });
  it("a delivery without its release in front of a HELD entry is stale", () => {
    expect(
      staleInboxBatch(stateOf({ a: [entry("k1", 0, "held")] }, { a: 0 }), [consumed("a", 0, "k1")])
    ).toBe(true);
  });
  it("a quarantine is stale once the delivery won (its message is at/below the cursor)", () => {
    const q = (inboxSeq: number) => [
      { eventType: "INBOX_QUARANTINED", payload: { topic: "a", inboxSeq, key: "k" } },
    ];
    expect(staleInboxBatch(stateOf({}, { a: 3 }), q(4))).toBe(false);
    expect(staleInboxBatch(stateOf({}, { a: 4 }), q(4))).toBe(true);
  });
  it("a manual release / discard is stale unless it names the topic's first HELD entry", () => {
    const s = stateOf({ a: [entry("k1", 0, "held"), entry("k2", 1, "held")] }, { a: 1 });
    expect(staleInboxBatch(s, [released("a", "k1", { operator: {} })])).toBe(false);
    expect(staleInboxBatch(s, [released("a", "k2", { operator: {} })])).toBe(true);
    expect(
      staleInboxBatch(s, [
        {
          eventType: "INBOX_RELEASED",
          payload: { topic: "a", key: "k1", disposition: "discard", operator: {} },
        },
      ])
    ).toBe(false);
  });
});

describe("quarantine helpers", () => {
  it("quarantineMax: 1..1024 only", () => {
    expect(() => assertQuarantineMax(undefined)).not.toThrow();
    expect(() => assertQuarantineMax(1)).not.toThrow();
    expect(() => assertQuarantineMax(1024)).not.toThrow();
    for (const bad of [0, -1, 1025, 2000, 1.5, Number.NaN]) {
      expect(() => assertQuarantineMax(bad)).toThrow(/quarantineMax/);
    }
  });
  it("the runtime refuses a quarantineMax above the fold's cap at construction", () => {
    expect(() => build({ inboxQuarantineMax: 2000 })).toThrow(/quarantineMax/);
    expect(build({ inboxQuarantineMax: 1024 }).rt.inboxQuarantineLimit).toBe(1024);
    expect(build({}).rt.inboxQuarantineLimit).toBe(256);
  });
  it("retained span: head minus the oldest PINNED copy (live or in flight), 0 when nothing is pinned", () => {
    expect(retainedSpan(null, null)).toBe(0);
    expect(retainedSpan(4, null)).toBe(0);
    expect(retainedSpan(4, 2)).toBe(3);
    expect(retainedSpan(1, 1)).toBe(1);
  });
  it("a REDACTED read is recognised at any depth, and an unverifiable walk fails closed", () => {
    expect(readsAsRedacted({ $shredded: true })).toBe(true);
    expect(readsAsRedacted({ a: [{ b: { $shredded: true } }] })).toBe(true);
    expect(readsAsRedacted({ a: 1, b: "x" })).toBe(false);
    expect(readsAsRedacted("plain")).toBe(false);
    expect(readsAsRedacted({ $shredded: "no" })).toBe(false);
  });
});
