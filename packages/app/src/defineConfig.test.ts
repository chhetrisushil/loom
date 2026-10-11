import { surface } from "@loom/agent-surface";
import { secret, sensitive } from "@loom/classify";
import {
  type EventEnvelope,
  agent$,
  instructions$,
  memory$,
  policy$,
  projection$,
  schedule$,
  skill$,
  step$,
  tool$,
} from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectMiddleware } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { BranchRegistry, EventStore } from "@loom/event-runtime";
import { InMemorySecretResolver, isSecretRef, retryMiddleware, secretRef } from "@loom/middleware";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type CatalogLike, defineConfig as defineConfigRaw } from "./defineConfig";
import { withPrincipalCodec } from "./principalTestSupport";

// ADR 0111 D1 — a composed compliance plugin requires crypto or a principalCodec; most suites here
// are about other things, so the in-memory test codec is added where a config needs one.
const defineConfig: typeof defineConfigRaw = (config) =>
  defineConfigRaw(withPrincipalCodec(config));

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
      observability: { onWarn: (m) => warnings.push(m) },
      checks: { manifest: { flows: { gated: { warnings: [] }, missing: { warnings: [] } } } },
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

describe("defineConfig — ctx.ui is injected (ADR 0114)", () => {
  it("a composed app's flow can use ctx.ui and surface(ctx), with identical patches", async () => {
    const seen: { eventType: string; payload: unknown }[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      observability: { onEvent: (e) => seen.push({ eventType: e.eventType, payload: e.payload }) },
      flows: [
        {
          definition: {
            _tag: "FlowDefinition",
            id: "ui-flow",
            name: "ui-flow",
            version: "1.0.0",
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            steps: [],
          },
          runner: (async (ctx: WorkflowContext) => {
            (ctx as unknown as { ui: { set(p: string, v: unknown): void } }).ui.set("a", 1);
            surface(ctx).set("a", 1);
            return {};
          }) as never,
        } as RegisteredFlow,
      ],
    });
    const handle = await app.runtime.start(app.runtime.getFlow("ui-flow") as RegisteredFlow, {});
    await handle.waitForCompletion();
    const patches = seen.filter((e) => e.eventType === "SURFACE_PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[0]?.payload).toEqual(patches[1]?.payload);
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
      execution: { effectMiddleware: [retryMiddleware({ maxRetries: 2, sleep: async () => {} })] },
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
      execution: { effectMiddleware: [spy] },
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
      observability: { telemetry: [{ onFlowComplete }] },
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

describe("defineConfig — retention.pinnedEventTypes (ADR 0106)", () => {
  it("wires the kinds into app.lifecycle: compaction keeps them in place", async () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      durability: { retention: { pinnedEventTypes: ["FINDING_RECORDED"] } },
    });
    const log = app.stores.eventStore;
    const at = (sequence: number, eventType: string) => ({
      id: `p-${sequence}`,
      workflowId: "wf",
      executionId: "p",
      eventType,
      sequence,
      timestamp: sequence,
      payload: { input: {} },
    });
    await log.append(at(0, "EXECUTION_STARTED"));
    await log.append(at(1, "FINDING_RECORDED"));
    await log.append(at(2, "STEP_STARTED"));
    await log.append(at(3, "STEP_STARTED"));
    expect(await app.lifecycle.compact("p")).toBe(2);
    expect((await log.read("p")).map((e) => e.sequence)).toEqual([0, 1, 3]);
  });

  it("wires retention.compactionExempt: an exempt execution keeps its whole log", async () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      durability: {
        retention: { pinnedEventTypes: ["FINDING_RECORDED"], compactionExempt: () => true },
      },
    });
    const log = app.stores.eventStore;
    for (let i = 0; i < 3; i++) {
      await log.append({
        id: `h-${i}`,
        workflowId: "wf",
        executionId: "h",
        eventType: i === 0 ? "EXECUTION_STARTED" : "STEP_STARTED",
        sequence: i,
        timestamp: i,
        payload: { input: {} },
      });
    }
    expect(await app.lifecycle.compact("h")).toBeNull();
    expect(await log.read("h")).toHaveLength(3);
  });

  it("refuses a kernel kind at config time, before any compaction pass", () => {
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        durability: { retention: { pinnedEventTypes: ["STEP_COMPLETED"] } },
      })
    ).toThrow(/kernel event kind/);
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
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: { secrets: { resolver } },
    });

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
      observability: { telemetry: [{ onStepComplete: (i) => stepOutputs.push(i.output) }] },
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

