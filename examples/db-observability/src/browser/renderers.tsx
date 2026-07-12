import type { WidgetRenderer } from "@loom/plugin-renderer-react";
import type { CSSProperties } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { card, cardTitle, colors, severityColor } from "./theme";

// Custom React renderers that draw the dashboard's widgets as VISUALISATIONS. They are
// registered under the STANDARD widget-kind names (MetricCard/Timeline/ProgressBar/
// DataTable/StatusBadge) and merged over renderer-react's defaults, so the SAME
// blueprint the composer produces renders as charts here and as text in the terminal.

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const span2: CSSProperties = { gridColumn: "1 / -1" };

// ── MetricCard → radial gauge (percent) or stat card (scalar) ─────────────────
export const MetricCardRenderer: WidgetRenderer = ({ widget, value }) => {
  const props = widget.props as { unit?: string; format?: string };
  const n = num(value);
  const isPercent = props.format === "percent" || props.unit === "%";

  if (isPercent) {
    const color = severityColor(n, 70, 85);
    const clamped = Math.max(0, Math.min(100, n));
    return (
      <div style={card} data-widget-kind="MetricCard" data-widget-id={widget.id}>
        <div style={cardTitle}>{widget.title}</div>
        <div style={{ position: "relative", height: 128 }}>
          <RadialBarChart
            width={224}
            height={140}
            cx={112}
            cy={122}
            innerRadius={74}
            outerRadius={108}
            barSize={20}
            startAngle={180}
            endAngle={0}
            data={[{ value: clamped }]}
          >
            <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
            <RadialBar
              background={{ fill: "#0f1620" }}
              dataKey="value"
              cornerRadius={10}
              angleAxisId={0}
              fill={color}
            />
          </RadialBarChart>
          <div style={gaugeLabel}>
            <span style={{ fontSize: 34, fontWeight: 800, color }}>{Math.round(n)}</span>
            <span style={{ fontSize: 15, color: colors.dim }}>{props.unit ?? "%"}</span>
          </div>
        </div>
      </div>
    );
  }

  // Scalar stat card (e.g. waiting clients, replica lag ms).
  const statColor = props.unit === "ms" ? severityColor(n, 200, 500) : colors.text;
  return (
    <div style={card} data-widget-kind="MetricCard" data-widget-id={widget.id}>
      <div style={cardTitle}>{widget.title}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 36, fontWeight: 800, color: statColor }}>{Math.round(n)}</span>
        <span style={{ fontSize: 14, color: colors.dim }}>{props.unit ?? ""}</span>
      </div>
    </div>
  );
};

// ── Timeline → filled area chart of the number[] history ──────────────────────
export const TimelineRenderer: WidgetRenderer = ({ widget, value }) => {
  const series = (Array.isArray(value) ? (value as number[]) : []).map((v, i) => ({ i, v }));
  const last = series.length > 0 ? series[series.length - 1]?.v : undefined;
  const gid = `grad-${widget.id}`;
  return (
    <div style={card} data-widget-kind="Timeline" data-widget-id={widget.id}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={cardTitle}>{widget.title ?? "Trend"}</span>
        <span style={{ fontSize: 18, fontWeight: 700, color: colors.text }}>
          {last !== undefined ? Math.round(last) : "—"}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={96}>
        <AreaChart data={series} margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.accent} stopOpacity={0.5} />
              <stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={["dataMin - 5", "dataMax + 5"]} />
          <Area
            type="monotone"
            dataKey="v"
            stroke={colors.accent}
            strokeWidth={2}
            fill={`url(#${gid})`}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

// ── ProgressBar → horizontal saturation bar ───────────────────────────────────
export const ProgressBarRenderer: WidgetRenderer = ({ widget, value }) => {
  const props = widget.props as { max?: number };
  const max = props.max ?? 100;
  const n = num(value);
  const pct = Math.round((n / max) * 100);
  const color = severityColor(pct, 75, 90);
  return (
    <div style={card} data-widget-kind="ProgressBar" data-widget-id={widget.id}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={cardTitle}>{widget.title ?? "Saturation"}</span>
        <span style={{ fontSize: 16, fontWeight: 700, color }}>
          {n}/{max}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={48}>
        <BarChart
          layout="vertical"
          data={[{ name: "v", value: n }]}
          margin={{ top: 8, right: 2, left: 2, bottom: 0 }}
        >
          <XAxis type="number" domain={[0, max]} hide />
          <YAxis type="category" dataKey="name" hide />
          <Bar
            dataKey="value"
            fill={color}
            radius={[4, 4, 4, 4]}
            background={{ fill: "#0f1620" }}
          />
        </BarChart>
      </ResponsiveContainer>
      <div style={{ fontSize: 12, color: colors.dim, marginTop: 4 }}>{pct}% saturated</div>
    </div>
  );
};

// ── DataTable → styled table with an inline bar for the cpuPct column ──────────
export const DataTableRenderer: WidgetRenderer = ({ widget, value }) => {
  const props = widget.props as { columns?: string[] };
  const rows = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
  const columns = props.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  return (
    <div style={{ ...card, ...span2 }} data-widget-kind="DataTable" data-widget-id={widget.id}>
      <div style={cardTitle}>{widget.title ?? "Table"}</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} style={th}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={String(row.statement ?? i)}>
              {columns.map((c) => (
                <td key={c} style={td}>
                  {renderCell(c, row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

function renderCell(column: string, value: unknown): JSX.Element | string {
  if (column === "cpuPct" && typeof value === "number") {
    const color = severityColor(value, 30, 55);
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 60,
            height: 8,
            background: "#0f1620",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <span
            style={{
              display: "block",
              width: `${Math.min(100, value)}%`,
              height: "100%",
              background: color,
            }}
          />
        </span>
        <span style={{ color }}>{value}%</span>
      </span>
    );
  }
  return value == null ? "—" : String(value);
}

// ── StatusBadge → narrative cards (question / WHAT / WHY) ──────────────────────
export const StatusBadgeRenderer: WidgetRenderer = ({ widget, value }) => {
  const title = widget.title ?? "";
  const text = value == null ? "—" : String(value);
  const isWhat = title.includes("WHAT");
  const isWhy = title.includes("WHY");
  const isQuestion = !isWhat && !isWhy;
  const accent = isWhat ? colors.good : isWhy ? colors.accent : colors.dim;
  return (
    <div
      style={{ ...card, ...span2, borderLeft: `3px solid ${accent}` }}
      data-widget-kind="StatusBadge"
      data-widget-id={widget.id}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          color: accent,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: isQuestion ? 18 : 15,
          marginTop: 6,
          color: colors.text,
          lineHeight: 1.55,
        }}
      >
        {text}
      </div>
    </div>
  );
};

const gaugeLabel: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
  gap: 3,
  paddingBottom: 12,
  pointerEvents: "none",
};
const th: CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  color: colors.dim,
  fontWeight: 600,
  borderBottom: `1px solid ${colors.cardBorder}`,
};
const td: CSSProperties = {
  padding: "8px",
  color: colors.text,
  borderBottom: `1px solid ${colors.cardBorder}`,
  verticalAlign: "middle",
};
