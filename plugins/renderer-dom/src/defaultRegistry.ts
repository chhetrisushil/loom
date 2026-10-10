import {
  type BindingStatus,
  RendererRegistry,
  type Widget,
  type WidgetAction,
} from "@loom/blueprint-runtime";
import { display, h, token } from "./safeDom";

// ── Kind-aware DOM renderers for loom's eight built-in widgets ───────────────
//
// The DOM sibling of `defaultTerminalRegistry` and the React `defaultRegistry`. The same
// question is asked of this surface as of those (ADR 0088): does it cover the catalogue? —
// `renderer-dom/src/parity.test.ts` asks it, for all three at once.

/** What a widget renderer receives. It returns the widget's BODY; the frame (status, source) is the adapter's. */
export interface DomWidgetContext {
  readonly doc: Document;
  readonly widget: Widget;
  readonly value: unknown;
  readonly status?: BindingStatus;
  /** Emit an action to the host. Absent when the host passed no `onAction`. */
  readonly onAction?: (action: WidgetAction) => void;
}
export type DomWidgetRenderer = (ctx: DomWidgetContext) => HTMLElement;

const SEVERITIES = new Set(["info", "warning", "error", "critical"]);
const titleOf = (c: DomWidgetContext, tag: string, cls: string): HTMLElement | undefined =>
  c.widget.title ? h(c.doc, tag, { class: cls }, c.widget.title) : undefined;

const metricCard: DomWidgetRenderer = (c) => {
  const unit = c.widget.props.unit;
  const shown = c.value === undefined || c.value === null ? "—" : display(c.value);
  return h(
    c.doc,
    "div",
    {},
    titleOf(c, "div", "metric-title"),
    h(
      c.doc,
      "div",
      { class: "metric-value" },
      shown,
      typeof unit === "string" && unit !== ""
        ? h(c.doc, "span", { class: "metric-unit" }, unit)
        : undefined
    )
  );
};

interface TimelineEntry {
  timestamp?: unknown;
  message?: unknown;
  level?: unknown;
}
const timeline: DomWidgetRenderer = (c) => {
  const entries = Array.isArray(c.value) ? (c.value as TimelineEntry[]) : [];
  return h(
    c.doc,
    "div",
    {},
    titleOf(c, "div", "timeline-title"),
    h(
      c.doc,
      "ul",
      { class: "timeline-entries" },
      ...entries.map((e) => {
        const entry = typeof e === "object" && e !== null ? e : {};
        return h(
          c.doc,
          "li",
          { class: "timeline-entry", "data-level": token(entry.level, "") || undefined },
          entry.timestamp
            ? h(c.doc, "span", { class: "timeline-ts" }, display(entry.timestamp))
            : undefined,
          h(c.doc, "span", { class: "timeline-msg" }, display(entry.message))
        );
      })
    )
  );
};

const approvalCard: DomWidgetRenderer = (c) => {
  const p = c.widget.props as { approveLabel?: unknown; rejectLabel?: unknown };
  const label = (v: unknown, d: string) => (typeof v === "string" && v !== "" ? v : d);
  const emit = (type: string, approved: boolean) => () =>
    c.onAction?.({ type, widgetId: c.widget.id, payload: { approved } });
  const pending = Boolean(c.value);
  return h(
    c.doc,
    "div",
    {},
    titleOf(c, "div", "approval-title"),
    pending
      ? h(
          c.doc,
          "div",
          { class: "approval-actions" },
          ...[
            button(c.doc, label(p.approveLabel, "Approve"), emit("APPROVE", true)),
            button(c.doc, label(p.rejectLabel, "Reject"), emit("REJECT", false)),
          ]
        )
      : h(c.doc, "div", { class: "approval-resolved" }, "No pending approval")
  );
};
function button(doc: Document, text: string, onClick: () => void): HTMLElement {
  const b = h(doc, "button", { type: "button" }, text);
  b.addEventListener("click", onClick);
  return b;
}

