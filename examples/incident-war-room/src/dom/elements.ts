import type { Widget } from "@loom/blueprint-runtime";
import type { AgentTask, PendingApproval, PlanEntry, RiskLevel } from "../domain";
import type { BranchSurface, BranchView } from "../warroom/branchView";
import type { StrategyOutcome } from "../warroom/strategies";

// ── BYOR + BYOC on the platform: one Custom Element per widget kind ────────────
//
// Loom's renderer contract is framework-agnostic ({ widget, value, onAction }).
// Here each widget kind is rendered by a native Web Component. The BlueprintDom
// renderer (dom/BlueprintDom.ts) sets `.widgetDef` and `.value` on each element
// and updates only `.value` when that widget's projection slice changes — the
// same granular, near-real-time update model React's fiber path gives, built
// directly on the platform with no framework.

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
const PHASE_COLORS: Record<string, string> = {
  idle: "#4a5568",
  planning: "#5a3fb0",
  dispatching: "#2b6cb0",
  "awaiting-approval": "#b7791f",
  "awaiting-branches": "#b7791f",
  "exploring-branches": "#5a3fb0",
  "branches-ready": "#2b6cb0",
  remediating: "#2b6cb0",
  resolved: "#276749",
  rejected: "#9b2c2c",
};
const BRANCH_STATUS_COLORS: Record<string, string> = {
  proposed: "#4a5568",
  simulating: "#5a3fb0",
  simulated: "#2b6cb0",
  committing: "#b7791f",
  committed: "#276749",
  rejected: "#5b3b3b",
};

// ── tiny DOM helpers ──────────────────────────────────────────────────────────
function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function pill(text: string, color: string): HTMLElement {
  const s = el("span", "pill", text);
  s.style.background = color;
  return s;
}

// The structural contract the BlueprintDom renderer drives each element through
// (kept separate from the HTMLElement subclass so the DOM tree stays typed as
// plain HTMLElement).
export interface WidgetHost {
  setWidget(widget: Widget): void;
  value: unknown;
}

// ── Base element ──────────────────────────────────────────────────────────────
export abstract class WidgetElement extends HTMLElement implements WidgetHost {
  protected widgetDef: Widget | null = null;
  private _value: unknown;

  connectedCallback(): void {
    this.style.display = "block";
  }

  setWidget(widget: Widget): void {
    this.widgetDef = widget;
    if (this.isConnected || this.widgetDef) this.render();
  }
  set value(v: unknown) {
    this._value = v;
    this.render();
  }
  get value(): unknown {
    return this._value;
  }

  protected titleText(): string {
    return this.widgetDef?.title ?? "";
  }
  protected propsOf<T>(): T {
    return (this.widgetDef?.props ?? {}) as T;
  }
  protected card(titleText?: string): { root: HTMLElement; body: HTMLElement } {
    const root = el("div", "card");
    if (titleText !== undefined) root.appendChild(el("div", "card-title", titleText));
    return { root, body: root };
  }
  protected abstract render(): void;
}

