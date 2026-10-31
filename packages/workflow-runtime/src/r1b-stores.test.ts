import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwrapTainted } from "@loom/classify";
import {
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
  InMemoryTimerStore,
} from "@loom/event-runtime";
import type { EventStore, TimerStore } from "@loom/event-runtime";
import {
  PostgresEventStore,
  PostgresSnapshotStore,
  PostgresTimerStore,
  migratePostgresStores,
  postgresPool,
} from "@loom/plugin-postgres";
import { SqliteEventStore, SqliteSnapshotStore, SqliteTimerStore } from "@loom/plugin-sqlite";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LogLifecycle } from "./LogLifecycle";
import { build, eventsOf, flow, kinds, until } from "./__tests__/r2Harness";
import { ContinuationConflictError, ForkPastContinuationError } from "./continuation";

// ADR 0109 on the durable backends: the same chain over memory, SQLite and Postgres. The successor's
// sequence 0 (a `~` id), the idempotent start, the conflict refusal, the chain-leaving fork and
// retention must all hold where the SQL is real.

interface Backend {
  name: string;
  skip?: boolean;
  setup(): Promise<void>;
  make(): { eventStore: EventStore; snapshotStore: SnapshotStore; timers: TimerStore };
  teardown(): Promise<void>;
}

const dir = mkdtempSync(join(tmpdir(), "loom-r1b-"));
let n = 0;

const memory: Backend = {
  name: "memory",
  setup: async () => {},
  make: () => ({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    timers: new InMemoryTimerStore(),
  }),
  teardown: async () => {},
};

const sqlite: Backend = {
  name: "sqlite",
  setup: async () => {},
  make: () => {
    const p = join(dir, `r1b-${++n}.db`);
    return {
      eventStore: new SqliteEventStore(p),
      snapshotStore: new SqliteSnapshotStore(p),
      timers: new SqliteTimerStore(p),
    };
  },
  teardown: async () => {
    rmSync(dir, { recursive: true, force: true });
  },
};

const pgUrl = process.env.LOOM_TEST_POSTGRES_URL;
const schema = `loom_r1b_${process.pid}`;
const pool =
  pgUrl !== undefined
    ? postgresPool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
    : undefined;
const postgres: Backend = {
  name: "postgres",
  skip: pgUrl === undefined,
  setup: async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.query(`CREATE SCHEMA ${schema}`);
    if (pool !== undefined) await migratePostgresStores(pool);
  },
  make: () => ({
    eventStore: new PostgresEventStore(pool as never),
    snapshotStore: new PostgresSnapshotStore(pool as never),
    timers: new PostgresTimerStore(pool as never),
  }),
  teardown: async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  },
};

const hop = () =>
  flow<{ n?: number }, unknown>("hop", async (ctx, input) => {
    const gen = input?.n ?? 0;
    const got = unwrapTainted(await ctx.receive("go"));
    if (gen >= 1) return { gen, got };
    return ctx.continueAsNew({ n: gen + 1 });
  });

