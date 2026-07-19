import { TypedFailure } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { fanout$ } from "@loom/orchestration";
import { InMemoryContentStore } from "@loom/plugin-content";
import { McpClient, mcpInvoke$, registerMcpInvoke } from "@loom/plugin-mcp";
import { registerSandboxEval, sandboxEval$, shapeHash } from "@loom/plugin-sandbox";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

// ── Durable telemetry hydration — the blueprint-interpreter pattern ───────────
// (ADRs 0060/0061/0063/0064.) The dashboard's telemetry is no longer read from
// pre-seeded projections: a HYDRATION PLAN — one node per projection, each naming
// an MCP tool, a pinned input-schema hash, and a content-addressed reshaping
// script — is the INPUT of a durable Loom flow (hash-pinned in the run's first
// event). A statically compiled interpreter runner walks it:
//
//   fanout$ ──► mcpInvoke$ (schema-pin verified per call; typed schemaDrift)
//          ──► sandboxEval$ (LLM-authored reshape in a QuickJS sandbox,
//                            output validated against a pinned shape hash)
//
// Ids are minted `${base}#${i}` (the ADR 0061 identity rule), so a crash — or a
// drift-aborted fan-out — recovers by substitution: recorded frames are served
// from the log, only the missing work re-executes.

/** One node of the plan: which tool feeds which projection, through which script. */
export interface HydrationNode {
  projectionId: string;
  toolName: string;
  /** Pinned at plan time from listTools; verified per call (ADR 0063). */
  expectedSchemaHash: string;
  /** Content-addressed reshape script — the blueprint pins its logic by hash (ADR 0064). */
  scriptRef: { __loomContent: string };
  /** Pinned structural shape of the reshaped output. */
  expectedOutputShapeHash: string;
}

export interface HydrationPlan {
  nodes: HydrationNode[];
}

export type HydratedStates = Record<string, unknown>;

/** Userspace domain event recorded when a drifted pin is repaired in-band. */
export const SCHEMA_REPAIRED = "SCHEMA_REPAIRED";

// ── The reshaping scripts (in a real GenUI system these are LLM-authored) ─────
// Each turns the backend's RAW shape into the projection-state shape the widgets
// bind to. They run in the sandbox: no I/O, resource-limited, shape-validated.

const RESHAPE_SCRIPTS: Record<string, { script: string; sampleOutput: unknown }> = {
  cpu: {
    script: `(() => {
      const pcts = input.samples.map((s) => s.pct);
      const current = pcts[pcts.length - 1];
      return { current, status: current >= 85 ? "saturated" : "elevated", history: pcts };
    })()`,
    sampleOutput: { current: 0, status: "", history: [0] },
  },
  connections: {
    script: `(() => ({
      active: input.in_use,
      waiting: input.queued,
      limit: input.max,
      status: input.in_use >= input.max * 0.95 ? "critical" : "warning",
    }))()`,
    sampleOutput: { active: 0, waiting: 0, limit: 0, status: "" },
  },
  replication: {
    script: `(() => ({
      lagMs: Math.max(...input.replicas.map((r) => r.lag_ms)),
      trend: input.write_rate,
      replicas: input.replicas.length,
    }))()`,
    sampleOutput: { lagMs: 0, trend: "", replicas: 0 },
  },
  queries: {
    script: `(() => ({
      slow: input.top.map((q) => ({ statement: q.sql, cpuPct: q.cpu_pct, calls: q.n_calls })),
      total: input.observed_total,
    }))()`,
    sampleOutput: { slow: [{ statement: "", cpuPct: 0, calls: 0 }], total: 0 },
  },
};

const PROJECTION_TOOLS: Record<string, string> = {
  cpu: "db.cpu",
  connections: "db.connections",
  replication: "db.replication",
  queries: "db.queries",
};

// ── The flow (dynamic steps — deliberately outside the static list, ADR 0061) ─

const planSchema = z.object({
  nodes: z.array(
    z.object({
      projectionId: z.string(),
      toolName: z.string(),
      expectedSchemaHash: z.string(),
      scriptRef: z.object({ __loomContent: z.string() }).passthrough(),
      expectedOutputShapeHash: z.string(),
    })
  ),
});

const hydrateFlowDef: FlowDefinition<HydrationPlan, HydratedStates> = {
  _tag: "FlowDefinition",
  id: "hydrate-telemetry",
  name: "Hydrate telemetry",
  version: "1.0.0",
  inputSchema: planSchema as unknown as z.ZodSchema<HydrationPlan>,
  outputSchema: z.record(z.unknown()) as z.ZodSchema<HydratedStates>,
  steps: [],
};

