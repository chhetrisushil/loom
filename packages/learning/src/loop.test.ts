import { attachOutcomes, recordOutcome } from "@loom/analytics";
import { step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { PostgresEventStore, PostgresSnapshotStore } from "@loom/plugin-postgres";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { LogLifecycle, WorkflowRuntime } from "@loom/workflow-runtime";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { decideWithPolicy } from "./decideWithPolicy";
import { evaluatePolicy } from "./evaluate";
import { evidenceEvents } from "./evidence";
import { promotionGate } from "./promote";
import { trajectories } from "./trajectories";
import type { Policy } from "./types";

// The whole loop, through the real kernel: a policy chooses, the choice is recorded
// as DECISION_RECORDED with its context and propensity (ADR 0079), the outcome is
// recorded against it, and a CANDIDATE policy is then evaluated against that log
// without ever running. If any link is broken this test is the one that notices.

const ROUTES = ["gemma", "opus"] as const;
type Route = (typeof ROUTES)[number];

const inputSchema = z.object({ tokens: z.number() });
const outputSchema = z.object({ route: z.string() });

function makeFlow(runner: FlowRunner<{ tokens: number }, { route: string }>) {
  return {
    definition: {
      _tag: "FlowDefinition" as const,
      id: "route-flow",
      name: "Route Flow",
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [
        step$({
          id: "noop",
          name: "Noop",
          toolId: "noop-tool",
          inputSchema: z.object({}),
          outputSchema: z.object({}),
        }),
      ],
    },
    runner,
  } as unknown as RegisteredFlow<{ tokens: number }, { route: string }>;
}

/** The logging policy: explores, so it logs a real propensity. */
function explorer(pOpus: number): Policy<Route> {
  return {
    id: "explorer",
    version: "1",
    select: (ctx) => {
      // Deterministic "exploration" keyed off the observation, so the test needs no RNG.
      const opus = ((ctx.tokens as number) / 100) % 5 === 0;
      return { action: opus ? "opus" : "gemma", propensity: opus ? pOpus : 1 - pOpus };
    },
  };
}

describe("the learning loop, end to end through the kernel", () => {
  it("records a learnable decision, then evaluates a candidate against the real log", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const effectRuntime = new EffectRuntime();
    const policy = explorer(0.2);

    const runner: FlowRunner<{ tokens: number }, { route: string }> = async (ctx, input) => {
      const route = await decideWithPolicy(ctx, "route", policy, { tokens: input.tokens }, [
        ...ROUTES,
      ]);
      // opus is genuinely better here; gemma is cheap and worse.
      recordOutcome(ctx, {
        key: route,
        score: route === "opus" ? 0.9 : 0.2,
        decisionId: "route",
      });
      return { route };
    };

    const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
    runtime.registerFlow(makeFlow(runner).definition, runner);

    const executionIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const handle = await runtime.start(makeFlow(runner), { tokens: i * 100 });
      await handle.waitForCompletion();
      executionIds.push(handle.executionId);
    }

    // Read back every log the way an offline job would.
    const log = (await Promise.all(executionIds.map((id) => eventStore.read(id)))).flat();

    const ts = trajectories<Route>(log);
    expect(ts).toHaveLength(100);

    const first = ts[0]?.steps[0];
    expect(first?.context).toEqual({ tokens: 0 });
    expect(first?.policy).toMatchObject({ id: "explorer", version: "1" });
    expect(first?.policy?.propensity).toBeGreaterThan(0);
    expect(first?.actions).toEqual(["gemma", "opus"]);
    expect(first?.rewardSource).toBe("direct");

    // A candidate that always takes the better arm should estimate above the log.
    const candidate: Policy<Route> = {
      id: "always-opus",
      version: "1",
      select: () => ({ action: "opus" }),
    };
    const report = evaluatePolicy(ts, candidate);

    expect(report.estimator).toBe("snips");
    expect(report.evaluated).toBe(100);
    expect(report.estimatedValue).toBeCloseTo(0.9);
    expect(report.loggedValue).toBeLessThan(report.estimatedValue as number);
    expect(report.lift as number).toBeGreaterThan(0);

    // …and the gate should still refuse it on this little evidence.
    expect(promotionGate(report).ok).toBe(false);
    expect(promotionGate(report, { minSteps: 50, minEffectiveSamples: 5 }).ok).toBe(true);
  });

  it("a flow that never passes a context produces nothing evaluable, and says so", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });

    const runner: FlowRunner<{ tokens: number }, { route: string }> = async (ctx) => {
      const route = await ctx.decide("route", () => "opus"); // the old, unlearnable way
      recordOutcome(ctx, { key: route as string, score: 1, decisionId: "route" });
      return { route: route as string };
    };
    runtime.registerFlow(makeFlow(runner).definition, runner);
    const handle = await runtime.start(makeFlow(runner), { tokens: 1 });
    await handle.waitForCompletion();

    const ts = trajectories<Route>(await eventStore.read(handle.executionId));
    const report = evaluatePolicy(ts, {
      id: "c",
      version: "1",
      select: () => ({ action: "opus" }),
    });

    expect(report.evaluated).toBe(0);
    expect(report.skipped.noContext).toBe(1);
    expect(report.warnings.join(" ")).toMatch(/no recorded context/);
    expect(promotionGate(report).ok).toBe(false);
  });
});

