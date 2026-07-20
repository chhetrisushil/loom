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

// ── Telemetry hydration — the transient blueprint-interpreter pattern ─────────
// (ADRs 0060/0061/0063/0064/0065; DE-series eval.) The dashboard's telemetry is
// a HYDRATION PLAN — one node per projection, each naming an MCP tool, a pinned
// input-schema hash, and a content-addressed reshaping script.
//
// The hot READ path is NOT a loom run (ADR 0065 — "don't make it a run until
// something durable happens"). It is a TRANSIENT interpreter: plain code walks
// the immutable plan, invoking each effect via `runtime.invokeTransient` — the
// supported façade over the non-durable path. It mutates nothing and writes ZERO
// events; if it fails the client simply retries. Every dashboard open and every
// 50 ms hydration batch runs here, paying no durability it never uses:
//
//   invokeTransient("mcp.invoke")   (schema-pin verified per call; typed schemaDrift)
//   invokeTransient("sandbox.eval") (LLM-authored reshape in a QuickJS sandbox,
//                                    output validated against a pinned shape hash)
//
// The determinism boundary is crossed ONLY when something durable happens: a
// pin drifts, and the REPAIR must be recorded. Then — and only then — we
// `start()` a durable loom run (the repair flow below) whose SCHEMA_REPAIRED
// event and repaired frames are the auditable, branchable forensic record.
// Ids in that run are minted `${base}#${i}` (the ADR 0061 identity rule), so a
// crash recovers by substitution.

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

// ── The durable REPAIR flow (only runs when a pin drifts) ─────────────────────
// The transient read path CANNOT record anything — that is the whole point. When
// it hits a `schemaDrift` TypedFailure, we cross the determinism boundary and
// `start()` this durable run. It re-walks the plan under the observed pin,
// recording SCHEMA_REPAIRED (the forensic payload) plus a durable frame per node
// — replay-substitutable and branchable. Dynamic steps, deliberately outside the
// static list (ADR 0061); ids minted `${base}#${i}`.

interface RepairInput {
  plan: HydrationPlan;
  drift: { toolName: string; expectedSchemaHash: string; observedHash: string };
}

const repairInputSchema = z.object({
  plan: z.object({
    nodes: z.array(
      z.object({
        projectionId: z.string(),
        toolName: z.string(),
        expectedSchemaHash: z.string(),
        scriptRef: z.object({ __loomContent: z.string() }).passthrough(),
        expectedOutputShapeHash: z.string(),
      })
    ),
  }),
  drift: z.object({
    toolName: z.string(),
    expectedSchemaHash: z.string(),
    observedHash: z.string(),
  }),
});

const repairFlowDef: FlowDefinition<RepairInput, HydratedStates> = {
  _tag: "FlowDefinition",
  id: "repair-telemetry",
  name: "Repair telemetry pin",
  version: "1.0.0",
  inputSchema: repairInputSchema as unknown as z.ZodSchema<RepairInput>,
  outputSchema: z.record(z.unknown()) as z.ZodSchema<HydratedStates>,
  steps: [],
};

const repairRunner: FlowRunner<RepairInput, HydratedStates> = async (ctx, { plan, drift }) => {
  // The typed payload IS the forensic record — recorded, replay-substituted,
  // branchable. Accept the observed schema as the new pin and durably re-walk.
  ctx.emit(SCHEMA_REPAIRED, drift);

  const raw: unknown[] = [];
  for (const [i, node] of plan.nodes.entries()) {
    const input = {
      toolName: node.toolName,
      args: { window: "5m" },
      // The drifted node re-runs under a re-minted id (`#repair` — a deliberate
      // retry is a NEW identity, ADR 0061) against the observed hash.
      expectedSchemaHash:
        node.toolName === drift.toolName ? drift.observedHash : node.expectedSchemaHash,
    };
    raw[i] =
      node.toolName === drift.toolName
        ? await ctx.run(mcpInvoke$(`hydrate#${i}#repair`), input)
        : await ctx.run(mcpInvoke$(`hydrate#${i}`), input);
  }

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
  /**
   * Hydrate the dashboard: walk the plan TRANSIENTLY (zero events), and on a
   * `schemaDrift` escalate to a durable repair run keyed by `executionId`.
   * Returns projectionId → reshaped state. The common case writes nothing.
   */
  hydrate: (executionId: string, plan: HydrationPlan) => Promise<HydratedStates>;
  /**
   * The pure transient walk, exposed for callers that want to handle drift
   * themselves. Throws a `schemaDrift` {@link TypedFailure} on a drifted pin.
   * Writes ZERO events under any outcome.
   */
  hydrateTransient: (plan: HydrationPlan) => Promise<HydratedStates>;
  /** The durable log for an executionId (empty unless a repair run happened). */
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
  runtime.registerFlow(repairFlowDef, repairRunner as FlowRunner<unknown, unknown>);
  const repairFlow: RegisteredFlow<RepairInput, HydratedStates> = {
    definition: repairFlowDef,
    runner: repairRunner,
  };

  // The transient interpreter: plain code over the immutable plan. Each effect
  // runs through `invokeTransient` — no execution, no fold, no fence, no events.
  async function hydrateTransient(plan: HydrationPlan): Promise<HydratedStates> {
    const raw = await Promise.all(
      plan.nodes.map((node) =>
        runtime.invokeTransient("mcp.invoke", {
          toolName: node.toolName,
          args: { window: "5m" },
          expectedSchemaHash: node.expectedSchemaHash,
        })
      )
    );
    const shaped = await Promise.all(
      plan.nodes.map((node, i) =>
        runtime.invokeTransient("sandbox.eval", {
          scriptRef: node.scriptRef,
          input: raw[i],
          expectedOutputShapeHash: node.expectedOutputShapeHash,
        })
      )
    );
    return Object.fromEntries(plan.nodes.map((node, i) => [node.projectionId, shaped[i]]));
  }

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
    hydrateTransient,
    async hydrate(executionId, plan) {
      try {
        // Hot path: transient, zero durable footprint. Retried by the client on
        // any transport failure — nothing to recover.
        return await hydrateTransient(plan);
      } catch (err) {
        if (!(err instanceof TypedFailure) || err.channel !== "schemaDrift") throw err;
        // Something durable happened: cross the boundary and record the repair.
        const drift = err.payload as RepairInput["drift"];
        const handle = await runtime.start(repairFlow, { plan, drift }, { executionId });
        const state = await handle.waitForCompletion();
        return state.variables._output as HydratedStates;
      }
    },
    events: (executionId) => eventStore.read(executionId),
  };
}
