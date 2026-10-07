import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
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
import { foldEvents } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LogLifecycle } from "./LogLifecycle";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { Latch, build, flow, slow, until } from "./__tests__/r2Harness";
import type { Harness } from "./__tests__/r2Harness";
import { executionAccessPolicy } from "./executionAccessPolicy";
import { ExecutionDeniedError, ExecutionNotTerminalError, OutcomeRefusedError } from "./types";

// ADR 0116 (R11) — `recordOutcome`: a late reward on a FINISHED execution, authorized as
// `annotate`, terminal-only, sequence-CAS, no fence, kernel-stamped. Over memory, SQLite, Postgres.

interface Backend {
  name: string;
  skip?: boolean;
  setup(): Promise<void>;
  make(): { eventStore: EventStore; snapshotStore: SnapshotStore; timers: TimerStore };
  teardown(): Promise<void>;
}
const dir = mkdtempSync(join(tmpdir(), "loom-r11-"));
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
    const p = join(dir, `r11-${++n}.db`);
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
const schema = `loom_r11_${process.pid}`;
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

const alice = { tenant: "acme", actor: "alice" };
const mallory = { tenant: "evil", actor: "mallory" };

for (const backend of [memory, sqlite, postgres]) {
  describe.skipIf(backend.skip === true)(`R11 recordOutcome on ${backend.name}`, () => {
    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());
    let seq = 0;
    const id = () => `${backend.name}-o${++seq}-${Math.random().toString(36).slice(2, 6)}`;
    const mk = (deps = {}, opts: Parameters<typeof build>[1] = {}): Harness =>
      build(deps, { ...backend.make(), ...opts });
    const authz = { executionAuthorizer: executionAccessPolicy() };

    // decide, then finish (or park / fail).
    const deciding = flow("decider", async (ctx) => {
      await ctx.decide("route", () => "opus");
      return { done: true };
    });
    const parking = flow("parker", async (ctx) => {
      await ctx.decide("route", () => "opus");
      await ctx.suspend({ on: "GO" });
      return { done: true };
    });
    const failing = flow("failer", async (ctx) => {
      await ctx.decide("route", () => "opus");
      throw new Error("boom");
    });
    const finish = async (h: Harness, f: typeof deciding, e: string, principal?: object) => {
      h.rt.registerFlow(f.definition, f.runner);
      const run = await h.rt.start(f, {}, { executionId: e, ...(principal && { principal }) });
      await run.waitForCompletion().catch(() => undefined);
    };
    const outcomes = async (h: Harness, e: string) =>
      (await h.eventStore.read(e)).filter((x) => x.eventType === "OUTCOME_RECORDED");

    it("attaches to a completed execution: stamped, status unchanged, folded", async () => {
      const h = mk(authz);
      const e = id();
      await finish(h, deciding, e, alice);
      const before = (await h.eventStore.read(e)).length;
      const r = await h.rt.recordOutcome(
        e,
        { decisionId: "route", key: "opus", score: 0.8, success: true },
        { principal: alice }
      );
      expect(r).toEqual({ appended: true, sequence: before });
      const state = await h.rt.loadState(e, { principal: alice });
      expect(state?.status).toBe("completed");
      expect(state?.variables._outcomes).toEqual([
        {
          key: "opus",
          success: true,
          score: 0.8,
          decisionId: "route",
          recordedBy: "alice",
          late: true,
        },
      ]);
      const [ev] = await outcomes(h, e);
      expect(ev?.metadata?.kernel).toBe(true);
    });

    it("attaches to a failed execution too, as the system", async () => {
      const h = mk({ ...authz, executionAuthz: { requirePrincipal: true } });
      const e = id();
      await finish(h, failing, e, alice);
      await h.rt.recordOutcome(
        e,
        { decisionId: "route", key: "opus", success: false },
        h.rt.systemOptions()
      );
      const state = await h.rt.loadState(e, h.rt.systemOptions());
      expect(state?.status).toBe("failed");
      expect((state?.variables._outcomes as { recordedBy: string }[])[0]?.recordedBy).toBe(
        "system"
      );
    });

    it("refuses a parked execution and the holder's next append still lands", async () => {
      const h = mk();
      const e = id();
      h.rt.registerFlow(parking.definition, parking.runner);
      const run = await h.rt.start(parking, {}, { executionId: e });
      await run.waitForSuspend();
      const len = (await h.eventStore.read(e)).length;
      await expect(
        h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 })
      ).rejects.toBeInstanceOf(ExecutionNotTerminalError);
      expect((await h.eventStore.read(e)).length).toBe(len);
      // The negative: a fence acquired by the attach would have superseded this resume.
      await (await h.rt.resume(e, { eventType: "GO", payload: {} })).waitForCompletion();
      expect((await h.rt.loadState(e))?.status).toBe("completed");
    });

    it("refuses a RUNNING execution without disturbing it", async () => {
      const latch = new Latch();
      const h = mk({}, { latch });
      const e = id();
      const running = flow("runner", async (ctx) => {
        await ctx.decide("route", () => "opus");
        await ctx.run(slow, {});
        return {};
      });
      h.rt.registerFlow(running.definition, running.runner);
      const run = await h.rt.start(running, {}, { executionId: e });
      await until(async () =>
        (await h.eventStore.read(e)).some((x) => x.eventType === "STEP_STARTED")
      );
      await expect(
        h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 })
      ).rejects.toBeInstanceOf(ExecutionNotTerminalError);
      latch.release();
      await run.waitForCompletion();
      expect((await h.rt.loadState(e))?.status).toBe("completed");
      expect(await outcomes(h, e)).toEqual([]);
    });

    it("two concurrent identical calls: exactly one append", async () => {
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      const o = { decisionId: "route", key: "opus", score: 1 };
      const res = await Promise.all([h.rt.recordOutcome(e, o), h.rt.recordOutcome(e, o)]);
      expect(res.map((r) => r.appended).sort()).toEqual([false, true]);
      expect((await outcomes(h, e)).length).toBe(1);
    });

    it("concurrent DIFFERENT outcomes: both land (CAS retry), sequences contiguous", async () => {
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      const keys = ["a", "b", "c", "d"];
      const res = await Promise.all(
        keys.map((key) => h.rt.recordOutcome(e, { decisionId: "route", key, score: 1 }))
      );
      expect(res.every((r) => r.appended)).toBe(true);
      const evs = await h.eventStore.read(e);
      expect(evs.map((x) => x.sequence)).toEqual(evs.map((_, i) => i));
      expect((await outcomes(h, e)).length).toBe(keys.length);
    });

    it("idempotent across retries and across a rebooted runtime", async () => {
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      const o = { decisionId: "route", key: "opus", score: 0.5 };
      expect((await h.rt.recordOutcome(e, o)).appended).toBe(true);
      expect((await h.rt.recordOutcome(e, o)).appended).toBe(false);
      const sib = h.sibling();
      sib.registerFlow(deciding.definition, deciding.runner);
      expect((await sib.recordOutcome(e, o)).appended).toBe(false);
      expect((await outcomes(h, e)).length).toBe(1);
    });

    it("refuses a conflicting score, an unknown decision, and malformed outcomes; nothing appended", async () => {
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      await h.rt.recordOutcome(e, { decisionId: "route", key: "opus", score: 0.5 });
      const len = (await h.eventStore.read(e)).length;
      const bad: Array<Parameters<WorkflowRuntime["recordOutcome"]>[1]> = [
        { decisionId: "route", key: "opus", score: 0.9 },
        { decisionId: "invented", key: "opus", score: 1 },
        { decisionId: "__proto__", key: "opus", score: 1 },
        { decisionId: "route", key: "", score: 1 },
        { decisionId: "route", key: "x", score: Number.NaN },
        { decisionId: "route", key: "x" },
      ];
      for (const o of bad) {
        await expect(h.rt.recordOutcome(e, o)).rejects.toBeInstanceOf(OutcomeRefusedError);
      }
      expect((await h.eventStore.read(e)).length).toBe(len);
    });

    it("unauthorized principal is refused and the log is untouched", async () => {
      const denied: string[] = [];
      const h = mk({ ...authz, onExecutionDenied: (r: { op: string }) => denied.push(r.op) });
      const e = id();
      await finish(h, deciding, e, alice);
      const before = await h.eventStore.read(e);
      await expect(
        h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 }, { principal: mallory })
      ).rejects.toBeInstanceOf(ExecutionDeniedError);
      expect(denied).toEqual(["annotate"]);
      expect(await h.eventStore.read(e)).toEqual(before);
    });

    it("strict: a principal-less call is refused; so is one for a missing execution", async () => {
      const h = mk({ ...authz, executionAuthz: { requirePrincipal: true } });
      const e = id();
      await finish(h, deciding, e, alice);
      const before = (await h.eventStore.read(e)).length;
      await expect(
        h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 })
      ).rejects.toBeInstanceOf(ExecutionDeniedError);
      await expect(
        h.rt.recordOutcome("nope", { decisionId: "route", key: "k", score: 1 })
      ).rejects.toBeInstanceOf(ExecutionDeniedError);
      expect((await h.eventStore.read(e)).length).toBe(before);
      expect(
        (
          await h.rt.recordOutcome(
            e,
            { decisionId: "route", key: "k", score: 1 },
            { principal: alice }
          )
        ).appended
      ).toBe(true);
    });

    it("a missing execution is an error, not an append", async () => {
      const h = mk();
      await expect(
        h.rt.recordOutcome("ghost", { decisionId: "route", key: "k", score: 1 })
      ).rejects.toThrow(/No execution found/);
    });

    it("a userspace ctx.emit cannot forge recordedBy / late; the fold ignores them unstamped", async () => {
      const h = mk();
      const e = id();
      const forger = flow("forger", async (ctx) => {
        await ctx.decide("route", () => "opus");
        const refused: string[] = [];
        for (const extra of [{ recordedBy: "root" }, { late: true }]) {
          try {
            await ctx.emit("OUTCOME_RECORDED", { key: "opus", decisionId: "route", ...extra });
          } catch {
            refused.push(Object.keys(extra)[0] as string);
          }
        }
        return { refused };
      });
      h.rt.registerFlow(forger.definition, forger.runner);
      const state = await (await h.rt.start(forger, {}, { executionId: e })).waitForCompletion();
      expect((state.variables._output as { refused: string[] }).refused).toEqual([
        "recordedBy",
        "late",
      ]);
      expect(await outcomes(h, e)).toEqual([]);
    });

    it("a late outcome does not extend retention from the terminal event", async () => {
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      const terminal = (await h.eventStore.read(e)).at(-1) as EventEnvelope;
      const ttl = 1_000;
      const life = new LogLifecycle(h.eventStore, h.snapshotStore);
      // The reward arrives long after the end (a runtime whose clock is `ttl * 10` later).
      const late = h.sibling({ now: () => terminal.timestamp + ttl * 10 });
      await late.recordOutcome(e, { decisionId: "route", key: "k", score: 1 });
      const now = terminal.timestamp + ttl + 1;
      expect(await life.evaluate(e, { terminalTtlMs: ttl }, now)).toBe("reclaimable");
      expect(await life.applyRetention(e, { terminalTtlMs: ttl }, now)).toBe("reclaimed");
    });

    it("replay: a terminal execution with a late outcome folds identically from log and snapshot", async () => {
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      await h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 });
      const events = await h.eventStore.read(e);
      const a = foldEvents(events);
      const b = foldEvents(events);
      expect(b).toEqual(a);
      expect(a.status).toBe("completed");
      const viaRuntime = await h.rt.loadState(e);
      expect(viaRuntime?.variables._outcomes).toEqual(a.variables._outcomes);
      // A snapshot older than the outcome is extended by the tail.
      const terminalSeq = events.length - 2;
      const snap = foldEvents(events.slice(0, terminalSeq + 1));
      await h.snapshotStore.save({
        id: `${e}-snap`,
        executionId: e,
        workflowId: deciding.definition.id,
        sequence: terminalSeq,
        state: snap,
        createdAt: 0,
      });
      expect((await h.rt.loadState(e))?.variables._outcomes).toEqual(a.variables._outcomes);
    });

    it("an execution that was ever fenced still accepts the attach, under its current token", async () => {
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      if (h.eventStore.acquireFence === undefined) return; // a store that does not fence
      const token = await h.eventStore.acquireFence(e);
      const r = await h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 });
      expect(r.appended).toBe(true);
      const [ev] = await outcomes(h, e);
      expect(ev?.metadata?.fence).toBe(token);
      expect(
        (await h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 })).appended
      ).toBe(false);
    });

    it("a continued execution is refused until R1b defines the chain head", async () => {
      const h = mk();
      const e = id();
      h.rt.registerFlow(parking.definition, parking.runner);
      await (await h.rt.start(parking, {}, { executionId: e })).waitForSuspend();
      const head = (await h.eventStore.read(e)).length;
      await h.eventStore.append({
        id: `${e}-${head}-cont`,
        workflowId: parking.definition.id,
        executionId: e,
        eventType: "EXECUTION_CONTINUED",
        sequence: head,
        timestamp: Date.now(),
        payload: { successorId: `${e}-next`, chainId: e, generation: 1 },
        metadata: { kernel: true },
      });
      expect((await h.rt.loadState(e))?.status).toBe("continued");
      await expect(
        h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 })
      ).rejects.toBeInstanceOf(ExecutionNotTerminalError);
      expect((await h.eventStore.read(e)).length).toBe(head + 1);
    });
  });
}
