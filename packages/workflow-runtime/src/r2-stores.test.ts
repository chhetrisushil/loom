import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwrapTainted } from "@loom/classify";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
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
import { TimerService } from "./TimerService";
import { Latch, build, eventsOf, flow, kinds, slow, tick, until } from "./__tests__/r2Harness";
import { appendInboxMessage, inboxStreamId } from "./inbox";

// ADR 0110 on the durable backends: the same protocol over memory, SQLite and Postgres. The
// inbox stream's head() allocation, truncatePrefixKeeping trim, the atomic appendBatch pair and
// the acquire-if-parked notify must all hold where the SQL is real.

interface Backend {
  name: string;
  skip?: boolean;
  setup(): Promise<void>;
  make(): {
    eventStore: EventStore;
    snapshotStore: SnapshotStore;
    timers: TimerStore;
  };
  teardown(): Promise<void>;
}

const dir = mkdtempSync(join(tmpdir(), "loom-r2-"));
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
    const p = join(dir, `r2-${++n}.db`);
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
const schema = `loom_r2_${process.pid}`;
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

for (const backend of [memory, sqlite, postgres]) {
  describe.skipIf(backend.skip === true)(`R2 on ${backend.name}`, () => {
    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());
    let seq = 0;
    const id = () => `${backend.name}-e${++seq}-${Math.random().toString(36).slice(2, 6)}`;
    const mk = (deps = {}, opts: Parameters<typeof build>[1] = {}) =>
      build(deps, { ...backend.make(), ...opts });
    const recv = (topic = "x") =>
      flow("w", async (ctx) => unwrapTainted(await ctx.receive<string>(topic)));
    const done = (h: ReturnType<typeof build>, e: string) =>
      until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);

    it("receive-before-send, send-before-receive: each delivered exactly once", async () => {
      const h = mk();
      const f = recv();
      h.rt.registerFlow(f.definition, f.runner);
      const a = id();
      await (await h.rt.start(f, {}, { executionId: a })).waitForSuspend();
      await h.rt.send(a, { topic: "x", payload: "A", messageId: "a1" });
      await done(h, a);
      expect((await h.rt.loadState(a))?.variables._output).toBe("A");
      expect((await eventsOf(h.eventStore, a, "MESSAGE_CONSUMED")).length).toBe(1);

      const latch = new Latch();
      const h2 = mk({}, { latch });
      const g = flow("busy", async (ctx) => {
        await ctx.run(slow, {});
        return unwrapTainted(await ctx.receive<string>("x"));
      });
      h2.rt.registerFlow(g.definition, g.runner);
      const b = id();
      const run = await h2.rt.start(g, {}, { executionId: b });
      await tick(30);
      await h2.rt.send(b, { topic: "x", payload: "B" });
      latch.release();
      await run.waitForCompletion();
      expect((await h2.rt.loadState(b))?.variables._output).toBe("B");
      expect(await kinds(h2.eventStore, b)).not.toContain("EXECUTION_SUSPENDED");
      expect((await eventsOf(h2.eventStore, b, "MESSAGE_CONSUMED")).length).toBe(1);
    });

    it("concurrent senders: unique head+1 sequences and per-topic FIFO", async () => {
      const h = mk();
      const N = 15;
      const f = flow("w", async (ctx) => {
        const got: number[] = [];
        for (let i = 0; i < N; i++) got.push(unwrapTainted(await ctx.receive<number>("q")));
        return got;
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      // two "processes" (runtimes) racing the store's (executionId, sequence) uniqueness
      const other = h.sibling();
      const res = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          (i % 2 === 0 ? h.rt : other).send(e, { topic: "q", payload: i })
        )
      );
      await done(h, e);
      expect(new Set(res.map((r) => r.inboxSeq)).size).toBe(N);
      const expected = res
        .map((r, i) => ({ s: r.inboxSeq, p: i }))
        .sort((x, y) => x.s - y.s)
        .map((x) => x.p);
      expect((await h.rt.loadState(e))?.variables._output).toEqual(expected);
    });

    it("a send from another process wakes the owner through the durable row; the pair is one atomic write", async () => {
      const h = mk();
      const f = recv();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await h.sibling().send(e, { topic: "x", payload: "far" });
      expect((await h.timers.due(Date.now())).filter((t) => t.executionId === e).length).toBe(1);
      await new TimerService(h.rt, h.timers).tick(Date.now());
      await done(h, e);
      expect((await h.rt.loadState(e))?.variables._output).toBe("far");
      const log = await h.eventStore.read(e);
      const c = log.find((x) => x.eventType === "MESSAGE_CONSUMED");
      const r = log.find((x) => x.eventType === "EXECUTION_RESUMED");
      expect(r?.sequence).toBe((c?.sequence as number) + 1); // adjacent: one batch
      expect(r?.metadata?.kernel).toBe(true);
    });

    it("a gap arrival (appended after the park) is found by the post-park re-read", async () => {
      const inner = backend.make();
      const view = Object.create(inner.eventStore) as EventStore;
      const e = id();
      let injected = false;
      view.append = async (env) => {
        await inner.eventStore.append(env);
        if (env.eventType === "EXECUTION_SUSPENDED" && env.executionId === e && !injected) {
          injected = true;
          await appendInboxMessage(
            inner.eventStore,
            e,
            { topic: "x", messageId: "gap", payload: "gap", sender: {} },
            Date.now
          );
        }
      };
      const h = build({}, { ...inner, eventStore: view });
      const f = recv();
      h.rt.registerFlow(f.definition, f.runner);
      await h.rt.start(f, {}, { executionId: e });
      await done(h, e);
      expect((await h.rt.loadState(e))?.variables._output).toBe("gap");
      expect((await eventsOf(inner.eventStore, e, "MESSAGE_CONSUMED")).length).toBe(1);
    });

    it("two notifiers racing one park deliver once (acquire-if-parked where the store has it)", async () => {
      const h = mk();
      const f = recv();
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      const other = h.sibling();
      other.registerFlow(f.definition, f.runner);
      await appendInboxMessage(
        h.eventStore,
        e,
        { topic: "x", messageId: "m", payload: "once", sender: {} },
        Date.now
      );
      await Promise.all([h.rt.notifyInbox(e), other.notifyInbox(e)]);
      await done(h, e);
      expect((await h.rt.loadState(e))?.variables._output).toBe("once");
      expect((await eventsOf(h.eventStore, e, "EXECUTION_RESUMED")).length).toBe(1);
    });

    it("trim keeps the unconsumed and the head; the terminal deletes the stream", async () => {
      const h = mk();
      const f = flow("w", async (ctx) => {
        const got: string[] = [];
        for (let i = 0; i < 3; i++) got.push(unwrapTainted(await ctx.receive<string>("a")));
        await ctx.suspend({ on: "hold" });
        return got;
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      for (const [topic, p] of [
        ["a", "a1"],
        ["a", "a2"],
        ["b", "b1"],
        ["a", "a3"],
      ] as const) {
        await appendInboxMessage(
          h.eventStore,
          e,
          { topic, messageId: p, payload: p, sender: {} },
          Date.now
        );
      }
      await h.rt.notifyInbox(e);
      await until(async () => (await h.rt.loadState(e))?.suspendedOn?.on === "hold", 8000);
      await tick(80);
      const left = (await h.eventStore.read(inboxStreamId(e))).map((x) => x.sequence);
      expect(left).toContain(2);
      expect(left).toContain(3);
      expect(left).not.toContain(1);
      // the head turning terminal deletes the stream with it (nothing can ever consume it)
      const fence = await h.eventStore.acquireFence?.(e);
      await h.rt.resume(e, { eventType: "hold", payload: { ok: true } }, { fence });
      await done(h, e);
      await tick(80);
      expect(await h.eventStore.read(inboxStreamId(e))).toEqual([]);
      const life = new LogLifecycle(h.eventStore, h.snapshotStore);
      expect(await life.applyRetention(e, { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
        "reclaimed"
      );
    });

    it("backpressure: InboxFullError at the backlog, owner's log untouched", async () => {
      const h = mk({ inboxMaxBacklog: 4 });
      const f = recv("never");
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      for (let i = 0; i < 4; i++) await h.rt.send(e, { topic: "other", payload: i });
      const before = await kinds(h.eventStore, e);
      await expect(h.rt.send(e, { topic: "other", payload: 9 })).rejects.toMatchObject({
        name: "InboxFullError",
      });
      expect(await kinds(h.eventStore, e)).toEqual(before);
    });
  });
}
