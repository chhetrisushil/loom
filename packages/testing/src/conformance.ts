import type { EventEnvelope, ExecutionState } from "@loom/core";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import type { BranchRef, BranchRegistry, EventStore } from "@loom/event-runtime";
import { readRangeOf } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import type { ExecutionPackage } from "@loom/worker-runtime";
import { describe, expect, it } from "vitest";

// ── SPI conformance kits (ADR 0033) ──────────────────────────────────────────
//
// Portable contract suites for Loom's extension SPIs. A third-party implementation
// proves it conforms by running the matching `run<Spi>Conformance(factory)` against
// itself — the same idiom as the K1 (kernel ABI) and K5 (event-schema) conformance
// tests, extended from the syscall surface to the pluggable storage seams. Each kit
// exercises the REQUIRED contract and skips OPTIONAL methods a backend omits.

function evt(executionId: string, sequence: number, eventType = "STEP_COMPLETED"): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload: { sequence },
  };
}

/**
 * The EventStore contract (`@loom/event-runtime`): durable, append-only, per-execution
 * ordered reads, live subscribe, and (optionally) fencing.
 */
export function runEventStoreConformance(factory: () => EventStore, label = "EventStore"): void {
  describe(`${label} conformance (EventStore SPI)`, () => {
    it("append + read returns an execution's events in sequence order", async () => {
      const store = factory();
      await store.append(evt("x", 0, "EXECUTION_STARTED"));
      await store.append(evt("x", 1));
      await store.append(evt("x", 2));
      expect((await store.read("x")).map((e) => e.sequence)).toEqual([0, 1, 2]);
      await store.close();
    });

    it("read isolates executions", async () => {
      const store = factory();
      await store.append(evt("x", 0));
      await store.append(evt("y", 0));
      expect(await store.read("y")).toHaveLength(1);
      expect((await store.read("x"))[0]?.executionId).toBe("x");
      await store.close();
    });

    it("readFrom returns the suffix at/after a sequence", async () => {
      const store = factory();
      for (let i = 0; i < 4; i++) await store.append(evt("x", i));
      expect((await store.readFrom("x", 2)).map((e) => e.sequence)).toEqual([2, 3]);
      await store.close();
    });

    it("readRangeOf returns a bounded inclusive range (native or fallback)", async () => {
      const store = factory();
      for (let i = 0; i < 5; i++) await store.append(evt("x", i));
      expect((await readRangeOf(store, "x", 1, 3)).map((e) => e.sequence)).toEqual([1, 2, 3]);
      await store.close();
    });

    it("subscribe delivers appended events; unsubscribe stops them", async () => {
      const store = factory();
      const seen: number[] = [];
      const unsub = await store.subscribe("x", (e) => seen.push(e.sequence));
      await store.append(evt("x", 0));
      await store.append(evt("x", 1));
      unsub();
      await store.append(evt("x", 2));
      expect(seen).toEqual([0, 1]);
      await store.close();
    });

    it("acquireFence increments monotonically (when supported)", async () => {
      const store = factory();
      if (store.acquireFence === undefined) return; // OPTIONAL — single-node backends omit it
      expect(await store.acquireFence("x")).toBe(1);
      expect(await store.acquireFence("x")).toBe(2);
      expect(await store.acquireFence("y")).toBe(1);
      await store.close();
    });
  });
}

function snap(executionId: string, sequence: number): Snapshot {
  return {
    id: `${executionId}-${sequence}`,
    executionId,
    workflowId: "wf",
    sequence,
    state: { executionId, workflowId: "wf" } as unknown as ExecutionState,
    createdAt: 1000 + sequence,
  };
}

/** The SnapshotStore contract (`@loom/snapshot-runtime`): save + point/latest/before reads. */
export function runSnapshotStoreConformance(
  factory: () => SnapshotStore,
  label = "SnapshotStore"
): void {
  describe(`${label} conformance (SnapshotStore SPI)`, () => {
    it("save + loadLatest returns the greatest-sequence snapshot", async () => {
      const store = factory();
      await store.save(snap("x", 1));
      await store.save(snap("x", 3));
      await store.save(snap("x", 2));
      expect((await store.loadLatest("x"))?.sequence).toBe(3);
      await store.close();
    });

    it("loadAt returns the exact sequence, null when absent", async () => {
      const store = factory();
      await store.save(snap("x", 5));
      expect((await store.loadAt("x", 5))?.sequence).toBe(5);
      expect(await store.loadAt("x", 4)).toBeNull();
      await store.close();
    });

    it("loadLatestBefore returns the greatest snapshot at or below a sequence", async () => {
      const store = factory();
      await store.save(snap("x", 1));
      await store.save(snap("x", 3));
      expect((await store.loadLatestBefore("x", 2))?.sequence).toBe(1);
      expect((await store.loadLatestBefore("x", 3))?.sequence).toBe(3);
      expect(await store.loadLatestBefore("x", 0)).toBeNull();
      await store.close();
    });

    it("loadLatest is null for an unknown execution", async () => {
      const store = factory();
      expect(await store.loadLatest("nope")).toBeNull();
      await store.close();
    });

    it("deleteExecution removes an execution's snapshots (when supported)", async () => {
      const store = factory();
      if (store.deleteExecution === undefined) return; // OPTIONAL (K10.1)
      await store.save(snap("x", 1));
      await store.deleteExecution("x");
      expect(await store.loadLatest("x")).toBeNull();
      await store.close();
    });
  });
}

