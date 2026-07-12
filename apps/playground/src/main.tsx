import { A2UI_PATCH } from "@loom/a2ui";
import type { A2UIPatch, A2UIPatchPayload, A2UISurfaceState } from "@loom/a2ui";
import { defineConfig } from "@loom/app";
import { CapabilityCatalog, capability$ } from "@loom/capability";
import type { EventEnvelope } from "@loom/core";
import { IntentRuntime } from "@loom/intent";
import { LoomProvider, useLoom } from "@loom/plugin-renderer-react";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { ConsoleTelemetryAdapter } from "@loom/telemetry";
import type { FlowTelemetryInfo, StepTelemetryInfo, TelemetryAdapter } from "@loom/telemetry";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { z } from "zod";
import { RegisteredTaskFlow, type TaskInput } from "./flow";
import { TaskProjection, type TaskState } from "./projection";

// ── Telemetry accumulator (module-level, polled by React) ─────────────────────

interface MutableTrace {
  flow: FlowTelemetryInfo | null;
  steps: Map<string, StepTelemetryInfo>;
}

const mutableTrace: MutableTrace = { flow: null, steps: new Map() };

function clearTrace(): void {
  mutableTrace.flow = null;
  mutableTrace.steps.clear();
}

const ReactAdapter: TelemetryAdapter = {
  onFlowStart: (info) => {
    mutableTrace.flow = { ...info };
    mutableTrace.steps.clear();
  },
  onFlowComplete: (info) => {
    mutableTrace.flow = { ...info };
  },
  onFlowFail: (info) => {
    mutableTrace.flow = { ...info };
  },
  onFlowSuspend: (info) => {
    mutableTrace.flow = { ...info };
  },
  onFlowResume: (info) => {
    mutableTrace.flow = { ...info };
  },
  onStepStart: (info) => {
    mutableTrace.steps.set(info.stepId, { ...info });
  },
  onStepComplete: (info) => {
    mutableTrace.steps.set(info.stepId, { ...info });
  },
  onStepFail: (info) => {
    mutableTrace.steps.set(info.stepId, { ...info });
  },
  onStepRetry: (info) => {
    mutableTrace.steps.set(info.stepId, { ...info });
  },
};

// ── Runtime setup (defineConfig) ──────────────────────────────────────────────
// A projection runtime that also folds the domain TaskProjection. defineConfig
// registers the A2UI "ui" surface for us and wires onEvent → handleEvent.
const projectionRuntime = new InMemoryProjectionRuntime();
projectionRuntime.register(TaskProjection);

// ── Capabilities + Intent (Intent Over Routes) ────────────────────────────────
// Register the flow as an intent-addressable capability, then let the Intent
// Runtime route a typed goal to it (deterministic keyword routing — no API key).
const catalog = new CapabilityCatalog().register(
  capability$({
    id: "task-analysis",
    intent: "Analyze a task: fetch data, process it, then apply the result after approval",
    tags: ["task", "analyze", "data", "process"],
    inputSchema: z.object({ taskId: z.string(), label: z.string() }),
    flow: RegisteredTaskFlow,
  })
);

// defineConfig assembles the stores, EffectRuntime, projection wiring, telemetry
// (Console + React adapters composed and fired after projection), the
// WorkflowRuntime, and registers the catalog's flow(s) into it.
const app = defineConfig({
  storage: { kind: "memory" },
  projectionRuntime,
  surfaces: ["ui"],
  catalog,
  telemetry: [ConsoleTelemetryAdapter, ReactAdapter],
});

const eventStore = app.stores.eventStore;
const workflowRuntime = app.runtime;
const intentRuntime = new IntentRuntime({ catalog, workflowRuntime });

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = "idle" | "running" | "suspended" | "completed" | "failed";

interface LogEntry {
  time: string;
  kind: "event" | "system";
  label: string;
  payload: unknown;
}

