import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step$ } from "@loom/core";
import { LocalDispatcher } from "@loom/dispatcher";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { SqliteBranchRegistry, SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";

import { CloudRunWorkerRuntime } from "@loom/platform-cloudrun";
import type { CloudRunConfig, CloudRunPlatform } from "@loom/platform-cloudrun";

import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import { createWorkerServer } from "@loom/worker-server";
import type { WorkerServer } from "@loom/worker-server";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeGraph } from "./executeGraph";
import type { GraphNode } from "./executeGraph";

// Three independent sub-analyses of an incident — the Epic 8 fan-out.
const LANES = ["metrics", "logs", "queries"] as const;
type Lane = (typeof LANES)[number];

function laneFlow(lane: Lane): RegisteredFlow {
  const s = step$({
    id: `${lane}-step`,
    name: lane,
    toolId: `${lane}-tool`,
    inputSchema: z.object({ incidentId: z.string() }),
    outputSchema: z.object({ finding: z.string() }),
  });
  const runner: FlowRunner<{ incidentId: string }, { finding: string }> = async (ctx, input) => {
    const out = (await ctx.run(s, { incidentId: input.incidentId })) as { finding: string };
    return out;
  };
  return {
    definition: {
      _tag: "FlowDefinition",
      id: lane,
      name: lane,
      version: "1.0.0",
      inputSchema: z.object({ incidentId: z.string() }),
      outputSchema: z.object({ finding: z.string() }),
      steps: [s],
    },
    runner,
  } as RegisteredFlow;
}

function registerLanes(
  runtime: WorkflowRuntime,
  effects: EffectRuntime,
  spies?: Partial<Record<Lane, () => Promise<unknown>>>
) {
  for (const lane of LANES) {
    const fn = spies?.[lane] ?? (async () => ({ finding: `${lane}-ok` }));
    effects.register(`${lane}-tool`, new ToolEffect(fn as never));
    runtime.registerFlow(laneFlow(lane).definition, laneFlow(lane).runner);
  }
}

const nodes: GraphNode[] = LANES.map((lane) => ({
  id: lane,
  flowId: lane,
  input: { incidentId: "inc-1" },
}));

describe("executeGraph — fan-out into per-branch executions + lineage join", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-graph-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs each node as its own execution and records lineage under the parent", async () => {
    const spies: Record<Lane, ReturnType<typeof vi.fn>> = {
      metrics: vi.fn(async () => ({ finding: "cpu-hot" })),
      logs: vi.fn(async () => ({ finding: "oom" })),
      queries: vi.fn(async () => ({ finding: "slow-scan" })),
    };
    const effects = new EffectRuntime();
    const runtime = new WorkflowRuntime({
      eventStore: new SqliteEventStore(join(dir, "events.db")),
      snapshotStore: new SqliteSnapshotStore(join(dir, "snap.db")),
      effectRuntime: effects,
    });
    registerLanes(runtime, effects, spies);
    const registry = new SqliteBranchRegistry(join(dir, "branches.db"));
    const dispatcher = new LocalDispatcher(new LocalWorkerRuntime(runtime));

    const graph = await executeGraph(dispatcher, nodes, {
      parentExecutionId: "incident-1",
      branchRegistry: registry,
      limit: 3,
    });

    expect(graph.completed).toBe(true);
    expect(graph.byId.metrics?.output).toEqual({ finding: "cpu-hot" });
    expect(graph.byId.queries?.output).toEqual({ finding: "slow-scan" });

    // Each node became a distinct execution (one writer each).
    const ids = graph.nodes.map((n) => n.executionId);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["incident-1:metrics", "incident-1:logs", "incident-1:queries"]);
    for (const s of Object.values(spies)) expect(s).toHaveBeenCalledTimes(1);

    // The join surface: the parent can enumerate its branches via lineage.
    const children = await registry.children("incident-1");
    expect(children.map((c) => c.executionId).sort()).toEqual(ids.slice().sort());
    await registry.close();
  });

  it("runs the graph across three Cloud Run instances (one per branch)", async () => {
    // Each resolveEndpoint boots a fresh worker instance with its OWN stores —
    // three concurrent branches ⇒ three live instances, joined by the caller.
    const instances: { server: WorkerServer; dispose: () => void; dir: string }[] = [];
    const platform: CloudRunPlatform = {
      async resolveEndpoint(_config: CloudRunConfig): Promise<string> {
        const idir = mkdtempSync(join(tmpdir(), "loom-graph-instance-"));
        const effects = new EffectRuntime();
        const eventStore = new SqliteEventStore(join(idir, "events.db"));
        const snapshotStore = new SqliteSnapshotStore(join(idir, "snap.db"));
        const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime: effects });
        registerLanes(runtime, effects);
        const server = createWorkerServer(new LocalWorkerRuntime(runtime));
        await server.start();
        instances.push({
          server,
          dir: idir,
          dispose: () => {
            eventStore.close();
            snapshotStore.close();
          },
        });
        return server.url;
      },
    };

    const dispatcher = new LocalDispatcher(new CloudRunWorkerRuntime(platform));
    try {
      const graph = await executeGraph(dispatcher, nodes, {
        parentExecutionId: "incident-2",
        limit: 3,
      });

      expect(graph.completed).toBe(true);
      expect(instances.length).toBe(3); // one Cloud Run instance per branch
      expect(new Set(graph.nodes.map((n) => n.executionId)).size).toBe(3);
      expect(graph.byId.metrics?.output).toEqual({ finding: "metrics-ok" });
    } finally {
      for (const inst of instances) {
        await inst.server.stop();
        inst.dispose();
        rmSync(inst.dir, { recursive: true, force: true });
      }
    }
  });
});
