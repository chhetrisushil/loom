import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
import { DuplicateEnvelopeIdError, DuplicateSequenceError } from "@loom/event-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "./SqliteEventStore";

function makeEnvelope(executionId: string, sequence: number, payload: unknown = {}): EventEnvelope {
  return {
    id: `evt-${executionId}-${sequence}`,
    workflowId: "test-flow",
    executionId,
    eventType: "TEST_EVENT",
    sequence,
    timestamp: Date.now(),
    payload,
  };
}

let store: SqliteEventStore;
let dbDir: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "loom-test-"));
  store = new SqliteEventStore(join(dbDir, "events.db"));
});

afterEach(() => {
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("SqliteEventStore", () => {
  describe("append and read", () => {
    it("appends and reads back events in sequence order", async () => {
      const N = 100;
      for (let i = 0; i < N; i++) {
        await store.append(makeEnvelope("exec-1", i, { index: i }));
      }
      const events = await store.read("exec-1");
      expect(events).toHaveLength(N);
      expect(events.map((e) => e.sequence)).toEqual(Array.from({ length: N }, (_, i) => i));
    });

    it("preserves payload through JSON round-trip", async () => {
      const payload = { nested: { value: 42 }, arr: [1, 2, 3], str: "hello" };
      await store.append(makeEnvelope("exec-2", 0, payload));
      const [event] = await store.read("exec-2");
      expect(event?.payload).toEqual(payload);
    });

    it("copyPrefix bulk-copies a re-stamped, metadata-merged prefix (no JS re-serialize)", async () => {
      // Parent log: 5 events, one with existing metadata.
      for (let i = 0; i < 5; i++) {
        await store.append({
          ...makeEnvelope("parent", i, { index: i }),
          ...(i === 2 && { metadata: { keep: "yes" } }),
        });
      }
      // Copy [0..3] into "child", merging fork provenance.
      await store.copyPrefix("parent", "child", 3, { forkedFrom: "parent", forkSequence: 3 });

      const child = await store.read("child");
      expect(child).toHaveLength(4); // sequences 0..3, not 4
      expect(child.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
      // Re-stamped id + executionId, payload preserved.
      expect(child[0]?.executionId).toBe("child");
      expect(child[0]?.id).toBe("child-0");
      expect(child[3]?.payload).toEqual({ index: 3 });
      // Metadata merged: provenance added, existing keys kept.
      expect(child[0]?.metadata).toMatchObject({ forkedFrom: "parent", forkSequence: 3 });
      expect(child[2]?.metadata).toMatchObject({ keep: "yes", forkedFrom: "parent" });
      // Parent untouched.
      expect(await store.read("parent")).toHaveLength(5);
    });

    it("preserves metadata when provided", async () => {
      const envelope = { ...makeEnvelope("exec-3", 0), metadata: { traceId: "abc123" } };
      await store.append(envelope);
      const [event] = await store.read("exec-3");
      expect(event?.metadata).toEqual({ traceId: "abc123" });
    });

    it("returns empty array for unknown executionId", async () => {
      expect(await store.read("nonexistent")).toEqual([]);
    });

    it("isolates events by executionId", async () => {
      await store.append(makeEnvelope("exec-a", 0));
      await store.append(makeEnvelope("exec-b", 0));
      expect(await store.read("exec-a")).toHaveLength(1);
      expect(await store.read("exec-b")).toHaveLength(1);
    });
  });

  describe("UNIQUE constraint", () => {
    // `makeEnvelope` derives the id from (executionId, sequence), so appending it twice
    // collides on the id PRIMARY KEY first — this case was named for a constraint it never
    // reached, and `.rejects.toThrow()` could not tell the difference. A DISTINCT id is
    // what makes the second write test `UNIQUE (execution_id, sequence)`, and the error
    // type is what proves WHICH constraint refused it.
    it("rejects a distinct envelope claiming an occupied (executionId, sequence)", async () => {
      await store.append(makeEnvelope("exec-4", 0));
      const intruder = { ...makeEnvelope("exec-4", 0), id: "evt-exec-4-0-second" };
      await expect(store.append(intruder)).rejects.toThrow(DuplicateSequenceError);
      const read = await store.read("exec-4");
      expect(read).toHaveLength(1);
      expect(read[0]?.id).toBe("evt-exec-4-0");
    });

    it("reports a duplicate ENVELOPE ID as its own error, not as a sequence conflict", async () => {
      // The other constraint on the table (#309). A re-used envelope id is a different bug
      // — the identity was minted twice, rather than a slot race being lost — and reporting
      // it as a sequence conflict would send the reader hunting the wrong problem.
      await store.append(makeEnvelope("exec-4b", 0));
      const sameId = { ...makeEnvelope("exec-4b", 1), id: "evt-exec-4b-0" };
      const err = await store.append(sameId).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(DuplicateEnvelopeIdError);
      expect(err).not.toBeInstanceOf(DuplicateSequenceError);
      expect((await store.read("exec-4b")).map((e) => e.sequence)).toEqual([0]);
    });
  });

  describe("readFrom", () => {
    it("reads events from a given sequence number inclusive", async () => {
      for (let i = 0; i < 10; i++) {
        await store.append(makeEnvelope("exec-5", i));
      }
      const events = await store.readFrom("exec-5", 5);
      expect(events).toHaveLength(5);
      expect(events[0]?.sequence).toBe(5);
    });
  });

  describe("subscribe", () => {
    it("calls handler when event is appended", async () => {
      const handler = vi.fn();
      await store.subscribe("exec-7", handler);
      await store.append(makeEnvelope("exec-7", 0));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toMatchObject({ sequence: 0 });
    });

    it("unsubscribes correctly", async () => {
      const handler = vi.fn();
      const unsub = await store.subscribe("exec-8", handler);
      unsub();
      await store.append(makeEnvelope("exec-8", 0));
      expect(handler).not.toHaveBeenCalled();
    });

    it("does not notify other executionIds", async () => {
      const handlerA = vi.fn();
      await store.subscribe("exec-A", handlerA);
      await store.append(makeEnvelope("exec-B", 0));
      expect(handlerA).not.toHaveBeenCalled();
    });
  });

  describe("1000 events", () => {
    it("handles 1000 events with contiguous sequences", async () => {
      for (let i = 0; i < 1000; i++) {
        await store.append(makeEnvelope("exec-big", i));
      }
      const events = await store.read("exec-big");
      expect(events).toHaveLength(1000);
      for (let i = 0; i < 1000; i++) {
        expect(events[i]?.sequence).toBe(i);
      }
    });
  });
});