const runner: FlowRunner<HydrationPlan, HydratedStates> = async (ctx, plan) => {
  const invokeInputs = plan.nodes.map((node) => ({
    toolName: node.toolName,
    args: { window: "5m" },
    expectedSchemaHash: node.expectedSchemaHash,
  }));

  // Phase 1 — fetch RAW telemetry: one mcpInvoke$ step per node (`hydrate#${i}`).
  // limit: 1 keeps the drift demo deterministic (nodes settle in order, so the
  // repair pass below substitutes a predictable prefix); production fan-outs
  // drop the limit and rely on the same substitution semantics.
  let raw: unknown[];
  try {
    raw = await fanout$(ctx, mcpInvoke$("hydrate"), invokeInputs, { limit: 1 });
  } catch (err) {
    if (!(err instanceof TypedFailure) || err.channel !== "schemaDrift") throw err;
    // In-band repair (the GenUI drift loop): the typed payload IS the forensic
    // record — recorded, replay-substituted, branchable. Accept the observed
    // schema as the new pin and re-walk the plan: recorded frames SUBSTITUTE
    // (zero re-invocation); the drifted node re-runs under a re-minted id
    // (`#repair` — the ADR 0061 rule: a deliberate retry is a NEW identity).
    const drift = err.payload as {
      toolName: string;
      expectedSchemaHash: string;
      observedHash: string;
    };
    ctx.emit(SCHEMA_REPAIRED, drift);
    raw = [];
    for (const [i, input] of invokeInputs.entries()) {
      raw[i] =
        input.toolName === drift.toolName
          ? await ctx.run(mcpInvoke$(`hydrate#${i}#repair`), {
              ...input,
              expectedSchemaHash: drift.observedHash,
            })
          : await ctx.run(mcpInvoke$(`hydrate#${i}`), input);
    }
  }

  // Phase 2 — reshape RAW → projection state in the sandbox, in parallel
  // (`reshape#${i}`), each output validated against its pinned shape hash.
  const shaped = await fanout$(
    ctx,
    sandboxEval$("reshape"),
    plan.nodes.map((node, i) => ({
      scriptRef: node.scriptRef,
      input: raw[i],
      expectedOutputShapeHash: node.expectedOutputShapeHash,
    }))
  );

  return Object.fromEntries(plan.nodes.map((node, i) => [node.projectionId, shaped[i]]));
};

// ── The harness ───────────────────────────────────────────────────────────────

export interface Hydrator {
  /** Build the plan: content-address the scripts, pin tool-schema + shape hashes. */
  buildPlan: () => Promise<HydrationPlan>;
  /** Run one durable hydration; returns projectionId → reshaped state. */
  hydrate: (executionId: string, plan: HydrationPlan) => Promise<HydratedStates>;
  /** The durable log (inspect SCHEMA_REPAIRED, step events, the logged plan). */
  events: (executionId: string) => Promise<EventEnvelope[]>;
}

export function createHydrator(serverUrl: string): Hydrator {
  const scripts = new InMemoryContentStore();
  const client = new McpClient({ transport: "http", url: serverUrl });
  const effectRuntime = new EffectRuntime();
  // toolsTtlMs: 0 — re-list per invoke batch (single-flight dedupes concurrent
  // refreshes), so a backend deploy between runs is observed immediately.
  registerMcpInvoke(client, effectRuntime, { server: "telemetry", toolsTtlMs: 0 });
  registerSandboxEval(effectRuntime, scripts);

  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime,
  });
  runtime.registerFlow(hydrateFlowDef, runner as FlowRunner<unknown, unknown>);
  const flow: RegisteredFlow<HydrationPlan, HydratedStates> = {
    definition: hydrateFlowDef,
    runner,
  };

  return {
    async buildPlan() {
      const tools = await client.listTools();
      const byName = new Map(tools.map((t) => [t.definition.id, t]));
      const nodes: HydrationNode[] = [];
      for (const [projectionId, toolName] of Object.entries(PROJECTION_TOOLS)) {
        const tool = byName.get(toolName);
        if (!tool) throw new Error(`telemetry server does not expose "${toolName}"`);
        const reshape = RESHAPE_SCRIPTS[projectionId];
        if (!reshape) throw new Error(`no reshape script for "${projectionId}"`);
        const scriptRef = await scripts.put(new TextEncoder().encode(reshape.script));
        nodes.push({
          projectionId,
          toolName,
          expectedSchemaHash: tool.schemaHash,
          scriptRef: { __loomContent: scriptRef.__loomContent },
          expectedOutputShapeHash: shapeHash(reshape.sampleOutput),
        });
      }
      return { nodes };
    },
    async hydrate(executionId, plan) {
      const handle = await runtime.start(flow, plan, { executionId });
      const state = await handle.waitForCompletion();
      return state.variables._output as HydratedStates;
    },
    events: (executionId) => eventStore.read(executionId),
  };
}
