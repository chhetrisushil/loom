import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectMiddleware } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { retryMiddleware } from "@loom/middleware";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";

const incident = z.object({ incidentId: z.string() });
const resolved = z.object({ resolved: z.boolean() });
const metricsStep = step$({
  id: "fetch-metrics",
  name: "Metrics",
  toolId: "metrics-tool",
  inputSchema: incident,
  outputSchema: z.object({ cpu: z.number() }),
});
const remediationStep = step$({
  id: "apply-remediation",
  name: "Remediate",
  toolId: "remediation-tool",
  inputSchema: incident,
  outputSchema: z.object({ fixed: z.boolean() }),
});

const FLOW = "gated";
const gatedRunner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
  ctx: WorkflowContext,
  input
) => {
  await ctx.run(metricsStep, { incidentId: input.incidentId });
  await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.incidentId });
  await ctx.run(remediationStep, { incidentId: input.incidentId });
  return { resolved: true };
};
function gatedFlow(): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: FLOW,
      name: FLOW,
      version: "1.0.0",
      inputSchema: incident,
      outputSchema: resolved,
      steps: [metricsStep, remediationStep],
    },
    runner: gatedRunner,
  } as RegisteredFlow;
}

function registerToolEffects(rt: EffectRuntime, metrics: () => Promise<unknown>) {
  rt.register("metrics-tool", new ToolEffect(metrics as never));
  rt.register("remediation-tool", new ToolEffect(async () => ({ fixed: true })));
}

describe("defineConfig — flowModules + manifest cross-check", () => {
  it("registers flows from statically-imported modules and warns on manifest gaps", async () => {
    const warnings: string[] = [];
    // A statically-imported module namespace (what `import * as flows` yields).
    const flowsModule = { Gated: gatedFlow() };
    const app = defineConfig({
      storage: { kind: "memory" },
      flowModules: [flowsModule],
      manifest: { flows: { gated: { warnings: [] }, missing: { warnings: [] } } },
      onWarn: (m) => warnings.push(m),
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));

    // The module's flow is registered and runnable.
    expect(app.runtime.getFlow("gated")).toBeDefined();
    const handle = await app.runtime.start(gatedFlow(), { incidentId: "i1" });
    expect((await handle.waitForSuspend()).status).toBe("suspended");

    // The manifest flow with no matching registration is flagged.
    expect(warnings.some((w) => w.includes("missing") && w.includes("not registered"))).toBe(true);
    expect(warnings.some((w) => w.includes('"gated"'))).toBe(false);
    await app.close();
  });
});

describe("defineConfig", () => {
  it("assembles a runtime that runs a flow start → suspend → resume", async () => {
    const app = defineConfig({ storage: { kind: "memory" }, flows: [gatedFlow()] });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));

    const handle = await app.runtime.start(gatedFlow(), { incidentId: "i1" });
    const suspended = await handle.waitForSuspend();
    expect(suspended.status).toBe("suspended");

    const resumed = await app.runtime.resume(handle.executionId, {
      eventType: "ApprovalGranted",
      payload: { approved: true },
    });
    const final = await resumed.waitForCompletion();
    expect(final.status).toBe("completed");
    expect(final.variables._output).toEqual({ resolved: true });
    await app.close();
  });

  it("wires effect middleware from config; retry recovers a flaky effect", async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce({ cpu: 87 });
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [gatedFlow()],
      effectMiddleware: [retryMiddleware({ maxRetries: 2, sleep: async () => {} })],
    });
    registerToolEffects(app.effectRuntime, flaky);

    const handle = await app.runtime.start(gatedFlow(), { incidentId: "i1" });
    const suspended = await handle.waitForSuspend();
    expect(suspended.status).toBe("suspended");
    expect(flaky).toHaveBeenCalledTimes(2); // failed once, retried, succeeded
    await app.close();
  });

  it("middleware is NOT re-invoked for replayed/completed steps", async () => {
    const seen: string[] = [];
    const spy: EffectMiddleware = async (ctx, _input, next) => {
      seen.push(ctx.stepId);
      return next();
    };
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [gatedFlow()],
      effectMiddleware: [spy],
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));

    const handle = await app.runtime.start(gatedFlow(), { incidentId: "i1" });
    await handle.waitForSuspend();
    expect(seen).toEqual(["fetch-metrics"]); // only the pre-suspend step ran

    const resumed = await app.runtime.resume(handle.executionId, {
      eventType: "ApprovalGranted",
      payload: {},
    });
    await resumed.waitForCompletion();
    // fetch-metrics is completed (skipped on replay) ⇒ middleware runs only for
    // the post-suspend step. No duplicate fetch-metrics entry.
    expect(seen).toEqual(["fetch-metrics", "apply-remediation"]);
    await app.close();
  });

  it("forwards telemetry adapters", async () => {
    const onFlowComplete = vi.fn();
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [gatedFlow()],
      telemetry: [{ onFlowComplete }],
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));
    const handle = await app.runtime.start(gatedFlow(), { incidentId: "i1" });
    await handle.waitForSuspend();
    const resumed = await app.runtime.resume(handle.executionId, {
      eventType: "ApprovalGranted",
      payload: {},
    });
    await resumed.waitForCompletion();
    expect(onFlowComplete).toHaveBeenCalled();
    await app.close();
  });

  it("matches a hand-wired runtime's folded state (config is sugar over DI)", async () => {
    const straightRunner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
      ctx
    ) => {
      await ctx.run(metricsStep, { incidentId: "i1" });
      await ctx.run(remediationStep, { incidentId: "i1" });
      return { resolved: true };
    };
    const straight = {
      definition: { ...gatedFlow().definition, id: "straight" },
      runner: straightRunner,
    } as RegisteredFlow;

    // hand-wired
    const effects = new EffectRuntime();
    registerToolEffects(effects, async () => ({ cpu: 87 }));
    const hand = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
    });
    hand.registerFlow(straight.definition, straight.runner);
    const handState = await (await hand.start(straight, { incidentId: "i1" })).waitForCompletion();

    // config
    const app = defineConfig({ storage: { kind: "memory" }, flows: [straight] });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));
    const cfgState = await (
      await app.runtime.start(straight, { incidentId: "i1" })
    ).waitForCompletion();

    const shape = (s: typeof handState) => ({
      status: s.status,
      frames: Object.fromEntries(
        Object.entries(s.frames).map(([k, f]) => [k, { status: f.status, output: f.output }])
      ),
      output: s.variables._output,
    });
    expect(shape(cfgState)).toEqual(shape(handState));
    await app.close();
  });
});