function ref(name: string, executionId: string, tip: number): BranchRef {
  return { name, executionId, tip, createdAt: 1, updatedAt: 1 };
}

/** The BranchRegistry contract (`@loom/event-runtime`): refs, tip moves, promote, lineage DAG. */
export function runBranchRegistryConformance(
  factory: () => BranchRegistry,
  label = "BranchRegistry"
): void {
  describe(`${label} conformance (BranchRegistry SPI)`, () => {
    it("putRef + getRef round-trips; listRefs is sorted by name; getRef null when absent", async () => {
      const reg = factory();
      await reg.putRef(ref("main", "execA", 5));
      await reg.putRef(ref("dev", "execB", 2));
      expect((await reg.getRef("main"))?.executionId).toBe("execA");
      expect(await reg.getRef("nope")).toBeNull();
      expect((await reg.listRefs()).map((r) => r.name)).toEqual(["dev", "main"]);
      await reg.close();
    });

    it("moveTip advances a ref's tip and is a no-op when absent", async () => {
      const reg = factory();
      await reg.putRef(ref("main", "execA", 5));
      await reg.moveTip("main", 9);
      expect((await reg.getRef("main"))?.tip).toBe(9);
      await reg.moveTip("ghost", 1); // no throw
      await reg.close();
    });

    it("promote repoints onto the winner's execution; throws when fromName is missing", async () => {
      const reg = factory();
      await reg.putRef(ref("cand", "execWin", 7));
      await reg.promote("cand", "release"); // creates release
      expect(await reg.getRef("release")).toMatchObject({ executionId: "execWin", tip: 7 });
      await reg.putRef(ref("release2", "execOld", 1));
      await reg.promote("cand", "release2"); // repoints existing
      expect((await reg.getRef("release2"))?.executionId).toBe("execWin");
      await expect(reg.promote("missing", "x")).rejects.toThrow();
      await reg.close();
    });

    it("deleteRef removes a ref", async () => {
      const reg = factory();
      await reg.putRef(ref("tmp", "execA", 1));
      await reg.deleteRef("tmp");
      expect(await reg.getRef("tmp")).toBeNull();
      await reg.close();
    });

    it("recordLineage + getLineage + children model the fork DAG", async () => {
      const reg = factory();
      await reg.recordLineage({
        executionId: "child1",
        parentExecutionId: "parent",
        forkSequence: 3,
      });
      await reg.recordLineage({
        executionId: "child2",
        parentExecutionId: "parent",
        forkSequence: 5,
      });
      expect((await reg.getLineage("child1"))?.parentExecutionId).toBe("parent");
      expect(await reg.getLineage("orphan")).toBeNull();
      expect((await reg.children("parent")).map((l) => l.executionId).sort()).toEqual([
        "child1",
        "child2",
      ]);
      await reg.close();
    });
  });
}

function pkg(executionId: string): ExecutionPackage {
  return { executionId, workflowId: "wf", flowId: "f", input: {} };
}

/**
 * The ExecutionDispatcher contract (`@loom/dispatcher`): dispatch a package to a terminal
 * result, report health, and accept a cancel without throwing.
 */
export function runExecutionDispatcherConformance(
  factory: () => ExecutionDispatcher,
  label = "ExecutionDispatcher"
): void {
  describe(`${label} conformance (ExecutionDispatcher SPI)`, () => {
    it("dispatch runs a package to a terminal result for the same executionId", async () => {
      const d = factory();
      const result = await d.dispatch(pkg("exec-1"));
      expect(result.executionId).toBe("exec-1");
      expect(["completed", "suspended", "failed"]).toContain(result.status);
      expect(typeof result.lastSequence).toBe("number");
    });

    it("health reports liveness and an in-flight count", async () => {
      const d = factory();
      const h = await d.health();
      expect(typeof h.healthy).toBe("boolean");
      expect(typeof h.inFlight).toBe("number");
    });

    it("cancel of an unknown execution is safe (no throw)", async () => {
      const d = factory();
      await expect(d.cancel("nope")).resolves.toBeUndefined();
    });
  });
}