// ── PhaseBanner ───────────────────────────────────────────────────────────────
class PhaseBannerElement extends WidgetElement {
  protected render(): void {
    const phase = typeof this.value === "string" && this.value ? this.value : "idle";
    const color = PHASE_COLORS[phase] ?? "#4a5568";
    const bar = el("div");
    bar.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-radius:10px;background:${color}22;border:1px solid ${color}`;
    bar.appendChild(el("span", undefined, this.titleText() || "Mission Phase")).style.color =
      "#93a2b8";
    bar.appendChild(pill(phase, color));
    this.replaceChildren(bar);
  }
}

// ── PlanFlow ──────────────────────────────────────────────────────────────────
class PlanFlowElement extends WidgetElement {
  protected render(): void {
    const plan = Array.isArray(this.value) ? (this.value as PlanEntry[]) : [];
    const { root } = this.card(this.titleText() || "Planned Workflow");
    if (plan.length === 0) root.appendChild(el("div", "empty", "Awaiting a goal…"));
    const row = el("div", "plan");
    plan.forEach((s, i) => {
      const step = el("div", "plan-step");
      const color = STATUS_COLORS[s.status] ?? "#7a8aa0";
      step.style.borderColor = color;
      step.title = s.rationale ?? "";
      const dot = el("span", "plan-dot", "●");
      dot.style.color = color;
      step.appendChild(dot);
      step.appendChild(document.createTextNode(s.title));
      row.appendChild(step);
      if (i < plan.length - 1) row.appendChild(el("span", "plan-arrow", "→"));
    });
    root.appendChild(row);
    this.replaceChildren(root);
  }
}

// ── AgentTaskList ─────────────────────────────────────────────────────────────
class AgentTaskListElement extends WidgetElement {
  protected render(): void {
    const tasks = Array.isArray(this.value) ? (this.value as AgentTask[]) : [];
    const { root } = this.card(this.titleText() || "Agent Tasks");
    if (tasks.length === 0) root.appendChild(el("div", "empty", "No tasks yet."));
    for (const t of tasks) {
      const color = STATUS_COLORS[t.status] ?? "#4a5568";
      const rowEl = el("div", "task-row");
      rowEl.style.borderLeft = `3px solid ${color}`;
      const main = el("div", "task-main");
      const head = el("div", "task-head");
      head.appendChild(el("span", "task-title", t.title));
      head.appendChild(el("span", "task-agent", t.agentName));
      main.appendChild(head);
      main.appendChild(el("div", "task-detail", t.detail));
      rowEl.appendChild(main);
      if (t.risk) rowEl.appendChild(pill(t.risk, RISK_COLORS[t.risk]));
      rowEl.appendChild(pill(t.status === "awaiting-approval" ? "approve?" : t.status, color));
      root.appendChild(rowEl);
    }
    this.replaceChildren(root);
  }
}

// ── RiskApproval (dispatches a bubbling widget-action event) ──────────────────
class RiskApprovalElement extends WidgetElement {
  private fire(type: string): void {
    this.dispatchEvent(
      new CustomEvent("widget-action", {
        bubbles: true,
        detail: { type, widgetId: this.widgetDef?.id },
      })
    );
  }
  protected render(): void {
    const pending = (this.value ?? null) as PendingApproval | null;
    const { root } = this.card(this.titleText() || "Approval");
    if (pending) root.style.borderColor = RISK_COLORS[pending.risk];
    if (!pending) {
      root.appendChild(el("div", "empty", "No decision required right now."));
    } else {
      const head = el("div");
      head.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:8px";
      const action = el("span", undefined, pending.action);
      action.style.cssText = "font-weight:700;color:#e6ecf5";
      head.append(action, pill(`${pending.risk} risk`, RISK_COLORS[pending.risk]));
      root.appendChild(head);
      const rationale = el("div", undefined, pending.rationale);
      rationale.style.cssText = "font-size:12px;color:#93a2b8;margin-bottom:12px";
      root.appendChild(rationale);
      const actions = el("div");
      actions.style.cssText = "display:flex;gap:8px";
      const approve = el("button", "btn green", "Approve");
      approve.addEventListener("click", () => this.fire("APPROVE"));
      const reject = el("button", "btn grey", "Reject");
      reject.addEventListener("click", () => this.fire("REJECT"));
      actions.append(approve, reject);
      root.appendChild(actions);
    }
    this.replaceChildren(root);
  }
}

// ── ConsoleLog (high-frequency streaming feed) ────────────────────────────────
class ConsoleLogElement extends WidgetElement {
  protected render(): void {
    const lines = Array.isArray(this.value) ? (this.value as string[]) : [];
    const { root } = this.card(this.titleText() || "Live Console");
    const box = el("div", "console");
    if (lines.length === 0) box.appendChild(el("div", "empty", "Idle."));
    for (const line of lines.slice(-80)) {
      box.appendChild(el("div", line.includes("[orchestrator]") ? "orch" : undefined, line));
    }
    root.appendChild(box);
    this.replaceChildren(root);
    box.scrollTop = box.scrollHeight;
  }
}

// ── Gauge ─────────────────────────────────────────────────────────────────────
class GaugeElement extends WidgetElement {
  protected render(): void {
    const p = this.propsOf<{ unit?: string; max?: number; goodBelow?: number }>();
    const num = typeof this.value === "number" ? this.value : 0;
    const max = p.max ?? 100;
    const good = p.goodBelow ?? 70;
    const color = num <= good ? "#38a169" : num <= good * 1.15 ? "#d69e2e" : "#e53e3e";
    const { root } = this.card(this.titleText());
    const valueRow = el("div");
    valueRow.style.cssText = "display:flex;align-items:baseline;gap:4px;margin-bottom:8px";
    const val = el("div", "gauge-value", String(Math.round(num)));
    val.style.color = color;
    valueRow.append(val, el("span", "gauge-unit", p.unit ?? ""));
    root.appendChild(valueRow);
    const track = el("div", "gauge-track");
    const fill = el("div", "gauge-fill");
    fill.style.width = `${Math.max(0, Math.min(100, (num / max) * 100))}%`;
    fill.style.background = color;
    track.appendChild(fill);
    root.appendChild(track);
    this.replaceChildren(root);
  }
}

// ── Sparkline (inline SVG) ────────────────────────────────────────────────────
const SVG_NS = "http://www.w3.org/2000/svg";
class SparklineElement extends WidgetElement {
  protected render(): void {
    const p = this.propsOf<{ unit?: string }>();
    const data = Array.isArray(this.value) ? (this.value as number[]) : [];
    const w = 220;
    const h = 44;
    const last = data.length ? data[data.length - 1] : undefined;
    const min = data.length ? Math.min(...data) : 0;
    const max = data.length ? Math.max(...data) : 1;
    const span = max - min || 1;
    const { root } = this.card();
    const head = el("div", "spark-head");
    head.appendChild(el("div", "card-title", this.titleText())).style.marginBottom = "0";
    head.appendChild(
      el("div", "spark-val", `${last !== undefined ? Math.round(last) : "—"} ${p.unit ?? ""}`)
    );
    root.appendChild(head);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.style.display = "block";
    svg.style.marginTop = "4px";
    if (data.length > 1) {
      const poly = document.createElementNS(SVG_NS, "polyline");
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", "#4299e1");
      poly.setAttribute("stroke-width", "2");
      poly.setAttribute(
        "points",
        data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / span) * h}`).join(" ")
      );
      svg.appendChild(poly);
    }
    root.appendChild(svg);
    this.replaceChildren(root);
  }
}

