import type { EventEnvelope, ExecutionState } from "@loom/core";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import type { CapabilityAuthorizer, CapabilityRequest } from "@loom/effect-runtime";
import type {
  BranchRef,
  BranchRegistry,
  EventStore,
  TimerRecord,
  TimerStore,
} from "@loom/event-runtime";
import type { LeaseStore } from "@loom/event-runtime";
import {
  DuplicateEnvelopeIdError,
  DuplicateSequenceError,
  headOf,
  readRangeOf,
} from "@loom/event-runtime";
import type { LlmProvider, LlmStreamChunk } from "@loom/llm";
import { assembleStream } from "@loom/llm";
import type { Projection, ProjectionRuntime } from "@loom/projection-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import type { ExecutionPackage, WorkerRuntime } from "@loom/worker-runtime";
import { describe, expect, it } from "vitest";

export {
  runEventStoreDecoratorConformance,
  runSnapshotStoreDecoratorConformance,
  type DecoratorConformanceOptions,
} from "./decorators.js";

/**
 * `ExecutionAuthorizer` and `TimerDispatcher` live in `@loom/workflow-runtime`, and importing
 * them here would close a cycle: workflow-runtime dev-depends on `@loom/plugin-sqlite`, which
 * depends on this package. So their shapes are declared STRUCTURALLY — TypeScript matches by
 * shape, so a real implementation satisfies these without importing anything.
 *
 * Duplicating a contract is how contracts drift, so it does not stand alone:
 * `@loom/worker-runtime-local` sees both packages and holds a compile-time proof that the
 * real interfaces still satisfy these. If an SPI gains a method, that build fails.
 */
export type ExecutionOpLike = "start" | "resume" | "cancel" | "query";

export interface ExecutionAuthzRequestLike {
  op: ExecutionOpLike;
  executionId: string;
  workflowId: string;
}

export interface ExecutionAuthorizerLike {
  authorize(request: ExecutionAuthzRequestLike): { allowed: boolean; reason?: string };
}

export interface ResumeEventLike {
  eventType: string;
  payload: unknown;
}

export type ResumeVerdictLike =
  | { status: "verified"; actor: string; verifiedBy: string }
  | { status: "rejected"; reason: string }
  | { status: "not-applicable" };

export interface ResumeAuthenticatorLike {
  verify(event: ResumeEventLike): ResumeVerdictLike;
}