describe("defineConfig — compliance / subject rights (T3)", () => {
  it("indexes subjects off the event stream and exports a subject's data", async () => {
    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx) => {
      await ctx.run(metricsStep, { incidentId: "i1" });
      return { resolved: true };
    };
    const flow = {
      definition: { ...gatedFlow().definition, id: "subj-flow", steps: [metricsStep] },
      runner,
    } as RegisteredFlow;

    // Subject = the incidentId carried in EXECUTION_STARTED input.
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: {
        compliance: {
          subjectOf: (e) =>
            e.eventType === "EXECUTION_STARTED"
              ? (e.payload as { input?: { incidentId?: string } }).input?.incidentId
              : undefined,
        },
      },
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));

    await (
      await app.runtime.start(flow, { incidentId: "acme" }, { executionId: "c1" })
    ).waitForCompletion();
    await (
      await app.runtime.start(flow, { incidentId: "acme" }, { executionId: "c2" })
    ).waitForCompletion();

    expect(app.subjectIndex?.executionsOf("acme")).toEqual(["c1", "c2"]);

    const out = await app.exportSubject("acme");
    expect(out.subjectId).toBe("acme");
    expect(out.executions.map((e) => e.executionId)).toEqual(["c1", "c2"]);
    expect(out.executions[0]?.status).toBe("completed");
    await app.close();
  });

  it("exportSubject throws a clear error when compliance is not configured", async () => {
    const app = defineConfig({ storage: { kind: "memory" }, flows: [gatedFlow()] });
    expect(app.subjectIndex).toBeUndefined();
    await expect(app.exportSubject("x")).rejects.toThrow(/compliance/);
    await app.close();
  });

  it("eraseSubject shreds a terminal subject via the wired shredder (T3 Phase B)", async () => {
    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx) => {
      await ctx.run(metricsStep, { incidentId: "i1" });
      return { resolved: true };
    };
    const flow = {
      definition: { ...gatedFlow().definition, id: "erase-flow", steps: [metricsStep] },
      runner,
    } as RegisteredFlow;

    const shredCalls: Array<[string, readonly string[]]> = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: {
        compliance: {
          subjectOf: (e) =>
            e.eventType === "EXECUTION_STARTED"
              ? (e.payload as { input?: { incidentId?: string } }).input?.incidentId
              : undefined,
          erase: {
            shred: async (subjectId, executionIds) => {
              shredCalls.push([subjectId, executionIds]);
            },
          },
        },
      },
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));

    await (
      await app.runtime.start(flow, { incidentId: "acme" }, { executionId: "e1" })
    ).waitForCompletion();

    const result = await app.eraseSubject("acme");
    expect(result.outcome).toBe("erased");
    expect(shredCalls).toEqual([["acme", ["e1"]]]);
    await app.close();
  });

  it('eraseSubject({ parked: "shred" }) CANCELS each parked owner (reason "erased") BEFORE shredding: no owner is left stuck', async () => {
    const flow = gatedFlow();
    const order: string[] = [];
    const seen: EventEnvelope[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      observability: { onEvent: (e) => seen.push(e) },
      security: {
        compliance: {
          subjectOf: (e) =>
            e.eventType === "EXECUTION_STARTED"
              ? (e.payload as { input?: { incidentId?: string } }).input?.incidentId
              : undefined,
          erase: {
            shred: async (subjectId) => {
              order.push(`shred ${subjectId} after ${(await app.runtime.loadState("p1"))?.status}`);
            },
          },
        },
      },
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));
    const h = await app.runtime.start(flow, { incidentId: "acme" }, { executionId: "p1" });
    await h.waitForSuspend();

    const r = await app.eraseSubject("acme", undefined, { parked: "shred" });
    expect(r).toMatchObject({ outcome: "erased", parkedShredded: ["p1"] });
    expect(order).toEqual(["shred acme after cancelled"]); // terminal BEFORE the key is destroyed
    const cancelled = seen.find((e) => e.eventType === "EXECUTION_CANCELLED");
    expect(cancelled?.payload).toMatchObject({ reason: "erased" });
    await app.close();
  });

  it("eraseSubject rejects when erasure is not configured", async () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [gatedFlow()], // index but no erase,
      security: { compliance: { subjectOf: () => undefined } },
    });
    await expect(app.eraseSubject("x")).rejects.toThrow(/eraseSubject requires/);
    await app.close();
  });

  it("partitions the subject index by tenant (T3-R2.4)", async () => {
    const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (ctx) => {
      await ctx.run(metricsStep, { incidentId: "i1" });
      return { resolved: true };
    };
    const flow = {
      definition: { ...gatedFlow().definition, id: "tenant-flow", steps: [metricsStep] },
      runner,
    } as RegisteredFlow;

    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: {
        compliance: {
          // subject = incidentId; tenant = a field carried on the same input.
          subjectOf: (e) =>
            e.eventType === "EXECUTION_STARTED"
              ? (e.payload as { input?: { incidentId?: string } }).input?.incidentId
              : undefined,
          tenantOf: (e) => (e.payload as { input?: { tenant?: string } }).input?.tenant,
        },
      },
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));

    // Same subject id "shared" under two tenants.
    await (
      await app.runtime.start(
        flow,
        { incidentId: "shared", tenant: "acme" } as { incidentId: string },
        { executionId: "t-acme" }
      )
    ).waitForCompletion();
    await (
      await app.runtime.start(
        flow,
        { incidentId: "shared", tenant: "globex" } as { incidentId: string },
        { executionId: "t-globex" }
      )
    ).waitForCompletion();

    expect(app.subjectIndex?.executionsOf("shared", "acme")).toEqual(["t-acme"]);
    expect(app.subjectIndex?.executionsOf("shared", "globex")).toEqual(["t-globex"]);
    // A tenant-scoped export never crosses the boundary.
    const acme = await app.exportSubject("shared", { tenant: "acme" });
    expect(acme.executions.map((e) => e.executionId)).toEqual(["t-acme"]);
    await app.close();
  });
});