interface TraceSnapshot {
  flow: FlowTelemetryInfo | null;
  steps: StepTelemetryInfo[];
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

const statusBg: Record<StepTelemetryInfo["status"], string> = {
  running: "#2b6cb0",
  completed: "#276749",
  failed: "#9b2c2c",
  retrying: "#b7791f",
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
  intentInput: {
    padding: "7px 12px",
    borderRadius: 6,
    border: "1px solid #2d3748",
    background: "#0f172a",
    color: "#e2e8f0",
    fontSize: 13,
    width: 280,
  },
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
  // Log
  logPanel: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    fontFamily: "monospace",
    fontSize: 12,
  },
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
  // State
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
  // Blueprint
  bpGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 },
  bpRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  card: {
    background: "#1a202c",
    borderRadius: 8,
    padding: "16px 20px",
    border: "1px solid #2d3748",
  },
  cardTitle: {
    fontSize: 11,
    color: "#718096",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
  },
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
  // Trace
  traceSection: { marginBottom: 24 },
  traceSectionTitle: {
    fontSize: 11,
    color: "#718096",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 10,
    fontWeight: 700,
  },
  traceSummaryRow: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "12px 16px",
    background: "#1a202c",
    borderRadius: 8,
    border: "1px solid #2d3748",
    marginBottom: 20,
    flexWrap: "wrap",
  },
  traceSummaryLabel: { fontSize: 12, color: "#718096" },
  traceSummaryVal: { fontSize: 13, fontWeight: 600, color: "#e2e8f0" },
  traceSummaryDivider: { width: 1, height: 16, background: "#2d3748" },
  traceGantt: {
    background: "#1a202c",
    borderRadius: 8,
    border: "1px solid #2d3748",
    padding: "16px 20px",
  },
  traceRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "6px 0",
    borderBottom: "1px solid #1e293b",
  },
  traceLabel: {
    fontSize: 12,
    color: "#a0aec0",
    width: 120,
    flexShrink: 0,
    fontFamily: "monospace",
  },
  traceBarContainer: {
    flex: 1,
    position: "relative" as const,
    height: 20,
    background: "#0d1117",
    borderRadius: 3,
  },
  traceBarFill: {
    position: "absolute" as const,
    top: 2,
    height: 16,
    borderRadius: 3,
    minWidth: 4,
    transition: "width 0.2s ease",
  },
  traceDuration: {
    fontSize: 11,
    color: "#4a5568",
    width: 70,
    textAlign: "right" as const,
    flexShrink: 0,
    fontFamily: "monospace",
  },
  traceMetricGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 12,
    marginTop: 16,
  },
  // Shared
  empty: { color: "#4a5568", fontStyle: "italic", padding: "32px 0" },
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
  const [tab, setTab] = useState<"blueprint" | "events" | "state" | "trace" | "a2ui">("blueprint");
  const [counter, setCounter] = useState(1);
  const [projState, setProjState] = useState<TaskState | null>(null);
  const [traceData, setTraceData] = useState<TraceSnapshot>({ flow: null, steps: [] });
  const [uiSurface, setUiSurface] = useState<A2UISurfaceState>({});
  const [patchStream, setPatchStream] = useState<{ time: string; patch: A2UIPatch }[]>([]);
  const [intentText, setIntentText] = useState("analyze a task and apply the result");

  const addLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [entry, ...prev]);
  }, []);

  const sysLog = useCallback(
    (label: string) => addLog({ time: now(), kind: "system", label, payload: null }),
    [addLog]
  );

  // Poll projection + A2UI surface + trace state every 200ms
  useEffect(() => {
    if (!executionId) return;
    const tick = () => {
      const st = pr.getState<TaskState>("task", executionId);
      if (st) setProjState(st);
      setUiSurface(pr.getState<A2UISurfaceState>("ui", executionId));
      setTraceData({
        flow: mutableTrace.flow,
        steps: Array.from(mutableTrace.steps.values()),
      });
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [executionId, pr]);

  // Subscribe to raw events for the event log + A2UI patch stream tabs.
  // subscribe() is async now, so resolve the unsubscribe and guard against the
  // effect being torn down before it settles.
  useEffect(() => {
    if (!executionId) return;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    void eventStore
      .subscribe(executionId, (e: EventEnvelope) => {
        addLog({ time: now(), kind: "event", label: e.eventType, payload: e.payload });
        if (e.eventType === A2UI_PATCH) {
          const payload = e.payload as A2UIPatchPayload;
          const entries = payload.patches.map((patch) => ({ time: now(), patch }));
          setPatchStream((prev) => [...entries.reverse(), ...prev]);
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unsub = u;
      });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [executionId, addLog]);

  const start = useCallback(
    async (intentText?: string) => {
      const taskId = `task-${String(counter).padStart(3, "0")}`;
      setCounter((n) => n + 1);
      setPhase("running");
      setLog([]);
      setProjState(null);
      setTraceData({ flow: null, steps: [] });
      setUiSurface({});
      setPatchStream([]);
      clearTrace();

      try {
        const input: TaskInput = { taskId, label: `Sample Task ${taskId}` };
        let handle: Awaited<ReturnType<typeof intentRuntime.run>>;
        if (intentText && intentText.trim().length > 0) {
          // Intent Over Routes: the Intent Runtime picks the capability, then runs it.
          const route = await intentRuntime.route(intentText);
          sysLog(`Intent "${intentText}" → capability ${route?.capability.id ?? "(none)"}`);
          handle = await intentRuntime.run(intentText, input);
        } else {
          sysLog(`Starting flow — ${taskId}`);
          handle = await wfr.start<TaskInput>(RegisteredTaskFlow, input);
        }
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
    },
    [wfr, counter, sysLog]
  );

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
    setTraceData({ flow: null, steps: [] });
    setUiSurface({});
    setPatchStream([]);
    clearTrace();
  }, []);

  return (
    <div style={s.page}>
      <header style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.logo}>⧖ Loom Playground</span>
          <span style={{ ...s.badge, background: phaseBg[phase] }}>{phase}</span>
        </div>
        <div style={s.controls}>
          {phase === "idle" && (
            <>
              <input
                style={s.intentInput}
                value={intentText}
                onChange={(e) => setIntentText(e.target.value)}
                placeholder="Describe your intent…"
                title="Intent Over Routes — the Intent Runtime routes this to a capability"
              />
              <button type="button" style={s.btn} onClick={() => void start(intentText)}>
                ➤ Run Intent
              </button>
              <button type="button" style={{ ...s.btn, ...s.btnGray }} onClick={() => void start()}>
                ▶ Run Flow
              </button>
            </>
          )}
          {phase === "suspended" && (
            <button
              type="button"
              style={{ ...s.btn, ...s.btnGreen }}
              onClick={() => void approve()}
            >
              ✓ Approve
            </button>
          )}
          {(phase === "completed" || phase === "failed") && (
            <button type="button" style={{ ...s.btn, ...s.btnGray }} onClick={reset}>
              ↺ Reset
            </button>
          )}
          {phase === "running" && <span style={s.spinner}>Running…</span>}
        </div>
      </header>

      <div style={s.tabBar}>
        {(["blueprint", "events", "state", "trace", "a2ui"] as const).map((t) => (
          <button
            type="button"
            key={t}
            style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}
            onClick={() => setTab(t)}
          >
            {t === "blueprint"
              ? "Blueprint"
              : t === "events"
                ? "Event Log"
                : t === "state"
                  ? "Projection State"
                  : t === "trace"
                    ? "Trace"
                    : "A2UI"}
          </button>
        ))}
      </div>

      <main style={s.content}>
        {tab === "blueprint" &&
          (projState ? (
            <BlueprintView state={projState} phase={phase} onApprove={() => void approve()} />
          ) : (
            <EmptyState />
          ))}

        {tab === "events" && (
          <div style={s.logPanel}>
            {log.length === 0 ? (
              <div style={s.empty}>No events yet — run the flow to see events here.</div>
            ) : (
              log.map((entry, i) => (
                <div
                  key={i}
                  style={{ ...s.logRow, ...(entry.kind === "system" ? s.logSystem : {}) }}
                >
                  <span style={s.logTime}>{entry.time}</span>
                  <span
                    style={{ ...s.logLabel, ...(entry.kind === "system" ? s.logLabelSystem : {}) }}
                  >
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

        {tab === "trace" && <TraceTab data={traceData} />}

        {tab === "a2ui" && <A2UITab surface={uiSurface} patches={patchStream} />}
      </main>

      <footer style={s.footer}>
        <span style={s.hint}>Experiment by editing: </span>
        <code style={s.inlineCode}>src/flow.ts</code>
        <span style={s.hint}> (steps & runner) · </span>
        <code style={s.inlineCode}>src/projection.ts</code>
        <span style={s.hint}> (state shape) · </span>
        <code style={s.inlineCode}>src/blueprint.ts</code>
        <span style={s.hint}> (widget layout) · Check DevTools console for </span>
        <code style={s.inlineCode}>[loom]</code>
        <span style={s.hint}> telemetry lines</span>
      </footer>
    </div>
  );
}

// ── TraceTab ──────────────────────────────────────────────────────────────────

function TraceTab({ data }: { data: TraceSnapshot }) {
  const { flow, steps } = data;

  if (!flow) {
    return <div style={s.empty}>No trace yet — run the flow to see execution timing here.</div>;
  }

  const now = Date.now();
  const totalMs = Math.max((flow.completedAt ?? now) - flow.startedAt, 1);
  const sorted = [...steps].sort((a, b) => a.startedAt - b.startedAt);

  return (
    <div>
      {/* Flow summary */}
      <div style={s.traceSummaryRow}>
        <div>
          <div style={s.traceSummaryLabel}>Execution</div>
          <div style={{ ...s.traceSummaryVal, fontSize: 11, fontFamily: "monospace" }}>
            {flow.executionId.slice(0, 20)}…
          </div>
        </div>
        <div style={s.traceSummaryDivider} />
        <div>
          <div style={s.traceSummaryLabel}>Status</div>
          <div>
            <span style={{ ...s.badge, background: phaseBg[flow.status as Phase] ?? phaseBg.idle }}>
              {flow.status}
            </span>
          </div>
        </div>
        <div style={s.traceSummaryDivider} />
        <div>
          <div style={s.traceSummaryLabel}>Total Duration</div>
          <div style={s.traceSummaryVal}>
            {flow.durationMs !== undefined
              ? `${flow.durationMs}ms`
              : `${Date.now() - flow.startedAt}ms…`}
          </div>
        </div>
        <div style={s.traceSummaryDivider} />
        <div>
          <div style={s.traceSummaryLabel}>Steps</div>
          <div style={s.traceSummaryVal}>{flow.stepCount}</div>
        </div>
        <div style={s.traceSummaryDivider} />
        <div>
          <div style={s.traceSummaryLabel}>Suspensions</div>
          <div style={s.traceSummaryVal}>{flow.suspendCount}</div>
        </div>
      </div>

      {/* Gantt bars */}
      <div style={s.traceSection}>
        <div style={s.traceSectionTitle}>Step Timeline</div>
        <div style={s.traceGantt}>
          {sorted.length === 0 ? (
            <div style={{ color: "#4a5568", fontStyle: "italic", fontSize: 12 }}>
              Waiting for steps…
            </div>
          ) : (
            sorted.map((step) => {
              const offsetPct = ((step.startedAt - flow.startedAt) / totalMs) * 100;
              const widthPct =
                step.durationMs !== undefined
                  ? Math.max((step.durationMs / totalMs) * 100, 2)
                  : Math.max(((now - step.startedAt) / totalMs) * 100, 2);

              return (
                <div key={step.stepId} style={s.traceRow}>
                  <div style={s.traceLabel}>{step.stepId}</div>
                  <div style={s.traceBarContainer}>
                    <div
                      style={{
                        ...s.traceBarFill,
                        left: `${offsetPct}%`,
                        width: `${widthPct}%`,
                        background: statusBg[step.status],
                        opacity: step.status === "running" ? 0.8 : 1,
                      }}
                    />
                  </div>
                  <div style={s.traceDuration}>
                    {step.durationMs !== undefined ? `${step.durationMs}ms` : "running…"}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Summary metric cards */}
      <div style={s.traceMetricGrid}>
        <div style={s.card}>
          <div style={s.cardTitle}>Total Duration</div>
          <div style={s.cardValue}>
            {flow.durationMs ?? Date.now() - flow.startedAt}
            <span style={s.cardUnit}>ms</span>
          </div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>Steps</div>
          <div style={s.cardValue}>{flow.stepCount}</div>
        </div>
        <div style={s.card}>
          <div style={s.cardTitle}>Suspensions</div>
          <div style={s.cardValue}>{flow.suspendCount}</div>
        </div>
      </div>
    </div>
  );
}

// ── BlueprintView ─────────────────────────────────────────────────────────────

function BlueprintView({
  state,
  phase,
  onApprove,
}: { state: TaskState; phase: Phase; onApprove: () => void }) {
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
            <div style={{ color: "#4a5568", fontStyle: "italic", fontSize: 12 }}>
              No events yet.
            </div>
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
              <button type="button" style={{ ...s.btn, ...s.btnGreen }} onClick={onApprove}>
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

function MetricCard({
  title,
  value,
  unit,
}: { title: string; value: number | null; unit?: string }) {
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
        <br />
        <br />
        Edit <code>src/flow.ts</code>, <code>src/projection.ts</code>, or{" "}
        <code>src/blueprint.ts</code> to experiment.
      </div>
    </div>
  );
}

// ── A2UITab ─────────────────────────────────────────────────────────────────
// Shows the A2UI protocol in action: the live "ui" surface (rebuilt purely by
// folding A2UI_PATCH events) on the left, and the raw patch stream on the right.

const patchColor: Record<string, string> = {
  set: "#3182ce",
  merge: "#805ad5",
  append: "#38a169",
  increment: "#d69e2e",
  remove: "#e53e3e",
};

function A2UITab({
  surface,
  patches,
}: {
  surface: A2UISurfaceState;
  patches: { time: string; patch: A2UIPatch }[];
}) {
  if (patches.length === 0) {
    return (
      <div style={s.empty}>
        No A2UI patches yet — run the flow. Each <code>ctx.ui.*</code> call emits one durable,
        replayable <code>A2UI_PATCH</code> event that folds into the surface.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div style={s.statePanel}>
        <div style={s.stateJsonTitle}>Live "ui" surface</div>
        <pre style={s.json}>{JSON.stringify(surface, null, 2)}</pre>
      </div>
      <div style={s.logPanel}>
        <div style={s.stateJsonTitle}>Patch stream ({patches.length})</div>
        {patches.map((entry, i) => (
          <div key={i} style={s.logRow}>
            <span style={s.logTime}>{entry.time}</span>
            <span
              style={{
                ...s.logLabel,
                color: patchColor[entry.patch.op] ?? "#a0aec0",
                minWidth: 74,
              }}
            >
              {entry.patch.op}
            </span>
            <span style={s.logPayload}>
              {entry.patch.path || "(root)"}
              {"value" in entry.patch ? ` = ${JSON.stringify(entry.patch.value)}` : ""}
              {entry.patch.op === "increment" ? ` += ${entry.patch.by ?? 1}` : ""}
            </span>
          </div>
        ))}
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
