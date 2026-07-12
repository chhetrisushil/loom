import { IntentRuntime } from "@loom/intent";
import {
  ApprovalCardRenderer,
  BlueprintRenderer,
  MetricCardRenderer,
  StatusBadgeRenderer,
  StreamingTextRenderer,
  TimelineRenderer,
  defaultRegistry,
  useLoom,
} from "@loom/plugin-renderer-react";
import type { WidgetAction } from "@loom/plugin-renderer-react";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { IncidentBlueprint } from "./blueprints/IncidentBlueprint";
import { incidentCatalog } from "./capabilities";

defaultRegistry.register("MetricCard", MetricCardRenderer);
defaultRegistry.register("Timeline", TimelineRenderer);
defaultRegistry.register("ApprovalCard", ApprovalCardRenderer);
defaultRegistry.register("StatusBadge", StatusBadgeRenderer);
defaultRegistry.register("StreamingText", StreamingTextRenderer);

type Phase = "idle" | "running" | "suspended" | "completed";

export function App() {
  // Runtimes are provided by <LoomProvider> in main.tsx
  const { workflowRuntime, projectionRuntime } = useLoom();

  const [phase, setPhase] = useState<Phase>("idle");
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [intentText, setIntentText] = useState("investigate high CPU on the postgres cluster");

  // Intent Over Routes: route a natural-language request to a capability rather
  // than wiring a button straight to a flow. Offline keyword routing (no API key).
  const intent = useMemo(
    () => new IntentRuntime({ catalog: incidentCatalog, workflowRuntime }),
    [workflowRuntime]
  );

  // Stable identity (setLog is stable) so effects/callbacks can list it as a dep.
  const addLog = useCallback(
    (msg: string) => setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]),
    []
  );

  const startInvestigation = useCallback(async () => {
    setPhase("running");
    const route = await intent.route(intentText);
    addLog(`Intent "${intentText}" → capability ${route?.capability.id ?? "(none)"}`);

    const handle = await intent.run(intentText, { incidentId: "cpu-001" });
    setExecutionId(handle.executionId);
    addLog(`Execution started: ${handle.executionId}`);

    handle.waitForSuspend().then(() => {
      setPhase("suspended");
      addLog("Workflow suspended — awaiting approval");
    });
  }, [intent, intentText, addLog]);

  const approve = useCallback(async () => {
    if (!executionId) return;
    setPhase("running");
    addLog("Approval granted — resuming workflow…");

    const handle = await workflowRuntime.resume(executionId, {
      eventType: "ApprovalGranted",
      payload: { approved: true, approvedBy: "operator" },
    });

    handle.waitForCompletion().then(() => {
      setPhase("completed");
      addLog("Workflow completed — incident resolved");
    });
  }, [workflowRuntime, executionId, addLog]);

  const reset = useCallback(() => {
    setPhase("idle");
    setExecutionId(null);
    setLog([]);
  }, []);

  const handleAction = useCallback(
    (action: WidgetAction) => {
      if (action.type === "APPROVE") void approve();
    },
    [approve]
  );

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Cloud Command Center</h1>
        <div style={styles.controls}>
          {phase === "idle" && (
            <>
              <input
                style={styles.intentInput}
                value={intentText}
                onChange={(e) => setIntentText(e.target.value)}
                placeholder="Describe your intent…"
                title="Intent Over Routes — routed to a capability by the Intent Runtime"
              />
              <button type="button" style={styles.btn} onClick={() => void startInvestigation()}>
                Run Intent
              </button>
            </>
          )}
          {phase === "suspended" && (
            <button
              type="button"
              style={{ ...styles.btn, ...styles.btnApprove }}
              onClick={() => void approve()}
            >
              Approve Remediation
            </button>
          )}
          {phase === "completed" && (
            <button type="button" style={{ ...styles.btn, ...styles.btnReset }} onClick={reset}>
              Reset
            </button>
          )}
          <span style={{ ...styles.badge, ...phaseBadgeStyle(phase) }}>{phase}</span>
        </div>
      </header>

      {executionId && (
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
          <div key={i} style={styles.logLine}>
            {line}
          </div>
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
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
    borderBottom: "1px solid #2d3748",
    paddingBottom: 16,
  },
  title: { fontSize: 22, fontWeight: 700, color: "#90cdf4" },
  controls: { display: "flex", alignItems: "center", gap: 12 },
  btn: {
    padding: "8px 16px",
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    background: "#3182ce",
    color: "#fff",
    fontWeight: 600,
    fontSize: 14,
  },
  btnApprove: { background: "#38a169" },
  btnReset: { background: "#4a5568" },
  intentInput: {
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid #2d3748",
    background: "#0f172a",
    color: "#e2e8f0",
    fontSize: 13,
    width: 320,
  },
  badge: {
    padding: "4px 10px",
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 700,
    color: "#fff",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  placeholder: {
    color: "#718096",
    textAlign: "center",
    padding: "64px 0",
    fontSize: 16,
  },
  logPanel: {
    marginTop: 32,
    background: "#1a202c",
    borderRadius: 8,
    padding: 16,
    maxHeight: 180,
    overflowY: "auto",
  },
  logTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#718096",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  logLine: { fontSize: 12, color: "#a0aec0", fontFamily: "monospace", lineHeight: 1.8 },
};
