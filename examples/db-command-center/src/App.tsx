import type { AgentCard } from "@loom/a2a";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { BlueprintRenderer, useProjection } from "@loom/renderer-react";
import type { RendererRegistry, WidgetAction, WidgetRenderer } from "@loom/renderer-react";
import React, { useCallback, useState } from "react";
import { MissionControlBlueprint } from "./blueprints/MissionControlBlueprint";
import { ObservabilityBlueprint } from "./blueprints/ObservabilityBlueprint";
import type { PendingApproval } from "./domain";
import type { Orchestrator } from "./orchestrator/Orchestrator";

export interface AppProps {
  orchestrator: Orchestrator;
  projectionRuntime: ProjectionRuntime;
  registry: RendererRegistry<WidgetRenderer>;
  missionId: string;
  agentCards: AgentCard[];
}

const EXAMPLE_GOALS = [
  "Why is CPU utilization high? Fix it if remediation is low risk.",
  "Investigate the read-replica lag issue and fix it if remediation is low risk, else wait for my approval.",
];

type Tab = "mission" | "observability";

export function App({
  orchestrator,
  projectionRuntime,
  registry,
  missionId,
  agentCards,
}: AppProps) {
  const [goal, setGoal] = useState(EXAMPLE_GOALS[0] ?? "");
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<Tab>("mission");
  const [fiberOn, setFiberOn] = useState(true);

  const run = useCallback(
    (text: string) => {
      if (running) return;
      setRunning(true);
      orchestrator.run(text).finally(() => setRunning(false));
    },
    [orchestrator, running]
  );

  // Route custom-widget actions (Approve/Reject from the RiskApproval widget)
  // back to the orchestrator's human-in-the-loop gate.
  const handleAction = useCallback(
    (action: WidgetAction) => {
      if (action.type === "APPROVE") orchestrator.resolveApproval(true);
      if (action.type === "REJECT") orchestrator.resolveApproval(false);
    },
    [orchestrator]
  );

  // Subscribe to the mission surface so the app can surface a prominent,
  // tab-independent approval prompt (the in-blueprint RiskApproval widget lives
  // only on Mission Control; a human might be looking at Observability).
  const missionState = useProjection<{ pendingApproval?: PendingApproval | null }>(
    projectionRuntime,
    "mission",
    missionId
  );
  const pendingApproval = missionState.pendingApproval ?? null;

  // Opt-in render-side fiber capabilities. Toggle to compare against the eager
  // whole-tree render path.
  const fiber = fiberOn ? { granularUpdates: true, suspense: true, deferStreaming: true } : false;

  const blueprint = tab === "mission" ? MissionControlBlueprint : ObservabilityBlueprint;

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>DB Command Center</h1>
          <div style={styles.subtitle}>
            Intent-driven · Human-in-the-loop · {agentCards.length} agents over A2A
          </div>
        </div>
        <label
          style={styles.fiberToggle}
          title="Render-side fiber: granular updates, suspense, deferred streaming"
        >
          <input type="checkbox" checked={fiberOn} onChange={(e) => setFiberOn(e.target.checked)} />
          render-side fiber
        </label>
      </header>

      <div style={styles.intentBar}>
        <input
          style={styles.input}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="State a goal — e.g. why is CPU high? fix it if low risk"
          disabled={running}
        />
        <button
          type="button"
          style={{ ...styles.runBtn, opacity: running ? 0.5 : 1 }}
          onClick={() => run(goal)}
          disabled={running}
        >
          {running ? "Running…" : "Run Intent"}
        </button>
      </div>

      <div style={styles.examples}>
        <span style={styles.examplesLabel}>Try:</span>
        {EXAMPLE_GOALS.map((g) => (
          <button
            key={g}
            type="button"
            style={styles.chip}
            onClick={() => {
              setGoal(g);
              run(g);
            }}
            disabled={running}
          >
            {g}
          </button>
        ))}
      </div>

      {pendingApproval && (
        <div style={styles.approvalBar} data-testid="approval-bar">
          <div style={{ flex: 1 }}>
            <div style={styles.approvalTitle}>
              Approval required — <strong>{pendingApproval.action}</strong>
              <span style={{ ...styles.riskTag, ...riskTagStyle(pendingApproval.risk) }}>
                {pendingApproval.risk} risk
              </span>
            </div>
            <div style={styles.approvalRationale}>{pendingApproval.rationale}</div>
          </div>
          <button
            type="button"
            style={{ ...styles.runBtn, background: "#38a169" }}
            onClick={() => orchestrator.resolveApproval(true)}
          >
            Approve
          </button>
          <button
            type="button"
            style={{ ...styles.runBtn, background: "#4a5568" }}
            onClick={() => orchestrator.resolveApproval(false)}
          >
            Reject
          </button>
        </div>
      )}

      <nav style={styles.tabs}>
        {(["mission", "observability"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            style={{ ...styles.tab, ...(tab === t ? styles.tabActive : {}) }}
            onClick={() => setTab(t)}
          >
            {t === "mission" ? "Mission Control" : "Observability"}
          </button>
        ))}
      </nav>

      {/* A boundary so the lazy (BYOC) LatencyChart can suspend even when the
          fiber per-widget boundaries are toggled off. */}
      <React.Suspense fallback={<div style={styles.loading}>Loading dashboard…</div>}>
        <BlueprintRenderer
          key={`${blueprint.id}-${fiberOn}`}
          blueprint={blueprint}
          projectionRuntime={projectionRuntime}
          executionId={missionId}
          registry={registry}
          onAction={handleAction}
          fiber={fiber}
        />
      </React.Suspense>
    </div>
  );
}

