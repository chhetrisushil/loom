import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ApprovalCardRenderer,
  BlueprintRenderer,
  MetricCardRenderer,
  StatusBadgeRenderer,
  TimelineRenderer,
  defaultRegistry,
} from "@loom/renderer-react";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { InMemoryEventStore, InMemorySnapshotStore } from "./runtime/browserStores";
import type { WidgetAction } from "@loom/renderer-react";
import { IncidentBlueprint } from "./blueprints/IncidentBlueprint";
import { InvestigateIncidentFlow } from "./flows/InvestigateIncident";
import { IncidentProjection } from "./projections/IncidentProjection";
import { MetricsProjection } from "./projections/MetricsProjection";

defaultRegistry.register("MetricCard", MetricCardRenderer);
defaultRegistry.register("Timeline", TimelineRenderer);
defaultRegistry.register("ApprovalCard", ApprovalCardRenderer);
defaultRegistry.register("StatusBadge", StatusBadgeRenderer);

function buildRuntimes() {
  const effectRuntime = new EffectRuntime();
  const projectionRuntime = new InMemoryProjectionRuntime();
  projectionRuntime.register(MetricsProjection);
  projectionRuntime.register(IncidentProjection);

  const workflowRuntime = new WorkflowRuntime({
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
    effectRuntime,
    onEvent: (e) => projectionRuntime.handleEvent(e),
  });
  workflowRuntime.registerFlow(
    InvestigateIncidentFlow.definition,
    InvestigateIncidentFlow.runner
  );

  effectRuntime.register(
    "metrics-tool",
    new ToolEffect(async () => ({
      cpu: { current: 87, threshold: 80 },
      memory: { usedMb: 14_000, totalMb: 16_000 },
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

  return { workflowRuntime, projectionRuntime };
}

type Phase = "idle" | "running" | "suspended" | "completed";

export function App() {
  const runtimesRef = useRef<ReturnType<typeof buildRuntimes> | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const handleRef = useRef<{ executionId: string; waitForSuspend: () => Promise<unknown>; waitForCompletion: () => Promise<unknown> } | null>(null);

  const addLog = (msg: string) =>
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  useEffect(() => {
    runtimesRef.current = buildRuntimes();
  }, []);

  const startInvestigation = useCallback(async () => {
    const rt = runtimesRef.current;
    if (!rt) return;
    setPhase("running");
    addLog("Starting InvestigateIncident for incident cpu-001…");

    const handle = await rt.workflowRuntime.start(InvestigateIncidentFlow, {
      incidentId: "cpu-001",
    });
    handleRef.current = handle;
    setExecutionId(handle.executionId);
    addLog(`Execution started: ${handle.executionId}`);

    handle.waitForSuspend().then(() => {
      setPhase("suspended");
      addLog("Workflow suspended — awaiting approval");
    });
  }, []);

  const approve = useCallback(async () => {
    const rt = runtimesRef.current;
    if (!rt || !executionId) return;
    setPhase("running");
    addLog("Approval granted — resuming workflow…");

    const handle = await rt.workflowRuntime.resume(executionId, {
      eventType: "ApprovalGranted",
      payload: { approved: true, approvedBy: "operator" },
    });

    handle.waitForCompletion().then(() => {
      setPhase("completed");
      addLog("Workflow completed — incident resolved");
    });
  }, [executionId]);

  const reset = useCallback(() => {
    runtimesRef.current = buildRuntimes();
    setPhase("idle");
    setExecutionId(null);
    setLog([]);
    handleRef.current = null;
  }, []);

  const handleAction = useCallback((action: WidgetAction) => {
    if (action.type === "APPROVE") approve();
  }, [approve]);

  const projectionRuntime = runtimesRef.current?.projectionRuntime;

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Cloud Command Center</h1>
        <div style={styles.controls}>
          {phase === "idle" && (
            <button style={styles.btn} onClick={startInvestigation}>
              Simulate Incident
            </button>
          )}
          {phase === "suspended" && (
            <button style={{ ...styles.btn, ...styles.btnApprove }} onClick={approve}>
              Approve Remediation
            </button>
          )}
          {(phase === "completed") && (
            <button style={{ ...styles.btn, ...styles.btnReset }} onClick={reset}>
              Reset
            </button>
          )}
          <span style={{ ...styles.badge, ...phaseBadgeStyle(phase) }}>{phase}</span>
        </div>
      </header>

      {executionId && projectionRuntime && (
        <BlueprintRenderer
          blueprint={IncidentBlueprint}
          projectionRuntime={projectionRuntime}
          executionId={executionId}
          onAction={handleAction}
        />
      )}

      {!executionId && (
        <div style={styles.placeholder}>
          Press <strong>Simulate Incident</strong> to start a durable workflow execution.
        </div>
      )}

      <aside style={styles.logPanel}>
        <div style={styles.logTitle}>Event Log</div>
        {log.map((line, i) => (
          <div key={i} style={styles.logLine}>{line}</div>
        ))}
      </aside>
    </div>
  );
}

function phaseBadgeStyle(phase: Phase): React.CSSProperties {
  const colors: Record<Phase, string> = {
    idle: "#4a5568",
    running: "#2b6cb0",
    suspended: "#b7791f",
    completed: "#276749",
  };
  return { background: colors[phase] };
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 1100, margin: "0 auto" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, borderBottom: "1px solid #2d3748", paddingBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: "#90cdf4" },
  controls: { display: "flex", alignItems: "center", gap: 12 },
  btn: { padding: "8px 16px", borderRadius: 6, border: "none", cursor: "pointer", background: "#3182ce", color: "#fff", fontWeight: 600, fontSize: 14 },
  btnApprove: { background: "#38a169" },
  btnReset: { background: "#4a5568" },
  badge: { padding: "4px 10px", borderRadius: 12, fontSize: 12, fontWeight: 700, color: "#fff", textTransform: "uppercase", letterSpacing: 1 },
  placeholder: { color: "#718096", textAlign: "center", padding: "64px 0", fontSize: 16 },
  logPanel: { marginTop: 32, background: "#1a202c", borderRadius: 8, padding: 16, maxHeight: 180, overflowY: "auto" },
  logTitle: { fontSize: 12, fontWeight: 700, color: "#718096", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 },
  logLine: { fontSize: 12, color: "#a0aec0", fontFamily: "monospace", lineHeight: 1.8 },
};
