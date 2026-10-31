import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import { DuplicateSequenceError } from "@loom/event-runtime";
import { SqliteEventStore } from "@loom/plugin-sqlite";

import { foldEvents } from "@loom/replay-vm";
import type { Snapshot } from "@loom/snapshot-runtime";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresBranchRegistry } from "./PostgresBranchRegistry";
import { PostgresEventStore } from "./PostgresEventStore";
import { EXPIRED_SQL, PostgresLeaseStore } from "./PostgresLeaseStore";
import { PostgresSnapshotStore } from "./PostgresSnapshotStore";
import { migrate } from "./schema";

// These tests need a real Postgres. They run when LOOM_TEST_POSTGRES_URL is set
// (e.g. postgres://postgres@localhost:55432/loomtest) and skip cleanly otherwise, so
// CI without a database stays green. The adapters are the horizontal-scale backend.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
const suite = PG_URL ? describe : describe.skip;

function makeEnvelope(executionId: string, sequence: number, payload: unknown = {}): EventEnvelope {
  return {
    id: `evt-${executionId}-${sequence}`,
    workflowId: "test-flow",
    executionId,
    eventType: "TEST_EVENT",
    sequence,
    timestamp: 1_700_000_000_000 + sequence,
    payload,
  };
}

suite("@loom/plugin-postgres", () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_URL });
    await migrate(admin);
  });

  afterAll(async () => {
    await admin.end();
  });

  beforeEach(async () => {
    await admin.query(
      "TRUNCATE events, snapshots, refs, lineage, fences, timers, leases, durable_state, read_model_rows, read_model_watermarks, memory_entries, archive_segments"
    );
  });

  describe("PostgresEventStore", () => {
    let store: PostgresEventStore;
    beforeEach(() => {
      store = new PostgresEventStore(PG_URL as string);
    });
    afterEach(async () => {
      await store.close();
    });

    it("appends and reads back events in sequence order", async () => {
      for (let i = 0; i < 50; i++) await store.append(makeEnvelope("e1", i, { index: i }));
      const events = await store.read("e1");
      expect(events).toHaveLength(50);
      expect(events.map((e) => e.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    });

    it("preserves a rich payload through the JSONB round-trip", async () => {
      const payload = { nested: { value: 42 }, arr: [1, 2, 3], str: "hello", b: true, z: null };
      await store.append(makeEnvelope("e2", 0, payload));
      const [event] = await store.read("e2");
      expect(event?.payload).toEqual(payload);
    });

    it("preserves metadata when provided", async () => {
      await store.append({ ...makeEnvelope("e3", 0), metadata: { traceId: "abc123" } });
      const [event] = await store.read("e3");
      expect(event?.metadata).toEqual({ traceId: "abc123" });
    });

    it("rejects a distinct envelope claiming an occupied (executionId, sequence)", async () => {
      // `makeEnvelope` derives the id from (executionId, sequence), so appending it twice
      // collides on the id PRIMARY KEY first — this case was named for a constraint it
      // never reached, and `.rejects.toThrow()` could not tell the difference. A DISTINCT
      // id is what makes the second write test `UNIQUE (execution_id, sequence)`, and the
      // error type is what proves WHICH constraint refused it.
      await store.append(makeEnvelope("e4", 0));
      const intruder = { ...makeEnvelope("e4", 0), id: "evt-e4-0-second" };
      await expect(store.append(intruder)).rejects.toThrow(DuplicateSequenceError);
      const read = await store.read("e4");
      expect(read).toHaveLength(1);
      expect(read[0]?.id).toBe("evt-e4-0");
    });

    it("lifecycle (K10.1/.4): deleteExecution removes all; truncatePrefix keeps sequence 0", async () => {
      for (let i = 0; i < 5; i++) await store.append(makeEnvelope("life", i));
      // Compaction: truncate (0..3] — sequence 0 stays as the bootstrap anchor.
      await store.truncatePrefix("life", 3);
      expect((await store.read("life")).map((e) => e.sequence)).toEqual([0, 4]);
      // Retention: delete the whole execution.
      await store.deleteExecution("life");
      expect(await store.read("life")).toEqual([]);
    });

    it("ADR 0118: a park ensures an inert token-0 fence row; acquireFenceIf also works on a park written before that (no row)", async () => {
      const ev = (id: string, seq: number, eventType: string) => ({
        ...makeEnvelope(id, seq),
        eventType,
      });
      await store.append(ev("p0", 0, "EXECUTION_STARTED"));
      await store.append(ev("p0", 1, "EXECUTION_SUSPENDED"));
      const row = async (id: string) =>
        (await admin.query("SELECT fence FROM fences WHERE execution_id = $1", [id])).rows;
      expect(await row("p0")).toEqual([{ fence: "0" }]); // created by the park append, inert
      await store.append(ev("p0", 2, "STEP_COMPLETED")); // an unfenced writer is NOT refused by a 0 row
      expect(await store.acquireFenceIf("p0", { fence: 0, parkSeq: 1 })).toEqual({ fence: 1 });
      // a step/audit event never creates the row (only a park does): the hot path is unchanged
      await store.append(ev("p1", 0, "EXECUTION_STARTED"));
      await store.append(ev("p1", 1, "STEP_COMPLETED"));
      expect(await row("p1")).toEqual([]);
      // a log written BEFORE this version: a park, no fence row. The conditional creates it itself.
      await store.append(ev("legacy", 0, "EXECUTION_STARTED"));
      await store.append(ev("legacy", 1, "EXECUTION_SUSPENDED"));
      await admin.query("DELETE FROM fences WHERE execution_id = 'legacy'");
      expect(await store.acquireFenceIf("legacy", { fence: 0, parkSeq: 1 })).toEqual({ fence: 1 });
      expect(await row("legacy")).toEqual([{ fence: "1" }]);
    });

    it("appendIfUnchanged vs an unfenced plain append for the same slot: never a gap, exactly one lands (P3 #1)", async () => {
      const ev = (id: string, seq: number, eventType: string) => ({
        ...makeEnvelope(id, seq),
        id: `${id}-${seq}-${eventType}`,
        eventType,
      });
      for (let i = 0; i < 40; i++) {
        const id = `race${i}`;
        await store.append(ev(id, 0, "EXECUTION_STARTED"));
        await store.append(ev(id, 1, "EXECUTION_COMPLETED"));
        const seen = await store.appendIfUnchanged(id, null);
        if (seen.appended) throw new Error("unreachable");
        const obs = { head: seen.head as number, fence: seen.fence, anchor: seen.anchor as string };
        const [a, b] = await Promise.all([
          store
            .appendIfUnchanged(id, ev(id, 2, "OUTCOME_RECORDED"), obs)
            .then((r) => (r.appended ? "late" : r.reason))
            .catch((e: Error) => e.name),
          store
            .append(ev(id, 2, "STEP_COMPLETED"))
            .then(() => "plain")
            .catch((e: Error) => e.name),
        ]);
        expect((await store.read(id)).map((e) => e.sequence)).toEqual([0, 1, 2]);
        // one of them owns slot 2; the other was refused, never silently accepted elsewhere
        expect([a === "late", b === "plain"].filter(Boolean)).toHaveLength(1);
      }
      // a skip-ahead is refused outright (the next slot's uniqueness is the only arbiter)
      await store.append(ev("skip", 0, "EXECUTION_STARTED"));
      const seen = await store.appendIfUnchanged("skip", null);
      if (seen.appended) throw new Error("unreachable");
      expect(
        await store.appendIfUnchanged("skip", ev("skip", 5, "OUTCOME_RECORDED"), {
          head: 0,
          fence: seen.fence,
          anchor: seen.anchor as string,
        })
      ).toMatchObject({ appended: false, reason: "moved" });
      expect((await store.read("skip")).map((e) => e.sequence)).toEqual([0]);
    });

    it("a token-0 fence row the conditional append creates is inert and reclaimed with the log (P3 #4)", async () => {
      const ev = (seq: number, eventType: string) => ({ ...makeEnvelope("t0", seq), eventType });
      await store.append(ev(0, "EXECUTION_STARTED"));
      await store.append(ev(1, "EXECUTION_COMPLETED"));
      const seen = await store.appendIfUnchanged("t0", null);
      if (seen.appended) throw new Error("unreachable");
      const rows = async () =>
        (await admin.query("SELECT fence FROM fences WHERE execution_id = 't0'")).rows;
      expect(await rows()).toEqual([]); // an observation creates nothing
      await store.appendIfUnchanged("t0", ev(2, "OUTCOME_RECORDED"), {
        head: 1,
        fence: 0,
        anchor: seen.anchor as string,
      });
      expect(await rows()).toEqual([{ fence: "0" }]); // inert: a plain unfenced append is still accepted
      await store.append(ev(3, "STEP_COMPLETED"));
      await store.deleteExecution("t0");
      expect(await rows()).toEqual([]); // gone with the log
    });

    // R11 round 3 (P3 #2): the conditional write and the conditional acquire both rest on "a
    // fresh snapshot per statement after the row lock is granted". A server whose default
    // isolation is stricter must not break that: the isolation is STATED, not assumed.
    describe("under a server default of REPEATABLE READ", () => {
      const rrPool = () =>
        new Pool({
          connectionString: PG_URL as string,
          options: "-c default_transaction_isolation=repeatable\\ read",
        });
      const blockedOnLock = async () => {
        for (let i = 0; i < 400; i++) {
          const r = await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()"
          );
          if (r.rowCount === 1) return;
          await new Promise((res) => setTimeout(res, 10)); // a poll interval, not a fixed wait
        }
        throw new Error("the transaction under test never blocked on the fence row");
      };
      const ev = (id: string, seq: number, eventType: string) => ({
        ...makeEnvelope(id, seq),
        eventType,
      });

      it("appendIfUnchanged: a write that committed while it waited for the row lock is `moved`, not a thrown duplicate", async () => {
        const rr = rrPool();
        const s = new PostgresEventStore(rr as never);
        try {
          await s.append(ev("rr1", 0, "EXECUTION_STARTED"));
          await s.append(ev("rr1", 1, "EXECUTION_COMPLETED"));
          const seen = await s.appendIfUnchanged("rr1", null);
          expect(seen.appended).toBe(false);
          const holder = await admin.connect();
          try {
            await holder.query("BEGIN");
            await holder.query(
              "INSERT INTO fences (execution_id, fence) VALUES ('rr1', 0) ON CONFLICT (execution_id) DO NOTHING"
            );
            await holder.query("SELECT fence FROM fences WHERE execution_id = 'rr1' FOR UPDATE");
            const pending = s.appendIfUnchanged("rr1", ev("rr1", 2, "OUTCOME_RECORDED"), {
              head: (seen as { head: number }).head,
              fence: 0,
              anchor: (seen as { anchor: string }).anchor,
            });
            await blockedOnLock();
            await holder.query(
              `INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload)
               VALUES ('rr1-rival', 'w', 'rr1', 'STEP_COMPLETED', 2, 1, '{}'::jsonb)`
            );
            await holder.query("COMMIT");
            expect(await pending).toMatchObject({ appended: false, reason: "moved", head: 2 });
          } finally {
            holder.release();
          }
          expect((await s.read("rr1")).map((e) => e.sequence)).toEqual([0, 1, 2]);
        } finally {
          await s.close();
        }
      });

      it("acquireFenceIf: an answering event that committed while it waited is seen (stale), not overwritten", async () => {
        const rr = rrPool();
        const s = new PostgresEventStore(rr as never);
        try {
          await s.append(ev("rr2", 0, "EXECUTION_STARTED"));
          await s.append(ev("rr2", 1, "EXECUTION_SUSPENDED"));
          const holder = await admin.connect();
          try {
            await holder.query("BEGIN");
            await holder.query(
              "INSERT INTO fences (execution_id, fence) VALUES ('rr2', 0) ON CONFLICT (execution_id) DO NOTHING"
            );
            await holder.query("SELECT fence FROM fences WHERE execution_id = 'rr2' FOR UPDATE");
            const pending = s.acquireFenceIf("rr2", { fence: 0, parkSeq: 1 });
            await blockedOnLock();
            await holder.query(
              `INSERT INTO events (id, workflow_id, execution_id, event_type, sequence, timestamp, payload)
               VALUES ('rr2-resumed', 'w', 'rr2', 'EXECUTION_RESUMED', 2, 1, '{}'::jsonb)`
            );
            await holder.query("COMMIT");
            expect(await pending).toEqual({ stale: true, fence: 0 });
          } finally {
            holder.release();
          }
        } finally {
          await s.close();
        }
      });
    });

    it("timers (T1.3): schedule is idempotent; due orders soonest-first; complete retires", async () => {
      const { PostgresTimerStore } = await import("./PostgresTimerStore");
      const timers = new PostgresTimerStore(PG_URL as string);
      try {
        await timers.schedule({ executionId: "b", wakeAt: 200 });
        await timers.schedule({ executionId: "a", wakeAt: 100 });
        await timers.schedule({ executionId: "a", wakeAt: 100 }); // idempotent
        expect(await timers.due(500)).toEqual([
          { executionId: "a", wakeAt: 100 },
          { executionId: "b", wakeAt: 200 },
        ]);
        await timers.complete("a", 100);
        expect(await timers.due(500)).toEqual([{ executionId: "b", wakeAt: 200 }]);
      } finally {
        await timers.close();
      }
    });

    it("read models (RM #183): idempotent apply, GREATEST watermarks, @> queries, keyset paging", async () => {
      const { PostgresReadModelStore } = await import("./PostgresReadModelStore");
      const rm = new PostgresReadModelStore(PG_URL as string);
      const row = (n: number, target: string) => ({
        rowId: `e-${n}`,
        executionId: "x-1",
        sequence: n,
        timestamp: 1_000 + n,
        kind: "FINDING_RECORDED",
        fields: { target },
        value: { n },
      });
      try {
        await rm.apply("m", "x-1", 1, [row(0, "orders"), row(1, "users")]);
        await rm.apply("m", "x-1", 0, [row(0, "orders")]); // duplicate + stale mark
        expect(await rm.watermark("m", "x-1")).toBe(1);
        const orders = await rm.query("m", { where: { target: "orders" } });
        expect(orders.rows).toHaveLength(1);
        expect((orders.rows[0]?.value as { n: number }).n).toBe(0);
        // keyset paging walks both rows exactly once
        const first = await rm.query("m", { limit: 1 });
        expect(first.nextCursor).toBeDefined();
        const second = await rm.query("m", { limit: 1, cursor: first.nextCursor as string });
        expect(second.rows[0]?.rowId).not.toBe(first.rows[0]?.rowId);
        expect(second.nextCursor).toBeUndefined();
        await rm.clear("m");
        expect((await rm.query("m")).rows).toHaveLength(0);
        expect(await rm.watermark("m", "x-1")).toBeNull();
      } finally {
        await rm.close();
      }
    });

    it("durable state (ADR 0051 D2): CAS create/update, loud conflicts, idempotent clear", async () => {
      const { PostgresDurableStateStore } = await import("./PostgresDurableStateStore");
      const state = new PostgresDurableStateStore(PG_URL as string);
      try {
        expect(await state.load("k")).toBeNull();
        const created = await state.save(
          "k",
          { contractVersion: 2, payload: { list: [1, "χ", null] } },
          0
        );
        expect(created.revision).toBe(1);
        expect(await state.load("k")).toEqual({
          contractVersion: 2,
          revision: 1,
          payload: { list: [1, "χ", null] },
        });
        const updated = await state.save("k", { contractVersion: 2, payload: { list: [] } }, 1);
        expect(updated.revision).toBe(2);
        await expect(state.save("k", { contractVersion: 2, payload: {} }, 1)).rejects.toMatchObject(
          {
            name: "RevisionConflictError",
            expectedRevision: 1,
            actualRevision: 2,
          }
        );
        await expect(
          state.save("ghost", { contractVersion: 1, payload: {} }, 3)
        ).rejects.toMatchObject({ name: "RevisionConflictError", actualRevision: 0 });
        await state.clear("k");
        expect(await state.load("k")).toBeNull();
        await state.clear("k"); // idempotent — must not throw
      } finally {
        await state.close();
      }
    });

    it("fencing (K9.4): acquireFence is monotonic; stale/unfenced appends are rejected", async () => {
      const one = await store.acquireFence("ef");
      const two = await store.acquireFence("ef");
      expect(one).toBe(1);
      expect(two).toBe(2);

      // Current token lands; stale token and missing token are zombie writes.
      await store.append({ ...makeEnvelope("ef", 0), metadata: { fence: two } });
      await expect(
        store.append({ ...makeEnvelope("ef", 1), metadata: { fence: one } })
      ).rejects.toThrow(/stale fence/);
      await expect(store.append(makeEnvelope("ef", 1))).rejects.toThrow(/stale fence/);
      expect(await store.read("ef")).toHaveLength(1);

      // Executions that never acquired a fence are untouched (G2).
      await store.append(makeEnvelope("unfenced", 0));
      expect(await store.read("unfenced")).toHaveLength(1);
    });

    it("reads from a given sequence inclusive", async () => {
      for (let i = 0; i < 10; i++) await store.append(makeEnvelope("e5", i));
      const events = await store.readFrom("e5", 5);
      expect(events).toHaveLength(5);
      expect(events[0]?.sequence).toBe(5);
    });

    it("isolates events by executionId and returns [] for unknown ids", async () => {
      await store.append(makeEnvelope("ea", 0));
      expect(await store.read("ea")).toHaveLength(1);
      expect(await store.read("nonexistent")).toEqual([]);
    });

    it("copyPrefix bulk-copies a re-stamped, metadata-merged prefix", async () => {
      for (let i = 0; i < 5; i++) {
        await store.append({
          ...makeEnvelope("parent", i, { index: i }),
          ...(i === 2 && { metadata: { keep: "yes" } }),
        });
      }
      await store.copyPrefix("parent", "child", 3, { forkedFrom: "parent", forkSequence: 3 });

      const child = await store.read("child");
      expect(child.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
      expect(child[0]?.executionId).toBe("child");
      expect(child[0]?.id).toBe("child-0");
      expect(child[3]?.payload).toEqual({ index: 3 });
      expect(child[0]?.metadata).toMatchObject({ forkedFrom: "parent", forkSequence: 3 });
      expect(child[2]?.metadata).toMatchObject({ keep: "yes", forkedFrom: "parent" });
      expect(await store.read("parent")).toHaveLength(5); // parent untouched
    });

    it("notifies same-process subscribers synchronously on append", async () => {
      const handler = vi.fn();
      await store.subscribe("e7", handler);
      await store.append(makeEnvelope("e7", 0));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toMatchObject({ sequence: 0 });
    });

    it("unsubscribes correctly and does not notify other executionIds", async () => {
      const handler = vi.fn();
      const unsub = await store.subscribe("e8", handler);
      unsub();
      await store.append(makeEnvelope("e8", 0));
      await store.append(makeEnvelope("other", 0));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("cross-node subscribe (LISTEN/NOTIFY)", () => {
    it("delivers an append on one connection to a subscriber on another", async () => {
      // Two store instances = two 'nodes' sharing one database.
      const nodeA = new PostgresEventStore(PG_URL as string);
      const nodeB = new PostgresEventStore(PG_URL as string);
      try {
        const received: EventEnvelope[] = [];
        let resolveGot: () => void = () => {};
        const got = new Promise<void>((resolve) => {
          resolveGot = resolve;
        });
        // AWAIT the subscription. `subscribe` resolves only after its LISTEN is
        // registered, precisely so "the caller cannot append-then-miss its own
        // subscription's first cross-node event" — this test used to fire it and
        // sleep 100ms instead, which is not a slow-machine problem but a lost one:
        // NOTIFY is not durable, so a listener that registers after the publish
        // never receives it and the wait below can only ever time out.
        await nodeB.subscribe("shared", (e) => {
          received.push(e);
          resolveGot();
        });
        await nodeA.append(makeEnvelope("shared", 0, { from: "A" }));

        await Promise.race([
          got,
          new Promise((_r, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
        ]);
        expect(received).toHaveLength(1);
        expect(received[0]?.payload).toEqual({ from: "A" });
      } finally {
        await nodeA.close();
        await nodeB.close();
      }
    });
  });

  describe("PostgresSnapshotStore", () => {
    let store: PostgresSnapshotStore;
    beforeEach(() => {
      store = new PostgresSnapshotStore(PG_URL as string);
    });
    afterEach(async () => {
      await store.close();
    });

    function snap(sequence: number): Snapshot {
      const state: ExecutionState = {
        executionId: "s1",
        workflowId: "wf",
        workflowVersion: "1.0.0",
        status: "running",
        frames: { step: { stepId: "step", status: "completed", attempts: 1 } },
        variables: { _input: { n: sequence } },
        sequence,
        startedAt: 1,
        updatedAt: sequence,
      };
      return {
        id: `snap-${sequence}`,
        executionId: "s1",
        workflowId: "wf",
        sequence,
        state,
        createdAt: sequence,
      };
    }

    it("saves and loads the latest / at / latest-before", async () => {
      await store.save(snap(0));
      await store.save(snap(10));
      await store.save(snap(20));

      expect((await store.loadLatest("s1"))?.sequence).toBe(20);
      expect((await store.loadAt("s1", 10))?.sequence).toBe(10);
      expect((await store.loadLatestBefore("s1", 15))?.sequence).toBe(10);
      expect(await store.loadLatestBefore("s1", -1)).toBeNull();
      // State round-trips through JSONB intact.
      expect((await store.loadAt("s1", 20))?.state.variables).toEqual({ _input: { n: 20 } });
    });
  });

  describe("PostgresSnapshotStore.pruneSnapshots (SPI 1.2.0, ADR 0134)", () => {
    let store: PostgresSnapshotStore;
    beforeEach(() => {
      store = new PostgresSnapshotStore(PG_URL as string);
    });
    afterEach(async () => {
      await store.close();
    });

    const mk = (executionId: string, sequence: number): Snapshot => ({
      id: `${executionId}-${sequence}`,
      executionId,
      workflowId: "wf",
      sequence,
      state: { executionId, workflowId: "wf", sequence } as unknown as ExecutionState,
      createdAt: sequence,
    });
    const seqs = async (id: string): Promise<number[]> => {
      const out: number[] = [];
      for (let s = 0; s <= 10; s++) if ((await store.loadAt(id, s)) !== null) out.push(s);
      return out;
    };

    it("deletes the exclusive range minus the keep-set in one statement, per execution", async () => {
      const id = `prune-${process.pid}-a`;
      const other = `prune-${process.pid}-b`;
      await store.deleteExecution(id);
      await store.deleteExecution(other);
      for (const s of [0, 1, 2, 3, 4, 5, 6]) {
        await store.save(mk(id, s));
        await store.save(mk(other, s));
      }
      expect(await store.pruneSnapshots(id, { after: 0, before: 6 }, [3])).toBe(4);
      expect(await seqs(id)).toEqual([0, 3, 6]);
      expect(await seqs(other)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(await store.pruneSnapshots(id, { after: 0, before: 6 }, [3])).toBe(0);
      expect(await store.pruneSnapshots(id, { after: 6, before: 0 })).toBe(0);
      expect(await store.pruneSnapshots(id, { after: -1, before: 6 })).toBe(2);
      expect(await seqs(id)).toEqual([6]);
      await store.deleteExecution(id);
      await store.deleteExecution(other);
    });
  });

  describe("PostgresBranchRegistry", () => {
    let reg: PostgresBranchRegistry;
    let clock: number;
    beforeEach(() => {
      clock = 1000;
      reg = new PostgresBranchRegistry(PG_URL as string, { now: () => clock });
    });
    afterEach(async () => {
      await reg.close();
    });

    it("upserts refs, moves tips, and promotes (pick-a-winner)", async () => {
      await reg.putRef({ name: "main", executionId: "x1", tip: 5, createdAt: 1, updatedAt: 1 });
      await reg.putRef({
        name: "spec",
        executionId: "x2",
        tip: 8,
        parentExecutionId: "x1",
        forkSequence: 5,
        createdAt: 2,
        updatedAt: 2,
      });

      expect((await reg.getRef("main"))?.executionId).toBe("x1");
      expect((await reg.listRefs()).map((r) => r.name)).toEqual(["main", "spec"]);

      await reg.moveTip("main", 9);
      expect((await reg.getRef("main"))?.tip).toBe(9);

      await reg.promote("spec", "main"); // main now points at spec's execution
      const main = await reg.getRef("main");
      expect(main?.executionId).toBe("x2");
      expect(main?.tip).toBe(8);

      await reg.deleteRef("spec");
      expect(await reg.getRef("spec")).toBeNull();
    });

    it("records and queries lineage (fork DAG)", async () => {
      await reg.recordLineage({ executionId: "c1", parentExecutionId: "p", forkSequence: 3 });
      await reg.recordLineage({ executionId: "c2", parentExecutionId: "p", forkSequence: 7 });

      expect((await reg.getLineage("c1"))?.parentExecutionId).toBe("p");
      const kids = await reg.children("p");
      expect(kids.map((k) => k.executionId).sort()).toEqual(["c1", "c2"]);
    });

    it("throws when promoting a non-existent ref", async () => {
      await expect(reg.promote("ghost", "main")).rejects.toThrow();
    });
  });

  describe("replay parity — Postgres vs SQLite", () => {
    it("folds a workflow-shaped event stream to identical state on both backends", async () => {
      const stream: EventEnvelope[] = [
        {
          id: "x-0",
          workflowId: "wf",
          executionId: "x",
          eventType: "EXECUTION_STARTED",
          sequence: 0,
          timestamp: 1,
          payload: { input: { incidentId: "i1" } },
        },
        {
          id: "x-1",
          workflowId: "wf",
          executionId: "x",
          eventType: "STEP_STARTED",
          sequence: 1,
          timestamp: 2,
          payload: { stepId: "diagnose", input: { incidentId: "i1" } },
        },
        {
          id: "x-2",
          workflowId: "wf",
          executionId: "x",
          eventType: "STEP_COMPLETED",
          sequence: 2,
          timestamp: 3,
          payload: { stepId: "diagnose", output: { cpu: 87, notes: ["OOM", "spike"] } },
        },
        {
          id: "x-3",
          workflowId: "wf",
          executionId: "x",
          eventType: "DECISION_RECORDED",
          sequence: 3,
          timestamp: 4,
          payload: { decisionId: "route:model", choice: "opus", source: "reasoning" },
        },
        {
          id: "x-4",
          workflowId: "wf",
          executionId: "x",
          eventType: "EXECUTION_COMPLETED",
          sequence: 4,
          timestamp: 5,
          payload: { output: { resolved: true } },
        },
      ];

      const pg = new PostgresEventStore(PG_URL as string);
      const dir = mkdtempSync(join(tmpdir(), "loom-pg-parity-"));
      const sqlite = new SqliteEventStore(join(dir, "events.db"));
      try {
        for (const e of stream) {
          await pg.append(e);
          await sqlite.append(e);
        }
        const pgEvents = await pg.read("x");
        const sqliteEvents = await sqlite.read("x");

        const initial = { executionId: "x", workflowId: "wf", workflowVersion: "1.0.0" };
        const pgState = foldEvents(pgEvents, initial);
        const sqliteState = foldEvents(sqliteEvents, initial);

        expect(pgState).toEqual(sqliteState);
        expect(pgState.status).toBe("completed");
        expect(pgState.frames.diagnose?.output).toEqual({ cpu: 87, notes: ["OOM", "spike"] });
        expect(
          (pgState.variables._decisions as Record<string, unknown>)["route:model"]
        ).toMatchObject({ choice: "opus" });
      } finally {
        await pg.close();
        sqlite.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("PostgresLeaseStore — the race it exists to lose loudly (#380)", () => {
    it("grants exactly one of many simultaneous acquires", async () => {
      // The conformance kit checks the CONTRACT with an injected clock, sequentially. This
      // checks the thing a lease is for: read-then-write would let several nodes each observe
      // a free lease and all take it, and only real concurrency can catch that.
      const store = new PostgresLeaseStore(admin);
      const contenders = Array.from({ length: 12 }, (_, i) => `node-${i}`);
      const results = await Promise.all(
        contenders.map((owner) => store.acquire("hot-execution", owner, 30_000))
      );
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);

      // And the winner is the one the store agrees about, not merely the one that returned.
      const [held] = await store.expired(Number.MAX_SAFE_INTEGER);
      expect(held?.owner).toBe(winners[0]?.owner);
      await store.release("hot-execution", winners[0]?.owner as string);
      await store.close();
    });

    it("hands an expired lease to exactly one of many waiting nodes", async () => {
      const store = new PostgresLeaseStore(admin);
      await store.acquire("expiring", "original", 1, Date.now() - 10_000); // long gone
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.acquire("expiring", `taker-${i}`, 30_000))
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      await store.close();
    });

    // L29: skew between NODES must not matter, because stamping and judging use DB time.
    describe("one clock for every node (L29)", () => {
      const HOUR = 3_600_000;
      const ttl = 60_000;
      // Run `fn` with this node's process clock skewed by `offset` ms.
      const onNode = async <T>(offset: number, fn: () => Promise<T>): Promise<T> => {
        const real = Date.now();
        const spy = vi.spyOn(Date, "now").mockImplementation(() => real + offset);
        try {
          return await fn();
        } finally {
          spy.mockRestore();
        }
      };

      it("a fast-clocked node cannot steal a live lease held by a slow-clocked node", async () => {
        const slow = new PostgresLeaseStore(admin);
        const fast = new PostgresLeaseStore(admin);
        const id = `skew-steal-${Date.now()}`;
        try {
          const held = await onNode(-HOUR, () => slow.acquire(id, "slow", ttl));
          expect(held).not.toBeNull();
          const stolen = await onNode(+HOUR, () => fast.acquire(id, "fast", ttl));
          expect(stolen).toBeNull();
          expect((await slow.get(id))?.owner).toBe("slow");
        } finally {
          await slow.release(id, "slow");
          await slow.close();
          await fast.close();
        }
      });

      it("a slow node's healthy lease is not seen as expired, and expiry is DB time", async () => {
        const slow = new PostgresLeaseStore(admin);
        const fast = new PostgresLeaseStore(admin);
        const id = `skew-expired-${Date.now()}`;
        try {
          const before = await slow.storeNow();
          const held = await onNode(-HOUR, () => slow.acquire(id, "slow", ttl));
          const after = await slow.storeNow();
          // Stamped on the DB clock (bracketed by two DB readings), not the skewed process
          // clock. No assumption that the test host and the DB share a clock.
          expect(held?.expiresAt).toBeGreaterThanOrEqual(before + ttl);
          expect(held?.expiresAt).toBeLessThanOrEqual(after + ttl);
          expect(await slow.renew(id, "slow", ttl)).toBe(true);
          const seen = await onNode(+HOUR, () => fast.expired());
          expect(seen.map((l) => l.executionId)).not.toContain(id);
          expect(await onNode(-HOUR, () => slow.renew(id, "slow", ttl))).toBe(true);
          const seenAfterRenew = await onNode(+HOUR, () => fast.expired());
          expect(seenAfterRenew.map((l) => l.executionId)).not.toContain(id);
        } finally {
          await slow.release(id, "slow");
          await slow.close();
          await fast.close();
        }
      });

      it("a genuinely expired lease is still taken over on DB time", async () => {
        const store = new PostgresLeaseStore(admin);
        const id = `skew-takeover-${Date.now()}`;
        try {
          await store.acquire(id, "old", 1, Date.now() - HOUR); // explicit now: long gone
          expect((await store.expired()).map((l) => l.executionId)).toContain(id);
          expect(await store.acquire(id, "new", ttl)).toMatchObject({ owner: "new" });
        } finally {
          await store.release(id, "new");
          await store.close();
        }
      });

      it("storeNow() reads the DB clock, not the process clock", async () => {
        const store = new PostgresLeaseStore(admin);
        try {
          const a = await store.storeNow();
          const skewed = await onNode(+HOUR, () => store.storeNow());
          const b = await store.storeNow();
          expect(skewed).toBeGreaterThanOrEqual(a);
          expect(skewed).toBeLessThanOrEqual(b);
        } finally {
          await store.close();
        }
      });

      it("a fractional ttl is rounded up rather than rejected by bigint", async () => {
        const store = new PostgresLeaseStore(admin);
        const id = `frac-ttl-${Date.now()}`;
        try {
          expect(await store.acquire(id, "a", 1_000.4, 1_000)).toMatchObject({ expiresAt: 2_001 });
          expect(await store.renew(id, "a", 2_500.2, 1_000)).toBe(true);
          expect(await store.get(id)).toMatchObject({ expiresAt: 3_501 });
        } finally {
          await store.release(id, "a");
          await store.close();
        }
      });

      it("expired() with no `now` uses idx_leases_expiry (an Index Cond, no per-row Filter)", async () => {
        const store = new PostgresLeaseStore(admin);
        await store.expired(); // ensure migrated
        const pool = admin;
        try {
          // Enough rows, and index-only preference forced, so the planner choice is about the
          // expression's volatility rather than a tiny-table seq scan.
          await pool.query(
            `INSERT INTO leases (execution_id, owner, expires_at)
             SELECT 'idx-' || g, 'o', 9000000000000 + g FROM generate_series(1, 20000) g
             ON CONFLICT DO NOTHING`
          );
          await pool.query("ANALYZE leases");
          const c = await pool.connect();
          try {
            await c.query("SET enable_seqscan = off");
            const { rows } = await c.query(`EXPLAIN (FORMAT JSON) ${EXPIRED_SQL}`, [null, 100]);
            const plan = JSON.stringify(rows[0]["QUERY PLAN"]);
            expect(plan).toContain("Index Cond");
            expect(plan).not.toContain('"Filter"');
          } finally {
            await c.query("RESET enable_seqscan");
            c.release();
          }
        } finally {
          await pool.query("DELETE FROM leases WHERE execution_id LIKE 'idx-%'");
          await store.close();
        }
      });

      it("an explicit `now` is still honoured for stamping, renewing and judging", async () => {
        const store = new PostgresLeaseStore(admin);
        const id = `explicit-now-${Date.now()}`;
        try {
          expect(await store.acquire(id, "a", 500, 1_000)).toMatchObject({ expiresAt: 1_500 });
          expect(await store.acquire(id, "b", 500, 1_499)).toBeNull();
          expect(await store.acquire(id, "b", 500, 1_500)).toMatchObject({ owner: "b" });
          expect(await store.renew(id, "b", 500, 2_000)).toBe(true);
          expect(await store.get(id)).toMatchObject({ expiresAt: 2_500 });
          expect((await store.expired(2_499)).map((l) => l.executionId)).not.toContain(id);
          expect((await store.expired(2_500)).map((l) => l.executionId)).toContain(id);
        } finally {
          await store.release(id, "b");
          await store.close();
        }
      });
    });
  });
});