describe("defineConfig — agent auto-wiring (a2a / agentSurface, opt-in)", () => {
  const triage = agent$({
    id: "triage",
    name: "Triage",
    description: "triage agent",
    tools: [],
    skills: [{ id: "s1", name: "Skill One" }],
  });
  const manualCard = {
    name: "Manual",
    description: "",
    url: "http://manual",
    version: "1.0.0",
    capabilities: {},
    skills: [],
  };

  it("backward compatible: hand-built AgentCards register verbatim, no flags needed", () => {
    const app = defineConfig({ storage: { kind: "memory" }, agents: [manualCard] });
    expect(app.bus.agentCards().map((c) => c.name)).toContain("Manual");
  });

  it("a2a: true auto-derives + registers an AgentCard from an agent$ definition", () => {
    const app = defineConfig({ storage: { kind: "memory" }, agents: [triage], a2a: true });
    const card = app.bus.agentCards().find((c) => c.name === "Triage");
    expect(card).toBeDefined();
    expect(card?.url).toBe("loom+inproc://triage"); // derived default endpoint
    expect(card?.skills).toEqual([{ id: "s1", name: "Skill One" }]);
  });

  it("agentSurface: true registers a surface per agent (id = agent.id)", () => {
    const app = defineConfig({ storage: { kind: "memory" }, agents: [triage], agentSurface: true });
    // getState throws unless the surface projection is registered.
    expect(() => app.projectionRuntime.getState("triage", "x")).not.toThrow();
  });

  it("opt-in: a definition passed with NO flags is not wired, and warns", () => {
    const warns: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      agents: [triage],
      observability: { onWarn: (m) => warns.push(m) },
    });
    expect(app.bus.agentCards()).toHaveLength(0); // not on the bus
    expect(() => app.projectionRuntime.getState("triage", "x")).toThrow(/not registered/); // no surface
    expect(warns.some((w) => w.includes("neither `a2a` nor `agentSurface`"))).toBe(true);
  });

  it("cards and definitions coexist in one list", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      agents: [manualCard, triage],
      a2a: true,
    });
    expect(
      app.bus
        .agentCards()
        .map((c) => c.name)
        .sort()
    ).toEqual(["Manual", "Triage"]);
  });

  it("discovers agents from agentModules (loom gen) and auto-wires them behind a2a", () => {
    const mod = { triageAgent: triage, notAnAgent: 42, alsoNot: "x" }; // value-shape discovery
    const app = defineConfig({ storage: { kind: "memory" }, agentModules: [mod], a2a: true });
    expect(app.bus.agentCards().map((c) => c.name)).toContain("Triage");
  });

  it("agentModules without a flag are not wired (opt-in, same as `agents`)", () => {
    const app = defineConfig({ storage: { kind: "memory" }, agentModules: [{ a: triage }] });
    expect(app.bus.agentCards()).toHaveLength(0);
  });

  it("exposes tool$ definitions discovered from toolModules on app.tools (effects stay manual)", () => {
    const lookup = tool$({
      id: "lookup",
      name: "Lookup",
      description: "d",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    });
    const app = defineConfig({
      storage: { kind: "memory" },
      toolModules: [{ LookupTool: lookup, notATool: 1 }],
    });
    expect(app.tools.map((t) => t.id)).toEqual(["lookup"]);
  });

  it("registers skill$ definitions from skillModules + skills into app.skills", () => {
    const refunds = skill$({
      id: "refunds",
      name: "Refunds",
      description: "handle refund requests",
      tags: ["billing"],
      instructions: instructions$("Refund the customer."),
    });
    const escalate = skill$({
      id: "escalate",
      name: "Escalate",
      description: "escalate to a human",
      instructions: instructions$("Page the on-call."),
    });
    const app = defineConfig({
      storage: { kind: "memory" },
      skills: [escalate],
      skillModules: [{ RefundsSkill: refunds, notASkill: 7 }],
    });
    expect(app.skills.ids().sort()).toEqual(["escalate", "refunds"]);
    // The deterministic selector is wired and scores over the discovered metadata.
    expect(app.skills.find("refund billing")[0]?.skill.id).toBe("refunds");
  });

  it("enforces a flow's policy$ deny end-to-end (EFFECT_DENIED, run rejects)", async () => {
    const noMetrics = policy$({
      id: "no-metrics",
      name: "No Metrics",
      rules: { deny: ["metrics-tool"] },
    });
    const guarded: RegisteredFlow = {
      definition: {
        _tag: "FlowDefinition",
        id: "guarded",
        name: "guarded",
        version: "1.0.0",
        inputSchema: incident,
        outputSchema: z.object({ cpu: z.number() }),
        steps: [metricsStep],
        policies: [noMetrics],
      },
      runner: (async (ctx: WorkflowContext, input: { incidentId: string }) =>
        ctx.run(metricsStep, { incidentId: input.incidentId })) as FlowRunner<unknown, unknown>,
    } as RegisteredFlow;
    const events: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [guarded],
      observability: { onEvent: (e) => events.push(e.eventType) },
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));
    const handle = await app.runtime.start(guarded, { incidentId: "i1" });
    await expect(handle.waitForCompletion()).rejects.toThrow(/denied/i);
    expect(events).toContain("EFFECT_DENIED");
  });

  it("a policy allow-list permits the listed effect and the flow completes", async () => {
    const onlyMetrics = policy$({
      id: "only-metrics",
      name: "Only Metrics",
      rules: { allow: ["metrics-tool"] },
    });
    const ok: RegisteredFlow = {
      definition: {
        _tag: "FlowDefinition",
        id: "ok-flow",
        name: "ok-flow",
        version: "1.0.0",
        inputSchema: incident,
        outputSchema: z.object({ cpu: z.number() }),
        steps: [metricsStep],
        policies: [onlyMetrics],
      },
      runner: (async (ctx: WorkflowContext, input: { incidentId: string }) =>
        ctx.run(metricsStep, { incidentId: input.incidentId })) as FlowRunner<unknown, unknown>,
    } as RegisteredFlow;
    const events: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [ok],
      observability: { onEvent: (e) => events.push(e.eventType) },
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));
    const handle = await app.runtime.start(ok, { incidentId: "i1" });
    await handle.waitForCompletion();
    expect(events).not.toContain("EFFECT_DENIED");
  });

  it("enforces an agent$'s policies on the capability flow it runs (via capabilityAgents)", async () => {
    const denyMetrics = policy$({
      id: "agent-deny",
      name: "Agent Deny",
      rules: { deny: ["metrics-tool"] },
    });
    const sre = agent$({ id: "sre", name: "SRE", tools: [], policies: [denyMetrics] });
    const capFlow: RegisteredFlow = {
      definition: {
        _tag: "FlowDefinition",
        id: "assess-flow",
        name: "assess",
        version: "1.0.0",
        inputSchema: incident,
        outputSchema: z.object({ cpu: z.number() }),
        steps: [metricsStep],
      },
      runner: (async (ctx: WorkflowContext, input: { incidentId: string }) =>
        ctx.run(metricsStep, { incidentId: input.incidentId })) as FlowRunner<unknown, unknown>,
    } as RegisteredFlow;
    const catalog: CatalogLike = {
      registerInto: (rt) => rt.registerFlow(capFlow.definition, capFlow.runner),
      get: (id) => (id === "assess" ? { flow: capFlow } : undefined),
    };
    const events: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      catalog,
      agents: [sre],
      capabilityAgents: { assess: "sre" },
      observability: { onEvent: (e) => events.push(e.eventType) },
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));
    // The agent runs its capability flow; effects execute under that flow's workflowId,
    // where the agent's policy denies metrics-tool.
    const handle = await app.runtime.start(capFlow, { incidentId: "i1" });
    await expect(handle.waitForCompletion()).rejects.toThrow(/denied/i);
    expect(events).toContain("EFFECT_DENIED");
  });

  it("folds an eager projection$ registered via projectionModules", () => {
    const counter = projection$({
      id: "evt-counter",
      name: "Counter",
      initialState: { n: 0 },
      handlers: { PING: (s: { n: number }) => ({ n: s.n + 1 }) },
    });
    const app = defineConfig({
      storage: { kind: "memory" },
      projectionModules: [{ Counter: counter, notAProjection: 1 }],
    });
    const ev = (seq: number) => ({
      id: `e${seq}`,
      workflowId: "w",
      executionId: "x",
      eventType: "PING",
      sequence: seq,
      timestamp: 0,
      payload: {},
    });
    app.projectionRuntime.handleEvent(ev(0));
    app.projectionRuntime.handleEvent(ev(1));
    expect(app.projectionRuntime.getState<{ n: number }>("evt-counter", "x").n).toBe(2);
  });

  it("loads a lazy projection$ (compiler ref) on the first matching event", async () => {
    let loaded = 0;
    // Simulate the compiler-emitted lazy ref: eventTypes known up front; fold code behind load().
    const lazy = projection$({
      id: "lazy-counter",
      name: "Lazy",
      initialState: { n: 0 },
      handlers: {
        _loomProjectionHandlersRef: true,
        eventTypes: ["PING"],
        load: async () => {
          loaded += 1;
          return { default: { PING: (s: { n: number }) => ({ n: s.n + 1 }) } };
        },
      } as never,
    });
    const app = defineConfig({
      storage: { kind: "memory" },
      projectionModules: [{ Lazy: lazy }],
    });
    const ev = (type: string, seq: number) => ({
      id: `e${seq}`,
      workflowId: "w",
      executionId: "x",
      eventType: type,
      sequence: seq,
      timestamp: 0,
      payload: {},
    });
    // A non-handled event must NOT trigger the load.
    app.projectionRuntime.handleEvent(ev("OTHER", 0));
    expect(loaded).toBe(0);
    // First matching event triggers the one-time load; buffered until ready.
    app.projectionRuntime.handleEvent(ev("PING", 1));
    expect(loaded).toBe(1);
    await new Promise((r) => setTimeout(r, 0)); // let the load + buffer-drain settle
    expect(app.projectionRuntime.getState<{ n: number }>("lazy-counter", "x").n).toBe(1);
  });

  it("registers memory$ definitions from memoryModules + memories into app.memory", async () => {
    const chat = memory$({ id: "chat", name: "Chat", maxEntries: 5 });
    const scratch = memory$({ id: "scratch", name: "Scratch" });
    const app = defineConfig({
      storage: { kind: "memory" },
      memories: [scratch],
      memoryModules: [{ ChatMemory: chat, notAMemory: 3 }],
    });
    // Registered defs are addressable; a round-trip through the runtime proves wiring.
    await app.memory.append("chat", "session-1", { role: "user", content: "hi" });
    const entries = await app.memory.read("chat", "session-1");
    expect(entries.map((e) => e.content)).toEqual(["hi"]);
    // The scratch (explicit) memory is registered too — reading an unwritten scope is empty.
    expect(await app.memory.read("scratch", "s")).toEqual([]);
  });

  it("merges scheduleModules into app.schedules and wires them into the TimerService", () => {
    const nightly = schedule$({ id: "nightly", cron: "0 0 * * *", flowId: "report" });
    const app = defineConfig({
      storage: { kind: "memory" },
      timers: { store: new InMemoryTimerStore() },
      scheduleModules: [{ NightlySchedule: nightly, notASchedule: 1 }],
    });
    expect(app.schedules.map((s) => s.id)).toEqual(["nightly"]);
  });

  it("warns when schedules are declared but no timers store is configured", () => {
    const nightly = schedule$({ id: "nightly", cron: "0 0 * * *", flowId: "report" });
    const onWarn = vi.fn();
    const app = defineConfig({
      storage: { kind: "memory" },
      scheduleModules: [{ NightlySchedule: nightly }],
      observability: { onWarn },
    });
    expect(app.schedules.map((s) => s.id)).toEqual(["nightly"]);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("will not fire"));
  });
});