// ── AgentFleet ────────────────────────────────────────────────────────────────
const AGENT_NAMES: Record<string, string> = {
  "diagnostics-agent": "Diagnostics",
  "remediation-agent": "Remediation",
  "capacity-agent": "Capacity",
};
class AgentFleetElement extends WidgetElement {
  protected render(): void {
    const fleet = (this.value ?? {}) as Record<string, { status?: string; handled?: number }>;
    const entries = Object.entries(fleet);
    const { root } = this.card(this.titleText() || "Agent Fleet");
    if (entries.length === 0) root.appendChild(el("div", "empty", "No agents online."));
    for (const [id, s] of entries) {
      const rowEl = el("div", "fleet-row");
      const dot = el("span", "fleet-dot");
      dot.style.background = STATUS_COLORS[s.status ?? "idle"] ?? "#4a5568";
      if (s.status === "busy") dot.style.boxShadow = "0 0 6px #2b6cb0";
      rowEl.appendChild(dot);
      rowEl.appendChild(el("span", "fleet-name", AGENT_NAMES[id] ?? id));
      rowEl.appendChild(el("span", "fleet-meta", `${s.handled ?? 0} handled`));
      rowEl.appendChild(el("span", "fleet-meta", s.status ?? "idle"));
      root.appendChild(rowEl);
    }
    this.replaceChildren(root);
  }
}

// ── MetricCard (a built-in Loom kind, given a platform renderer here) ─────────
class MetricCardElement extends WidgetElement {
  protected render(): void {
    const p = this.propsOf<{ unit?: string }>();
    const v = this.value;
    const display = v !== undefined && v !== null ? String(v) : "—";
    const { root } = this.card(this.titleText());
    const line = el("div");
    line.appendChild(el("span", "metric-value", display));
    if (p.unit) line.appendChild(el("span", "metric-unit", p.unit));
    root.appendChild(line);
    this.replaceChildren(root);
  }
}

