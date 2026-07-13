import { secret, sensitive } from "@loom/classify";
import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectMiddleware } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { BranchRegistry } from "@loom/event-runtime";
import { InMemorySecretResolver, isSecretRef, retryMiddleware, secretRef } from "@loom/middleware";
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

describe("defineConfig — custom storage (bring your own backend)", () => {
  it("uses the injected EventStore/SnapshotStore verbatim and writes to them", async () => {
    // Any EventStore/SnapshotStore works — here in-memory stands in for a real
    // network backend (Postgres/Redis/DynamoDB) to prove they're used as-is.
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const appendSpy = vi.spyOn(eventStore, "append");
    const closeSpy = vi.spyOn(eventStore, "close");

    const app = defineConfig({
      storage: { kind: "custom", eventStore, snapshotStore },
      flows: [gatedFlow()],
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));

    // The exact instances are threaded through — not copied or re-created.
    expect(app.stores.eventStore).toBe(eventStore);
    expect(app.stores.snapshotStore).toBe(snapshotStore);

    // A real run writes to the injected store (gatedFlow suspends → events committed).
    await (await app.runtime.start(gatedFlow(), { incidentId: "i1" })).waitForSuspend();
    expect(appendSpy).toHaveBeenCalled();

    await app.close();
    expect(closeSpy).toHaveBeenCalled();
  });

  it("threads an injected BranchRegistry through to app.stores (custom + branching)", () => {
    const branchRegistry = { name: "byo-branch-registry" } as unknown as BranchRegistry;
    const app = defineConfig({
      storage: {
        kind: "custom",
        eventStore: new InMemoryAsyncEventStore(),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        branchRegistry,
      },
    });
    expect(app.stores.branchRegistry).toBe(branchRegistry);
  });
});

describe("defineConfig — retention (K10.1 log lifecycle)", () => {
  it("exposes an app.lifecycle wired over the app's stores", async () => {
    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx) => {
      await ctx.run(metricsStep, { incidentId: "i1" });
      await ctx.run(remediationStep, { incidentId: "i1" });
      return { resolved: true };
    };
    const flow = {
      definition: { ...gatedFlow().definition, id: "straight-r" },
      runner,
    } as RegisteredFlow;
    const app = defineConfig({ storage: { kind: "memory" }, flows: [flow] });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));
    const handle = await app.runtime.start(flow, { incidentId: "i1" }, { executionId: "r1" });
    await handle.waitForCompletion();

    // A per-execution retention pass drives off the app's own stores — no background thread.
    const outcome = await app.lifecycle.applyRetention(
      "r1",
      { terminalTtlMs: 0 },
      Date.now() + 1e9
    );
    expect(outcome).toBe("reclaimed");
    expect(await app.stores.eventStore.read("r1")).toHaveLength(0);
  });
});

describe("defineConfig — secrets (K10-R2)", () => {
  it("resolves input refs for the tool and redacts secret() output fields from the log", async () => {
    const mintStep = step$({
      id: "mint",
      toolId: "mint-tool",
      inputSchema: z.object({ apiKey: z.any() }),
      outputSchema: z.object({ token: secret(z.string()), ok: z.boolean() }),
    });
    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx) => {
      await ctx.run(mintStep, { apiKey: secretRef("vault-key") });
      return { resolved: true };
    };
    const flow = {
      definition: { ...gatedFlow().definition, id: "mint-flow", steps: [mintStep] },
      runner,
    } as RegisteredFlow;

    const resolver = new InMemorySecretResolver(new Map([["vault-key", "sk_live_REAL"]]));
    const app = defineConfig({ storage: { kind: "memory" }, flows: [flow], secrets: { resolver } });

    let toolSawKey: unknown;
    app.effectRuntime.register(
      "mint-tool",
      new ToolEffect(async (input: { apiKey: string }) => {
        toolSawKey = input.apiKey; // the tool sees the RESOLVED secret
        return { token: "sk_minted_SECRET", ok: true };
      })
    );

    const handle = await app.runtime.start(flow, { incidentId: "i1" }, { executionId: "s1" });
    await handle.waitForCompletion();

    // The tool received the resolved input secret.
    expect(toolSawKey).toBe("sk_live_REAL");

    const events = await app.stores.eventStore.read("s1");
    // Input side: STEP_STARTED logged the reference, never the real key.
    const started = events.find((e) => e.eventType === "STEP_STARTED");
    expect(JSON.stringify(started?.payload)).not.toContain("sk_live_REAL");
    expect(JSON.stringify(started?.payload)).toContain("vault-key");
    // Output side: STEP_COMPLETED logged a ref, never the minted secret.
    const completed = events.find((e) => e.eventType === "STEP_COMPLETED");
    const loggedToken = (completed?.payload as { output: { token: unknown } }).output.token;
    expect(isSecretRef(loggedToken)).toBe(true);
    expect(JSON.stringify(completed?.payload)).not.toContain("sk_minted_SECRET");
    // The minted value is recoverable only through the resolver.
    expect(resolver.resolve("s1:mint:token")).toBe("sk_minted_SECRET");
    await app.close();
  });
});

describe("defineConfig — egress scrubbing (K10-R6)", () => {
  it("scrubs sensitive() output fields from telemetry adapters automatically", async () => {
    const lookupStep = step$({
      id: "lookup",
      toolId: "lookup-tool",
      inputSchema: z.object({ q: z.string() }),
      outputSchema: z.object({ ssn: sensitive(z.string()), ok: z.boolean() }),
    });
    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx) => {
      await ctx.run(lookupStep, { q: "who" });
      return { resolved: true };
    };
    const flow = {
      definition: { ...gatedFlow().definition, id: "lookup-flow", steps: [lookupStep] },
      runner,
    } as RegisteredFlow;

    const stepOutputs: unknown[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      telemetry: [{ onStepComplete: (i) => stepOutputs.push(i.output) }],
    });
    app.effectRuntime.register(
      "lookup-tool",
      new ToolEffect(async () => ({ ssn: "123-45-6789", ok: true }))
    );

    const handle = await app.runtime.start(flow, { incidentId: "i1" }, { executionId: "t1" });
    await handle.waitForCompletion();

    // Telemetry (egress) never saw the plaintext ssn — only the mask.
    expect(stepOutputs[0]).toEqual({ ssn: "[redacted]", ok: true });
    // But the LOG still has it (encryption/erasure is the log's concern, not egress).
    const completed = (await app.stores.eventStore.read("t1")).find(
      (e) => e.eventType === "STEP_COMPLETED"
    );
    expect((completed?.payload as { output: { ssn: string } }).output.ssn).toBe("123-45-6789");
    await app.close();
  });
});
