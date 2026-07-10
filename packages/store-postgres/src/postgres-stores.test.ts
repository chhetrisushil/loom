import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import { SqliteEventStore } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import type { Snapshot } from "@loom/snapshot-runtime";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresBranchRegistry } from "./PostgresBranchRegistry";
import { PostgresEventStore } from "./PostgresEventStore";
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

suite("@loom/store-postgres", () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_URL });
    await migrate(admin);
  });

  afterAll(async () => {
    await admin.end();
  });

  beforeEach(async () => {
    await admin.query("TRUNCATE events, snapshots, refs, lineage, fences, timers");
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

    it("rejects duplicate (executionId, sequence) pairs", async () => {
      await store.append(makeEnvelope("e4", 0));
      await expect(store.append(makeEnvelope("e4", 0))).rejects.toThrow();
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
        const got = new Promise<void>((resolve) => {
          void nodeB.subscribe("shared", (e) => {
            received.push(e);
            resolve();
          });
        });
        // Give node B's LISTEN a moment to register before node A appends.
        await new Promise((r) => setTimeout(r, 100));
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
});