// ADR 0116 — a reward that arrives AFTER the execution finished. `runtime.recordOutcome` appends it
// to the terminal log; trajectories and the off-policy estimate must treat it exactly like an
// in-run outcome, and the logged propensity must be untouched.
describe("late rewards flow into trajectories and evaluation like on-time ones", () => {
  it("a late outcome yields the same trajectory, evaluation and propensity as an on-time one", async () => {
    const policy = explorer(0.2);
    const make = (onTime: boolean) => {
      const eventStore = new InMemoryAsyncEventStore();
      const runner: FlowRunner<{ tokens: number }, { route: string }> = async (ctx, input) => {
        const route = await decideWithPolicy(ctx, "route", policy, { tokens: input.tokens }, [
          ...ROUTES,
        ]);
        if (onTime) {
          recordOutcome(ctx, {
            key: route,
            score: route === "opus" ? 0.9 : 0.2,
            decisionId: "route",
          });
        }
        return { route };
      };
      const runtime = new WorkflowRuntime({
        eventStore,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        effectRuntime: new EffectRuntime(),
      });
      runtime.registerFlow(makeFlow(runner).definition, runner);
      return { runtime, eventStore, flow: makeFlow(runner) };
    };
    const onTime = make(true);
    const late = make(false);
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      for (const app of [onTime, late]) {
        const h = await app.runtime.start(app.flow, { tokens: i * 100 }, { executionId: `x${i}` });
        await h.waitForCompletion();
      }
      ids.push(`x${i}`);
    }
    // Before the rewards arrive the late log has NO measured reward.
    const bare = trajectories<Route>(
      (await Promise.all(ids.map((id) => late.eventStore.read(id)))).flat()
    );
    expect(bare[0]?.steps[0]?.rewardSource).not.toBe("direct");

    const rewards = await Promise.all(
      ids.map(async (executionId) => {
        const out = (await late.runtime.loadState(executionId))?.variables._output as {
          route: string;
        };
        return {
          executionId,
          decisionId: "route",
          key: out.route,
          score: out.route === "opus" ? 0.9 : 0.2,
        };
      })
    );
    expect(await attachOutcomes(late.runtime, rewards)).toMatchObject({
      appended: 40,
      duplicates: 0,
      failed: [],
    });
    // Re-running the batch is a no-op (idempotent).
    expect(await attachOutcomes(late.runtime, rewards)).toMatchObject({
      appended: 0,
      duplicates: 40,
      failed: [],
    });

    const read = async (app: typeof onTime) =>
      trajectories<Route>((await Promise.all(ids.map((id) => app.eventStore.read(id)))).flat());
    const a = await read(onTime);
    const b = await read(late);
    expect(
      b.map((t) => t.steps.map((s) => [s.decisionId, s.action, s.reward, s.rewardSource, s.policy]))
    ).toEqual(
      a.map((t) => t.steps.map((s) => [s.decisionId, s.action, s.reward, s.rewardSource, s.policy]))
    );
    const candidate: Policy<Route> = {
      id: "always-opus",
      version: "1",
      select: () => ({ action: "opus" }),
    };
    const ra = evaluatePolicy(a, candidate);
    const rb = evaluatePolicy(b, candidate);
    expect(rb.estimatedValue).toBeCloseTo(ra.estimatedValue as number);
    expect(rb.loggedValue).toBeCloseTo(ra.loggedValue as number);
    expect(rb.evaluated).toBe(ra.evaluated);
    // The terminal outcome is still the execution's own result, not the late reward's.
    expect(b.every((t) => t.outcome === "completed")).toBe(true);
  });
});