// A snapshot store that records what it was asked to save, so cadence is observable
// without a database.
class CountingSnapshotStore implements SnapshotStore {
  readonly saves: Snapshot[] = [];
  async save(s: Snapshot): Promise<void> {
    this.saves.push(s);
  }
  async loadLatest(id: string): Promise<Snapshot | null> {
    const mine = this.saves.filter((s) => s.executionId === id);
    return mine.length > 0 ? (mine[mine.length - 1] ?? null) : null;
  }
  async loadAt(): Promise<Snapshot | null> {
    return null;
  }
  async loadLatestBefore(): Promise<Snapshot | null> {
    return null;
  }
  async close(): Promise<void> {}
}

function buildWithCadence(snapshotEvery?: number): {
  app: ReturnType<typeof defineConfig>;
  snapshots: CountingSnapshotStore;
} {
  const snapshots = new CountingSnapshotStore();
  const app = defineConfig({
    storage: {
      kind: "custom",
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: snapshots,
    },
    flows: [gatedFlow()],
    ...(snapshotEvery !== undefined && { durability: { snapshotEvery } }),
  });
  registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));
  return { app, snapshots };
}

describe("defineConfig — snapshotEvery", () => {
  it("forwards the cadence to the runtime it builds", async () => {
    // Before this key existed, an app wired through defineConfig could not set the
    // cadence at all, which also made settle-time checkpointing (gated on it)
    // unreachable rather than merely off by default.
    const { app, snapshots } = buildWithCadence(2);

    const handle = await app.runtime.start(gatedFlow(), { incidentId: "i1" });
    const suspended = await handle.waitForSuspend();
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget saves drain

    // MID-RUN saves specifically. `suspend` checkpoints at its own tip whatever the
    // cadence, so asserting `saves.length > 0` here would hold with the option ignored
    // entirely — it has to be the saves BEFORE the suspension that prove forwarding.
    const midRun = snapshots.saves.filter((s) => s.sequence < suspended.sequence);
    expect(midRun.length).toBeGreaterThan(0);
    for (const s of midRun) expect(s.sequence % 2).toBe(0);
    await app.close();
  });

  it("is the CAUSE of those snapshots — omitted, the mid-run cadence stays off", async () => {
    // The control. `suspend` checkpoints at its tip regardless, so the comparison is
    // against mid-run saves specifically: without a cadence there must be none before
    // the suspension's own.
    const { app, snapshots } = buildWithCadence(undefined);

    const handle = await app.runtime.start(gatedFlow(), { incidentId: "i1" });
    const suspended = await handle.waitForSuspend();
    await new Promise((r) => setTimeout(r, 0));

    const midRun = snapshots.saves.filter((s) => s.sequence < suspended.sequence);
    expect(midRun).toEqual([]);
    await app.close();
  });
});

