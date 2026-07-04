import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { LoomProvider, useLoom } from "@loom/renderer-react";
import type { EventEnvelope } from "@loom/core";
import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { RegisteredTaskFlow, type TaskInput } from "./flow";
import { TaskProjection, type TaskState } from "./projection";
import { InMemoryEventStore, InMemorySnapshotStore } from "./stores";

// ── Runtime setup ─────────────────────────────────────────────────────────────

const eventStore = new InMemoryEventStore();
const effectRuntime = new EffectRuntime();
const projectionRuntime = new InMemoryProjectionRuntime();
projectionRuntime.register(TaskProjection);

const workflowRuntime = new WorkflowRuntime({
  eventStore,
  snapshotStore: new InMemorySnapshotStore(),
  effectRuntime,
  onEvent: (e: EventEnvelope) => projectionRuntime.handleEvent(e),
});

// registerFlow auto-wires LazyEffect for every step with handler$
workflowRuntime.registerFlow(RegisteredTaskFlow.definition, RegisteredTaskFlow.runner);

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = "idle" | "running" | "suspended" | "completed" | "failed";

interface LogEntry {
  time: string;
  kind: "event" | "system";
  label: string;
  payload: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function now() {
  return new Date().toLocaleTimeString("en", { hour12: false });
}

const phaseBg: Record<Phase, string> = {
  idle: "#4a5568",
  running: "#2b6cb0",
  suspended: "#b7791f",
  completed: "#276749",
  failed: "#9b2c2c",
};

const dotColor: Record<TaskState["timeline"][number]["level"], string> = {
  info: "#63b3ed",
  warning: "#d69e2e",
  success: "#48bb78",
};

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "#0d1117",
    color: "#e2e8f0",
    fontFamily: "system-ui, sans-serif",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 24px",
    borderBottom: "1px solid #1e293b",
    background: "#111827",
    flexShrink: 0,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  logo: { fontSize: 16, fontWeight: 700, color: "#90cdf4", letterSpacing: 0.5 },
  badge: {
    padding: "2px 10px",
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 700,
    color: "#fff",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  controls: { display: "flex", alignItems: "center", gap: 10 },
  btn: {
    padding: "7px 16px",
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    background: "#3182ce",
    color: "#fff",
    fontWeight: 600,
    fontSize: 13,
  },
  btnGreen: { background: "#2f855a" },
  btnGray: { background: "#4a5568" },
  spinner: { fontSize: 13, color: "#718096", fontStyle: "italic" },
  tabBar: {
    display: "flex",
    borderBottom: "1px solid #1e293b",
    background: "#111827",
    paddingLeft: 16,
    flexShrink: 0,
  },
  tab: {
    padding: "10px 20px",
    border: "none",
    background: "transparent",
    color: "#718096",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    borderBottom: "2px solid transparent",
  },
  tabActive: { color: "#90cdf4", borderBottom: "2px solid #3182ce" },
  content: { flex: 1, overflow: "auto", padding: 24 },
  logPanel: { display: "flex", flexDirection: "column", gap: 2, fontFamily: "monospace", fontSize: 12 },
  logRow: {
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
    padding: "4px 8px",
    borderRadius: 4,
    background: "#1a202c",
  },
  logSystem: { background: "#1e2a3a" },
  logTime: { color: "#4a5568", minWidth: 80, flexShrink: 0 },
  logLabel: { color: "#63b3ed", fontWeight: 600, minWidth: 200, flexShrink: 0 },
  logLabelSystem: { color: "#718096" },
  logPayload: { color: "#a0aec0", wordBreak: "break-all" },
  statePanel: { maxWidth: 640 },
  stateRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "7px 0",
    borderBottom: "1px solid #1e293b",
  },
  stateKey: { color: "#718096", fontSize: 13 },
  stateVal: { color: "#e2e8f0", fontSize: 13, fontWeight: 500 },
  stateJsonTitle: {
    color: "#718096",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 1,
    margin: "16px 0 8px",
  },
  divider: { height: 1, background: "#1e293b", margin: "12px 0" },
  json: {
    background: "#1a202c",
    borderRadius: 6,
    padding: 16,
    fontSize: 12,
    color: "#a0aec0",
    overflow: "auto",
    margin: 0,
  },
  empty: { color: "#4a5568", fontStyle: "italic", padding: "32px 0" },
  bpGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 16,
    marginBottom: 24,
  },
  bpRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  card: {
    background: "#1a202c",
    borderRadius: 8,
    padding: "16px 20px",
    border: "1px solid #2d3748",
  },
  cardTitle: { fontSize: 11, color: "#718096", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 },
  cardValue: { fontSize: 28, fontWeight: 700, color: "#90cdf4" },
  cardUnit: { fontSize: 11, color: "#4a5568", marginLeft: 4 },
  timeline: {
    background: "#1a202c",
    borderRadius: 8,
    padding: "16px 20px",
    border: "1px solid #2d3748",
    maxHeight: 300,
    overflow: "auto",
  },
  timelineTitle: { fontSize: 13, fontWeight: 600, color: "#e2e8f0", marginBottom: 12 },
  timelineItem: {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    padding: "4px 0",
    borderBottom: "1px solid #1e293b",
  },
  timelineDot: { width: 6, height: 6, borderRadius: "50%", marginTop: 6, flexShrink: 0 },
  timelineMsg: { fontSize: 12, color: "#a0aec0", flex: 1 },
  approvalCard: {
    background: "#1a202c",
    borderRadius: 8,
    padding: "16px 20px",
    border: "1px solid #2d3748",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    alignItems: "flex-start",
  },
  approvalTitle: { fontSize: 13, fontWeight: 600, color: "#e2e8f0" },
  approvalBody: { fontSize: 12, color: "#718096", lineHeight: 1.6 },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "64px 24px",
    gap: 12,
    textAlign: "center",
  },
  emptyIcon: { fontSize: 48, opacity: 0.15, marginBottom: 8 },
  emptyTitle: { fontSize: 20, fontWeight: 600, color: "#718096" },
  emptyBody: { fontSize: 14, color: "#4a5568", lineHeight: 1.8, maxWidth: 480 },
  footer: {
    padding: "10px 24px",
    borderTop: "1px solid #1e293b",
    background: "#111827",
    fontSize: 12,
    flexShrink: 0,
  },
  hint: { color: "#4a5568" },
  inlineCode: {
    background: "#1a202c",
    padding: "1px 6px",
    borderRadius: 4,
    color: "#90cdf4",
    fontFamily: "monospace",
  },
};

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const { workflowRuntime: wfr, projectionRuntime: pr } = useLoom();

  const [phase, setPhase] = useState<Phase>("idle");
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [tab, setTab] = useState<"blueprint" | "events" | "state">("blueprint");
  const [counter, setCounter] = useState(1);
  const [projState, setProjState] = useState<TaskState | null>(null);

  const addLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [entry, ...prev]);
  }, []);

  const sysLog = useCallback(
    (label: string) => addLog({ time: now(), kind: "system", label, payload: null }),
    [addLog]
  );

  // Poll projection state every 200ms while an execution is active
  useEffect(() => {
    if (!executionId) return;
    const tick = () => {
      const st = pr.getState<TaskState>("task", executionId);
      if (st) setProjState(st);
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [executionId, pr]);

  // Subscribe to raw events for the event log tab
  useEffect(() => {
    if (!executionId) return;
    return eventStore.subscribe(executionId, (e: EventEnvelope) => {
      addLog({ time: now(), kind: "event", label: e.eventType, payload: e.payload });
    });
  }, [executionId, addLog]);

  const start = useCallback(async () => {
    const taskId = `task-${String(counter).padStart(3, "0")}`;
    setCounter((n) => n + 1);
    setPhase("running");
    setLog([]);
    setProjState(null);
    sysLog(`Starting flow — ${taskId}`);

    try {
      const handle = await wfr.start<TaskInput>(RegisteredTaskFlow, {
        taskId,
        label: `Sample Task ${taskId}`,
      });
      setExecutionId(handle.executionId);
      sysLog(`Execution ID: ${handle.executionId}`);

      handle.waitForSuspend().then(() => {
        setPhase("suspended");
        sysLog("Suspended — waiting for approval");
      });

      handle.waitForCompletion().then((st) => {
        if (st.status === "completed") {
          setPhase("completed");
          sysLog("Completed");
        }
      });
    } catch (err) {
      setPhase("failed");
      sysLog(`Error: ${String(err)}`);
    }
  }, [wfr, counter, sysLog]);

  const approve = useCallback(async () => {
    if (!executionId) return;
    setPhase("running");
    sysLog("Sending approval…");
    try {
      const handle = await wfr.resume(executionId, {
        eventType: "TaskApproved",
        payload: { approvedBy: "playground-user", approvedAt: Date.now() },
      });
      handle.waitForCompletion().then((st) => {
        if (st.status === "completed") {
          setPhase("completed");
          sysLog("Completed after approval");
        }
      });
    } catch (err) {
      setPhase("failed");
      sysLog(`Resume error: ${String(err)}`);
    }
  }, [wfr, executionId, sysLog]);

  const reset = useCallback(() => {
    setPhase("idle");
    setExecutionId(null);
    setLog([]);
    setProjState(null);
  }, []);

  return (
    <div style={s.page}>
      {/* Header */}
      <header style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.logo}>⧖ Loom Playground</span>
          <span style={{ ...s.badge, background: phaseBg[phase] }}>{phase}</span>
        </div>
        <div style={s.controls}>
          {phase === "idle" && (
            <button style={s.btn} onClick={() => void start()}>▶ Run Flow</button>
          )}
          {phase === "suspended" && (
            <button style={{ ...s.btn, ...s.btnGreen }} onClick={() => void approve()}>
              ✓ Approve
            </button>
          )}
          {(phase === "completed" || phase === "failed") && (
            <button style={{ ...s.btn, ...s.btnGray }} onClick={reset}>↺ Reset</button>
          )}
          {phase === "running" && <span style={s.spinner}>Running…</span>}
        </div>
      </header>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {(["blueprint", "events", "state"] as const).map((t) => (
          <button
            key={t}
            style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}
            onClick={() => setTab(t)}
          >
            {t === "blueprint" ? "Blueprint" : t === "events" ? "Event Log" : "Projection State"}
          </button>
        ))}
      </div>

      {/* Main content */}
      <main style={s.content}>
        {tab === "blueprint" && (
          projState ? (
            <BlueprintView state={projState} phase={phase} onApprove={() => void approve()} />
          ) : (
            <EmptyState />
          )
        )}

        {tab === "events" && (
          <div style={s.logPanel}>
            {log.length === 0 ? (
              <div style={s.empty}>No events yet — run the flow to see events here.</div>
            ) : (
              log.map((entry, i) => (
                <div key={i} style={{ ...s.logRow, ...(entry.kind === "system" ? s.logSystem : {}) }}>
                  <span style={s.logTime}>{entry.time}</span>
                  <span style={{ ...s.logLabel, ...(entry.kind === "system" ? s.logLabelSystem : {}) }}>
                    {entry.label}
                  </span>
                  {entry.payload !== null && (
                    <span style={s.logPayload}>{JSON.stringify(entry.payload)}</span>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {tab === "state" && (
          <div style={s.statePanel}>
            {projState ? (
              <>
                {(
                  [
                    ["Status", projState.status],
                    ["Task ID", projState.taskId || "—"],
                    ["Label", projState.label || "—"],
                    ["Items Found", projState.items ?? "—"],
                    ["Processed", projState.processed ?? "—"],
                    ["Score", projState.score ?? "—"],
                    ["Pending Approval", String(projState.pendingApproval)],
                    ["Summary", projState.summary ?? "—"],
                  ] as [string, string | number][]
                ).map(([k, v]) => (
                  <div key={k} style={s.stateRow}>
                    <span style={s.stateKey}>{k}</span>
                    <span style={s.stateVal}>{String(v)}</span>
                  </div>
                ))}
                <div style={s.divider} />
                <div style={s.stateJsonTitle}>Full JSON</div>
                <pre style={s.json}>{JSON.stringify(projState, null, 2)}</pre>
              </>
            ) : (
              <div style={s.empty}>No projection state yet — run the flow first.</div>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer style={s.footer}>
        <span style={s.hint}>Experiment by editing: </span>
        <code style={s.inlineCode}>src/flow.ts</code>
        <span style={s.hint}> (steps & runner) · </span>
        <code style={s.inlineCode}>src/projection.ts</code>
        <span style={s.hint}> (state shape) · </span>
        <code style={s.inlineCode}>src/blueprint.ts</code>
        <span style={s.hint}> (widget layout)</span>
      </footer>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BlueprintView({
  state,
  phase,
  onApprove,
}: {
  state: TaskState;
  phase: Phase;
  onApprove: () => void;
}) {
  return (
    <div>
      <div style={s.bpGrid}>
        <MetricCard title="Items Found" value={state.items} unit="items" />
        <MetricCard title="Processed" value={state.processed} unit="items" />
        <MetricCard title="Score" value={state.score} />
      </div>
      <div style={s.bpRow}>
        <div style={s.timeline}>
          <div style={s.timelineTitle}>Event Timeline</div>
          {state.timeline.length === 0 ? (
            <div style={{ color: "#4a5568", fontStyle: "italic", fontSize: 12 }}>No events yet.</div>
          ) : (
            [...state.timeline].reverse().map((entry, i) => (
              <div key={i} style={s.timelineItem}>
                <div style={{ ...s.timelineDot, background: dotColor[entry.level] }} />
                <span style={s.timelineMsg}>{entry.message}</span>
              </div>
            ))
          )}
        </div>
        <div style={s.approvalCard}>
          <div style={s.approvalTitle}>Approval</div>
          {state.pendingApproval ? (
            <>
              <div style={s.approvalBody}>
                The flow is suspended and waiting for approval.
                <br />
                Score: <strong>{state.score ?? "—"}</strong>
              </div>
              <button style={{ ...s.btn, ...s.btnGreen }} onClick={onApprove}>
                ✓ Approve & Apply
              </button>
            </>
          ) : (
            <div style={s.approvalBody}>
              {phase === "completed"
                ? "✓ Applied. Reset to run again."
                : "Approval panel activates when the flow suspends."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ title, value, unit }: { title: string; value: number | null; unit?: string }) {
  return (
    <div style={s.card}>
      <div style={s.cardTitle}>{title}</div>
      <div>
        <span style={s.cardValue}>{value ?? "—"}</span>
        {unit && value !== null && <span style={s.cardUnit}>{unit}</span>}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={s.emptyState}>
      <div style={s.emptyIcon}>⧖</div>
      <div style={s.emptyTitle}>Nothing running yet</div>
      <div style={s.emptyBody}>
        Click <strong>Run Flow</strong> to start the Task Analysis workflow.
        <br />
        The flow fetches data → processes it → suspends for approval → applies the result.
        <br /><br />
        Edit <code>src/flow.ts</code>, <code>src/projection.ts</code>, or{" "}
        <code>src/blueprint.ts</code> to experiment.
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root")!).render(
  <LoomProvider workflowRuntime={workflowRuntime} projectionRuntime={projectionRuntime}>
    <App />
  </LoomProvider>
);
