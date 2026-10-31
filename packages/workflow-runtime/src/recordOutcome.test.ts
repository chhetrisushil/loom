import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
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
import { foldEvents } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LogLifecycle } from "./LogLifecycle";
import type { WorkflowRuntime } from "./WorkflowRuntime";
import { LATE_OUTCOMES_MAX } from "./WorkflowRuntime";
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
const bind = (v: unknown, t: object): unknown => (typeof v === "function" ? v.bind(t) : v);
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
    // Application events below the decision: what compaction can actually reclaim.
    const noisy = flow("noisy", async (ctx) => {
      for (let i = 0; i < 3; i++) await ctx.emit("note", { i });
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
    const finish = async (
      h: Harness,
      f: typeof deciding,
      e: string,
      principal?: PrincipalChain
    ) => {
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
      const life = new LogLifecycle(h.eventStore, h.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
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
      // The snapshot-restored state (snapshot + tail) equals the full fold of the log.
      const restored = await h.rt.loadState(e);
      expect(restored?.status).toBe(a.status);
      expect(restored?.sequence).toBe(a.sequence);
      expect(restored?.variables._outcomes).toEqual(a.variables._outcomes);
      expect(restored?.variables._decisions).toEqual(a.variables._decisions);
    });

    it("after compaction the late outcome lands ABOVE the checkpoint: folded, idempotent, retention right", async () => {
      let clock = 1_000_000;
      const h = mk({ now: () => clock });
      const e = id();
      await finish(h, noisy, e);
      const terminal = (await h.eventStore.read(e)).at(-1) as EventEnvelope;
      clock = terminal.timestamp + 10;
      const life = new LogLifecycle(h.eventStore, h.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
      expect(await life.compact(e)).not.toBeNull();
      const snap = await h.snapshotStore.loadLatest(e);
      const checkpoint = snap?.sequence ?? -1;
      const o = { decisionId: "route", key: "late", score: 1 };
      const r = await h.rt.recordOutcome(e, o);
      expect(r.appended).toBe(true);
      expect(r.sequence).toBeGreaterThan(checkpoint);
      // The fold sees it, and a repeat is a no-op instead of a second append.
      expect((await h.rt.loadState(e))?.variables._outcomes).toEqual([
        expect.objectContaining({ key: "late", late: true }),
      ]);
      expect((await h.rt.recordOutcome(e, o)).appended).toBe(false);
      expect((await outcomes(h, e)).length).toBe(1);
      // Retention is judged from the terminal event, which compaction keeps (Q3).
      const ttl = 1_000;
      clock = terminal.timestamp + ttl * 100;
      expect(await life.evaluate(e, { terminalTtlMs: ttl }, terminal.timestamp + ttl + 1)).toBe(
        "reclaimable"
      );
    });

    it("compaction keeps the terminal event: one late outcome per TTL cannot pin a compacted log", async () => {
      let clock = 1_000_000;
      const h = mk({ now: () => clock });
      const e = id();
      await finish(h, noisy, e);
      const terminal = (await h.eventStore.read(e)).at(-1) as EventEnvelope;
      const ttl = 1_000;
      const life = new LogLifecycle(h.eventStore, h.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
      await life.compact(e);
      expect((await h.eventStore.read(e)).some((x) => x.eventType === "EXECUTION_COMPLETED")).toBe(
        true
      );
      // A reward arrives just inside every TTL window: each would restart the clock if the
      // retention fallback used `updatedAt` (the outcome handler moves it).
      for (let k = 1; k <= 3; k++) {
        clock = terminal.timestamp + Math.floor(ttl * 0.9) + k;
        await h.rt.recordOutcome(e, { decisionId: "route", key: `w${k}`, score: 1 });
        await life.compact(e);
      }
      expect(await life.evaluate(e, { terminalTtlMs: ttl }, terminal.timestamp + ttl + 1)).toBe(
        "reclaimable"
      );
      expect((await h.rt.loadState(e))?.variables._outcomes).toHaveLength(3);
    });

    it("compaction folds the in-run reward into the checkpoint; late rewards stay above the terminal event and the folded state is unchanged", async () => {
      const rewarding = flow("rewarder", async (ctx) => {
        for (let i = 0; i < 3; i++) await ctx.emit("note", { i });
        await ctx.decide("route", () => "opus");
        await ctx.emit("OUTCOME_RECORDED", { key: "inrun", decisionId: "route", score: 0.5 });
        return { done: true };
      });
      const h = mk();
      const e = id();
      await finish(h, rewarding, e);
      await h.rt.recordOutcome(e, { decisionId: "route", key: "late", score: 1 });
      const before = (await h.rt.loadState(e))?.variables._outcomes;
      const life = new LogLifecycle(h.eventStore, h.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
      expect(await life.compact(e)).not.toBeNull();
      await h.rt.recordOutcome(e, { decisionId: "route", key: "late2", score: 1 });
      await life.compact(e); // nothing new below the terminal event: a no-op, not an error
      // R11 round 3: compaction keeps NO learning evidence in place. The in-run reward (below the
      // terminal event) is absorbed by the checkpoint; the late ones sit ABOVE the terminal event.
      const kept = (await outcomes(h, e)).map((x) => (x.payload as { key: string }).key);
      expect(kept).toEqual(["late", "late2"]);
      expect((await h.eventStore.read(e)).some((x) => x.eventType === "DECISION_RECORDED")).toBe(
        false
      );
      const after = (await h.rt.loadState(e))?.variables._outcomes as Array<{ key: string }>;
      expect(after.map((o) => o.key)).toEqual(["inrun", "late", "late2"]);
      expect(after.slice(0, 2)).toEqual(before);
    });

    it("refuses an overflowing score (finite or not), at the cap and in a flow's own emit", async () => {
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      for (const score of [1.7e308, -1.7e308, 1e9 + 1, Number.POSITIVE_INFINITY]) {
        await expect(
          h.rt.recordOutcome(e, { decisionId: "route", key: "x", score })
        ).rejects.toBeInstanceOf(OutcomeRefusedError);
      }
      expect(
        (await h.rt.recordOutcome(e, { decisionId: "route", key: "edge", score: 1e9 })).appended
      ).toBe(true);
      const emitting = flow("emitter", async (ctx) => {
        await ctx.decide("route", () => "opus");
        await ctx.emit("OUTCOME_RECORDED", { key: "k", decisionId: "route", score: 1.7e308 });
        return { done: true };
      });
      const e2 = id();
      h.rt.registerFlow(emitting.definition, emitting.runner);
      await (await h.rt.start(emitting, {}, { executionId: e2 }))
        .waitForCompletion()
        .catch(() => undefined);
      expect(await outcomes(h, e2)).toEqual([]);
    });

    it("caps late outcomes per execution with a typed refusal, and stays fast", async () => {
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      for (let i = 0; i < LATE_OUTCOMES_MAX; i++) {
        await h.rt.recordOutcome(e, { decisionId: "route", key: `k${i}`, score: 1 });
      }
      const len = (await h.eventStore.read(e)).length;
      await expect(
        h.rt.recordOutcome(e, { decisionId: "route", key: "one-too-many", score: 1 })
      ).rejects.toBeInstanceOf(OutcomeRefusedError);
      // An already-recorded pair is still idempotent at the cap.
      expect(
        (await h.rt.recordOutcome(e, { decisionId: "route", key: "k0", score: 1 })).appended
      ).toBe(false);
      expect((await h.eventStore.read(e)).length).toBe(len);
    }, 120_000);

    // The p2 scenario, round 3 (user decision A): a late outcome and a REOPEN race for the same
    // slot. BOTH land, in either order, and the reopener is never the one displaced.
    const reopenRace = async (
      when: "before-its-append" | "acquire-in-window" | "after-it-finished"
    ) => {
      const base = backend.make();
      let hook: (() => Promise<void>) | null = null;
      let inWindow: (() => Promise<void>) | null = null;
      const store = new Proxy(base.eventStore, {
        get(t, k, recv) {
          if (k === "append" || k === "appendBatch") {
            return async (x: EventEnvelope | EventEnvelope[]) => {
              const first = Array.isArray(x) ? x[0] : x;
              if (hook !== null && first?.eventType !== "OUTCOME_RECORDED") {
                const run = hook;
                hook = null;
                await run();
              }
              return (t as never as Record<string, (a: unknown) => unknown>)[k as string]?.call(
                t,
                x
              );
            };
          }
          if (k === "appendIfUnchanged") {
            return async (eid: string, ev: EventEnvelope | null, expect?: never) => {
              if (ev !== null && inWindow !== null) {
                const run = inWindow;
                inWindow = null;
                await run();
              }
              return (t as EventStore).appendIfUnchanged!(eid, ev, expect);
            };
          }
          const v = Reflect.get(t, k, recv);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as EventStore;
      const h = mk({}, { ...base, eventStore: store });
      const failing = flow("fenced", async (ctx) => {
        await ctx.decide("route", () => "opus");
        throw new Error("boom");
      });
      const fixed = flow("fenced2", async (ctx) => {
        await ctx.decide("route", () => "opus");
        return { done: true };
      });
      h.rt.registerFlow(failing.definition, failing.runner);
      h.rt.registerFlow(fixed.definition, fixed.runner);
      const e = id();
      await (await h.rt.start(failing, {}, { executionId: e }))
        .waitForCompletion()
        .catch(() => undefined);
      const fenced = store.acquireFence !== undefined; // SQLite does not fence
      if (!fenced && when === "acquire-in-window") return undefined;
      const late = (key: string) => h.rt.recordOutcome(e, { decisionId: "route", key, score: 0.5 });
      let fence: number | undefined = 0;
      let outcome: Promise<unknown> = Promise.resolve();
      if (when === "acquire-in-window") {
        // the late write OBSERVED the log before the reopener took its token, and appends after
        inWindow = async () => {
          fence = await h.rt.acquireFence(e);
        };
        const r = await late("a");
        expect(r.appended).toBe(true); // `moved` -> re-observed -> landed
        fence = await h.rt.acquireFence(e); // a fresh token for the reopen, as a real holder would
      } else if (fenced) {
        fence = await h.rt.acquireFence(e);
      }
      if (when === "before-its-append") {
        // the reopener holds a token and has folded; the late outcome slips in before its append
        hook = async () => {
          const r = await late("b");
          expect(r.appended).toBe(true);
        };
      }
      const run = await h.rt.resumeAs(
        e,
        "fenced2",
        { eventType: "RETRY", payload: {} },
        { strategy: "operator-ack", ...(fenced && fence !== undefined && { fence }) }
      );
      await run.waitForCompletion();
      if (when === "after-it-finished") outcome = late("c");
      await outcome;
      return { h, e, fence };
    };

    for (const when of ["before-its-append", "acquire-in-window", "after-it-finished"] as const) {
      it(`a late outcome and a reopener race (${when}): both land, the reopener is never displaced`, async () => {
        const got = await reopenRace(when);
        if (got === undefined) return;
        const { h, e } = got;
        const state = await h.rt.loadState(e);
        expect(state?.status).toBe("completed");
        const log = await h.eventStore.read(e);
        expect(log.map((x) => x.sequence)).toEqual(log.map((_, i) => i)); // gap-free
        expect(new Set(log.map((x) => x.id)).size).toBe(log.length);
        expect(log.filter((x) => x.eventType === "OUTCOME_RECORDED")).toHaveLength(1);
        expect(log.some((x) => x.eventType === "EXECUTION_COMPLETED")).toBe(true);
        expect((state?.variables._outcomes as unknown[]).length).toBe(1);
        // the reopener's own events carry its token; the late outcome carries none
        const o = log.find((x) => x.eventType === "OUTCOME_RECORDED") as EventEnvelope;
        expect(o.metadata?.fence).toBeUndefined();
      });
    }

    // The reopen's retry (`landReopenBootstrap`) folds the events above its head ONLY when every
    // one is a kernel-stamped, LATE `OUTCOME_RECORDED` in the very next slots. Each condition is
    // pinned by an interloper that takes the reopener's slot with something that fails ONE of
    // them; the reopen must then stay on the ordinary path (no durable landing, fails as before).
    const interloped = async (
      shape: (e: string, at: number, fence: number | undefined) => EventEnvelope[],
      opts: { shiftRead?: number } = {}
    ) => {
      const base = backend.make();
      let hook: (() => Promise<void>) | null = null;
      const store = new Proxy(base.eventStore, {
        get(t, k, recv) {
          if (k === "append" || k === "appendBatch") {
            return async (x: EventEnvelope | EventEnvelope[]) => {
              const first = Array.isArray(x) ? x[0] : x;
              if (hook !== null && first?.eventType !== "OUTCOME_RECORDED") {
                const run = hook;
                hook = null;
                await run();
              }
              return (t as never as Record<string, (a: unknown) => unknown>)[k as string]?.call(
                t,
                x
              );
            };
          }
          if (k === "readFrom" && opts.shiftRead !== undefined) {
            // a store that answers the tail with a hole in it
            return async (eid: string, from: number) =>
              (await (t as EventStore).readFrom(eid, from)).map((ev) =>
                ev.eventType === "OUTCOME_RECORDED" && ev.sequence >= from
                  ? { ...ev, sequence: ev.sequence + (opts.shiftRead as number) }
                  : ev
              );
          }
          const v = Reflect.get(t, k, recv);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as EventStore;
      const h = mk({}, { ...base, eventStore: store });
      const failing = flow("fenced3", async (ctx) => {
        await ctx.decide("route", () => "opus");
        throw new Error("boom");
      });
      const fixed = flow("fenced4", async (ctx) => {
        await ctx.decide("route", () => "opus");
        return { done: true };
      });
      h.rt.registerFlow(failing.definition, failing.runner);
      h.rt.registerFlow(fixed.definition, fixed.runner);
      const e = id();
      await (await h.rt.start(failing, {}, { executionId: e }))
        .waitForCompletion()
        .catch(() => undefined);
      const at = (await h.rt.loadState(e))!.sequence;
      const fence = store.acquireFence !== undefined ? await h.rt.acquireFence(e) : undefined;
      hook = async () => {
        for (const ev of shape(e, at, fence)) await base.eventStore.append(ev);
      };
      const before = (await h.eventStore.read(e)).length;
      let failed = false;
      try {
        const run = await h.rt.resumeAs(
          e,
          "fenced4",
          { eventType: "RETRY", payload: {} },
          { strategy: "operator-ack", ...(fence !== undefined && { fence }) }
        );
        await run.waitForCompletion();
      } catch {
        failed = true;
      }
      const log = await h.eventStore.read(e);
      return { failed, log, before, e, h };
    };
    const outcomeAt = (
      e: string,
      sequence: number,
      fence: number | undefined,
      meta: Record<string, unknown>,
      late: boolean
    ): EventEnvelope => ({
      id: `${e}-${sequence}-intruder`,
      workflowId: "fenced3",
      executionId: e,
      eventType: "OUTCOME_RECORDED",
      sequence,
      timestamp: Date.now(),
      payload: {
        key: "x",
        score: 0.1,
        decisionId: "route",
        recordedBy: "mallory",
        ...(late && { late: true }),
      },
      metadata: { ...meta, ...(fence !== undefined && { fence }) },
    });
    for (const [name, shape, shift] of [
      [
        "an UNSTAMPED OUTCOME_RECORDED above the terminal event",
        (e: string, at: number, f?: number) => [outcomeAt(e, at + 1, f, {}, true)],
        undefined,
      ],
      [
        "a kernel-stamped OUTCOME_RECORDED that is not late",
        (e: string, at: number, f?: number) => [outcomeAt(e, at + 1, f, { kernel: true }, false)],
        undefined,
      ],
      [
        "a late outcome the store reports at a non-contiguous slot",
        (e: string, at: number, f?: number) => [outcomeAt(e, at + 1, f, { kernel: true }, true)],
        1,
      ],
    ] as const) {
      it(`a reopen that loses its slot to ${name} stays on the ordinary path (fails as before)`, async () => {
        const got = await interloped(shape, shift === undefined ? {} : { shiftRead: shift });
        expect(got.failed).toBe(true);
        // nothing of the reopen is durable: only the interloper's event sits above the terminal
        expect(got.log.length).toBe(got.before + 1);
      });
    }

    it("a store or decorator that drops the creation anchor is refused with a typed error, not 8 'moved' retries", async () => {
      const base = backend.make();
      let calls = 0;
      const store = new Proxy(base.eventStore, {
        get(t, k, recv) {
          if (k === "appendIfUnchanged") {
            return async (eid: string, ev: EventEnvelope | null, expect?: never) => {
              calls++;
              const r = await (t as EventStore).appendIfUnchanged!(eid, ev, expect);
              const { anchor: _dropped, ...rest } = r as unknown as Record<string, unknown>;
              return rest;
            };
          }
          const v = Reflect.get(t, k, recv);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as EventStore;
      const h = mk({}, { ...base, eventStore: store });
      const e = id();
      await finish(h, deciding, e);
      const err = await h.rt
        .recordOutcome(e, { decisionId: "route", key: "k", score: 1 })
        .catch((x: unknown) => x);
      expect(err).toBeInstanceOf(OutcomeRefusedError);
      expect(String((err as Error).message)).toMatch(/dropped the creation anchor/);
      expect(calls).toBe(1); // refused on the first observation, never retried
      expect(await outcomes(h, e)).toEqual([]);
    });

    it("a pre-0116 compacted execution ([0] + checkpoint) refuses a late outcome until restoreTerminalEvent repairs it (idempotent, refuses non-terminal)", async () => {
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      const life = new LogLifecycle(h.eventStore, h.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
      // the OLD compaction shape: checkpoint at the tip, the log truncated through it to [0]
      const state = (await h.rt.loadState(e))!;
      await h.snapshotStore.save({
        id: `${e}-old-ckpt`,
        executionId: e,
        workflowId: state.workflowId,
        sequence: state.sequence,
        state,
        createdAt: 0,
      });
      await h.eventStore.truncatePrefix!(e, state.sequence);
      expect((await h.eventStore.read(e)).map((x) => x.sequence)).toEqual([0]);
      await expect(
        h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 })
      ).rejects.toBeInstanceOf(OutcomeRefusedError);

      // dry run writes nothing
      const dry = await life.restoreTerminalEvent(e);
      expect(dry.status).toBe("would-restore");
      expect((await h.eventStore.read(e)).length).toBe(1);
      const done = await life.restoreTerminalEvent(e, { apply: true });
      expect(done).toMatchObject({ status: "restored", sequence: state.sequence + 1 });
      const after = (await h.rt.loadState(e))!;
      expect(after.status).toBe("completed");
      expect(after.sequence).toBe(state.sequence + 1);
      expect({ ...after, sequence: 0, updatedAt: 0 }).toEqual({
        ...state,
        sequence: 0,
        updatedAt: 0,
      });
      expect(after.updatedAt).toBe(state.updatedAt);
      // idempotent
      expect((await life.restoreTerminalEvent(e, { apply: true })).status).toBe("intact");
      expect((await h.eventStore.read(e)).length).toBe(2);
      // and the late outcome now lands, folded
      const r = await h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 });
      expect(r).toEqual({ appended: true, sequence: state.sequence + 2 });
      expect(((await h.rt.loadState(e))!.variables._outcomes as unknown[]).length).toBe(1);
      // never-compacted and non-terminal executions are left alone
      const e2 = id();
      await finish(h, deciding, e2);
      expect((await life.restoreTerminalEvent(e2, { apply: true })).status).toBe("intact");
      const e3 = id();
      h.rt.registerFlow(parking.definition, parking.runner);
      await h.rt.start(parking, {}, { executionId: e3 });
      await until(async () => (await h.rt.loadState(e3))?.status === "suspended");
      const s3 = (await h.rt.loadState(e3))!;
      await h.snapshotStore.save({
        id: `${e3}-old-ckpt`,
        executionId: e3,
        workflowId: s3.workflowId,
        sequence: s3.sequence,
        state: s3,
        createdAt: 0,
      });
      await h.eventStore.truncatePrefix!(e3, s3.sequence);
      expect(await life.restoreTerminalEvent(e3, { apply: true })).toMatchObject({
        status: "not-terminal",
        foldedStatus: "suspended",
      });
      expect((await h.eventStore.read(e3)).length).toBe(1);
    });

    // ADR 0116 round 5 — restoreTerminalEvent must never supersede a live fence holder.
    const compactedOld = async (h: Harness, e: string) => {
      await finish(h, deciding, e);
      const state = (await h.rt.loadState(e))!;
      await h.snapshotStore.save({
        id: `${e}-old-ckpt`,
        executionId: e,
        workflowId: state.workflowId,
        sequence: state.sequence,
        state,
        createdAt: 0,
      });
      await h.eventStore.truncatePrefix!(e, state.sequence);
      return state;
    };

    it("restoreTerminalEvent never supersedes a live fence holder: the holder moves the token between the observation and the CAS -> busy, nothing written, the holder's append lands", async () => {
      const h = mk();
      const store = h.eventStore;
      if (store.acquireFenceIf === undefined || store.appendIfUnchanged === undefined) return;
      const e = id();
      const state = await compactedOld(h, e);
      await store.acquireFence!(e); // a token exists before the repair (token 1)
      let holder = 0;
      const wrapped = new Proxy(store, {
        get: (t, k) => {
          if (k === "appendIfUnchanged") {
            return async (...a: Parameters<NonNullable<EventStore["appendIfUnchanged"]>>) => {
              const r = await t.appendIfUnchanged!(...a);
              holder = await t.acquireFence!(e); // the live holder wakes up right after the observation
              return r;
            };
          }
          return bind(Reflect.get(t, k), t);
        },
      }) as EventStore;
      const life = new LogLifecycle(wrapped, h.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
      const r = await life.restoreTerminalEvent(e, { apply: true });
      expect(r.status).toBe("busy");
      expect((await store.read(e)).length).toBe(1); // nothing written
      // the holder's token was NOT superseded: its append succeeds
      await store.append({
        id: `${e}-holder`,
        workflowId: state.workflowId,
        executionId: e,
        eventType: "OUTCOME_RECORDED",
        sequence: state.sequence + 1,
        timestamp: 1,
        payload: {},
        metadata: { fence: holder },
      });
      expect((await store.read(e)).length).toBe(2);
    });

    it("restoreTerminalEvent on an idle FENCED execution (token > 0, no holder) succeeds, then is intact", async () => {
      const h = mk();
      const store = h.eventStore;
      if (store.acquireFenceIf === undefined || store.appendIfUnchanged === undefined) return;
      const e = id();
      const state = await compactedOld(h, e);
      await store.acquireFence!(e);
      const life = new LogLifecycle(store, h.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
      expect(await life.restoreTerminalEvent(e, { apply: true })).toMatchObject({
        status: "restored",
        sequence: state.sequence + 1,
      });
      expect((await life.restoreTerminalEvent(e, { apply: true })).status).toBe("intact");
      expect((await h.rt.loadState(e))!.status).toBe("completed");
    });

    it("concurrent restoreTerminalEvent repairs: exactly one writes, the other reports cleanly (no throw, no duplicate)", async () => {
      const h = mk();
      const store = h.eventStore;
      if (store.acquireFenceIf === undefined || store.appendIfUnchanged === undefined) return;
      const e = id();
      await compactedOld(h, e);
      await store.acquireFence!(e);
      const life = new LogLifecycle(store, h.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
      const rs = await Promise.all([
        life.restoreTerminalEvent(e, { apply: true }),
        life.restoreTerminalEvent(e, { apply: true }),
      ]);
      const statuses = rs.map((r) => r.status).sort();
      expect(statuses.filter((x) => x === "restored")).toHaveLength(1);
      expect(statuses.every((x) => x === "restored" || x === "busy" || x === "intact")).toBe(true);
      expect((await store.read(e)).length).toBe(2);
    });

    it("a store WITHOUT acquireFenceIf refuses a fenced execution (busy) unless force: true", async () => {
      const h = mk();
      const store = h.eventStore;
      if (store.acquireFence === undefined) return;
      const e = id();
      await compactedOld(h, e);
      await store.acquireFence(e);
      const bare = new Proxy(store, {
        get: (t, k) =>
          k === "acquireFenceIf" || k === "appendIfUnchanged"
            ? undefined
            : bind(Reflect.get(t, k), t),
      }) as EventStore;
      const life = new LogLifecycle(bare, h.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
      expect((await life.restoreTerminalEvent(e, { apply: true })).status).toBe("busy");
      expect((await store.read(e)).length).toBe(1);
      expect((await life.restoreTerminalEvent(e, { apply: true, force: true })).status).toBe(
        "restored"
      );
    });

    it("a fence acquired after the end (redispatch, timers, recovery, a dead holder) does NOT block late outcomes; the token is never bumped", async () => {
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      if (h.eventStore.acquireFence === undefined) return; // a store that does not fence
      // at-least-once redispatch acquires a fresh token on the finished execution, repeatedly
      let token = 0;
      for (let i = 0; i < 3; i++) token = await h.eventStore.acquireFence(e);
      const r = await h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 });
      expect(r.appended).toBe(true);
      const [ev] = await outcomes(h, e);
      expect(ev?.metadata?.fence).toBeUndefined(); // compared, never presented
      expect(await h.eventStore.acquireFence(e)).toBe(token + 1); // not bumped by the attach
      // idempotent, and a further acquire (a holder that died) still does not block a new key
      expect(
        (await h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 })).appended
      ).toBe(false);
      await h.eventStore.acquireFence(e);
      expect(
        (await h.rt.recordOutcome(e, { decisionId: "route", key: "k2", score: 1 })).appended
      ).toBe(true);
    });

    it("a holder that reopened and FINISHED under its own token: a late outcome lands, token unchanged", async () => {
      const h = mk();
      const e2 = id();
      const failing = flow("failer2", async (ctx) => {
        await ctx.decide("route", () => "opus");
        throw new Error("boom");
      });
      const fixed = flow("failer2", async (ctx) => {
        await ctx.decide("route", () => "opus");
        return { done: true };
      });
      h.rt.registerFlow(failing.definition, failing.runner);
      await (await h.rt.start(failing, {}, { executionId: e2 }))
        .waitForCompletion()
        .catch(() => undefined);
      h.rt.registerFlow(fixed.definition, fixed.runner);
      if (h.eventStore.acquireFence === undefined) return;
      const t2 = await h.rt.acquireFence(e2);
      if (t2 === undefined) return;
      await (
        await h.rt.resumeAs(
          e2,
          "failer2",
          { eventType: "RETRY", payload: {} },
          { strategy: "operator-ack", fence: t2 }
        )
      ).waitForCompletion();
      expect((await h.rt.loadState(e2))?.status).toBe("completed");
      expect(
        (await h.rt.recordOutcome(e2, { decisionId: "route", key: "k", score: 1 })).appended
      ).toBe(true);
      expect(await h.eventStore.acquireFence(e2)).toBe(t2 + 1);
    });

    it("refuses with a clear error when the store has no appendIfUnchanged (no unsafe fallback)", async () => {
      const base = backend.make();
      const bare = new Proxy(base.eventStore, {
        get: (t, k, r) => (k === "appendIfUnchanged" ? undefined : bind(Reflect.get(t, k, r), t)),
      }) as EventStore;
      const h = mk({}, { ...base, eventStore: bare });
      const e = id();
      await finish(h, deciding, e);
      const len = (await h.eventStore.read(e)).length;
      await expect(
        h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 })
      ).rejects.toThrow(/appendIfUnchanged/);
      expect((await h.eventStore.read(e)).length).toBe(len);
    });

    it("retention deleting the log between the observation and the write: refused, NO orphan log", async () => {
      const base = backend.make();
      let hook: (() => Promise<void>) | null = null;
      const store = new Proxy(base.eventStore, {
        get(t, k, r) {
          if (k !== "appendIfUnchanged") return bind(Reflect.get(t, k, r), t);
          return async (eid: string, ev: EventEnvelope | null, expect?: never) => {
            if (ev !== null && hook !== null) {
              const run = hook;
              hook = null;
              await run();
            }
            return (t as EventStore).appendIfUnchanged!(eid, ev, expect);
          };
        },
      }) as EventStore;
      const h = mk({}, { ...base, eventStore: store });
      const e = id();
      await finish(h, deciding, e);
      const terminal = (await h.eventStore.read(e)).at(-1) as EventEnvelope;
      const life = new LogLifecycle(base.eventStore, base.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
      hook = async () => {
        expect(await life.applyRetention(e, { terminalTtlMs: 0 }, terminal.timestamp + 10)).toBe(
          "reclaimed"
        );
      };
      await expect(
        h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 })
      ).rejects.toThrow(/No execution found/);
      expect(await base.eventStore.read(e)).toEqual([]);
      expect(await base.eventStore.head?.(e)).toBeNull();
      expect(await base.eventStore.listExecutions?.()).not.toContain(e);
    });

    it("a tombstoned fence stays effective after retention: a plain unfenced append is still refused (postgres)", async () => {
      if (backend.name !== "postgres") return;
      const h = mk();
      const e = id();
      await finish(h, deciding, e);
      const token = await h.eventStore.acquireFence?.(e);
      expect(token).toBeGreaterThan(0);
      const terminal = (await h.eventStore.read(e)).at(-1) as EventEnvelope;
      const life = new LogLifecycle(h.eventStore, h.snapshotStore, {
        compactionArchive: new InMemoryArchiveStore(),
      });
      expect(await life.applyRetention(e, { terminalTtlMs: 0 }, terminal.timestamp + 10)).toBe(
        "reclaimed"
      );
      await expect(
        h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 })
      ).rejects.toThrow(/No execution found/);
      expect(await h.eventStore.read(e)).toEqual([]);
      // the zombie writer of a re-created id is still fenced out
      await expect(
        h.eventStore.append({ ...(terminal as EventEnvelope), sequence: 0, id: `${e}-z` })
      ).rejects.toMatchObject({ name: "StaleFenceError" });
      expect(await h.eventStore.acquireFence?.(e)).toBe((token as number) + 1);
    });

    it("a continued execution accepts a late outcome on its OWN log (ADR 0109 / 0116 D1)", async () => {
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
      // the decision lives in THAT generation's log: the outcome lands there, not on the head
      await expect(
        h.rt.recordOutcome(e, { decisionId: "route", key: "k", score: 1 })
      ).resolves.toEqual({ appended: true, sequence: head + 1 });
      expect((await h.eventStore.read(e)).length).toBe(head + 2);
      expect((await h.rt.loadState(e))?.status).toBe("continued");
    });
  });
}