/** A snapshot store whose every save rejects — the failure `onStorageError` alone sees. */
class FailingSnapshotStore implements SnapshotStore {
  readonly attempts: number[] = [];
  async save(s: Snapshot): Promise<void> {
    this.attempts.push(s.sequence);
    throw new Error("snapshot backend unavailable");
  }
  async loadLatest(): Promise<Snapshot | null> {
    return null;
  }
  async loadAt(): Promise<Snapshot | null> {
    return null;
  }
  async loadLatestBefore(): Promise<Snapshot | null> {
    return null;
  }
  async close(): Promise<void> {}
}

function buildWithFailingSnapshots(onStorageError?: (executionId: string, err: unknown) => void): {
  app: ReturnType<typeof defineConfig>;
  snapshots: FailingSnapshotStore;
} {
  const snapshots = new FailingSnapshotStore();
  const app = defineConfig({
    storage: {
      kind: "custom",
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: snapshots,
    },
    flows: [gatedFlow()],
    ...(onStorageError !== undefined && { observability: { onStorageError } }),
    durability: { snapshotEvery: 2 },
  });
  registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));
  return { app, snapshots };
}

describe("defineConfig — onStorageError", () => {
  it("forwards the hook, the only channel a failed checkpoint has", async () => {
    // Snapshot saves are fire-and-forget (a lost checkpoint costs replay time, not
    // correctness), so nothing else observes them: no rejection, no event, no status
    // change. Unforwarded, `snapshotEvery` against a store that fails every save is
    // indistinguishable from one taking no snapshots at all.
    const errors: { executionId: string; err: unknown }[] = [];
    const { app, snapshots } = buildWithFailingSnapshots((executionId, err) => {
      errors.push({ executionId, err });
    });

    const handle = await app.runtime.start(gatedFlow(), { incidentId: "i1" });
    const suspended = await handle.waitForSuspend();
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget saves settle

    expect(snapshots.attempts.length).toBeGreaterThan(0); // the cadence did fire
    expect(errors.length).toBeGreaterThan(0); // …and every rejection reached the app
    expect(errors[0]?.executionId).toBe(suspended.executionId);
    expect((errors[0]?.err as Error).message).toBe("snapshot backend unavailable");
    await app.close();
  });

  it("unwired, the same failures leave no trace — which is why it must be settable", async () => {
    // The control, and the reason this is worth a config key rather than a note: with
    // no hook the run is byte-identical to a healthy one. It suspends, its state is
    // correct, nothing rejects — while replay silently stops being bounded.
    const { app, snapshots } = buildWithFailingSnapshots(undefined);

    const handle = await app.runtime.start(gatedFlow(), { incidentId: "i1" });
    const suspended = await handle.waitForSuspend();
    await new Promise((r) => setTimeout(r, 0));

    expect(snapshots.attempts.length).toBeGreaterThan(0);
    expect(suspended.status).toBe("suspended"); // unharmed, and unaware
    await app.close();
  });
});

