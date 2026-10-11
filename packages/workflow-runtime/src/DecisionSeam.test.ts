import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { DecideOptions, FlowRunner, RegisteredFlow } from "./types";

// M2 (Loom 2.0, P9) — the Decision seam. `ctx.decide` records an optimizer's choice
// as a durable DECISION_RECORDED event; on replay/resume the recorded choice is
// served and the optimizer is never re-consulted, so a single run replays purely
// (P2) even though outcomes may change run-to-run.

const inputSchema = z.object({ id: z.string() });
const outputSchema = z.object({ model: z.string() });

const finalizeStep = step$({
  id: "finalize",
  name: "Finalize",
  toolId: "finalize-tool",
  inputSchema: z.object({ model: z.string() }),
  outputSchema: z.object({ done: z.boolean() }),
});

function makeFlow(
  runner: FlowRunner<{ id: string }, { model: string }>
): RegisteredFlow<{ id: string }, { model: string }> {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "decide-flow",
      name: "Decide Flow",
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [finalizeStep],
    },
    runner,
  };
}

describe("M2 — Decision seam (ctx.decide / DECISION_RECORDED)", () => {
  it("records a decision once; replay serves it without re-invoking the optimizer", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const effectRuntime = new EffectRuntime();
    effectRuntime.register(
      "finalize-tool",
      new ToolEffect(vi.fn().mockResolvedValue({ done: true }))
    );

    // The optimizer returns a DIFFERENT value each call — so if replay wrongly
    // re-ran it, the observed choice would change and the assertions would fail.
    let calls = 0;
    const optimizer = vi.fn(() => `model-${++calls}`);
    const seenChoices: string[] = [];

    const runner: FlowRunner<{ id: string }, { model: string }> = async (ctx) => {
      const model = await ctx.decide("route:model", () => optimizer(), { source: "test" });
      seenChoices.push(model);
      await ctx.suspend({ on: "Approved" });
      await ctx.run(finalizeStep, { model });
      return { model };
    };

    // ── First run: decide, then suspend. Optimizer consulted exactly once. ──
    const runtime1 = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
    runtime1.registerFlow(makeFlow(runner).definition, runner);
    const handle1 = await runtime1.start(makeFlow(runner), { id: "x" });
    const suspended = await handle1.waitForSuspend();

    expect(suspended.status).toBe("suspended");
    expect(optimizer).toHaveBeenCalledTimes(1);
    expect(seenChoices).toEqual(["model-1"]);

    // The choice is durably in the log.
    const events = await eventStore.read(handle1.executionId);
    const decision = events.find((e) => e.eventType === "DECISION_RECORDED");
    expect(decision?.payload).toMatchObject({
      decisionId: "route:model",
      choice: "model-1",
      source: "test",
    });

    // ── Resume on a fresh runtime sharing the stores. The flow re-runs from the
    // top; decide short-circuits from the log; the optimizer is NOT called again. ──
    const runtime2 = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
    runtime2.registerFlow(makeFlow(runner).definition, runner);
    const handle2 = await runtime2.resume(handle1.executionId, {
      eventType: "Approved",
      payload: {},
    });
    const final = await handle2.waitForCompletion();

    expect(final.status).toBe("completed");
    expect(optimizer).toHaveBeenCalledTimes(1); // still exactly once
    expect(seenChoices).toEqual(["model-1", "model-1"]); // replay saw the SAME choice
    expect((final.variables._output as { model: string }).model).toBe("model-1");
  });
});