// ── LatencyChart (async component: native dynamic import → code-splitting) ─────
class LatencyChartElement extends WidgetElement {
  private loaded: ((host: HTMLElement, data: number[]) => void) | null = null;
  protected render(): void {
    const data = Array.isArray(this.value) ? (this.value as number[]) : [];
    const { root } = this.card(this.titleText() || "Replica Lag (ms)");
    if (this.loaded) {
      this.loaded(root, data);
      this.replaceChildren(root);
      return;
    }
    root.appendChild(el("div", "empty", "Loading chart…"));
    this.replaceChildren(root);
    // Lazily code-split the chart implementation, then re-render. Native ESM
    // dynamic import — the platform's equivalent of React.lazy + Suspense.
    void import("./latencyChart").then((mod) => {
      this.loaded = mod.renderBars;
      this.render();
    });
  }
}

// ── BranchGraph (git-log --graph of the fork DAG) ─────────────────────────────
class BranchGraphElement extends WidgetElement {
  protected render(): void {
    const s = (this.value ?? {}) as Partial<BranchSurface>;
    const branches = Array.isArray(s.branches) ? s.branches : [];
    const { root } = this.card(this.titleText() || "Branch Graph");
    if (branches.length === 0) {
      root.appendChild(el("div", "empty", "No fork point yet — reach the gate to branch."));
      this.replaceChildren(root);
      return;
    }
    const graph = el("div", "branch-graph");
    // The trunk: main at the fork point.
    const trunk = el("div", "branch-trunk");
    const at = s.forkPoint != null ? `@${s.forkPoint}` : "";
    trunk.append(el("span", "graph-dot main", "●"), el("span", "graph-label", `main ${at}`));
    graph.appendChild(trunk);
    // One line per candidate branch off the gate.
    for (const b of branches) {
      const line = el("div", "branch-line");
      const color = BRANCH_STATUS_COLORS[b.status] ?? "#4a5568";
      const connector = el("span", "graph-connector", "└─");
      const dot = el("span", "graph-dot", b.winner ? "◆" : "○");
      dot.style.color = color;
      const label = el("span", "graph-label", b.branchName);
      if (b.winner) label.style.color = "#7ee2a8";
      const status = pill(b.status, color);
      line.append(connector, dot, label, status);
      graph.appendChild(line);
    }
    root.appendChild(graph);
    if (typeof s.lineageCount === "number") {
      root.appendChild(
        el("div", "branch-note", `${s.lineageCount} forked from the gate · losers kept as lineage`)
      );
    }
    this.replaceChildren(root);
  }
}

// ── BranchDiff (side-by-side projected-outcome comparison) ────────────────────
const COLS: Array<{
  key: keyof StrategyOutcome & string;
  label: string;
  fmt: (v: number) => string;
}> = [
  { key: "projectedLagMs", label: "Lag after", fmt: (v) => `${v} ms` },
  { key: "etaMinutes", label: "ETA", fmt: (v) => `${v} min` },
  { key: "downtimeSeconds", label: "Downtime", fmt: (v) => `${v} s` },
  { key: "costPerHourUsd", label: "Cost", fmt: (v) => `$${v}/hr` },
];
class BranchDiffElement extends WidgetElement {
  protected render(): void {
    const branches = Array.isArray(this.value) ? (this.value as BranchView[]) : [];
    const { root } = this.card(this.titleText() || "Projected Outcomes");
    const explored = branches.filter((b) => b.outcome);
    if (explored.length === 0) {
      root.appendChild(el("div", "empty", "Explore the branches to compare projected outcomes."));
      this.replaceChildren(root);
      return;
    }
    const table = el("div", "diff");
    // Header row.
    const head = el("div", "diff-row diff-head");
    head.appendChild(el("span", "diff-cell diff-strat", "Strategy"));
    for (const c of COLS) head.appendChild(el("span", "diff-cell", c.label));
    head.appendChild(el("span", "diff-cell", "Risk"));
    table.appendChild(head);
    for (const b of explored) {
      const o = b.outcome;
      if (!o) continue;
      const row = el("div", "diff-row");
      if (b.winner) row.classList.add("winner");
      const name = el("span", "diff-cell diff-strat", b.label);
      if (b.winner) name.append(pill("winner", "#276749"));
      row.appendChild(name);
      for (const c of COLS) {
        row.appendChild(el("span", "diff-cell", c.fmt(o[c.key] as number)));
      }
      row.appendChild(pill(o.risk, RISK_COLORS[o.risk as RiskLevel] ?? "#4a5568"));
      table.appendChild(row);
    }
    root.appendChild(table);
    this.replaceChildren(root);
  }
}