// ── The remaining WorkflowRuntime deps defineConfig had never forwarded ───────
//
// All three are runtime-constructor-only with no setter, so an app assembled the
// supported way could not set them at all. `resumeAuthenticator` is covered by
// verify.test.ts, where the K12 rule that demands it now actually fires.

describe("defineConfig — executionAuthorizer / onExecutionDenied", () => {
  const mallory = [{ id: "mallory" }] as never;
  const deny = { authorize: () => ({ allowed: false, reason: "not on the list" }) };

  const build = (denied?: (r: unknown, reason?: string) => void) => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [gatedFlow()],
      security: {
        executionAuthorizer: deny,
        ...(denied !== undefined && { onExecutionDenied: denied }),
      },
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));
    return app;
  };

  it("refuses a principal-carrying start the authorizer denies", async () => {
    // Unforwarded, this start SUCCEEDED — there was no way to gate an execution's
    // lifecycle from defineConfig at all.
    const app = build();
    await expect(
      app.runtime.start(gatedFlow(), { incidentId: "i1" }, { principal: mallory })
    ).rejects.toThrow(/denied/);
    await app.close();
  });

  it("fires the audit hook with the refused request and reason", async () => {
    const denials: { request: unknown; reason?: string | undefined }[] = [];
    const app = build((request, reason) => denials.push({ request, reason }));
    await expect(
      app.runtime.start(gatedFlow(), { incidentId: "i1" }, { principal: mallory })
    ).rejects.toThrow();
    expect(denials).toHaveLength(1);
    expect(denials[0]?.reason).toBe("not on the list");
    await app.close();
  });

  it("leaves principal-less calls alone — the kernel's own machinery still runs", async () => {
    // The trust-boundary model, restated as a test: the gate applies only to calls that
    // carry a principal, so TimerService and recovery are unaffected.
    const app = build();
    const handle = await app.runtime.start(gatedFlow(), { incidentId: "i1" });
    expect((await handle.waitForSuspend()).status).toBe("suspended");
    await app.close();
  });
});