describe("reward poisoning cannot pass the promotion gate (ADR 0116 review)", () => {
  it("overflowing rewards make evaluatePolicy refuse, and a NaN-lift report fails the gate", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const policy = explorer(0.2);
    const runner: FlowRunner<{ tokens: number }, { route: string }> = async (ctx, input) => {
      const route = await decideWithPolicy(ctx, "route", policy, { tokens: input.tokens }, [
        ...ROUTES,
      ]);
      return { route };
    };
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });
    runtime.registerFlow(makeFlow(runner).definition, runner);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const h = await runtime.start(
        makeFlow(runner),
        { tokens: i * 100 },
        { executionId: `p${i}` }
      );
      await h.waitForCompletion();
      ids.push(`p${i}`);
    }
    // A log that already holds finite-but-enormous rewards (written around the guard, as an
    // older or foreign writer could).
    for (const id of ids) {
      const evs = await eventStore.read(id);
      for (const [n, key] of ["a", "b"].entries()) {
        await eventStore.append({
          id: `${id}-poison-${key}`,
          workflowId: evs[0]?.workflowId as string,
          executionId: id,
          eventType: "OUTCOME_RECORDED",
          sequence: evs.length + n,
          timestamp: Date.now(),
          payload: { key, decisionId: "route", score: 1.7e308 },
        });
      }
    }
    const log = (await Promise.all(ids.map((id) => eventStore.read(id)))).flat();
    const candidate: Policy<Route> = {
      id: "always-opus",
      version: "1",
      select: () => ({ action: "opus" }),
    };
    expect(() => evaluatePolicy(trajectories<Route>(log), candidate)).toThrow(/non-finite/);

    // A hand-built / deserialized report with a NaN lift used to PASS (`NaN < minLift` is false).
    const poisoned = {
      policy: { id: "c", version: "1" },
      evaluated: 100,
      skipped: { noContext: 0, noActions: 0, noReward: 0 },
      agreement: 0.5,
      loggedValue: Number.POSITIVE_INFINITY,
      estimatedValue: Number.NaN,
      estimator: "snips" as const,
      lift: Number.NaN,
      effectiveSampleSize: 100,
      warnings: [],
    };
    const verdict = promotionGate(poisoned, { minSteps: 10 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/not a finite/);
  });
});

