import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import { describe, expect, it } from "vitest";
import { ExecutionJournal } from "./ExecutionJournal";

// ADR 0110 — a deferred (durable-first) batch holds back every LATER envelope's `onEvent`, so
// live subscribers (projections, the compliance subject index) always see sequence order; a
// lost batch's envelopes are never delivered.

class GatedStore extends InMemoryAsyncEventStore {
  gate: Promise<void> = Promise.resolve();
  fail = false;
  override async appendBatch(events: EventEnvelope[]): Promise<void> {
    await this.gate;
    if (this.fail) throw new Error("disk");
    return super.appendBatch(events);
  }
}

function rig() {
  const store = new GatedStore();
  const seen: string[] = [];
  const journal = new ExecutionJournal(
    store,
    { executionId: "e", workflowId: "f" },
    new ReplayVM([]),
    (e) => seen.push(`${e.sequence}:${e.eventType}`),
    () => {}
  );
  let open!: () => void;
  store.gate = new Promise<void>((r) => {
    open = r;
  });
  return { store, journal, seen, open };
}

describe("ExecutionJournal onEvent order across a deferred batch", () => {
  it("a commit made while a deferred batch is in flight is delivered after it", async () => {
    const r = rig();
    r.journal.commit("A", {});
    r.journal.commitAtomic(
      [
        { eventType: "B1", payload: {} },
        { eventType: "B2", payload: {} },
      ],
      { deferOnEvent: true }
    );
    r.journal.commit("C", {});
    expect(r.seen).toEqual(["0:A"]);
    r.open();
    await r.journal.drain();
    expect(r.seen).toEqual(["0:A", "1:B1", "2:B2", "3:C"]);
  });

  it("a lost deferred batch is never delivered; what queued behind it still is, in order", async () => {
    const r = rig();
    r.store.fail = true;
    r.journal.commitAtomic([{ eventType: "B", payload: {} }], { deferOnEvent: true });
    r.journal.commit("C", {});
    expect(r.seen).toEqual([]);
    r.open();
    await r.journal.drain().catch(() => {});
    expect(r.seen).toEqual(["1:C"]);
  });

  it("with nothing deferred, onEvent stays synchronous", () => {
    const r = rig();
    r.journal.commit("A", {});
    r.journal.commitAtomic([{ eventType: "B", payload: {} }]);
    expect(r.seen).toEqual(["0:A", "1:B"]);
  });
});
