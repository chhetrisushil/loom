import { RendererRegistry, type Widget } from "@loom/blueprint-runtime";
import { formatValue, indent } from "./format";

// ── Kind-aware terminal renderers for loom's eight built-in widgets ──────────
//
// The terminal renderer used to be kind-blind: `title: value` for everything, so it could not
// fail on a kind it did not know — and could not render a progress bar as anything but a number.
// ADR 0088 asks the second question of every surface — does it cover the catalogue? — and
// `defaultRegistry.test.ts` asks it of this one with `catalogCoverage(builtinCatalog, …)`.
// Adding a kind to `WidgetKind` without a renderer here fails that test.

/** One widget kind, rendered to a block of text. Multi-line output is the renderer's own. */
export type TerminalWidgetRenderer = (widget: Widget, value: unknown) => string;

const BAR_CELLS = 20;

const title = (w: Widget): string => w.title ?? w.kind;

const block = (heading: string, body: string): string =>
  body.includes("\n") ? `${heading}:\n${indent(body, "    ")}` : `${heading}: ${body}`;

const metricCard: TerminalWidgetRenderer = (w, v) => {
  const unit = typeof w.props.unit === "string" ? ` ${w.props.unit}` : "";
  return v === null || v === undefined ? `${title(w)}: —` : `${title(w)}: ${formatValue(v)}${unit}`;
};

const statusBadge: TerminalWidgetRenderer = (w, v) =>
  `${title(w)}: [${v === null || v === undefined ? "—" : String(v)}]`;

const progressBar: TerminalWidgetRenderer = (w, v) => {
  if (typeof v !== "number" || Number.isNaN(v)) return `${title(w)}: —`;
  const max = typeof w.props.max === "number" && w.props.max > 0 ? w.props.max : 100;
  const ratio = Math.min(1, Math.max(0, v / max));
  const filled = Math.round(ratio * BAR_CELLS);
  const pct = Math.round(ratio * 100);
  return `${title(w)}: [${"#".repeat(filled)}${"-".repeat(BAR_CELLS - filled)}] ${pct}%`;
};

const timeline: TerminalWidgetRenderer = (w, v) => {
  if (!Array.isArray(v)) return block(title(w), formatValue(v));
  const max = typeof w.props.maxItems === "number" ? w.props.maxItems : v.length;
  return block(title(w), formatValue(v.slice(0, max)));
};

const dataTable: TerminalWidgetRenderer = (w, v) => {
  if (!Array.isArray(v)) return block(title(w), formatValue(v));
  if (v.length === 0) return `${title(w)}: (empty)`;
  const rows = v.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
  const declared = Array.isArray(w.props.columns) ? (w.props.columns as string[]) : undefined;
  const columns = declared ?? Object.keys(rows[0] ?? {});
  const lines = [
    columns.join(" | "),
    ...rows.map((r) => columns.map((c) => String(r[c] ?? "—")).join(" | ")),
  ];
  return block(title(w), lines.join("\n"));
};

const alertCard: TerminalWidgetRenderer = (w, v) => {
  const severity = typeof w.props.severity === "string" ? w.props.severity : "info";
  return `${severity.toUpperCase()} ${title(w)}: ${formatValue(v)}`;
};

const approvalCard: TerminalWidgetRenderer = (w, v) => {
  const approve = typeof w.props.approveLabel === "string" ? w.props.approveLabel : "Approve";
  const reject = typeof w.props.rejectLabel === "string" ? w.props.rejectLabel : "Reject";
  return `${title(w)}: ${formatValue(v)}  (${approve} / ${reject})`;
};

const streamingText: TerminalWidgetRenderer = (w, v) => {
  if (v !== null && v !== undefined && v !== "") return `${title(w)}: ${String(v)}`;
  const placeholder = typeof w.props.placeholder === "string" ? w.props.placeholder : "…";
  return `${title(w)}: ${placeholder}`;
};

/** Renderers for the eight kinds `@loom/blueprint-runtime` ships. Merge your own on top. */
export const defaultTerminalRegistry: RendererRegistry<TerminalWidgetRenderer> =
  new RendererRegistry<TerminalWidgetRenderer>()
    .register("MetricCard", metricCard)
    .register("StatusBadge", statusBadge)
    .register("ProgressBar", progressBar)
    .register("Timeline", timeline)
    .register("DataTable", dataTable)
    .register("AlertCard", alertCard)
    .register("ApprovalCard", approvalCard)
    .register("StreamingText", streamingText);