// ADR 0079 (T2) — `decide` must carry the observation and the policy stamp through to
// the durable event. This is the whole kernel change: without it the log records only
// (action, reward) and no contextual policy is learnable from it afterwards.
describe("ADR 0079 — context + policy on the decision seam", () => {
  it("writes context and policy into DECISION_RECORDED, and omits them when unused", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: new EffectRuntime(),
    });

    const runner: FlowRunner<{ id: string }, { model: string }> = async (ctx, input) => {
      const model = await ctx.decide("route", () => "opus", {
        context: { intent: "summarize", tokens: 4096, tenant: input.id },
        policy: { id: "linucb", version: "3", propensity: 0.7 },
      });
      await ctx.decide("plain", () => "unstamped");
      return { model };
    };
    runtime.registerFlow(makeFlow(runner).definition, runner);

    const handle = await runtime.start(makeFlow(runner), { id: "acme" });
    await handle.waitForCompletion();

    const decisions = (await eventStore.read(handle.executionId))
      .filter((e) => e.eventType === "DECISION_RECORDED")
      .map((e) => e.payload as Record<string, unknown>);

    expect(decisions[0]).toEqual({
      decisionId: "route",
      choice: "opus",
      context: { intent: "summarize", tokens: 4096, tenant: "acme" },
      policy: { id: "linucb", version: "3", propensity: 0.7 },
      innerSteps: [], // ADR 0113 D3: always written (an absent field means a pre-R7 record)
    });
    // A decision no policy produced stays exactly as it was before 1.18.0 apart from ADR 0113's
    // `innerSteps` — the policy fields are opt-in by presence, never defaulted in.
    expect(decisions[1]).toEqual({ decisionId: "plain", choice: "unstamped", innerSteps: [] });
  });

  it("does not make the observation a replay input — the decider stays uncalled", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const effectRuntime = new EffectRuntime();
    effectRuntime.register(
      "finalize-tool",
      new ToolEffect(vi.fn().mockResolvedValue({ done: true }))
    );

    // Each call returns something new, so a wrongly re-consulted decider is visible.
    let calls = 0;
    const decider = vi.fn(() => `model-${++calls}`);

    // The context CHANGES between the two runs (a policy that has since learned more).
    // Replay must still serve the originally recorded choice.
    const makeRunner =
      (tokens: number, version: string): FlowRunner<{ id: string }, { model: string }> =>
      async (ctx) => {
        const model = await ctx.decide("route", () => decider(), {
          context: { tokens },
          policy: { id: "linucb", version, propensity: 0.7 },
        });
        await ctx.suspend({ on: "Approved" });
        await ctx.run(finalizeStep, { model });
        return { model };
      };

    const first = makeRunner(4096, "3");
    const runtime1 = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
    runtime1.registerFlow(makeFlow(first).definition, first);
    const handle1 = await runtime1.start(makeFlow(first), { id: "x" });
    await handle1.waitForSuspend();
    expect(decider).toHaveBeenCalledTimes(1);

    const second = makeRunner(999_999, "4");
    const runtime2 = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
    runtime2.registerFlow(makeFlow(second).definition, second);
    const handle2 = await runtime2.resume(handle1.executionId, {
      eventType: "Approved",
      payload: {},
    });
    const final = await handle2.waitForCompletion();

    expect(final.status).toBe("completed");
    expect(decider).toHaveBeenCalledTimes(1); // never re-consulted
    expect((final.variables._output as { model: string }).model).toBe("model-1");
  });
});

// ADR 0124 follow-up — `@loom/learning` fills the `policy` stamp from INSIDE the decider (so a
// replay consults no policy). That relies on `opts` being read at commit, after the decider
// settles, and on a served decision reading no `opts` at all. Pin both here, in the kernel, so a
// refactor that snapshots `opts` up front fails in this package rather than as a learning bug.
describe("ADR 0124 — opts are read at commit", () => {
  it("records fields the decider set on the opts object; a served decision reads no opts", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const effectRuntime = new EffectRuntime();
    effectRuntime.register(
      "finalize-tool",
      new ToolEffect(vi.fn().mockResolvedValue({ done: true }))
    );

    let deciderCalls = 0;
    let optsReads = 0;
    const runner: FlowRunner<{ id: string }, { model: string }> = async (ctx) => {
      const fields: DecideOptions = {};
      // Counts every property read, so a served decision touching opts is visible.
      const opts = new Proxy(fields, {
        get(target, key) {
          optsReads++;
          return Reflect.get(target, key);
        },
      }) as DecideOptions;
      const model = await ctx.decide(
        "route",
        () => {
          deciderCalls++;
          fields.policy = { id: "p", version: "7", propensity: 0.25 };
          fields.context = { tokens: 10 };
          fields.rationale = "set by the decider";
          return "opus";
        },
        opts
      );
      await ctx.suspend({ on: "Approved" });
      await ctx.run(finalizeStep, { model });
      return { model };
    };

    const runtime1 = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
    runtime1.registerFlow(makeFlow(runner).definition, runner);
    const handle = await runtime1.start(makeFlow(runner), { id: "x" });
    await handle.waitForSuspend();

    const recorded = (await eventStore.read(handle.executionId)).find(
      (e) => e.eventType === "DECISION_RECORDED"
    )?.payload as Record<string, unknown>;
    expect(recorded).toMatchObject({
      decisionId: "route",
      choice: "opus",
      policy: { id: "p", version: "7", propensity: 0.25 },
      context: { tokens: 10 },
      rationale: "set by the decider",
    });
    expect(deciderCalls).toBe(1);

    // Resume on a fresh runtime: the decision is served — no decider call, no opts read.
    optsReads = 0;
    const runtime2 = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
    runtime2.registerFlow(makeFlow(runner).definition, runner);
    const resumed = await runtime2.resume(handle.executionId, {
      eventType: "Approved",
      payload: {},
    });
    const final = await resumed.waitForCompletion();
    expect(final.status).toBe("completed");
    expect(deciderCalls).toBe(1);
    expect(optsReads).toBe(0);
  });
});
