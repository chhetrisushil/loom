import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "./SqliteEventStore";
import type { EventEnvelope } from "./types";

function makeEnvelope(
  executionId: string,
  sequence: number,
  payload: unknown = {}
): EventEnvelope {
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
    it("appends and reads back events in sequence order", () => {
      const N = 100;
      for (let i = 0; i < N; i++) {
        store.append(makeEnvelope("exec-1", i, { index: i }));
      }
      const events = store.read("exec-1");
      expect(events).toHaveLength(N);
      expect(events.map((e) => e.sequence)).toEqual(Array.from({ length: N }, (_, i) => i));
    });

    it("preserves payload through JSON round-trip", () => {
      const payload = { nested: { value: 42 }, arr: [1, 2, 3], str: "hello" };
      store.append(makeEnvelope("exec-2", 0, payload));
      const [event] = store.read("exec-2");
      expect(event?.payload).toEqual(payload);
    });

    it("preserves metadata when provided", () => {
      const envelope = { ...makeEnvelope("exec-3", 0), metadata: { traceId: "abc123" } };
      store.append(envelope);
      const [event] = store.read("exec-3");
      expect(event?.metadata).toEqual({ traceId: "abc123" });
    });

    it("returns empty array for unknown executionId", () => {
      expect(store.read("nonexistent")).toEqual([]);
    });

    it("isolates events by executionId", () => {
      store.append(makeEnvelope("exec-a", 0));
      store.append(makeEnvelope("exec-b", 0));
      expect(store.read("exec-a")).toHaveLength(1);
      expect(store.read("exec-b")).toHaveLength(1);
    });
  });

  describe("UNIQUE constraint", () => {
    it("rejects duplicate (executionId, sequence) pairs", () => {
      store.append(makeEnvelope("exec-4", 0));
      expect(() => store.append(makeEnvelope("exec-4", 0))).toThrow();
    });
  });

  describe("readFrom", () => {
    it("reads events from a given sequence number inclusive", () => {
      for (let i = 0; i < 10; i++) {
        store.append(makeEnvelope("exec-5", i));
      }
      const events = store.readFrom("exec-5", 5);
      expect(events).toHaveLength(5);
      expect(events[0]?.sequence).toBe(5);
    });
  });

  describe("nextSequence", () => {
    it("returns 0 for an empty executionId", () => {
      expect(store.nextSequence("exec-new")).toBe(0);
    });

    it("returns next sequence after appending events", () => {
      store.append(makeEnvelope("exec-6", 0));
      store.append(makeEnvelope("exec-6", 1));
      expect(store.nextSequence("exec-6")).toBe(2);
    });
  });

  describe("subscribe", () => {
    it("calls handler when event is appended", () => {
      const handler = vi.fn();
      store.subscribe("exec-7", handler);
      store.append(makeEnvelope("exec-7", 0));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toMatchObject({ sequence: 0 });
    });

    it("unsubscribes correctly", () => {
      const handler = vi.fn();
      const unsub = store.subscribe("exec-8", handler);
      unsub();
      store.append(makeEnvelope("exec-8", 0));
      expect(handler).not.toHaveBeenCalled();
    });

    it("does not notify other executionIds", () => {
      const handlerA = vi.fn();
      store.subscribe("exec-A", handlerA);
      store.append(makeEnvelope("exec-B", 0));
      expect(handlerA).not.toHaveBeenCalled();
    });
  });

  describe("1000 events", () => {
    it("handles 1000 events with contiguous sequences", () => {
      for (let i = 0; i < 1000; i++) {
        store.append(makeEnvelope("exec-big", i));
      }
      const events = store.read("exec-big");
      expect(events).toHaveLength(1000);
      for (let i = 0; i < 1000; i++) {
        expect(events[i]?.sequence).toBe(i);
      }
    });
  });
});
