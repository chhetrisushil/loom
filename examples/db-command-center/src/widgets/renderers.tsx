import type { WidgetAction, WidgetRendererProps } from "@loom/plugin-renderer-react";
import React from "react";
import type { AgentTask, PendingApproval, PlanEntry, RiskLevel, TaskStatus } from "../domain";

// ── BYOR: React renderers for the custom (BYOC) widget kinds ───────────────────
//
// Each component receives the framework-agnostic WidgetRendererProps
// ({ widget, value, onAction }). value is the widget's bound projection slice,
// resolved by the renderer — so these components are pure presentation.

const STATUS_COLORS: Record<string, string> = {
  idle: "#4a5568",
  queued: "#4a5568",
  working: "#2b6cb0",
  busy: "#2b6cb0",
  "awaiting-approval": "#b7791f",
  completed: "#276749",
  failed: "#9b2c2c",
  cancelled: "#4a5568",
};

const RISK_COLORS: Record<RiskLevel, string> = {
  low: "#276749",
  medium: "#b7791f",
  high: "#9b2c2c",
};

function pill(color: string): React.CSSProperties {
  return {
    background: color,
    color: "#fff",
    borderRadius: 10,
    padding: "2px 9px",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };
}

const card: React.CSSProperties = {
  background: "#141a24",
  border: "1px solid #232c3b",
  borderRadius: 10,
  padding: 14,
};

const cardTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#7a8aa0",
  textTransform: "uppercase",
  letterSpacing: 1,
  marginBottom: 10,
};