describe("defineConfig — now", () => {
  it("stamps event envelopes from the injected clock", async () => {
    // DST/simulation: envelope timestamps were the one clock Loom's time-injection
    // principle did not reach through defineConfig.
    const fixed = 1_700_000_000_000;
    const seen: number[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [gatedFlow()],
      observability: { onEvent: (e) => seen.push(e.timestamp) },
      execution: { now: () => fixed },
    });
    registerToolEffects(app.effectRuntime, async () => ({ cpu: 87 }));

    const handle = await app.runtime.start(gatedFlow(), { incidentId: "i1" });
    await handle.waitForSuspend();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => t === fixed)).toBe(true);
    await app.close();
  });
});

// ── An erasure fold that fails must not take the process down ────────────────
//
// The erase coordinator reads (and writes) the durable store, so both `loadParked` at boot
// and `handleEvent` per event reject on an ordinary storage failure. Nothing awaits either
// — they are fire-and-forget from the composition root and the onEvent hook — so an
// escaping rejection is UNHANDLED, and Node terminates the process by default.

describe("defineConfig — a failing erase coordinator", () => {
  /** An event store whose reads reject, as a network-backed one does on a bad day. */
  function unreadableStore(): EventStore {
    const inner = new InMemoryAsyncEventStore();
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "read") {
          return async () => {
            throw new Error("store unavailable");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as EventStore;
  }

  const compliance = {
    subjectOf: (e: EventEnvelope) =>
      e.eventType === "EXECUTION_STARTED"
        ? (e.payload as { input?: { incidentId?: string } }).input?.incidentId
        : undefined,
    erase: { shred: async () => {} },
  };

  it("reports the boot-time failure through onWarn instead of rejecting into nothing", async () => {
    const warnings: string[] = [];
    const app = defineConfig({
      storage: {
        kind: "custom",
        eventStore: unreadableStore(),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
      },
      flows: [gatedFlow()],
      security: { compliance },
      observability: { onWarn: (m) => warnings.push(m) },
    });
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget settle

    expect(warnings.some((w) => w.includes("erasure coordinator"))).toBe(true);
    expect(warnings.some((w) => w.includes("store unavailable"))).toBe(true);
    // …and the app is still usable: a failed parked-list read is not fatal.
    expect(app.runtime).toBeDefined();
    await app.close();
  });
});