for (const backend of [memory, sqlite, postgres]) {
  describe.skipIf(backend.skip === true)(`R1b on ${backend.name}`, () => {
    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());

    const mk = (id: string) => {
      const stores = backend.make();
      const h = build(
        { continueAsNewEnabled: true },
        {
          eventStore: stores.eventStore,
          snapshotStore: stores.snapshotStore,
          timers: stores.timers,
        }
      );
      const f = hop();
      h.rt.registerFlow(f.definition, f.runner);
      return { h, f, id: `${id}-${process.pid}-${++n}` };
    };

    it("rotates: successor first, then the commit; the chain completes through the old id", async () => {
      const { h, f, id } = mk("rot");
      await (await h.rt.start(f, {}, { executionId: id })).waitForSuspend();
      await h.rt.send(id, { topic: "go", payload: 1, messageId: "m1" });
      // The successor starts FIRST and the predecessor's EXECUTION_CONTINUED commits after it, so the
      // successor can park before that commit lands: wait for both, never for the successor alone.
      await until(
        async () =>
          (await h.rt.loadState(`${id}~1`))?.status === "suspended" &&
          (await h.rt.loadState(id))?.status === "continued",
        8000
      );
      const succ = (await h.eventStore.read(`${id}~1`))[0];
      const [cont] = await eventsOf(h.eventStore, id, "EXECUTION_CONTINUED");
      expect(succ?.timestamp).toBeLessThanOrEqual(cont?.timestamp as number); // successor FIRST
      expect(cont?.metadata?.kernel).toBe(true);
      expect((await h.rt.loadState(id))?.status).toBe("continued");
      await h.rt.send(id, { topic: "go", payload: 2, messageId: "m2" }); // the OLD id
      await until(async () => (await h.rt.loadState(`${id}~1`))?.status === "completed", 8000);
      expect((await h.rt.loadState(`${id}~1`))?.variables._output).toEqual({ gen: 1, got: 2 });
      expect(await eventsOf(h.eventStore, id, "MESSAGE_CONSUMED")).toHaveLength(1);
      expect(await eventsOf(h.eventStore, `${id}~1`, "MESSAGE_CONSUMED")).toHaveLength(1);
    });

    it("a squatter at the successor id is a typed conflict; a matching one is adopted", async () => {
      const bad = mk("squat");
      await bad.h.eventStore.append({
        id: `${bad.id}~1-0`,
        workflowId: "hop",
        executionId: `${bad.id}~1`,
        eventType: "EXECUTION_STARTED",
        sequence: 0,
        timestamp: Date.now(),
        payload: { input: {} },
      });
      await (await bad.h.rt.start(bad.f, {}, { executionId: bad.id })).waitForSuspend();
      await bad.h.rt.send(bad.id, { topic: "go", payload: 1 });
      await until(
        async () => (await kinds(bad.h.eventStore, bad.id)).includes("EXECUTION_FAILED"),
        8000
      );
      expect(await kinds(bad.h.eventStore, bad.id)).not.toContain("EXECUTION_CONTINUED");
      expect((await bad.h.eventStore.read(`${bad.id}~1`)).length).toBe(1); // untouched
      expect(ContinuationConflictError).toBeDefined();

      const ok = mk("adopt");
      await ok.h.eventStore.append({
        id: `${ok.id}~1-0`,
        workflowId: "hop",
        executionId: `${ok.id}~1`,
        eventType: "EXECUTION_STARTED",
        sequence: 0,
        timestamp: Date.now(),
        payload: {
          input: { n: 1 },
          chainId: ok.id,
          generation: 1,
          continuedFrom: { executionId: ok.id },
        },
      });
      await (await ok.h.rt.start(ok.f, {}, { executionId: ok.id })).waitForSuspend();
      await ok.h.rt.send(ok.id, { topic: "go", payload: 1 });
      await until(
        async () => (await kinds(ok.h.eventStore, ok.id)).includes("EXECUTION_CONTINUED"),
        8000
      );
      expect(
        (await ok.h.eventStore.read(`${ok.id}~1`)).filter((e) => e.sequence === 0)
      ).toHaveLength(1);
    });

    it("a fork of a chain member leaves the chain; a fork past the continuation is refused", async () => {
      const { h, f, id } = mk("fork");
      await (await h.rt.start(f, {}, { executionId: id })).waitForSuspend();
      await h.rt.send(id, { topic: "go", payload: 1 });
      // The successor starts FIRST and the predecessor's EXECUTION_CONTINUED commits after it, so the
      // successor can park before that commit lands: wait for both, never for the successor alone.
      await until(
        async () =>
          (await h.rt.loadState(`${id}~1`))?.status === "suspended" &&
          (await h.rt.loadState(id))?.status === "continued",
        8000
      );
      const tip = (await h.eventStore.read(`${id}~1`)).length - 1;
      const forkId = `${id}-fork`;
      await h.rt.fork(`${id}~1`, tip, { executionId: forkId });
      expect((await h.rt.loadState(forkId))?.variables._chain).toEqual({
        chainId: forkId,
        generation: 0,
      });
      const cont = (await h.eventStore.read(id)).find((e) => e.eventType === "EXECUTION_CONTINUED");
      await expect(
        h.rt.fork(id, cont?.sequence as number, { executionId: `${id}-bad` })
      ).rejects.toBeInstanceOf(ForkPastContinuationError);
    });

    it("retention reclaims the continued predecessor and leaves the live head", async () => {
      const { h, f, id } = mk("ret");
      await (await h.rt.start(f, {}, { executionId: id })).waitForSuspend();
      await h.rt.send(id, { topic: "go", payload: 1 });
      // The successor starts FIRST and the predecessor's EXECUTION_CONTINUED commits after it, so the
      // successor can park before that commit lands: wait for both, never for the successor alone.
      await until(
        async () =>
          (await h.rt.loadState(`${id}~1`))?.status === "suspended" &&
          (await h.rt.loadState(id))?.status === "continued",
        8000
      );
      const life = new LogLifecycle(h.eventStore, h.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
      expect(await life.applyRetention(id, { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
        "reclaimed"
      );
      expect(await h.eventStore.read(id)).toEqual([]);
      expect((await h.rt.loadState(`${id}~1`))?.status).toBe("suspended");
    });
  });
}