// ── AgentTaskList — the near-real-time list of agent tasks ─────────────────────
export const AgentTaskListRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const tasks = Array.isArray(value) ? (value as AgentTask[]) : [];
  return (
    <div style={card} data-widget-kind="AgentTaskList" data-widget-id={widget.id}>
      <div style={cardTitle}>{widget.title ?? "Agent Tasks"}</div>
      {tasks.length === 0 && <div style={{ color: "#5b6b82", fontSize: 13 }}>No tasks yet.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tasks.map((t) => (
          <div
            key={t.id}
            style={{
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
              padding: "10px 12px",
              background: "#0f1620",
              borderRadius: 8,
              borderLeft: `3px solid ${STATUS_COLORS[t.status] ?? "#4a5568"}`,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: "#e6ecf5" }}>{t.title}</span>
                <span style={{ fontSize: 11, color: "#5f7a99" }}>{t.agentName}</span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "#93a2b8",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {t.detail}
              </div>
            </div>
            {t.risk && <span style={pill(RISK_COLORS[t.risk])}>{t.risk}</span>}
            <span style={pill(STATUS_COLORS[t.status] ?? "#4a5568")}>{labelFor(t.status)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

function labelFor(status: TaskStatus): string {
  return status === "awaiting-approval" ? "approve?" : status;
}

// ── PlanFlow — the dynamically-composed workflow ───────────────────────────────
export const PlanFlowRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const plan = Array.isArray(value) ? (value as PlanEntry[]) : [];
  return (
    <div style={card} data-widget-kind="PlanFlow" data-widget-id={widget.id}>
      <div style={cardTitle}>{widget.title ?? "Planned Workflow"}</div>
      {plan.length === 0 && <div style={{ color: "#5b6b82", fontSize: 13 }}>Awaiting a goal…</div>}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {plan.map((s, i) => (
          <React.Fragment key={s.capabilityId}>
            <div
              style={{
                padding: "6px 11px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                background: "#0f1620",
                border: `1px solid ${STATUS_COLORS[s.status] ?? "#232c3b"}`,
                color: "#cdd8e6",
              }}
              title={s.rationale ?? ""}
            >
              <span style={{ color: STATUS_COLORS[s.status] ?? "#7a8aa0", marginRight: 6 }}>●</span>
              {s.title}
            </div>
            {i < plan.length - 1 && <span style={{ color: "#3d4a5c" }}>→</span>}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

// ── RiskApproval — human-in-the-loop gate ──────────────────────────────────────
export const RiskApprovalRenderer: React.FC<WidgetRendererProps> = ({
  widget,
  value,
  onAction,
}) => {
  const pending = (value ?? null) as PendingApproval | null;
  const fire = (type: string): void => {
    const action: WidgetAction = { type, widgetId: widget.id };
    onAction?.(action);
  };
  return (
    <div
      style={{
        ...card,
        border: `1px solid ${pending ? RISK_COLORS[pending.risk] : "#232c3b"}`,
      }}
      data-widget-kind="RiskApproval"
      data-widget-id={widget.id}
    >
      <div style={cardTitle}>{widget.title ?? "Approval"}</div>
      {!pending && (
        <div style={{ color: "#5b6b82", fontSize: 13 }}>No decision required right now.</div>
      )}
      {pending && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontWeight: 700, color: "#e6ecf5" }}>{pending.action}</span>
            <span style={pill(RISK_COLORS[pending.risk])}>{pending.risk} risk</span>
          </div>
          <div style={{ fontSize: 12, color: "#93a2b8", marginBottom: 12 }}>
            {pending.rationale}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={btn("#276749")} onClick={() => fire("APPROVE")}>
              Approve
            </button>
            <button type="button" style={btn("#4a5568")} onClick={() => fire("REJECT")}>
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

function btn(bg: string): React.CSSProperties {
  return {
    padding: "7px 16px",
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    background: bg,
    color: "#fff",
    fontWeight: 600,
    fontSize: 13,
  };
}

// ── PhaseBanner ────────────────────────────────────────────────────────────────
const PHASE_COLORS: Record<string, string> = {
  idle: "#4a5568",
  planning: "#5a3fb0",
  dispatching: "#2b6cb0",
  "awaiting-approval": "#b7791f",
  remediating: "#2b6cb0",
  resolved: "#276749",
  rejected: "#9b2c2c",
};

export const PhaseBannerRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const phase = typeof value === "string" && value ? value : "idle";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        borderRadius: 10,
        background: `${PHASE_COLORS[phase] ?? "#4a5568"}22`,
        border: `1px solid ${PHASE_COLORS[phase] ?? "#4a5568"}`,
      }}
      data-widget-kind="PhaseBanner"
      data-widget-id={widget.id}
    >
      <span style={{ fontSize: 13, color: "#93a2b8" }}>{widget.title ?? "Mission Phase"}</span>
      <span style={pill(PHASE_COLORS[phase] ?? "#4a5568")}>{phase}</span>
    </div>
  );
};

// ── Gauge ──────────────────────────────────────────────────────────────────────
export const GaugeRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const props = widget.props as { unit?: string; max?: number; goodBelow?: number };
  const num = typeof value === "number" ? value : 0;
  const max = props.max ?? 100;
  const pct = Math.max(0, Math.min(100, (num / max) * 100));
  const good = props.goodBelow ?? 70;
  const color = num <= good ? "#38a169" : num <= good * 1.15 ? "#d69e2e" : "#e53e3e";
  return (
    <div style={card} data-widget-kind="Gauge" data-widget-id={widget.id}>
      <div style={cardTitle}>{widget.title}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 8 }}>
        <span style={{ fontSize: 28, fontWeight: 800, color }}>{Math.round(num)}</span>
        <span style={{ fontSize: 13, color: "#7a8aa0" }}>{props.unit ?? ""}</span>
      </div>
      <div style={{ height: 8, background: "#0f1620", borderRadius: 4, overflow: "hidden" }}>
        <div
          style={{ width: `${pct}%`, height: "100%", background: color, transition: "width .4s" }}
        />
      </div>
    </div>
  );
};

// ── Sparkline ──────────────────────────────────────────────────────────────────
export const SparklineRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const props = widget.props as { unit?: string };
  const data = Array.isArray(value) ? (value as number[]) : [];
  const last = data.length > 0 ? data[data.length - 1] : undefined;
  const w = 220;
  const h = 44;
  const min = data.length ? Math.min(...data) : 0;
  const max = data.length ? Math.max(...data) : 1;
  const span = max - min || 1;
  const points = data
    .map((v, i) => {
      const x = data.length > 1 ? (i / (data.length - 1)) * w : 0;
      const y = h - ((v - min) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <div style={card} data-widget-kind="Sparkline" data-widget-id={widget.id}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={cardTitle}>{widget.title}</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#cdd8e6" }}>
          {last !== undefined ? Math.round(last) : "—"}
          <span style={{ fontSize: 11, color: "#7a8aa0" }}> {props.unit ?? ""}</span>
        </div>
      </div>
      <svg
        width={w}
        height={h}
        style={{ display: "block", marginTop: 4 }}
        role="img"
        aria-label={`${String(widget.title)} sparkline`}
      >
        <title>{`${String(widget.title)} sparkline`}</title>
        {data.length > 1 && (
          <polyline points={points} fill="none" stroke="#4299e1" strokeWidth={2} />
        )}
      </svg>
    </div>
  );
};

// ── AgentFleet — long-running agent health ─────────────────────────────────────
const AGENT_NAMES: Record<string, string> = {
  "diagnostics-agent": "Diagnostics",
  "remediation-agent": "Remediation",
  "capacity-agent": "Capacity",
};

export const AgentFleetRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const fleet = (value ?? {}) as Record<string, { status?: string; handled?: number }>;
  const entries = Object.entries(fleet);
  return (
    <div style={card} data-widget-kind="AgentFleet" data-widget-id={widget.id}>
      <div style={cardTitle}>{widget.title ?? "Agent Fleet"}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {entries.length === 0 && (
          <div style={{ color: "#5b6b82", fontSize: 13 }}>No agents online.</div>
        )}
        {entries.map(([id, s]) => (
          <div key={id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: STATUS_COLORS[s.status ?? "idle"] ?? "#4a5568",
                boxShadow: s.status === "busy" ? "0 0 6px #2b6cb0" : "none",
              }}
            />
            <span style={{ flex: 1, fontSize: 13, color: "#cdd8e6" }}>{AGENT_NAMES[id] ?? id}</span>
            <span style={{ fontSize: 11, color: "#7a8aa0" }}>{s.handled ?? 0} handled</span>
            <span style={{ fontSize: 11, color: "#5f7a99" }}>{s.status ?? "idle"}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── ConsoleLog — high-frequency streaming feed (fiber deferStreaming) ──────────
export const ConsoleLogRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const lines = Array.isArray(value) ? (value as string[]) : [];
  const tail = lines.slice(-80);
  return (
    <div style={card} data-widget-kind="ConsoleLog" data-widget-id={widget.id}>
      <div style={cardTitle}>{widget.title ?? "Live Console"}</div>
      <div
        style={{
          maxHeight: 220,
          overflowY: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 12,
          lineHeight: 1.7,
        }}
      >
        {tail.length === 0 && <div style={{ color: "#5b6b82" }}>Idle.</div>}
        {tail.map((line, i) => (
          <div key={i} style={{ color: line.includes("[orchestrator]") ? "#7f9cf5" : "#93a2b8" }}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
};

// ── LatencyChart — async BYOC component (fiber suspense) ───────────────────────
//
// React.lazy created at module scope so the promise is stable across renders.
// Simulates a code-split chart module that takes ~700ms to load. With the fiber
// `suspense` capability enabled, the per-widget <Suspense> boundary shows the
// placeholder while this resolves, without blanking sibling widgets.
const LazyChartImpl = React.lazy(
  () =>
    new Promise<{ default: React.FC<{ data: number[] }> }>((resolve) => {
      setTimeout(() => resolve({ default: BarChart }), 700);
    })
);

function BarChart({ data }: { data: number[] }): React.ReactElement {
  const max = data.length ? Math.max(...data) : 1;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 80 }}>
      {data.slice(-16).map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${Math.max(4, (v / (max || 1)) * 100)}%`,
            background: "#4299e1",
            borderRadius: 2,
          }}
          title={String(Math.round(v))}
        />
      ))}
    </div>
  );
}

export const LatencyChartRenderer: React.FC<WidgetRendererProps> = ({ widget, value }) => {
  const data = Array.isArray(value) ? (value as number[]) : [];
  return (
    <div style={card} data-widget-kind="LatencyChart" data-widget-id={widget.id}>
      <div style={cardTitle}>{widget.title ?? "Replica Lag (ms)"}</div>
      <LazyChartImpl data={data} />
    </div>
  );
};
