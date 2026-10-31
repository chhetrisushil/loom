import type { EventEnvelope } from "@loom/core";
import {
  ArchiveConflictError,
  type ArchiveSegment,
  type ArchiveStore,
  assertSegmentDigest,
  buildSegment,
} from "@loom/event-runtime";
import { describe, expect, it } from "vitest";

const env = (executionId: string, sequence: number): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType: sequence === 0 ? "EXECUTION_STARTED" : "STEP_STARTED",
  sequence,
  timestamp: 1_000 + sequence,
  // Deliberately awkward JSON: nested objects with unsorted keys, unicode, null, numbers, an array.
  payload: { z: 1, a: { y: [1, "two", null, { b: 2, a: 1 }], x: "é " }, n: -0.5 },
  metadata: { k2: "v", k1: { deep: true } },
});

const seg = (executionId: string, from: number, through: number, skip: number[] = []) =>
  buildSegment(
    Array.from({ length: through - from + 1 }, (_, i) => from + i)
      .filter((s) => !skip.includes(s))
      .map((s) => env(executionId, s)),
    from,
    through
  );

/**
 * ADR 0138 — the ArchiveStore SPI conformance kit. A backend is conforming when segments come back
 * exactly as appended (deep-equal, so a store that reorders object keys on a JSON round trip still
 * passes: the digest is over canonical JSON), append is append-only/contiguous and idempotent for an
 * exact repeat, and executions are isolated.
 */
export function runArchiveStoreConformance(
  factory: () => ArchiveStore | Promise<ArchiveStore>,
  label = "ArchiveStore"
): void {
  describe(`${label} conformance (ArchiveStore SPI)`, () => {
    it("an unknown execution reads as empty", async () => {
      const store = await factory();
      expect(await store.headers("nope")).toEqual([]);
      expect(await store.read("nope")).toEqual([]);
      await store.close();
    });

    it("returns a segment exactly as appended, and its digest still verifies", async () => {
      const store = await factory();
      const s = seg("x", 1, 5, [3]);
      await store.append("x", s);
      const [back] = await store.read("x");
      expect(back).toEqual(s);
      assertSegmentDigest("x", back as ArchiveSegment);
      expect(await store.headers("x")).toEqual([
        { from: 1, through: 5, count: 4, digest: s.digest },
      ]);
      await store.close();
    });

    it("keeps segments in ascending order and reads by range (whole segments that overlap)", async () => {
      const store = await factory();
      await store.append("x", seg("x", 1, 5));
      await store.append("x", seg("x", 6, 9));
      await store.append("x", seg("x", 10, 20));
      expect((await store.headers("x")).map((h) => [h.from, h.through])).toEqual([
        [1, 5],
        [6, 9],
        [10, 20],
      ]);
      expect((await store.read("x", { from: 7, through: 12 })).map((r) => r.from)).toEqual([6, 10]);
      expect((await store.read("x", { from: 21 })).length).toBe(0);
      expect((await store.read("x", { through: 0 })).length).toBe(0);
      expect((await store.read("x", { from: 5, through: 5 })).map((r) => r.from)).toEqual([1]);
      await store.close();
    });

    it("append of an exact repeat is a no-op (a crash between archive and truncate is retried)", async () => {
      const store = await factory();
      const s = seg("x", 1, 5);
      await store.append("x", s);
      await store.append("x", s);
      expect((await store.headers("x")).length).toBe(1);
      await store.append("x", seg("x", 6, 9));
      await store.append("x", s); // an old repeat, after later segments
      expect((await store.headers("x")).length).toBe(2);
      await store.close();
    });

    it("rejects an overlapping or rewinding segment and writes nothing", async () => {
      const store = await factory();
      await store.append("x", seg("x", 1, 5));
      await store.append("x", seg("x", 6, 9));
      for (const bad of [seg("x", 5, 8), seg("x", 1, 12), seg("x", 2, 3), seg("x", 9, 9)]) {
        await expect(store.append("x", bad)).rejects.toBeInstanceOf(ArchiveConflictError);
      }
      // same range, different content: not a repeat
      const changed = buildSegment([{ ...env("x", 6), payload: { other: true } }], 6, 9);
      await expect(store.append("x", changed)).rejects.toBeInstanceOf(ArchiveConflictError);
      expect((await store.headers("x")).map((h) => [h.from, h.through])).toEqual([
        [1, 5],
        [6, 9],
      ]);
      await store.close();
    });

    it("allows a later segment that leaves a gap (a log compacted before an archive existed)", async () => {
      const store = await factory();
      await store.append("x", seg("x", 4, 6));
      await store.append("x", seg("x", 20, 22));
      expect((await store.headers("x")).length).toBe(2);
      await store.close();
    });

    it("isolates executions", async () => {
      const store = await factory();
      await store.append("a", seg("a", 1, 3));
      await store.append("b", seg("b", 1, 7));
      expect((await store.headers("a"))[0]?.through).toBe(3);
      expect((await store.headers("b"))[0]?.through).toBe(7);
      await store.close();
    });

    it("deleteExecution (if implemented) removes only that execution", async () => {
      const store = await factory();
      if (store.deleteExecution === undefined) return void (await store.close());
      await store.append("a", seg("a", 1, 3));
      await store.append("b", seg("b", 1, 3));
      await store.deleteExecution("a");
      expect(await store.headers("a")).toEqual([]);
      expect((await store.headers("b")).length).toBe(1);
      await store.deleteExecution("a"); // idempotent
      await store.close();
    });
  });
}