describe("compaction and learning evidence (ADR 0116 amendment, round 3)", () => {
  it("trajectories built from the folded state are identical compacted vs uncompacted (in-run and late rewards)", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const policy = explorer(0.2);
    const runner: FlowRunner<{ tokens: number }, { route: string }> = async (ctx, input) => {
      for (let i = 0; i < 3; i++) await ctx.emit("note", { i }); // something to reclaim
      const route = await decideWithPolicy(ctx, "route", policy, { tokens: input.tokens }, [
        ...ROUTES,
      ]);
      await decideWithPolicy(ctx, "second", policy, { tokens: input.tokens + 100 }, [...ROUTES]);
      recordOutcome(ctx, { key: `in-${route}`, score: 0.3, decisionId: "route" });
      return { route };
    };
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: new EffectRuntime(),
    });
    runtime.registerFlow(makeFlow(runner).definition, runner);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const h = await runtime.start(
        makeFlow(runner),
        { tokens: i * 100 },
        { executionId: `c${i}` }
      );
      await h.waitForCompletion();
      ids.push(`c${i}`);
      await runtime.recordOutcome(`c${i}`, { decisionId: "route", key: "late", score: 0.9 });
    }
    const shape = (ts: ReturnType<typeof trajectories<Route>>) =>
      ts.map((t) => ({
        outcome: t.outcome,
        terminalReward: t.terminalReward,
        steps: t.steps.map((s) => [
          s.decisionId,
          s.action,
          s.actions,
          s.reward,
          s.rewardSource,
          s.directReward,
          s.policy,
          s.context,
        ]),
      }));
    const evidence = async () =>
      (
        await Promise.all(
          ids.map(async (id) =>
            evidenceEvents((await runtime.loadState(id))!, await eventStore.read(id))
          )
        )
      ).flat();
    const full = shape(
      trajectories<Route>((await Promise.all(ids.map((id) => eventStore.read(id)))).flat())
    );
    // the state-built path agrees with the log path on a log that was never compacted
    expect(shape(trajectories<Route>(await evidence()))).toEqual(full);

    const life = new LogLifecycle(eventStore, snapshotStore);
    for (const id of ids) expect(await life.compact(id)).not.toBeNull();
    const log = (await Promise.all(ids.map((id) => eventStore.read(id)))).flat();
    // nothing extra is kept in place: every decision and the in-run reward are in the checkpoint
    expect(log.filter((e) => e.eventType === "DECISION_RECORDED")).toHaveLength(0);
    expect(log.filter((e) => e.eventType === "OUTCOME_RECORDED")).toHaveLength(10); // late ones
    expect(shape(trajectories<Route>(await evidence()))).toEqual(full);
    // the log alone is NOT enough once compacted: that is why the state path exists
    expect(shape(trajectories<Route>(log))).not.toEqual(full);
    // and a late outcome after compaction still joins to its decision
    const r = await runtime.recordOutcome("c0", { decisionId: "second", key: "later", score: 0.1 });
    expect(r.appended).toBe(true);
    const t0 = trajectories<Route>(
      evidenceEvents((await runtime.loadState("c0"))!, await eventStore.read("c0"))
    )[0];
    expect(t0?.steps.find((s) => s.decisionId === "second")?.directReward).toBe(0.1);
  });

  it("a long agent run's decisions are reclaimed by compaction (2 KB x 1000 compacts back down)", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const big = "x".repeat(2000);
    const runner: FlowRunner<{ tokens: number }, { route: string }> = async (ctx) => {
      for (let i = 0; i < 1000; i++) await ctx.decide(`llm-${i}`, () => big + i);
      return { route: "done" };
    };
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: new EffectRuntime(),
    });
    runtime.registerFlow(makeFlow(runner).definition, runner);
    await (
      await runtime.start(makeFlow(runner), { tokens: 1 }, { executionId: "big" })
    ).waitForCompletion();
    const bytes = (evs: readonly { payload: unknown }[]) =>
      evs.reduce((n, e) => n + JSON.stringify(e).length, 0);
    const before = await eventStore.read("big");
    expect(await new LogLifecycle(eventStore, snapshotStore).compact("big")).not.toBeNull();
    const after = await eventStore.read("big");
    expect(after.filter((e) => e.eventType === "DECISION_RECORDED")).toHaveLength(0);
    expect(bytes(after)).toBeLessThan(bytes(before) / 50);
    // ...and every decision is still there for the learner, from the folded state
    const t = trajectories<string>(evidenceEvents((await runtime.loadState("big"))!, after))[0];
    expect(t?.steps).toHaveLength(1000);
    expect(t?.steps[999]?.action).toBe(`${big}999`);
  });

  describe("decision ORDER of the evidence (discounted terminal credit)", () => {
    const run = async (
      ids: string[],
      stores: { eventStore: EventStore; snapshotStore: SnapshotStore } = {
        eventStore: new InMemoryAsyncEventStore(),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
      },
      executionId = "o"
    ) => {
      const { eventStore, snapshotStore } = stores;
      const runner: FlowRunner<{ tokens: number }, { route: string }> = async (ctx) => {
        for (const id of ids) await ctx.decide(id, () => id);
        return { route: "done" };
      };
      const runtime = new WorkflowRuntime({
        eventStore,
        snapshotStore,
        effectRuntime: new EffectRuntime(),
      });
      runtime.registerFlow(makeFlow(runner).definition, runner);
      await (
        await runtime.start(makeFlow(runner), { tokens: 1 }, { executionId })
      ).waitForCompletion();
      return { eventStore, snapshotStore, runtime };
    };
    const credit = (events: Parameters<typeof trajectories>[0]) =>
      trajectories<string>(events, { discount: 0.5 })[0]?.steps.map((s) => [
        s.decisionId,
        s.reward,
      ]);

    it("an uncompacted log keeps the TRUE order even for array-index-like decisionIds", async () => {
      const { eventStore, runtime } = await run(["b", "10", "2", "a"]);
      const log = await eventStore.read("o");
      const raw = credit(log);
      expect(raw?.map((r) => r[0])).toEqual(["b", "10", "2", "a"]);
      expect(credit(evidenceEvents((await runtime.loadState("o"))!, log))).toEqual(raw);
    });

    it("a compacted execution with ordinary decisionIds discounts identically", async () => {
      const { eventStore, snapshotStore, runtime } = await run(["d-b", "d-10", "d-2", "d-a"]);
      const raw = credit(await eventStore.read("o"));
      expect(await new LogLifecycle(eventStore, snapshotStore).compact("o")).not.toBeNull();
      expect(
        credit(evidenceEvents((await runtime.loadState("o"))!, await eventStore.read("o")))
      ).toEqual(raw);
    });

    // ADR 0128: the fold stamps `seq` on each decision, so the order survives the checkpoint even
    // for array-index-like ids (which a plain object lists first, ascending).
    it("absorbed array-index-like ids keep their true order", async () => {
      const { eventStore, snapshotStore, runtime } = await run(["b", "10", "2", "a"]);
      expect(await new LogLifecycle(eventStore, snapshotStore).compact("o")).not.toBeNull();
      const got = credit(
        evidenceEvents((await runtime.loadState("o"))!, await eventStore.read("o"))
      );
      expect(got?.map((r) => r[0])).toEqual(["b", "10", "2", "a"]);
    });

    it("a LEGACY snapshot (no seq) is read in folded-map order, with no migration", async () => {
      const { eventStore, snapshotStore, runtime } = await run(["d-b", "d-a"]);
      expect(await new LogLifecycle(eventStore, snapshotStore).compact("o")).not.toBeNull();
      const state = (await runtime.loadState("o"))!;
      const decisions = state.variables._decisions as Record<string, Record<string, unknown>>;
      expect(decisions["d-b"]?.seq).toBeTypeOf("number");
      // Strip `seq` as a pre-1.24 fold would have written it, and reverse the map.
      const legacy = Object.fromEntries(
        Object.entries(decisions)
          .reverse()
          .map(([id, { seq: _seq, ...rest }]) => [id, rest])
      );
      const events = evidenceEvents(
        { ...state, variables: { ...state.variables, _decisions: legacy } },
        await eventStore.read("o")
      );
      expect(credit(events)?.map((r) => r[0])).toEqual(["d-a", "d-b"]); // map order, as before
    });

    // The Postgres half: `jsonb` orders object keys by length, then bytes, so a snapshot read back
    // from Postgres lists `route-a` before `route-b` whatever order they were decided in. Without
    // `seq` the discounted credit is swapped; with it, compaction is invisible.
    const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;
    const pgIt = PG_URL ? it : it.skip;
    const pgStores: Array<{ close(): Promise<void> }> = [];
    afterAll(async () => {
      for (const st of pgStores) await st.close();
    });
    pgIt(
      "a compacted run on the REAL Postgres store keeps decision order (jsonb reorders keys)",
      async () => {
        const eventStore = new PostgresEventStore(PG_URL as string);
        const snapshotStore = new PostgresSnapshotStore(PG_URL as string);
        pgStores.push(eventStore, snapshotStore);
        const executionId = `order-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const { runtime } = await run(
          ["route-b", "route-a"],
          { eventStore, snapshotStore },
          executionId
        );
        const raw = credit(await eventStore.read(executionId));
        expect(raw?.map((r) => r[0])).toEqual(["route-b", "route-a"]);
        expect(
          await new LogLifecycle(eventStore, snapshotStore).compact(executionId)
        ).not.toBeNull();
        const state = (await runtime.loadState(executionId))!;
        // The premise: jsonb really did reorder the folded map.
        expect(Object.keys(state.variables._decisions as object)).toEqual(["route-a", "route-b"]);
        expect(credit(evidenceEvents(state, await eventStore.read(executionId)))).toEqual(raw);
      }
    );
  });
});