export interface TimerDispatcherLike {
  dispatch(
    pkg: {
      executionId: string;
      workflowId: string;
      flowId: string;
      resumeEvent: { eventType: string; payload: unknown };
      metadata?: Record<string, unknown>;
    },
    meta?: { target?: string }
  ): Promise<unknown>;
}

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

    it("headOf reports the tip without materializing the log (native or fallback)", async () => {
      const store = factory();
      expect(await headOf(store, "ghost")).toBeNull();
      for (let i = 0; i < 4; i++) await store.append(evt("x", i));
      expect(await headOf(store, "x")).toBe(3);
      await store.append(evt("x", 4));
      expect(await headOf(store, "x")).toBe(4);
      // Other executions do not contribute to it.
      await store.append(evt("y", 0));
      expect(await headOf(store, "x")).toBe(4);
      expect(await headOf(store, "y")).toBe(0);
      await store.close();
    });

    it("readRangeOf returns a bounded inclusive range (native or fallback)", async () => {
      const store = factory();
      for (let i = 0; i < 5; i++) await store.append(evt("x", i));
      expect((await readRangeOf(store, "x", 1, 3)).map((e) => e.sequence)).toEqual([1, 2, 3]);
      await store.close();
    });

    // ── uniqueness (#306) ────────────────────────────────────────────────────
    //
    // The clause the contract was missing, which is why a backend could omit the check and
    // still "conform": SQLite and Postgres enforce `UNIQUE (execution_id, sequence)`, the
    // reference in-memory store used to accept both writes and interleave them. Two
    // unfenced writers recovering the same execution allocate the SAME next sequence
    // (`ExecutionJournal` seeds from folded state and increments in-process), so this is
    // reachable without either writer being a fenced-out zombie.
    //
    // Note the DISTINCT envelope ids: the SQL backends also key `id`, and reusing one would
    // pass this test against the wrong constraint.
    it("rejects a second envelope claiming an occupied (executionId, sequence)", async () => {
      const store = factory();
      await store.append(evt("u", 0));
      await expect(
        store.append({ ...evt("u", 0), id: "u-0-second", payload: { intruder: true } })
      ).rejects.toThrow(DuplicateSequenceError);
      // Rejected, not merely reported: the winner is intact and alone.
      const read = await store.read("u");
      expect(read).toHaveLength(1);
      expect(read[0]?.id).toBe("u-0");
      await store.close();
    });

    it("appendBatch (if implemented) rejects a duplicate against the log, atomically", async () => {
      const store = factory();
      if (store.appendBatch === undefined) return void (await store.close());
      await store.append(evt("ub", 0));
      await expect(
        store.appendBatch([{ ...evt("ub", 0), id: "ub-0-second" }, evt("ub", 1)])
      ).rejects.toThrow(DuplicateSequenceError);
      // The VALID envelope in the batch must not have landed either.
      expect((await store.read("ub")).map((e) => e.sequence)).toEqual([0]);
      await store.close();
    });

    it("appendBatch (if implemented) rejects a duplicate WITHIN the batch", async () => {
      const store = factory();
      if (store.appendBatch === undefined) return void (await store.close());
      // Neither envelope conflicts with the durable log — only with each other. A backend
      // that validates solely against stored rows passes the case above and fails here.
      await expect(
        store.appendBatch([evt("uc", 0), { ...evt("uc", 0), id: "uc-0-second" }])
      ).rejects.toThrow(DuplicateSequenceError);
      expect(await store.read("uc")).toEqual([]);
      await store.close();
    });

    // The events table's OTHER key (#309), required WITHIN an execution.
    //
    // Cross-execution id uniqueness is deliberately NOT required, for the same reason
    // whole-batch atomicity across executions is not: {@link ShardedEventStore} cannot
    // provide it — separate executions live on separate backing stores, and no shard can
    // see another's ids. A single-log backend (SQLite, Postgres, one in-memory store) gets
    // store-wide uniqueness from its `PRIMARY KEY (id)` and is free to be stricter; a
    // caller must not depend on it.
    it("rejects a second envelope re-using an id within an execution", async () => {
      const store = factory();
      await store.append(evt("v", 0));
      await expect(store.append({ ...evt("v", 1), id: "v-0" })).rejects.toThrow(
        DuplicateEnvelopeIdError
      );
      expect((await store.read("v")).map((e) => e.sequence)).toEqual([0]);
      await store.close();
    });

    it("frees an id when its event is deleted, so the slot can be re-used", async () => {
      const store = factory();
      if (store.deleteExecution === undefined) return void (await store.close());
      await store.append(evt("del", 0));
      await store.deleteExecution("del");
      // The id index must not outlive the events it indexes: an erased execution that
      // cannot be re-created is a leak with a user-visible symptom.
      await expect(store.append(evt("del", 0))).resolves.toBeUndefined();
      expect(await store.read("del")).toHaveLength(1);
      await store.close();
    });

    it("appendBatch (if implemented) rejects a duplicate id WITHIN the batch", async () => {
      const store = factory();
      if (store.appendBatch === undefined) return void (await store.close());
      await expect(
        store.appendBatch([evt("ud", 0), { ...evt("ud", 1), id: "ud-0" }])
      ).rejects.toThrow(DuplicateEnvelopeIdError);
      expect(await store.read("ud")).toEqual([]);
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

    it("listExecutions enumerates distinct executionIds (when supported)", async () => {
      const store = factory();
      if (store.listExecutions === undefined) return; // OPTIONAL (1.1.0)
      await store.append(evt("x", 0));
      await store.append(evt("x", 1)); // same execution, still one id
      await store.append(evt("y", 0));
      const ids = new Set(await store.listExecutions());
      expect(ids.has("x")).toBe(true);
      expect(ids.has("y")).toBe(true);
      expect(ids.size).toBe(2);
      await store.close();
    });

    it("listExecutionsPage walks every id exactly once, lexicographic, bounded pages (when supported)", async () => {
      const store = factory();
      if (store.listExecutionsPage === undefined) {
        await store.close();
        return; // OPTIONAL (1.2.0, SP-1)
      }
      const ids = Array.from({ length: 23 }, (_, i) => `e-${String(i).padStart(2, "0")}`);
      for (const id of ids) await store.append(evt(id, 0));
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await store.listExecutionsPage({
          ...(cursor !== undefined && { cursor }),
          limit: 5,
        });
        expect(page.executionIds.length).toBeLessThanOrEqual(5);
        // A non-final page is never empty: scatter-gather consumers read [] as the end.
        if (page.nextCursor !== undefined) expect(page.executionIds.length).toBeGreaterThan(0);
        seen.push(...page.executionIds);
        if (page.nextCursor === undefined) break;
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(ids); // all, exactly once, lexicographic
      // Paged and whole-list enumerations agree.
      if (store.listExecutions !== undefined) {
        expect(new Set(await store.listExecutions())).toEqual(new Set(seen));
      }
      await store.close();
    });

    // ── appendBatch (OPTIONAL, SPI 1.3.0 / ADR 0074 D1) ──────────────────────
    //
    // These are what make "a bring-your-own backend benefits from the scaling work too" a
    // testable claim rather than an aspiration: implement the hook, run this suite, know
    // you got the contract right. Every case is skipped when the method is absent.

    it("appendBatch (if implemented) is equivalent to N sequential appends", async () => {
      const store = factory();
      if (store.appendBatch === undefined) return void (await store.close());
      await store.appendBatch([evt("b", 0, "EXECUTION_STARTED"), evt("b", 1), evt("b", 2)]);
      const read = await store.read("b");
      expect(read.map((e) => e.sequence)).toEqual([0, 1, 2]);
      expect(read.map((e) => e.eventType)).toEqual([
        "EXECUTION_STARTED",
        "STEP_COMPLETED",
        "STEP_COMPLETED",
      ]);
      await store.close();
    });

    it("appendBatch (if implemented) spans executions — the coalescer's actual shape", async () => {
      const store = factory();
      if (store.appendBatch === undefined) return void (await store.close());
      // A cross-execution batch is what CoalescingEventStore produces; a backend that only
      // handles same-execution batches would pass the test above and fail here.
      await store.appendBatch([evt("m", 0), evt("n", 0), evt("m", 1), evt("n", 1)]);
      expect((await store.read("m")).map((e) => e.sequence)).toEqual([0, 1]);
      expect((await store.read("n")).map((e) => e.sequence)).toEqual([0, 1]);
      await store.close();
    });

    it("appendBatch (if implemented) treats empty input as a no-op", async () => {
      const store = factory();
      if (store.appendBatch === undefined) return void (await store.close());
      await expect(store.appendBatch([])).resolves.toBeUndefined();
      await store.close();
    });

    it("appendBatch (if implemented) is atomic PER EXECUTION — no holes in one log", async () => {
      const store = factory();
      if (store.appendBatch === undefined || store.acquireFence === undefined) {
        return void (await store.close());
      }
      // Fence "f" forward, then batch a VALID envelope (carrying the token) with an
      // INVALID one (missing it) for the SAME execution. Per-execution atomicity means
      // neither may land: committing only the second would leave sequence 1 durable with
      // sequence 0 missing — a hole no fold expects.
      const fence = await store.acquireFence("f");
      await expect(
        store.appendBatch([{ ...evt("f", 0), metadata: { fence } }, evt("f", 1)])
      ).rejects.toThrow();
      expect(await store.read("f")).toEqual([]);
      await store.close();
    });

    it("appendBatch (if implemented) honours fencing per envelope", async () => {
      const store = factory();
      if (store.appendBatch === undefined || store.acquireFence === undefined) {
        return void (await store.close());
      }
      const fence = await store.acquireFence("f");
      // Carrying the current token, the batch lands; the fence is per envelope, so an
      // unfenced execution in the same batch is unaffected.
      await store.appendBatch([{ ...evt("f", 0), metadata: { fence } }, evt("unfenced", 0)]);
      expect((await store.read("f")).map((e) => e.sequence)).toEqual([0]);
      expect((await store.read("unfenced")).map((e) => e.sequence)).toEqual([0]);
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
/**
 * The portable {@link LeaseStore} contract (#380). Ownership with an expiry is the fact the log
 * cannot hold — so the cases below are about the two answers that matter to a caller: *who has
 * it* and *have I lost it*, at a clock the test controls.
 */
export function runLeaseStoreConformance(factory: () => LeaseStore, label = "LeaseStore"): void {
  describe(`${label} conformance (LeaseStore SPI)`, () => {
    it("grants a free lease and refuses one another owner already holds", async () => {
      const store = factory();
      expect(await store.acquire("x", "node-a", 1000, 0)).toMatchObject({
        executionId: "x",
        owner: "node-a",
        expiresAt: 1000,
      });
      // The `null` that is the whole point: only one node should run this execution.
      expect(await store.acquire("x", "node-b", 1000, 100)).toBeNull();
      // A different execution is unaffected — leases are per execution, not a global lock.
      expect(await store.acquire("y", "node-b", 1000, 100)).not.toBeNull();
      await store.close();
    });

    it("lets the holder re-acquire — restarting your own work is not a conflict", async () => {
      const store = factory();
      await store.acquire("x", "node-a", 1000, 0);
      const again = await store.acquire("x", "node-a", 1000, 500);
      expect(again).toMatchObject({ owner: "node-a", expiresAt: 1500 });
      await store.close();
    });

    it("hands an EXPIRED lease to whoever asks next", async () => {
      const store = factory();
      await store.acquire("x", "node-a", 1000, 0);
      expect(await store.acquire("x", "node-b", 1000, 999)).toBeNull(); // not yet
      expect(await store.acquire("x", "node-b", 1000, 1001)).toMatchObject({ owner: "node-b" });
      await store.close();
    });

    it("renew extends for the holder and FAILS once ownership is lost", async () => {
      const store = factory();
      await store.acquire("x", "node-a", 1000, 0);
      expect(await store.renew("x", "node-a", 1000, 500)).toBe(true);
      expect(await store.renew("x", "node-b", 1000, 500)).toBe(false); // never a steal
      expect(await store.renew("ghost", "node-a", 1000, 500)).toBe(false);

      // Taken over after expiry: the old owner must learn it is no longer alive, because a
      // caller that keeps working on `true` is the split brain this exists to surface.
      await store.acquire("x", "node-b", 1000, 2000);
      expect(await store.renew("x", "node-a", 1000, 2100)).toBe(false);
      await store.close();
    });

    it("expired() reports what stopped saying it was alive, soonest first", async () => {
      const store = factory();
      await store.acquire("late", "n", 1000, 0);
      await store.acquire("early", "n", 100, 0);
      await store.acquire("alive", "n", 10_000, 0);

      const dead = await store.expired(2000);
      expect(dead.map((l) => l.executionId)).toEqual(["early", "late"]);
      expect(await store.expired(50)).toEqual([]);
      expect((await store.expired(2000, 1)).map((l) => l.executionId)).toEqual(["early"]);
      await store.close();
    });

    it("release frees it for the holder and is a no-op for anyone else", async () => {
      const store = factory();
      await store.acquire("x", "node-a", 1000, 0);
      await store.release("x", "node-b"); // not yours
      expect(await store.acquire("x", "node-b", 1000, 100)).toBeNull();

      await store.release("x", "node-a");
      expect(await store.acquire("x", "node-b", 1000, 100)).not.toBeNull();
      await store.release("ghost", "node-a"); // no throw
      await store.close();
    });

    it("get reads the current lease, including an expired one (optional; skipped if absent)", async () => {
      const store = factory();
      if (store.get === undefined) return void (await store.close());
      expect(await store.get("x")).toBeNull();

      await store.acquire("x", "node-a", 1000, 0);
      expect(await store.get("x")).toMatchObject({ owner: "node-a", expiresAt: 1000 });

      // An EXPIRED lease is still a lease: `null` must mean "nothing ever held this", because
      // a census counts those separately — one is unwatched, the other is collectable.
      expect(await store.get("x")).not.toBeNull();
      await store.release("x", "node-a");
      expect(await store.get("x")).toBeNull();
      await store.close();
    });

    it("refuses a TTL that would expire on arrival", async () => {
      const store = factory();
      await expect(store.acquire("x", "n", 0, 0)).rejects.toThrow(/positive/);
      await expect(store.acquire("x", "n", -1, 0)).rejects.toThrow(/positive/);
      await expect(store.renew("x", "n", 0, 0)).rejects.toThrow(/positive/);
      await store.close();
    });
  });
}

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

    it("promote with `expect` is a compare-and-set: the loser is refused, not applied", async () => {
      // Two nodes promoting different winners onto `main` both "succeed" without this —
      // last write wins and the losing branch silently becomes what main names.
      const reg = factory();
      await reg.putRef(ref("cand-a", "execA", 3));
      await reg.putRef(ref("cand-b", "execB", 4));

      // `expect: null` means "must not exist yet" — the first promotion creates it.
      await reg.promote("cand-a", "main", { expect: null });
      expect((await reg.getRef("main"))?.executionId).toBe("execA");

      // A second node still believes main names nothing. It loses, and NOTHING moves.
      await expect(reg.promote("cand-b", "main", { expect: null })).rejects.toMatchObject({
        name: "BranchPromotionConflictError",
      });
      expect((await reg.getRef("main"))?.executionId).toBe("execA");

      // A stale expectation loses the same way.
      await expect(reg.promote("cand-b", "main", { expect: "execGone" })).rejects.toMatchObject({
        name: "BranchPromotionConflictError",
      });
      expect((await reg.getRef("main"))?.executionId).toBe("execA");

      // The current holder's expectation wins.
      await reg.promote("cand-b", "main", { expect: "execA" });
      expect((await reg.getRef("main"))?.executionId).toBe("execB");
      expect((await reg.getRef("main"))?.tip).toBe(4);

      // And omitting `expect` keeps the 1.0.0 last-write-wins behaviour.
      await reg.promote("cand-a", "main");
      expect((await reg.getRef("main"))?.executionId).toBe("execA");
      await reg.close();
    });

    it("listRefs pages by keyset and refuses a nonsense limit", async () => {
      const reg = factory();
      for (const n of ["a", "b", "c", "d"]) await reg.putRef(ref(n, `exec-${n}`, 1));

      expect((await reg.listRefs({ limit: 2 })).map((r) => r.name)).toEqual(["a", "b"]);
      expect((await reg.listRefs({ limit: 2, after: "b" })).map((r) => r.name)).toEqual(["c", "d"]);
      expect((await reg.listRefs({ after: "d" })).map((r) => r.name)).toEqual([]);
      // Unpaged stays unpaged — the 1.0.0 call is unchanged.
      expect((await reg.listRefs()).map((r) => r.name)).toEqual(["a", "b", "c", "d"]);

      // `LIMIT -1` is SQLite for "no limit": an unvalidated negative would hand back the
      // whole table to a caller that asked for one row.
      await expect(reg.listRefs({ limit: 0 })).rejects.toThrow(/positive integer/);
      await expect(reg.listRefs({ limit: -1 })).rejects.toThrow(/positive integer/);
      await expect(reg.listRefs({ limit: 1.5 })).rejects.toThrow(/positive integer/);
      await reg.close();
    });

    it("deleteRef removes a ref", async () => {
      const reg = factory();
      await reg.putRef(ref("tmp", "execA", 1));
      await reg.deleteRef("tmp");
      expect(await reg.getRef("tmp")).toBeNull();
      await reg.close();
    });

    it("removeLineage forgets one edge and leaves its siblings (optional; skipped if absent)", async () => {
      const reg = factory();
      if (reg.removeLineage === undefined) return void (await reg.close());
      await reg.recordLineage({ executionId: "kidA", parentExecutionId: "mum", forkSequence: 1 });
      await reg.recordLineage({ executionId: "kidB", parentExecutionId: "mum", forkSequence: 2 });

      await reg.removeLineage("kidA");
      expect(await reg.getLineage("kidA")).toBeNull();
      expect((await reg.children("mum")).map((c) => c.executionId)).toEqual(["kidB"]);

      // Forgetting an edge that is not there is a no-op, not an error: retention deletes
      // executions that may never have been forked.
      await reg.removeLineage("kidA");
      await reg.removeLineage("never-existed");
      expect((await reg.children("mum")).map((c) => c.executionId)).toEqual(["kidB"]);
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

/**
 * Prove a {@link TimerStore} (T1 durable timers) conforms: idempotent scheduling,
 * soonest-first due ordering with a limit, and completion semantics.
 */
export function runTimerStoreConformance(factory: () => TimerStore, label = "TimerStore"): void {
  describe(`${label} conformance (TimerStore SPI)`, () => {
    it("schedule + due returns due timers soonest-first", async () => {
      const s = factory();
      await s.schedule({ executionId: "b", wakeAt: 200 });
      await s.schedule({ executionId: "a", wakeAt: 100 });
      await s.schedule({ executionId: "c", wakeAt: 900 });
      expect(await s.due(500)).toEqual([
        { executionId: "a", wakeAt: 100 },
        { executionId: "b", wakeAt: 200 },
      ]);
      await s.close();
    });

    it("schedule is idempotent per (executionId, wakeAt)", async () => {
      const s = factory();
      await s.schedule({ executionId: "a", wakeAt: 100 });
      await s.schedule({ executionId: "a", wakeAt: 100 });
      expect((await s.due(500)).length).toBe(1);
      await s.close();
    });

    it("due excludes not-yet-due timers and respects the limit", async () => {
      const s = factory();
      for (let i = 0; i < 5; i++) await s.schedule({ executionId: `e${i}`, wakeAt: i });
      await s.schedule({ executionId: "future", wakeAt: 10_000 });
      const due: TimerRecord[] = await s.due(100, 3);
      expect(due.length).toBe(3);
      expect(due.every((t) => t.wakeAt <= 100)).toBe(true);
      await s.close();
    });

    it("complete removes a fired timer; unknown timers are a no-op", async () => {
      const s = factory();
      await s.schedule({ executionId: "a", wakeAt: 100 });
      await s.complete("a", 100);
      expect(await s.due(500)).toEqual([]);
      await expect(s.complete("nope", 1)).resolves.toBeUndefined();
      await s.close();
    });
  });
}

/**
 * Prove a {@link ProjectionRuntime} conforms: per-execution folding of matching
 * events, initial state before any events, live subscribe/unsubscribe, and
 * `seedState`. Drives a small counter projection.
 */
export function runProjectionRuntimeConformance(
  factory: () => ProjectionRuntime,
  label = "ProjectionRuntime"
): void {
  const counter: Projection<{ n: number }> = {
    id: "counter",
    initialState: { n: 0 },
    handlers: {
      TICK: (s, e) => ({ n: s.n + ((e.payload as { by?: number }).by ?? 1) }),
    },
  };
  const tick = (executionId: string, by: number, sequence: number): EventEnvelope => ({
    id: `evt-${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType: "TICK",
    sequence,
    timestamp: 0,
    payload: { by },
  });

  describe(`${label} conformance (ProjectionRuntime SPI)`, () => {
    it("getState returns the initial state before any events", () => {
      const r = factory();
      r.register(counter);
      expect(r.getState("counter", "x")).toEqual({ n: 0 });
    });

    it("handleEvent folds matching events per execution", () => {
      const r = factory();
      r.register(counter);
      r.handleEvent(tick("x", 2, 1));
      r.handleEvent(tick("x", 3, 2));
      r.handleEvent(tick("y", 5, 1));
      expect(r.getState("counter", "x")).toEqual({ n: 5 });
      expect(r.getState("counter", "y")).toEqual({ n: 5 });
    });

    it("subscribe fires on change; unsubscribe stops delivery", () => {
      const r = factory();
      r.register(counter);
      const seen: number[] = [];
      const unsub = r.subscribe<{ n: number }>("counter", "x", (s) => seen.push(s.n));
      r.handleEvent(tick("x", 1, 1));
      unsub();
      r.handleEvent(tick("x", 1, 2));
      expect(seen).toContain(1);
      expect(seen).not.toContain(2);
    });

    it("seedState sets state directly", () => {
      const r = factory();
      r.register(counter);
      r.seedState("counter", "x", { n: 42 });
      expect(r.getState("counter", "x")).toEqual({ n: 42 });
    });

    it("an unhandled event type leaves state unchanged", () => {
      const r = factory();
      r.register(counter);
      r.handleEvent({ ...tick("x", 1, 1), eventType: "OTHER" });
      expect(r.getState("counter", "x")).toEqual({ n: 0 });
    });
  });
}

/**
 * Prove a {@link WorkerRuntime} conforms: `allocate` yields a lease, `execute` runs a
 * package to a terminal status echoing the executionId, and `release` is safe. Because
 * `execute` needs a runnable package, the factory returns a worker AND a package it can
 * run (fresh per case, so their flow ids match).
 */
export function runWorkerRuntimeConformance(
  factory: () => { worker: WorkerRuntime; pkg: ExecutionPackage },
  label = "WorkerRuntime"
): void {
  describe(`${label} conformance (WorkerRuntime SPI)`, () => {
    it("allocate → execute → release runs a package to a terminal status", async () => {
      const { worker, pkg } = factory();
      const lease = await worker.allocate({ executionId: pkg.executionId });
      expect(typeof lease.leaseId).toBe("string");
      const result = await worker.execute(lease, pkg);
      expect(result.executionId).toBe(pkg.executionId);
      expect(["completed", "suspended", "failed"]).toContain(result.status);
      expect(result.lastSequence).toBeGreaterThanOrEqual(0);
      await expect(worker.release(lease)).resolves.toBeUndefined();
    });
  });
}

/**
 * Prove an {@link LlmProvider} conforms: `complete` returns `content` + a valid
 * `stopReason`; `stream` (when supported) yields chunks terminated by `done` AND
 * assembles to the same outcome `complete` returns.
 *
 * **The parity contract (R8).** A streamed result MUST equal the completed one —
 * the same discipline ADR 0059 D1 applies to content ("the streamed address ≡ the
 * whole-buffer address"), for the model call. Without it the two paths drift, and
 * the drift shows up as an agent that behaves differently once streaming is
 * switched on: a `stream` that reports no `toolCalls` turns a tool-using turn into
 * a text answer, and one that reports no `usage` meters nothing.
 *
 * The outcome fields stay OPTIONAL, so a text-only streaming provider still
 * conforms. What is checked is honesty: whatever IS reported must match. Note this
 * requires a provider that answers the same request the same way — true of the
 * offline fakes this suite is meant to be run against, not of a live model at
 * temperature.
 */
export function runLlmProviderConformance(factory: () => LlmProvider, label = "LlmProvider"): void {
  const req = { messages: [{ role: "user" as const, content: "hi" }] };
  describe(`${label} conformance (LlmProvider SPI)`, () => {
    it("complete returns content and a valid stopReason", async () => {
      const res = await factory().complete(req);
      expect(typeof res.content).toBe("string");
      expect(["end_turn", "tool_use", "max_tokens"]).toContain(res.stopReason);
    });

    it("stream (when supported) yields chunks ending with done:true", async () => {
      const provider = factory();
      if (provider.stream === undefined) return;
      const chunks: LlmStreamChunk[] = [];
      for await (const c of provider.stream(req)) chunks.push(c);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[chunks.length - 1]?.done).toBe(true);
    });

    it("stream terminates exactly once, and only at the end", async () => {
      // `assembleStream` refuses anything else, so a provider that ends twice (or
      // early) would fail at the point of use rather than here.
      const provider = factory();
      if (provider.stream === undefined) return;
      const chunks: LlmStreamChunk[] = [];
      for await (const c of provider.stream(req)) chunks.push(c);
      expect(chunks.filter((c) => c.done)).toHaveLength(1);
      expect(() => assembleStream(chunks)).not.toThrow();
    });

    it("a streamed result equals the completed one (parity)", async () => {
      const provider = factory();
      if (provider.stream === undefined) return;
      const completed = await provider.complete(req);
      const chunks: LlmStreamChunk[] = [];
      for await (const c of provider.stream(req)) chunks.push(c);
      const streamed = assembleStream(chunks);

      // Content is the whole point of streaming: concatenated deltas must be the
      // same text the completed call returned.
      expect(streamed.content).toBe(completed.content);

      // The outcome fields are checked only where the stream reports them —
      // absent means "not reported", which is allowed; a DIFFERENT value is not.
      if (streamed.stopReason !== undefined && chunks.some((c) => c.stopReason !== undefined)) {
        expect(streamed.stopReason).toBe(completed.stopReason);
      }
      if (streamed.toolCalls !== undefined) {
        expect(streamed.toolCalls).toEqual(completed.toolCalls);
      }
      if (streamed.usage !== undefined) {
        expect(streamed.usage).toEqual(completed.usage);
      }
    });
  });
}

/**
 * Prove a {@link CapabilityAuthorizer} conforms: `authorize` returns a boolean decision,
 * deterministically for a given request, and a denial's `reason` (if any) is a string.
 * (Policy content is the plugin's — the kit pins the *shape* and determinism.)
 */
/**
 * `ExecutionAuthorizer` — gates the execution LIFECYCLE (C.1), where `CapabilityAuthorizer`
 * gates effects. Wired as `security.executionAuthorizer`.
 *
 * The kit is about the contract a caller relies on, not about any policy: a verdict is
 * SYNCHRONOUS (it runs at the entry of start/resume/cancel/query, before anything is
 * appended), deterministic for one request, and must answer for EVERY op — an authorizer
 * that silently allows an op it did not consider is the failure mode worth catching, since
 * `cancel` and `query` are the two people forget.
 */
export function runExecutionAuthorizerConformance(
  factory: () => ExecutionAuthorizerLike,
  label = "ExecutionAuthorizer"
): void {
  const OPS: ExecutionOpLike[] = ["start", "resume", "cancel", "query"];
  const req = (op: ExecutionOpLike): ExecutionAuthzRequestLike => ({
    op,
    executionId: "e",
    workflowId: "w",
  });
  describe(`${label} conformance (ExecutionAuthorizer SPI)`, () => {
    it("answers every lifecycle op with a boolean decision", () => {
      const a = factory();
      for (const op of OPS) {
        const verdict = a.authorize(req(op));
        expect(typeof verdict.allowed, `op "${op}" returned no boolean decision`).toBe("boolean");
      }
    });

    it("is deterministic for the same request", () => {
      const a = factory();
      for (const op of OPS) {
        expect(a.authorize(req(op)).allowed).toBe(a.authorize(req(op)).allowed);
      }
    });

    it("returns synchronously — the verdict is read before anything is appended", () => {
      const verdict = factory().authorize(req("start")) as unknown;
      expect(verdict).not.toBeInstanceOf(Promise);
      expect(typeof (verdict as { then?: unknown }).then).not.toBe("function");
    });

    it("a denial's reason, when present, is a string", () => {
      for (const op of OPS) {
        const d = factory().authorize(req(op));
        if (!d.allowed && d.reason !== undefined) expect(typeof d.reason).toBe("string");
      }
    });

    it("decides on the request alone — a missing principal is a policy choice, not a crash", () => {
      // `principal` is optional on the request, and the SPI doc says the policy decides how
      // to treat its absence. Deciding is fine; throwing is not — the caller has no verdict
      // to act on, and the lifecycle op fails for a reason that is not an authz decision.
      expect(() => factory().authorize(req("resume"))).not.toThrow();
    });
  });
}

/**
 * `TimerDispatcher` — where a due wake RUNS (#392). Wired as `timers.dispatcher`.
 *
 * One method, and the contract is about what it must tolerate rather than what it must do.
 * A timer service calls this for an execution whose original lane may no longer exist — a
 * node is often recovering an execution precisely BECAUSE its lane went away — so a target
 * hint is a HINT: an unknown one must fall back, never strand the wake. And the resume event
 * must be passed through untouched, because the kernel decides the vocabulary (K7.5), not
 * the transport.
 */
export function runTimerDispatcherConformance(
  factory: () => TimerDispatcherLike,
  label = "TimerDispatcher"
): void {
  const pkg = () => ({
    executionId: "e1",
    workflowId: "wf",
    flowId: "wf",
    resumeEvent: { eventType: "TIMER_FIRED", payload: { wakeAt: 1 } },
  });
  describe(`${label} conformance (TimerDispatcher SPI)`, () => {
    it("dispatch returns a promise", async () => {
      await expect(Promise.resolve(factory().dispatch(pkg()))).resolves.not.toThrow();
    });

    it("accepts a wake with no target — placement is optional", async () => {
      await factory().dispatch(pkg());
    });

    it("does not strand a wake whose target it does not know", async () => {
      // The recorded target is a hint that can outlive the lane that produced it. A
      // dispatcher that rejects an unknown target leaves the execution suspended forever,
      // which is strictly worse than running it somewhere else.
      await factory().dispatch(pkg(), { target: "a-lane-that-was-retired" });
    });

    it("carries the resume event through unchanged", async () => {
      // Whatever the transport does, it may not reinterpret the event: the kernel owns the
      // resume vocabulary, and a dispatcher that rewrites it changes what the log records.
      const seen: unknown[] = [];
      const dispatcher = factory();
      const original = pkg();
      await dispatcher.dispatch(original);
      seen.push(original.resumeEvent);
      expect(original.resumeEvent).toEqual({ eventType: "TIMER_FIRED", payload: { wakeAt: 1 } });
    });
  });
}

/**
 * `ResumeAuthenticator` — may this event REOPEN a suspended execution (K12.2)?
 *
 * The narrowest of the three authority rings, and the one an attacker reaches first: a resume
 * arrives from OUTSIDE the process, where an effect call and a lifecycle call do not.
 *
 * The verdict has three statuses, and the third is the one to get right. `not-applicable`
 * means *this event is not mine to judge* — the runtime treats it as no opinion and lets the
 * resume proceed. It is emphatically NOT a soft denial: an authenticator that returns it for
 * an event it wanted to refuse has allowed that event. Only `rejected` refuses, and it must
 * carry a reason, because `ApprovalRejectedError` surfaces that reason to the caller.
 *
 * So the kit checks the verdict is one of the three and correctly shaped, and that it is
 * deterministic — a verifier that changes its mind about one event cannot be reasoned about.
 * It does NOT assert a policy: which events you govern is yours to decide.
 */
export function runResumeAuthenticatorConformance(
  factory: () => ResumeAuthenticatorLike,
  label = "ResumeAuthenticator"
): void {
  const event = (eventType: string): ResumeEventLike => ({ eventType, payload: {} });
  const CASES = ["Approved", "__not-a-declared-gate__"];
  describe(`${label} conformance (ResumeAuthenticator SPI)`, () => {
    it("returns one of the three statuses for any event", () => {
      const a = factory();
      for (const type of CASES) {
        expect(["verified", "rejected", "not-applicable"]).toContain(a.verify(event(type)).status);
      }
    });

    it("is deterministic for the same event", () => {
      const a = factory();
      for (const type of CASES) {
        expect(a.verify(event(type)).status).toBe(a.verify(event(type)).status);
      }
    });

    it("a rejection carries a reason — the caller surfaces it", () => {
      // ApprovalRejectedError puts this reason in front of whoever tried to resume. A
      // rejection with an empty reason tells them only that something refused them.
      const a = factory();
      for (const type of CASES) {
        const verdict = a.verify(event(type));
        if (verdict.status === "rejected") {
          expect(typeof verdict.reason).toBe("string");
          expect(verdict.reason.length).toBeGreaterThan(0);
        }
      }
    });

    it("a verification names both the actor and what verified them", () => {
      const a = factory();
      for (const type of CASES) {
        const verdict = a.verify(event(type));
        if (verdict.status === "verified") {
          expect(typeof verdict.actor).toBe("string");
          expect(typeof verdict.verifiedBy).toBe("string");
        }
      }
    });
  });
}

export function runCapabilityAuthorizerConformance(
  factory: () => CapabilityAuthorizer,
  label = "CapabilityAuthorizer"
): void {
  const req: CapabilityRequest = { toolId: "t", executionId: "e", workflowId: "w", stepId: "s" };
  describe(`${label} conformance (CapabilityAuthorizer SPI)`, () => {
    it("authorize returns a boolean decision", () => {
      expect(typeof factory().authorize(req).allowed).toBe("boolean");
    });

    it("authorize is deterministic for the same request", () => {
      const a = factory();
      expect(a.authorize(req).allowed).toBe(a.authorize(req).allowed);
    });

    it("a denial's reason, when present, is a string", () => {
      const d = factory().authorize(req);
      if (!d.allowed && d.reason !== undefined) expect(typeof d.reason).toBe("string");
    });
  });
}

// ── KeyStore (K10.2 crypto-shredding SPI) ─────────────────────────────────────
//
// Not a kernel seam — it is the crypto plugin's SPI — but the erasure contract is
// security-critical, so the kit ships here (with a structural type, so `@loom/conformance`
// stays free of any plugin dependency). Call it from a KeyStore impl's test suite.

/** Structural view of the crypto-plugin KeyStore SPI (avoids a plugin dependency). */
export interface KeyStoreLike {
  /** See `KeyStore.durable` — declared, because losing a key erases the subject. */
  readonly durable?: boolean;
  getOrCreate(subjectId: string): Promise<Uint8Array>;
  get(subjectId: string): Promise<Uint8Array | null>;
  destroy(subjectId: string): Promise<void>;
}

/**
 * Assert a KeyStore implementation upholds the erasure contract: stable keys,
 * create-on-first-use, distinct keys per subject, and — the security-critical invariant —
 * a destroyed key is gone forever and can never be resurrected.
 */
export function runKeyStoreConformance(factory: () => KeyStoreLike, label = "KeyStore"): void {
  const eq = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

  describe(`${label} conformance (KeyStore SPI, K10.2)`, () => {
    it("says whether it survives a restart, if it says anything", () => {
      // `durable` is optional on the SPI, so absence is allowed here and reported by
      // `loom doctor` as an advisory — the honest handling for a question only the author
      // can answer. What is NOT allowed is answering it with something other than a boolean.
      const declared = factory().durable;
      if (declared !== undefined) expect(typeof declared).toBe("boolean");
    });

    it("getOrCreate returns a stable key for a subject", async () => {
      const store = factory();
      expect(eq(await store.getOrCreate("s1"), await store.getOrCreate("s1"))).toBe(true);
    });

    it("distinct subjects get distinct keys", async () => {
      const store = factory();
      expect(eq(await store.getOrCreate("s1"), await store.getOrCreate("s2"))).toBe(false);
    });

    it("get returns null before creation and the key after", async () => {
      const store = factory();
      expect(await store.get("s1")).toBeNull();
      const created = await store.getOrCreate("s1");
      const got = await store.get("s1");
      expect(got).not.toBeNull();
      expect(eq(got as Uint8Array, created)).toBe(true);
    });

    it("destroy makes the key unrecoverable (get → null)", async () => {
      const store = factory();
      await store.getOrCreate("s1");
      await store.destroy("s1");
      expect(await store.get("s1")).toBeNull();
    });

    it("a destroyed key can NEVER be resurrected (the erasure invariant)", async () => {
      const store = factory();
      await store.getOrCreate("s1");
      await store.destroy("s1");
      // getOrCreate may throw or yield, but get() MUST still report the subject as erased —
      // resurrecting the same key would defeat crypto-shredding.
      await store.getOrCreate("s1").catch(() => undefined);
      expect(await store.get("s1")).toBeNull();
    });

    it("destroy is idempotent and destroying an unknown subject is a no-op", async () => {
      const store = factory();
      await store.destroy("never-existed");
      await store.getOrCreate("s1");
      await store.destroy("s1");
      await store.destroy("s1");
      expect(await store.get("s1")).toBeNull();
    });
  });
}

// ── ContentStore (ADR 0046 content-store SPI) ─────────────────────────────────
//
// Not a kernel seam — it is the content plugin's SPI — but the contract (content-addressed,
// idempotent, loud-free absence) is worth pinning. Structural type so `@loom/conformance`
// stays free of any plugin dependency. Call from a ContentStore impl's test suite.

/** Structural view of the content-store SPI (avoids a plugin dependency). */
export interface ContentStoreLike {
  put(bytes: Uint8Array): Promise<{ __loomContent: string }>;
  /** OPTIONAL (ST-1, SPI streaming): content-addressed streaming ingestion. */
  putStream?(stream: AsyncIterable<Uint8Array>): Promise<{ __loomContent: string }>;
  get(ref: { __loomContent: string }): Promise<Uint8Array | null>;
  /** OPTIONAL (TS-10, ADR 0062): batched get — positional, null-on-absence. */
  getMany?(refs: readonly { __loomContent: string }[]): Promise<(Uint8Array | null)[]>;
  delete(ref: { __loomContent: string }): Promise<void>;
}

/**
 * Assert a ContentStore implementation upholds the ADR-0046 contract: content-addressed +
 * idempotent puts (identical bytes → same ref, stored once), faithful round-trip, `get`
 * returns `null` (never throws) on absence, and `delete` is idempotent physical erasure.
 */
export function runContentStoreConformance(
  factory: () => ContentStoreLike,
  label = "ContentStore"
): void {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
  const eq = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

  describe(`${label} conformance (ContentStore SPI, ADR 0046)`, () => {
    it("round-trips stored bytes", async () => {
      const store = factory();
      const ref = await store.put(bytes("hello"));
      const got = await store.get(ref);
      expect(got).not.toBeNull();
      expect(eq(got as Uint8Array, bytes("hello"))).toBe(true);
    });

    it("is content-addressed: identical bytes yield the same ref (idempotent)", async () => {
      const store = factory();
      const a = await store.put(bytes("same"));
      const b = await store.put(bytes("same"));
      expect(a.__loomContent).toBe(b.__loomContent);
    });

    it("distinct bytes yield distinct refs", async () => {
      const store = factory();
      const a = await store.put(bytes("a"));
      const b = await store.put(bytes("b"));
      expect(a.__loomContent).not.toBe(b.__loomContent);
    });

    it("get returns null (never throws) for an absent ref", async () => {
      const store = factory();
      expect(await store.get({ __loomContent: "sha256:deadbeef" })).toBeNull();
    });

    it("delete physically erases; a subsequent get is null and delete is idempotent", async () => {
      const store = factory();
      const ref = await store.put(bytes("erase-me"));
      await store.delete(ref);
      expect(await store.get(ref)).toBeNull();
      await store.delete(ref); // idempotent — must not throw
    });

    it("putStream addresses the streamed sequence exactly like put(concat) (when supported)", async () => {
      const store = factory();
      if (store.putStream === undefined) return; // OPTIONAL (ST-1, ADR 0059)
      const text = "streamed-content-".repeat(64);
      async function* chunks(): AsyncGenerator<Uint8Array> {
        const all = bytes(text);
        for (let i = 0; i < all.length; i += 13) yield all.slice(i, i + 13);
      }
      const streamed = await store.putStream(chunks());
      const whole = await store.put(bytes(text));
      expect(streamed.__loomContent).toBe(whole.__loomContent); // identical address
      const got = await store.get(streamed);
      expect(eq(got as Uint8Array, bytes(text))).toBe(true); // faithful round-trip
      const again = await store.putStream(chunks());
      expect(again.__loomContent).toBe(streamed.__loomContent); // idempotent by address
    });

    it("getMany is element-wise get: positional, null holes, duplicates identical (when supported)", async () => {
      const store = factory();
      if (store.getMany === undefined) return; // OPTIONAL (TS-10, ADR 0062)
      const a = await store.put(bytes("alpha"));
      const b = await store.put(bytes("beta"));
      const absent = { __loomContent: "sha256:deadbeef" };

      expect(await store.getMany([])).toEqual([]);

      const results = await store.getMany([a, absent, b, a]);
      expect(results).toHaveLength(4);
      expect(eq(results[0] as Uint8Array, bytes("alpha"))).toBe(true);
      expect(results[1]).toBeNull(); // absent → null hole, never a throw
      expect(eq(results[2] as Uint8Array, bytes("beta"))).toBe(true);
      expect(eq(results[3] as Uint8Array, bytes("alpha"))).toBe(true); // duplicate resolves identically

      // Element-wise agreement with get.
      for (const [i, ref] of [a, absent, b].entries()) {
        const single = await store.get(ref);
        const batched = (await store.getMany([a, absent, b]))[i] ?? null;
        expect(batched === null ? null : [...(batched as Uint8Array)]).toEqual(
          single === null ? null : [...single]
        );
      }
    });
  });
}

// ── DurableStateStore (ADR 0051 D2 durable-state SPI) ─────────────────────────
//
// The `@loom/plugin-durable-state` backend contract: a dumb keyed CAS store.
// Contract knowledge (schemas, migrations) lives above the SPI, so conformance
// pins only storage semantics: revisions start at 1 and increment by exactly one,
// `expectedRevision: 0` creates, any mismatch rejects with an error shaped like
// RevisionConflictError (matched structurally — 3P backends may not share the
// class), and `clear` is idempotent. Structural type, same idiom as ContentStore.

/** Structural view of the durable-state store SPI (avoids a plugin dependency). */
export interface DurableStateStoreLike {
  load(
    key: string
  ): Promise<{ contractVersion: number; revision: number; payload: unknown } | null>;
  save(
    key: string,
    value: { contractVersion: number; payload: unknown },
    expectedRevision: number
  ): Promise<{ contractVersion: number; revision: number; payload: unknown }>;
  clear(key: string): Promise<void>;
}

/**
 * Assert a DurableStateStore backend upholds the ADR-0051-D2 contract:
 * compare-and-set revisions (create at 0 → 1, strict +1 increments), loud
 * structured conflicts carrying expected/actual, absence as `null` (never a
 * throw), JSON payload fidelity, per-key isolation, and idempotent `clear`.
 */
export function runDurableStateStoreConformance(
  factory: () => DurableStateStoreLike,
  label = "DurableStateStore"
): void {
  describe(`${label} conformance (DurableStateStore SPI, ADR 0051 D2)`, () => {
    it("load returns null (never throws) for an absent key", async () => {
      const store = factory();
      expect(await store.load("absent")).toBeNull();
    });

    it("save with expectedRevision 0 creates at revision 1 and round-trips", async () => {
      const store = factory();
      const saved = await store.save("k", { contractVersion: 2, payload: { n: 1 } }, 0);
      expect(saved.revision).toBe(1);
      expect(saved.contractVersion).toBe(2);
      const loaded = await store.load("k");
      expect(loaded).toEqual({ contractVersion: 2, revision: 1, payload: { n: 1 } });
    });

    it("CAS increments by exactly one per successful save", async () => {
      const store = factory();
      await store.save("k", { contractVersion: 1, payload: { n: 1 } }, 0);
      const second = await store.save("k", { contractVersion: 1, payload: { n: 2 } }, 1);
      expect(second.revision).toBe(2);
      expect((await store.load("k"))?.payload).toEqual({ n: 2 });
    });

    it("a stale expectedRevision rejects with a structured conflict and leaves the record intact", async () => {
      const store = factory();
      await store.save("k", { contractVersion: 1, payload: { n: 1 } }, 0);
      await store.save("k", { contractVersion: 1, payload: { n: 2 } }, 1);
      await expect(
        store.save("k", { contractVersion: 1, payload: { n: 99 } }, 1)
      ).rejects.toMatchObject({
        name: "RevisionConflictError",
        expectedRevision: 1,
        actualRevision: 2,
      });
      expect(await store.load("k")).toEqual({ contractVersion: 1, revision: 2, payload: { n: 2 } });
    });

    it("creating an existing key (expectedRevision 0) conflicts", async () => {
      const store = factory();
      await store.save("k", { contractVersion: 1, payload: {} }, 0);
      await expect(store.save("k", { contractVersion: 1, payload: {} }, 0)).rejects.toMatchObject({
        name: "RevisionConflictError",
        actualRevision: 1,
      });
    });

    it("updating an absent key conflicts with actualRevision 0", async () => {
      const store = factory();
      await expect(
        store.save("ghost", { contractVersion: 1, payload: {} }, 3)
      ).rejects.toMatchObject({
        name: "RevisionConflictError",
        expectedRevision: 3,
        actualRevision: 0,
      });
    });

    it("preserves JSON payload fidelity (nesting, arrays, null, numbers, unicode)", async () => {
      const store = factory();
      const payload = {
        nested: { deep: [1, 2.5, null, "χ", { flag: false }] },
        empty: {},
        list: [] as unknown[],
      };
      await store.save("k", { contractVersion: 1, payload }, 0);
      expect((await store.load("k"))?.payload).toEqual(payload);
    });

    it("keys are isolated", async () => {
      const store = factory();
      await store.save("a", { contractVersion: 1, payload: { of: "a" } }, 0);
      await store.save("b", { contractVersion: 1, payload: { of: "b" } }, 0);
      expect((await store.load("a"))?.payload).toEqual({ of: "a" });
      expect((await store.load("b"))?.payload).toEqual({ of: "b" });
    });

    it("clear removes the key, is idempotent, and create works again afterwards", async () => {
      const store = factory();
      await store.save("k", { contractVersion: 1, payload: { n: 1 } }, 0);
      await store.clear("k");
      expect(await store.load("k")).toBeNull();
      await store.clear("k"); // idempotent — must not throw
      const recreated = await store.save("k", { contractVersion: 1, payload: { n: 2 } }, 0);
      expect(recreated.revision).toBe(1);
    });
  });
}

// ── ReadModelStore (RM, db-copilot infra — issue #183) ────────────────────────
//
// The `@loom/plugin-read-model` backend contract: a dumb indexed row store with
// idempotent apply and monotonic per-execution watermarks. Model knowledge
// (kinds, extractors) lives above the SPI, so conformance pins storage
// semantics only. Structural type, same idiom as ContentStore/DurableStateStore.

type RmScalar = string | number | boolean | null;

/** Structural view of the read-model store SPI (avoids a plugin dependency). */
export interface ReadModelStoreLike {
  apply(
    modelId: string,
    executionId: string,
    upToSequence: number,
    rows: readonly {
      rowId: string;
      executionId: string;
      sequence: number;
      timestamp: number;
      kind: string;
      fields: Record<string, RmScalar>;
      value: unknown;
    }[]
  ): Promise<void>;
  watermark(modelId: string, executionId: string): Promise<number | null>;
  watermarkedExecutions(modelId: string): Promise<string[]>;
  query(
    modelId: string,
    q?: {
      kind?: string;
      where?: Record<string, RmScalar>;
      order?: "asc" | "desc";
      limit?: number;
      cursor?: string;
    }
  ): Promise<{ rows: { rowId: string; value: unknown }[]; nextCursor?: string }>;
  /** OPTIONAL (SPI 1.1.0): delete rows by indexed-field equality; returns the count. */
  purge?(modelId: string, where: Record<string, RmScalar>): Promise<number>;
  clear(modelId: string): Promise<void>;
}

/**
 * Assert a ReadModelStore backend upholds the RM contract: idempotent apply
 * (per rowId), monotonic watermarks (never regress), kind + field-equality
 * queries with stable keyset pagination (no duplicates, no gaps, order held
 * across pages), per-model isolation, and idempotent clear of rows AND
 * watermarks.
 */
export function runReadModelStoreConformance(
  factory: () => ReadModelStoreLike,
  label = "ReadModelStore"
): void {
  const row = (
    n: number,
    over: Partial<{
      kind: string;
      fields: Record<string, RmScalar>;
      executionId: string;
      timestamp: number;
    }> = {}
  ) => ({
    rowId: `e-${n}`,
    executionId: over.executionId ?? "x-1",
    sequence: n,
    timestamp: over.timestamp ?? 1_000 + n,
    kind: over.kind ?? "FINDING_RECORDED",
    fields: over.fields ?? { target: "orders" },
    value: { n },
  });

  describe(`${label} conformance (ReadModelStore SPI, RM)`, () => {
    it("apply is idempotent per rowId; re-apply never duplicates", async () => {
      const store = factory();
      await store.apply("m", "x-1", 0, [row(0)]);
      await store.apply("m", "x-1", 0, [row(0)]);
      const page = await store.query("m");
      expect(page.rows).toHaveLength(1);
    });

    it("watermarks advance monotonically and never regress", async () => {
      const store = factory();
      await store.apply("m", "x-1", 5, []);
      await store.apply("m", "x-1", 3, []); // late/duplicate delivery
      expect(await store.watermark("m", "x-1")).toBe(5);
      expect(await store.watermark("m", "ghost")).toBeNull();
      expect(await store.watermarkedExecutions("m")).toEqual(["x-1"]);
    });

    it("queries filter by kind and by field equality (ANDed)", async () => {
      const store = factory();
      await store.apply("m", "x-1", 2, [
        row(0, { fields: { target: "orders", severity: "high" } }),
        row(1, { fields: { target: "orders", severity: "low" } }),
        row(2, { kind: "DECISION_RECORDED", fields: { target: "orders" } }),
      ]);
      expect((await store.query("m", { kind: "FINDING_RECORDED" })).rows).toHaveLength(2);
      expect(
        (await store.query("m", { where: { target: "orders", severity: "high" } })).rows
      ).toHaveLength(1);
      expect((await store.query("m", { where: { target: "users" } })).rows).toHaveLength(0);
    });

    it("keyset pagination walks every row exactly once, order held, both directions", async () => {
      const store = factory();
      const rows = Array.from({ length: 23 }, (_, n) => row(n, { timestamp: 5_000 - n }));
      await store.apply("m", "x-1", 22, rows);
      for (const order of ["asc", "desc"] as const) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await store.query("m", {
            order,
            limit: 4,
            ...(cursor !== undefined && { cursor }),
          });
          seen.push(...page.rows.map((r) => r.rowId));
          if (page.nextCursor === undefined) break;
          cursor = page.nextCursor;
        }
        expect(seen).toHaveLength(23);
        expect(new Set(seen).size).toBe(23);
      }
    });

    it("rejects malformed cursors and invalid limits loudly (audit hardening)", async () => {
      const store = factory();
      await store.apply("m", "x-1", 0, [row(0)]);
      await expect(store.query("m", { cursor: "not json" })).rejects.toThrow(/cursor/);
      await expect(store.query("m", { cursor: '{"x":1}' })).rejects.toThrow(/cursor/);
      await expect(store.query("m", { limit: 0 })).rejects.toThrow(/limit/);
      await expect(store.query("m", { limit: -1 })).rejects.toThrow(/limit/);
    });

    it("models are isolated; clear drops rows AND watermarks for one model only", async () => {
      const store = factory();
      await store.apply("a", "x-1", 0, [row(0)]);
      await store.apply("b", "x-1", 0, [row(0)]);
      await store.clear("a");
      await store.clear("a"); // idempotent
      expect((await store.query("a")).rows).toHaveLength(0);
      expect(await store.watermark("a", "x-1")).toBeNull();
      expect((await store.query("b")).rows).toHaveLength(1);
      expect(await store.watermark("b", "x-1")).toBe(0);
    });

    // ── purge (OPTIONAL, SPI 1.1.0 — ADR 0093) ───────────────────────────────

    it("purge deletes exactly the matching rows, scoped to one model (OPTIONAL)", async () => {
      const store = factory();
      if (store.purge === undefined) return;
      await store.apply("a", "x-1", 2, [
        row(0, { fields: { target: "orders" } }),
        row(1, { fields: { target: "orders" } }),
        row(2, { fields: { target: "users" } }),
      ]);
      await store.apply("b", "x-1", 0, [row(0, { fields: { target: "orders" } })]);

      expect(await store.purge("a", { target: "orders" })).toBe(2);
      expect((await store.query("a")).rows).toHaveLength(1);
      // Another model's rows with the same field value are a different subject's data.
      expect((await store.query("b")).rows).toHaveLength(1);
    });

    it("purge leaves watermarks alone, so catch-up cannot resurrect the rows (OPTIONAL)", async () => {
      const store = factory();
      if (store.purge === undefined) return;
      await store.apply("a", "x-1", 7, [row(0, { fields: { target: "orders" } })]);
      await store.purge("a", { target: "orders" });
      // The row is erased; the watermark still says this execution is indexed through 7.
      // A backend that cleared it would make the next incremental scan re-read the log
      // from zero and re-derive exactly what was just erased.
      expect(await store.watermark("a", "x-1")).toBe(7);
    });

    it("purge is idempotent, matches nothing rather than everything, and refuses an empty filter (OPTIONAL)", async () => {
      const store = factory();
      if (store.purge === undefined) return;
      await store.apply("a", "x-1", 0, [row(0, { fields: { target: "orders" } })]);

      // An erasure is retried; the second run legitimately finds nothing.
      expect(await store.purge("a", { target: "ghost" })).toBe(0);
      expect(await store.purge("unknown-model", { target: "orders" })).toBe(0);
      expect((await store.query("a")).rows).toHaveLength(1);

      // The empty filter is the one a caller reaches by ACCIDENT — a subject id that
      // resolved to nothing. Read as match-all it wipes the model; read as match-none it
      // reports an erasure that did not happen. Both are wrong, so it must throw.
      await expect(store.purge("a", {})).rejects.toBeInstanceOf(TypeError);
      expect((await store.query("a")).rows).toHaveLength(1);

      expect(await store.purge("a", { target: "orders" })).toBe(1);
      expect(await store.purge("a", { target: "orders" })).toBe(0); // idempotent
    });

    it("purge ANDs its fields, exactly as query does (OPTIONAL)", async () => {
      const store = factory();
      if (store.purge === undefined) return;
      await store.apply("a", "x-1", 1, [
        row(0, { fields: { target: "orders", severity: "high" } }),
        row(1, { fields: { target: "orders", severity: "low" } }),
      ]);
      // A backend ORing its clauses would take both — and an erasure that deletes more
      // than it was asked to is as much a defect as one that deletes less.
      expect(await store.purge("a", { target: "orders", severity: "high" })).toBe(1);
      const left = await store.query("a");
      expect(left.rows).toHaveLength(1);
    });
  });
}

export interface MemoryEntryLike {
  /** OPTIONAL caller-assigned identity. Every backend MUST round-trip it. */
  id?: string;
  role?: string;
  content: unknown;
  timestamp: number;
}

export interface MemoryStoreLike {
  append(key: string, entry: MemoryEntryLike): Promise<void>;
  read(key: string): Promise<MemoryEntryLike[]>;
  clear(key: string): Promise<void>;
  /** OPTIONAL: atomic whole-list rewrite (empty ⇒ the key is dropped). */
  replace?(key: string, entries: readonly MemoryEntryLike[]): Promise<void>;
  /** OPTIONAL: relevance retrieval, best first. */
  search?(key: string, query: string, opts?: { limit?: number }): Promise<MemoryEntryLike[]>;
  /** OPTIONAL: delete the listed ids from a key, keeping the survivors in append order. */
  remove?(key: string, ids: readonly string[]): Promise<void>;
  /** OPTIONAL: release backend resources. */
  close?(): Promise<void>;
}

/**
 * Assert a MemoryStore backend (`@loom/memory`) upholds the SPI: a key names an
 * ORDERED LIST of entries, appended to, read whole, and cleared.
 *
 * Three of these cases exist because they are exactly what a SQL backend gets wrong
 * on the first attempt, and what an in-memory reference cannot fail:
 *
 *  - order is APPEND order, not timestamp order. Entries routinely share a timestamp
 *    (a turn written in one tick), so `ORDER BY timestamp` silently reshuffles a
 *    conversation. A backend needs its own monotonic insertion key.
 *  - the list is a LIST, not a set: two identical entries are two entries.
 *  - an ABSENT `role` must read back absent, not `null`. A nullable column round-trips
 *    `{ content }` into `{ role: null, content }`, which is a different prompt.
 *
 * `replace`, `search` and `remove` are optional and skipped when a backend omits them.
 * `replace` must be equivalent to clear-then-append-all, including on an absent key.
 *
 * `MemoryEntry.id` is NOT optional to support (ADR 0091). It is the fourth thing a SQL
 * backend gets wrong on the first attempt, and in the same way `role` was: a store that
 * decomposes an entry into columns drops a field nobody told it to keep, and every case
 * that only checks `content` stays green. The id case is required for backends WITHOUT
 * `remove` too, because that is precisely when it matters — those are removed from by
 * read-filter-`replace` above the SPI, which matches on the id `read` gives back, so a
 * dropped id turns a deletion into a silent no-op rather than an error.
 *
 * The `search` cases pin the CONTRACT and not the ranking: results are a subset of
 * `read(key)`, terms are OR-ed (a longer question must not return less), `role` and
 * `timestamp` are metadata and never searchable text, a user's question is not a query
 * language, and a cleared or replaced key stops matching. Which of two matching entries
 * ranks first is the backend's business — BM25, `ts_rank` and the reference scorer
 * disagree, and a kit that pinned an order would be pinning an implementation.
 *
 * "A cleared or replaced key stops matching" and "a query matching nothing returns []"
 * are free for an inverted index and are the two cases a SIMILARITY backend has to
 * design for: cosine is defined against every entry, so an unthresholded ranking is
 * never empty. That is a floor to choose, not a reason to exempt the backend — the
 * third-party `loom-plugin-vector` passes this kit unmodified.
 *
 * Note what a portable kit CANNOT reach: a backend that joins its index back to the rows
 * satisfies the clear/replace cases structurally, index maintenance or not. That the index
 * is truly maintained (rather than growing forever behind a join that hides it) is a
 * backend-specific assertion, and belongs in the backend's own suite.
 */
export function runMemoryStoreConformance(
  factory: () => MemoryStoreLike,
  label = "MemoryStore"
): void {
  const entry = (content: unknown, timestamp = 1_000): MemoryEntryLike => ({ content, timestamp });

  describe(`${label} conformance (MemoryStore SPI)`, () => {
    it("append + read returns a key's entries in append order", async () => {
      const store = factory();
      await store.append("k", entry("a"));
      await store.append("k", entry("b"));
      await store.append("k", entry("c"));
      expect((await store.read("k")).map((e) => e.content)).toEqual(["a", "b", "c"]);
      await store.close?.();
    });

    it("read returns [] (never throws) for an absent key", async () => {
      const store = factory();
      expect(await store.read("absent")).toEqual([]);
      await store.close?.();
    });

    it("preserves append order for entries sharing a timestamp", async () => {
      const store = factory();
      for (const c of ["first", "second", "third"]) await store.append("k", entry(c, 7));
      expect((await store.read("k")).map((e) => e.content)).toEqual(["first", "second", "third"]);
      await store.close?.();
    });

    it("does not order by timestamp: an out-of-order timestamp keeps its append position", async () => {
      const store = factory();
      await store.append("k", entry("late-clock", 9_000));
      await store.append("k", entry("early-clock", 1));
      expect((await store.read("k")).map((e) => e.content)).toEqual(["late-clock", "early-clock"]);
      await store.close?.();
    });

    it("is a list, not a set: identical entries are kept separately", async () => {
      const store = factory();
      await store.append("k", entry("same"));
      await store.append("k", entry("same"));
      expect(await store.read("k")).toHaveLength(2);
      await store.close?.();
    });

    it("keys are isolated", async () => {
      const store = factory();
      await store.append("a", entry("of-a"));
      await store.append("b", entry("of-b"));
      expect((await store.read("a")).map((e) => e.content)).toEqual(["of-a"]);
      expect((await store.read("b")).map((e) => e.content)).toEqual(["of-b"]);
      await store.close?.();
    });

    it("round-trips role, content and timestamp; an absent role stays absent", async () => {
      const store = factory();
      await store.append("k", { role: "user", content: "hi", timestamp: 42 });
      await store.append("k", { content: "no role", timestamp: 43 });
      const [withRole, withoutRole] = await store.read("k");
      expect(withRole).toEqual({ role: "user", content: "hi", timestamp: 42 });
      expect(withoutRole).toEqual({ content: "no role", timestamp: 43 });
      expect("role" in (withoutRole as object)).toBe(false);
      await store.close?.();
    });

    it("preserves JSON content fidelity (nesting, arrays, null, numbers, unicode)", async () => {
      const store = factory();
      const content = {
        nested: { deep: [1, 2.5, null, "χ", { flag: false }] },
        empty: {},
        list: [] as unknown[],
      };
      await store.append("k", entry(content));
      expect((await store.read("k"))[0]?.content).toEqual(content);
      await store.close?.();
    });

    it("clear empties the key, is idempotent, and append works again afterwards", async () => {
      const store = factory();
      await store.append("k", entry("gone"));
      await store.clear("k");
      expect(await store.read("k")).toEqual([]);
      await store.clear("k"); // idempotent
      await store.append("k", entry("fresh"));
      expect((await store.read("k")).map((e) => e.content)).toEqual(["fresh"]);
      await store.close?.();
    });

    it("clear isolates keys", async () => {
      const store = factory();
      await store.append("a", entry("keep"));
      await store.append("b", entry("drop"));
      await store.clear("b");
      expect((await store.read("a")).map((e) => e.content)).toEqual(["keep"]);
      await store.close?.();
    });

    it("replace rewrites the whole list, in order (OPTIONAL)", async () => {
      const store = factory();
      if (store.replace === undefined) return void (await store.close?.());
      await store.append("k", entry("old-1"));
      await store.append("k", entry("old-2"));
      await store.replace("k", [entry("new-1"), entry("new-2"), entry("new-3")]);
      expect((await store.read("k")).map((e) => e.content)).toEqual(["new-1", "new-2", "new-3"]);
      await store.close?.();
    });

    it("replace with an empty list empties the key (OPTIONAL)", async () => {
      const store = factory();
      if (store.replace === undefined) return void (await store.close?.());
      await store.append("k", entry("gone"));
      await store.replace("k", []);
      expect(await store.read("k")).toEqual([]);
      await store.close?.();
    });

    it("replace works on an absent key and isolates other keys (OPTIONAL)", async () => {
      const store = factory();
      if (store.replace === undefined) return void (await store.close?.());
      await store.append("other", entry("untouched"));
      await store.replace("ghost", [entry("materialized")]);
      expect((await store.read("ghost")).map((e) => e.content)).toEqual(["materialized"]);
      expect((await store.read("other")).map((e) => e.content)).toEqual(["untouched"]);
      await store.close?.();
    });

    it("entries appended after a replace follow the replaced list (OPTIONAL)", async () => {
      const store = factory();
      if (store.replace === undefined) return void (await store.close?.());
      await store.append("k", entry("old"));
      await store.replace("k", [entry("kept")]);
      await store.append("k", entry("later"));
      expect((await store.read("k")).map((e) => e.content)).toEqual(["kept", "later"]);
      await store.close?.();
    });

    it("search returns matching entries and only matching entries (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      await store.append("k", entry("the replica lag alert fired"));
      await store.append("k", entry("someone renamed a column"));
      const hits = await store.search("k", "replica lag");
      expect(hits.map((e) => e.content)).toEqual(["the replica lag alert fired"]);
      await store.close?.();
    });

    it("search matches ANY term, not all of them (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      await store.append("k", entry("vacuum finished"));
      // A question mentioning things the entry never says must not hide the entry: a
      // longer question returning fewer memories is the failure mode of AND-ing terms.
      const hits = await store.search("k", "why did the vacuum take so long on tuesday");
      expect(hits.map((e) => e.content)).toEqual(["vacuum finished"]);
      await store.close?.();
    });

    it("search is scoped to one key (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      await store.append("a", entry("shared-term in a"));
      await store.append("b", entry("shared-term in b"));
      const hits = await store.search("a", "shared");
      expect(hits.map((e) => e.content)).toEqual(["shared-term in a"]);
      await store.close?.();
    });

    it("search finds a term nested inside structured content (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      await store.append("k", entry({ tool: "psql", result: { rows: [{ note: "deadlock" }] } }));
      expect(await store.search("k", "deadlock")).toHaveLength(1);
      await store.close?.();
    });

    it("search does not match on role or timestamp (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      // Metadata is not content. Indexing `role` makes every assistant turn a hit for
      // "assistant"; indexing the timestamp makes an epoch millisecond a searchable token.
      await store.append("k", { role: "assistant", content: "no keyword here", timestamp: 1234 });
      expect(await store.search("k", "assistant")).toEqual([]);
      expect(await store.search("k", "1234")).toEqual([]);
      await store.close?.();
    });

    it("search returns [] for a query that matches nothing, an empty query, and an absent key (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      await store.append("k", entry("something"));
      expect(await store.search("k", "unrelated")).toEqual([]);
      expect(await store.search("k", "   ?!  ")).toEqual([]); // no terms at all
      expect(await store.search("absent", "something")).toEqual([]);
      await store.close?.();
    });

    it("search accepts a query carrying search-engine syntax as plain words (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      // A user question is not a query language. Unescaped, these reach FTS5/tsquery as
      // operators and either throw a syntax error or silently mean something else.
      await store.append("k", entry("index bloat on orders"));
      for (const query of ['"bloat" AND', "bloat*", "bloat NEAR orders", "-bloat", "bloat | (:"]) {
        expect((await store.search("k", query)).length).toBeGreaterThan(0);
      }
      await store.close?.();
    });

    it("search honours limit (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      for (let i = 0; i < 5; i++) await store.append("k", entry(`alert number ${i}`));
      expect(await store.search("k", "alert", { limit: 2 })).toHaveLength(2);
      await store.close?.();
    });

    it("search bounds a hostile limit instead of trusting it (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      for (let i = 0; i < 5; i++) await store.append("k", entry(`alert number ${i}`));

      // A NEGATIVE limit is the one that matters. Passed through, `.slice(0, -1)` dropped
      // the last hit, SQLite read `LIMIT -1` as NO LIMIT and returned everything, and
      // Postgres rejected it — so the value a caller reaches by arithmetic silently
      // DEFEATED the bound on one backend and crashed another.
      expect(await store.search("k", "alert", { limit: -1 })).toEqual([]);
      expect(await store.search("k", "alert", { limit: 0 })).toEqual([]);
      // Fractional clamps to its floor rather than throwing: `total / pages` is a limit,
      // not a mistake.
      expect(await store.search("k", "alert", { limit: 2.9 })).toHaveLength(2);
      // An enormous limit is capped, never handed to the backend verbatim.
      expect(
        (await store.search("k", "alert", { limit: Number.MAX_SAFE_INTEGER })).length
      ).toBeLessThanOrEqual(5);
      await store.close?.();
    });

    it("search results are a subset of the key's entries (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      await store.append("k", entry("checkpoint tuning"));
      await store.append("k", entry("checkpoint spike"));
      const all = await store.read("k");
      for (const hit of await store.search("k", "checkpoint")) {
        expect(all).toContainEqual(hit);
      }
      await store.close?.();
    });

    it("clear removes entries from the search index too (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      await store.append("k", entry("forgettable fact"));
      await store.clear("k");
      // A cleared key must stop matching. Backends that search an index directly, rather
      // than joining back to the rows, fail this the moment they forget to maintain it.
      expect(await store.search("k", "forgettable")).toEqual([]);
      await store.close?.();
    });

    it("replace updates the search index (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined || store.replace === undefined) {
        return void (await store.close?.());
      }
      await store.append("k", entry("superseded fact"));
      await store.replace("k", [entry("current fact")]);
      expect(await store.search("k", "superseded")).toEqual([]);
      expect((await store.search("k", "current")).map((e) => e.content)).toEqual(["current fact"]);
      await store.close?.();
    });

    // ── Entry identity (REQUIRED — ADR 0091) ─────────────────────────────────

    it("round-trips a caller-assigned id; an absent id stays absent", async () => {
      const store = factory();
      await store.append("k", { id: "doc-1#0", content: "first chunk", timestamp: 42 });
      await store.append("k", { content: "no id", timestamp: 43 });
      const [identified, anonymous] = await store.read("k");
      expect(identified).toEqual({ id: "doc-1#0", content: "first chunk", timestamp: 42 });
      expect(anonymous).toEqual({ content: "no id", timestamp: 43 });
      // Same rule as `role`: a nullable column must not turn `{ content }` into
      // `{ id: null, content }`. An id read back as null matches no removal and
      // equals no other entry, so it is worse than useless — it is undetectable.
      expect("id" in (anonymous as object)).toBe(false);
      await store.close?.();
    });

    it("an id is metadata, not searchable text (OPTIONAL)", async () => {
      const store = factory();
      if (store.search === undefined) return void (await store.close?.());
      await store.append("k", { id: "RB-101", content: "checkpoint tuning", timestamp: 1_000 });
      // By the same rule that excludes `role` and the taint wrapper's `origin`: ids are
      // assigned per document, so indexing them makes a document's own id a term that
      // matches every one of its chunks and nothing else's — a phantom retrieval mode
      // that looks like relevance.
      expect(await store.search("k", "RB-101")).toEqual([]);
      expect((await store.search("k", "checkpoint")).map((e) => e.content)).toEqual([
        "checkpoint tuning",
      ]);
      await store.close?.();
    });

    it("replace preserves ids (OPTIONAL)", async () => {
      const store = factory();
      if (store.replace === undefined) return void (await store.close?.());
      await store.replace("k", [
        { id: "a", content: "one", timestamp: 1 },
        { content: "two", timestamp: 2 },
      ]);
      const rows = await store.read("k");
      expect(rows.map((e) => e.id)).toEqual(["a", undefined]);
      // The rewrite path is how a store without `remove` deletes. Losing ids there
      // would make the FIRST removal work and every later one silently miss.
      expect("id" in (rows[1] as object)).toBe(false);
      await store.close?.();
    });

    // ── remove (OPTIONAL) ────────────────────────────────────────────────────

    it("remove deletes the named entries and keeps the survivors in append order (OPTIONAL)", async () => {
      const store = factory();
      if (store.remove === undefined) return void (await store.close?.());
      for (const [id, content] of [
        ["a", "first"],
        ["b", "second"],
        ["c", "third"],
      ] as const) {
        await store.append("k", { id, content, timestamp: 1_000 });
      }
      await store.remove("k", ["b"]);
      // Order is the point: deleting from the middle must not reshuffle what is left,
      // or a conversation re-reads out of sequence after one entry is retracted.
      expect((await store.read("k")).map((e) => e.content)).toEqual(["first", "third"]);
      await store.close?.();
    });

    it("remove is idempotent, ignores unknown ids, and reads an empty list as nothing (OPTIONAL)", async () => {
      const store = factory();
      if (store.remove === undefined) return void (await store.close?.());
      await store.append("k", { id: "a", content: "keep", timestamp: 1_000 });
      await store.remove("k", ["missing"]);
      await store.remove("k", []); // MUST NOT be read as "all"
      await store.remove("absent-key", ["a"]);
      expect((await store.read("k")).map((e) => e.content)).toEqual(["keep"]);
      await store.remove("k", ["a"]);
      await store.remove("k", ["a"]); // idempotent: a retried ingest re-runs this
      expect(await store.read("k")).toEqual([]);
      await store.close?.();
    });

    it("remove never touches an entry that has no id (OPTIONAL)", async () => {
      const store = factory();
      if (store.remove === undefined) return void (await store.close?.());
      await store.append("k", { content: "anonymous", timestamp: 1_000 });
      await store.append("k", { id: "a", content: "identified", timestamp: 1_000 });
      // A backend matching on a NULL id column (`id IN (...)` with a null-safe operator,
      // or a JS `undefined` colliding with a missing map entry) would take both.
      await store.remove("k", ["a", "undefined", "null", ""]);
      expect((await store.read("k")).map((e) => e.content)).toEqual(["anonymous"]);
      await store.close?.();
    });

    it("remove takes every entry sharing an id, and is scoped to one key (OPTIONAL)", async () => {
      const store = factory();
      if (store.remove === undefined) return void (await store.close?.());
      await store.append("a", { id: "dup", content: "one", timestamp: 1_000 });
      await store.append("a", { id: "dup", content: "two", timestamp: 1_000 });
      await store.append("b", { id: "dup", content: "other key", timestamp: 1_000 });
      // Uniqueness is the caller's to keep; the SPI does not require an index for it.
      // Removing only one of a duplicated pair would leave a survivor that no id can
      // ever address again — a leak with a name.
      await store.remove("a", ["dup"]);
      expect(await store.read("a")).toEqual([]);
      expect((await store.read("b")).map((e) => e.content)).toEqual(["other key"]);
      await store.close?.();
    });

    it("a key emptied by remove reads as [] and accepts appends again (OPTIONAL)", async () => {
      const store = factory();
      if (store.remove === undefined) return void (await store.close?.());
      await store.append("k", { id: "a", content: "gone", timestamp: 1_000 });
      await store.remove("k", ["a"]);
      expect(await store.read("k")).toEqual([]);
      await store.append("k", { id: "b", content: "fresh", timestamp: 1_000 });
      expect((await store.read("k")).map((e) => e.content)).toEqual(["fresh"]);
      await store.close?.();
    });

    it("remove takes entries out of the search index too (OPTIONAL)", async () => {
      const store = factory();
      if (store.remove === undefined || store.search === undefined) {
        return void (await store.close?.());
      }
      await store.append("k", { id: "old", content: "superseded runbook step", timestamp: 1_000 });
      await store.append("k", { id: "new", content: "current runbook step", timestamp: 1_000 });
      await store.remove("k", ["old"]);
      // The whole reason `remove` exists: a revised document whose old revision stays
      // retrievable is worse than one that was never removable, because retrieval then
      // returns both and a citation cannot say which is live.
      expect((await store.search("k", "runbook")).map((e) => e.content)).toEqual([
        "current runbook step",
      ]);
      expect(await store.search("k", "superseded")).toEqual([]);
      await store.close?.();
    });
  });
}

/**
 * Prove a {@link Policy} (`@loom/learning`) conforms to the SPI (ADR 0080).
 *
 * The kit pins the *shape and safety* of a policy, never its quality — what it
 * chooses is the plugin's business, and a policy that chooses badly is still
 * conformant. What is NOT negotiable is the propensity contract: a policy that
 * misreports `P(chosen | context)` silently biases every off-policy evaluation
 * computed from its logs, and nothing downstream can detect it. That is why the
 * distribution check below exists.
 *
 * `contexts` should be representative observations your policy will really see.
 */
export function runPolicyConformance<A>(
  factory: () => {
    id: string;
    version: string;
    select(
      context: Record<string, unknown>,
      actions: readonly A[]
    ): { action: A; propensity?: number };
  },
  actions: readonly A[],
  contexts: readonly Record<string, unknown>[],
  label = "Policy"
): void {
  if (actions.length < 2) throw new Error("runPolicyConformance: need at least 2 actions");
  if (contexts.length === 0) throw new Error("runPolicyConformance: need at least 1 context");
  const first = contexts[0] as Record<string, unknown>;

  describe(`${label} conformance (Policy SPI)`, () => {
    it("declares a non-empty id and version", () => {
      const p = factory();
      expect(typeof p.id).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.version).toBe("string");
      expect(p.version.length).toBeGreaterThan(0);
    });

    it("always chooses from the action set it was given", () => {
      const p = factory();
      for (const context of contexts) {
        expect(actions).toContain(p.select(context, actions).action);
      }
    });

    it("returns the only action when there is exactly one", () => {
      const only = [actions[0] as A];
      expect(factory().select(first, only).action).toBe(only[0]);
    });

    it("reports a propensity in (0,1] when it reports one at all", () => {
      const p = factory();
      for (const context of contexts) {
        const { propensity } = p.select(context, actions);
        if (propensity === undefined) continue;
        expect(propensity).toBeGreaterThan(0);
        expect(propensity).toBeLessThanOrEqual(1);
      }
    });

    it("does not mutate the context or the action set it is handed", () => {
      const context = { ...first };
      const given = [...actions];
      factory().select(context, given);
      expect(context).toEqual(first);
      expect(given).toEqual([...actions]);
    });

    it("survives an unfamiliar action without throwing (new arms appear in production)", () => {
      const p = factory();
      expect(() => p.select(first, actions)).not.toThrow();
    });
  });
}