function riskTagStyle(risk: PendingApproval["risk"]): React.CSSProperties {
  const bg = risk === "high" ? "#9b2c2c" : risk === "medium" ? "#b7791f" : "#276749";
  return { background: bg };
}

const styles: Record<string, React.CSSProperties> = {
  shell: { maxWidth: 1180, margin: "0 auto" },
  approvalBar: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "12px 16px",
    marginBottom: 16,
    borderRadius: 10,
    background: "#2b210e",
    border: "1px solid #b7791f",
  },
  approvalTitle: { fontSize: 14, color: "#f0e6d2", display: "flex", alignItems: "center", gap: 8 },
  approvalRationale: { fontSize: 12, color: "#c9b892", marginTop: 3 },
  riskTag: {
    color: "#fff",
    borderRadius: 10,
    padding: "2px 9px",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid #232c3b",
    paddingBottom: 14,
    marginBottom: 16,
  },
  title: { fontSize: 22, fontWeight: 800, color: "#9ecbff" },
  subtitle: { fontSize: 12, color: "#6b7d95", marginTop: 2 },
  fiberToggle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "#93a2b8",
    cursor: "pointer",
  },
  intentBar: { display: "flex", gap: 10, marginBottom: 10 },
  input: {
    flex: 1,
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid #232c3b",
    background: "#0f1620",
    color: "#e2e8f0",
    fontSize: 14,
  },
  runBtn: {
    padding: "10px 20px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    background: "#3182ce",
    color: "#fff",
    fontWeight: 700,
    fontSize: 14,
  },
  examples: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 18 },
  examplesLabel: { fontSize: 12, color: "#6b7d95" },
  chip: {
    padding: "5px 10px",
    borderRadius: 14,
    border: "1px solid #2b3546",
    background: "#141a24",
    color: "#a9b7c9",
    fontSize: 11,
    cursor: "pointer",
    textAlign: "left",
    maxWidth: 420,
  },
  tabs: { display: "flex", gap: 6, marginBottom: 16 },
  tab: {
    padding: "8px 16px",
    borderRadius: 8,
    border: "1px solid #232c3b",
    background: "#0f1620",
    color: "#93a2b8",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  tabActive: { background: "#1c2635", color: "#9ecbff", borderColor: "#3182ce" },
  loading: { color: "#6b7d95", padding: 40, textAlign: "center" },
};
