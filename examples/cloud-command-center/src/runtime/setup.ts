import { a2uiSurfaceProjection } from "@loom/a2ui";
import { ToolEffect } from "@loom/effect-runtime";
import { EffectRuntime } from "@loom/effect-runtime";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";

import { InMemoryProjectionRuntime } from "@loom/projection-runtime";

import { WorkflowRuntime } from "@loom/workflow-runtime";
import { IncidentProjection } from "../projections/IncidentProjection";
import { MetricsProjection } from "../projections/MetricsProjection";
import { llmProvider, registerAiTriageEffect } from "./aiTriage";

// llmProvider + registerAiTriageEffect live in ./aiTriage (browser-safe, no
// SQLite imports) so both this Node setup and the browser entry can share them.
export { llmProvider, registerAiTriageEffect } from "./aiTriage";

export interface RuntimeConfig {
  dbPath: string;
  snapshotDbPath: string;
}

export interface Runtimes {
  workflowRuntime: WorkflowRuntime;
  projectionRuntime: InMemoryProjectionRuntime;
  eventStore: SqliteEventStore;
  snapshotStore: SqliteSnapshotStore;
  effectRuntime: EffectRuntime;
}

export function createRuntimes(config: RuntimeConfig): Runtimes {
  const eventStore = new SqliteEventStore(config.dbPath);
  const snapshotStore = new SqliteSnapshotStore(config.snapshotDbPath);
  const effectRuntime = new EffectRuntime();
  const projectionRuntime = new InMemoryProjectionRuntime();

  projectionRuntime.register(MetricsProjection);
  projectionRuntime.register(IncidentProjection);
  // A2UI: fold the "ui" surface. Widgets bind to it via { projectionId: "ui", … }.
  projectionRuntime.register(a2uiSurfaceProjection("ui"));

  const workflowRuntime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime,
    onEvent: (event) => projectionRuntime.handleEvent(event),
  });

  return { workflowRuntime, projectionRuntime, eventStore, snapshotStore, effectRuntime };
}

export function registerMockEffects(effectRuntime: EffectRuntime): void {
  effectRuntime.register(
    "metrics-tool",
    new ToolEffect(async () => ({
      cpu: { current: 87, threshold: 80 },
      memory: { usedMb: 14000, totalMb: 16000 },
      connections: { active: 450, max: 500 },
    }))
  );

  effectRuntime.register(
    "logs-tool",
    new ToolEffect(async () => ({
      logs: [
        { level: "error", message: "OOM killer invoked", timestamp: Date.now() - 5000 },
        { level: "error", message: "Connection pool exhausted", timestamp: Date.now() - 3000 },
      ],
    }))
  );

  effectRuntime.register(
    "remediation-tool",
    new ToolEffect(async () => ({
      success: true,
      summary: "Pod restarted successfully, CPU normalized to 32%",
      appliedAt: Date.now(),
    }))
  );

  registerAiTriageEffect(effectRuntime, llmProvider);
}