// ── BranchControls (Explore / Promote — dispatches widget-action) ─────────────
class BranchControlsElement extends WidgetElement {
  private fire(type: string, payload?: unknown): void {
    this.dispatchEvent(
      new CustomEvent("widget-action", {
        bubbles: true,
        detail: { type, widgetId: this.widgetDef?.id ?? "branch-controls", payload },
      })
    );
  }
  protected render(): void {
    const s = (this.value ?? {}) as Partial<BranchSurface>;
    const phase = s.phase ?? "idle";
    const branches = Array.isArray(s.branches) ? s.branches : [];
    const { root } = this.card(this.titleText() || "War Room");
    root.appendChild(
      el("div", "branch-note", s.note ?? "Branch-only, no merge — pick one winner.")
    );
    const bar = el("div", "branch-actions");
    if (phase === "prepared" || phase === "idle") {
      const explore = el("button", "btn", "Explore branches");
      explore.addEventListener("click", () => this.fire("EXPLORE"));
      if (branches.length === 0) (explore as HTMLButtonElement).disabled = true;
      bar.appendChild(explore);
    } else if (phase === "exploring") {
      bar.appendChild(el("div", "empty", "Simulating candidate branches…"));
    } else if (phase === "explored") {
      for (const b of branches) {
        const btn = el("button", "btn green", `Promote ${b.label}`) as HTMLButtonElement;
        btn.addEventListener("click", () => this.fire("PROMOTE", { strategy: b.strategy }));
        bar.appendChild(btn);
      }
    } else if (phase === "committing") {
      bar.appendChild(el("div", "empty", "Applying the winner for real…"));
    } else if (phase === "committed") {
      const winner = branches.find((b) => b.winner);
      bar.appendChild(
        el("div", "branch-committed", `Committed: ${winner?.label ?? "—"} — main now names it.`)
      );
    }
    root.appendChild(bar);
    this.replaceChildren(root);
  }
}

// ── Registry: widget kind → custom-element tag ────────────────────────────────
export const KIND_TO_TAG: Record<string, string> = {
  PhaseBanner: "dcc-phase-banner",
  PlanFlow: "dcc-plan-flow",
  AgentTaskList: "dcc-agent-task-list",
  RiskApproval: "dcc-risk-approval",
  ConsoleLog: "dcc-console-log",
  Gauge: "dcc-gauge",
  Sparkline: "dcc-sparkline",
  AgentFleet: "dcc-agent-fleet",
  LatencyChart: "dcc-latency-chart",
  MetricCard: "dcc-metric-card",
  BranchGraph: "dcc-branch-graph",
  BranchDiff: "dcc-branch-diff",
  BranchControls: "dcc-branch-controls",
};

const DEFINITIONS: Array<[string, CustomElementConstructor]> = [
  ["dcc-phase-banner", PhaseBannerElement],
  ["dcc-plan-flow", PlanFlowElement],
  ["dcc-agent-task-list", AgentTaskListElement],
  ["dcc-risk-approval", RiskApprovalElement],
  ["dcc-console-log", ConsoleLogElement],
  ["dcc-gauge", GaugeElement],
  ["dcc-sparkline", SparklineElement],
  ["dcc-agent-fleet", AgentFleetElement],
  ["dcc-latency-chart", LatencyChartElement],
  ["dcc-metric-card", MetricCardElement],
  ["dcc-branch-graph", BranchGraphElement],
  ["dcc-branch-diff", BranchDiffElement],
  ["dcc-branch-controls", BranchControlsElement],
];

// Register every custom element exactly once (idempotent for HMR/tests).
export function defineWidgetElements(): void {
  for (const [tag, ctor] of DEFINITIONS) {
    if (!customElements.get(tag)) customElements.define(tag, ctor);
  }
}