const statusBadge: DomWidgetRenderer = (c) => {
  const text = typeof c.value === "string" ? c.value : "unknown";
  return h(
    c.doc,
    "div",
    {},
    c.widget.title ? h(c.doc, "span", { class: "badge-title" }, c.widget.title) : undefined,
    h(c.doc, "span", { class: `badge badge--${token(c.value, "unknown")}` }, text)
  );
};

const streamingText: DomWidgetRenderer = (c) => {
  const placeholder = c.widget.props.placeholder;
  const text =
    c.value !== undefined && c.value !== null
      ? display(c.value)
      : typeof placeholder === "string"
        ? placeholder
        : "";
  return h(
    c.doc,
    "div",
    {},
    c.widget.title !== undefined
      ? h(c.doc, "div", { class: "streaming-title" }, c.widget.title)
      : undefined,
    h(c.doc, "pre", { class: "streaming-content" }, text)
  );
};

const progressBar: DomWidgetRenderer = (c) => {
  const maxProp = c.widget.props.max;
  const max = typeof maxProp === "number" && maxProp > 0 ? maxProp : 100;
  const current = typeof c.value === "number" && Number.isFinite(c.value) ? c.value : undefined;
  // A native <progress> with no `value` is the standard INDETERMINATE bar: an unresolved
  // binding must not read as 0%.
  return h(
    c.doc,
    "div",
    {},
    titleOf(c, "div", "progress-title"),
    h(c.doc, "progress", {
      class: "progress-track",
      "aria-label": c.widget.title ?? "progress",
      max,
      value: current,
    }),
    h(
      c.doc,
      "div",
      { class: "progress-value" },
      current === undefined ? "—" : `${current} / ${max}`
    )
  );
};

const dataTable: DomWidgetRenderer = (c) => {
  const rows = (Array.isArray(c.value) ? c.value : []).map((r) =>
    typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {}
  );
  const declared = c.widget.props.columns;
  // Without declared columns, the union of the rows' keys: a first-row sample silently drops
  // every column the first row happens to lack.
  const columns = Array.isArray(declared)
    ? declared.map(String)
    : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return h(
    c.doc,
    "div",
    {},
    titleOf(c, "div", "table-title"),
    rows.length === 0
      ? h(c.doc, "div", { class: "table-empty" }, c.value === undefined ? "—" : "no rows")
      : h(
          c.doc,
          "table",
          {},
          h(
            c.doc,
            "thead",
            {},
            h(c.doc, "tr", {}, ...columns.map((col) => h(c.doc, "th", { scope: "col" }, col)))
          ),
          h(
            c.doc,
            "tbody",
            {},
            ...rows.map((r) =>
              h(c.doc, "tr", {}, ...columns.map((col) => h(c.doc, "td", {}, display(r[col]))))
            )
          )
        )
  );
};

const alertCard: DomWidgetRenderer = (c) => {
  const sev = c.widget.props.severity;
  // An unrecognised severity falls back to `info`: bound data never authors a class name.
  const severity = typeof sev === "string" && SEVERITIES.has(sev) ? sev : "info";
  return h(
    c.doc,
    "div",
    {
      class: `alert alert--${severity}`,
      "data-severity": severity,
      role: severity === "error" || severity === "critical" ? "alert" : "status",
    },
    titleOf(c, "div", "alert-title"),
    h(
      c.doc,
      "div",
      { class: "alert-message" },
      c.value === undefined || c.value === null ? "—" : display(c.value)
    )
  );
};

/**
 * Renderers for the eight kinds `@loom/blueprint-runtime` ships. Merge your own on top.
 *
 * Shared and process-wide: do not `.register()` on it. Build yours with
 * `defaultDomRegistry.merge(mine)`, which returns a new registry.
 */
export const defaultDomRegistry: RendererRegistry<DomWidgetRenderer> =
  new RendererRegistry<DomWidgetRenderer>()
    .register("MetricCard", metricCard)
    .register("Timeline", timeline)
    .register("ApprovalCard", approvalCard)
    .register("StatusBadge", statusBadge)
    .register("StreamingText", streamingText)
    .register("ProgressBar", progressBar)
    .register("DataTable", dataTable)
    .register("AlertCard", alertCard);
