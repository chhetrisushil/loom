// ── The scoreboard (ADR 0131 D4.4) ────────────────────────────────────────────
//
// One run = one scoreboard: a flat map `area/subject/metric -> { value, gated }`. It is built to DIFF:
// keys sorted by code unit, values rounded to 4 decimal places, no timestamps, no absolute paths, no
// host facts. Two runs over the same code and data serialise to the same bytes (the determinism
// proof `pnpm eval` is checked with), and a reviewer reads a changed score as a one-line diff.

/** One measured number. `gated: false` is report-only (it never fails a run). */
export interface MetricRow {
  /** `area/subject/metric`, for example `toolSearch/bm25f/recall@5`. */
  readonly key: string;
  readonly value: number;
  readonly gated: boolean;
  /** A COST (steps, tool calls): a rise is the regression. Absent = higher is better (every S1 row). */
  readonly lowerIsBetter?: boolean;
}

export interface ScoreboardEntry {
  readonly value: number;
  readonly gated: boolean;
  /** Present (and `true`) only on a cost metric, so S1 rows serialise exactly as they always did. */
  readonly lowerIsBetter?: true;
}

export interface Scoreboard {
  readonly version: 1;
  readonly metrics: Readonly<Record<string, ScoreboardEntry>>;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Round to 4 decimal places (the precision the scoreboard stores). */
export const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

/** Build a scoreboard: sorted, rounded. A duplicate key or a non-finite value throws (never silently dropped). */
export function buildScoreboard(rows: readonly MetricRow[]): Scoreboard {
  const sorted = [...rows].sort((a, b) => byCodeUnit(a.key, b.key));
  const metrics: Record<string, ScoreboardEntry> = {};
  for (const r of sorted) {
    if (!Number.isFinite(r.value))
      throw new RangeError(`scoreboard: ${r.key} is not finite (${r.value})`);
    if (Object.hasOwn(metrics, r.key)) throw new Error(`scoreboard: duplicate metric ${r.key}`);
    metrics[r.key] = {
      value: round4(r.value),
      gated: r.gated,
      ...(r.lowerIsBetter === true && { lowerIsBetter: true as const }),
    };
  }
  return { version: 1, metrics };
}

/** The bytes written to `scoreboard.json`: stable, newline-terminated. */
export function serializeScoreboard(sb: Scoreboard): string {
  return `${JSON.stringify(sb, null, 2)}\n`;
}

export function parseScoreboard(text: string): Scoreboard {
  const raw = JSON.parse(text) as Scoreboard;
  if (raw.version !== 1 || typeof raw.metrics !== "object" || raw.metrics === null) {
    throw new Error("scoreboard: unrecognised file (expected version 1)");
  }
  return raw;
}

export type DeltaStatus = "regressed" | "improved" | "unchanged" | "new" | "not-run";

export interface MetricDelta {
  readonly key: string;
  readonly baseline: number | undefined;
  readonly current: number | undefined;
  /** `current - baseline`, rounded to 4 dp; undefined for `new` / `not-run`. */
  readonly delta: number | undefined;
  readonly status: DeltaStatus;
  readonly gated: boolean;
}

/**
 * Compare a run to a committed baseline, metric by metric.
 *
 * - `regressed`: the value fell, or ROSE for a `lowerIsBetter` cost metric (both sides are already rounded to 4 dp, so any fall is real).
 * - `new`: measured now, absent from the baseline (a reviewer adds it with `eval:update-baseline`).
 * - `not-run`: in the baseline, absent from this run, for example the Postgres leg on a machine with no
 *   database. It is REPORTED, never silently equal; it is not a regression because nothing was measured.
 */
export function compareAgainstBaseline(current: Scoreboard, baseline: Scoreboard): MetricDelta[] {
  const keys = [
    ...new Set([...Object.keys(current.metrics), ...Object.keys(baseline.metrics)]),
  ].sort(byCodeUnit);
  return keys.map((key): MetricDelta => {
    const c = current.metrics[key];
    const b = baseline.metrics[key];
    const gated = (c ?? b)?.gated ?? false;
    if (c === undefined) {
      return {
        key,
        baseline: (b as ScoreboardEntry).value,
        current: undefined,
        delta: undefined,
        status: "not-run",
        gated,
      };
    }
    if (b === undefined) {
      return { key, baseline: undefined, current: c.value, delta: undefined, status: "new", gated };
    }
    const delta = round4(c.value - b.value);
    // A cost metric regresses when it RISES.
    const worse = c.lowerIsBetter === true || b.lowerIsBetter === true ? delta > 0 : delta < 0;
    const better = c.lowerIsBetter === true || b.lowerIsBetter === true ? delta < 0 : delta > 0;
    const status: DeltaStatus = worse ? "regressed" : better ? "improved" : "unchanged";
    return { key, baseline: b.value, current: c.value, delta, status, gated };
  });
}

/** Gated metrics that regressed: the only deltas that fail `pnpm eval`. */
export const regressions = (deltas: readonly MetricDelta[]): MetricDelta[] =>
  deltas.filter((d) => d.status === "regressed" && d.gated);

const fmt = (n: number | undefined): string => (n === undefined ? "-" : n.toFixed(4));
const sign = (n: number | undefined): string =>
  n === undefined ? "-" : `${n > 0 ? "+" : ""}${n.toFixed(4)}`;

/** The human summary written to `scoreboard.md` (same determinism rules as the JSON). */
export function renderScoreboardMarkdown(sb: Scoreboard): string {
  const lines = [
    "# Loom evals scoreboard",
    "",
    "| metric | value | gated |",
    "| --- | ---: | :---: |",
  ];
  for (const [key, e] of Object.entries(sb.metrics)) {
    lines.push(`| \`${key}\` | ${fmt(e.value)} | ${e.gated ? "yes" : "no"} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** A delta table for the console / PR: only rows that are not `unchanged`. */
export function renderDeltas(deltas: readonly MetricDelta[]): string {
  const changed = deltas.filter((d) => d.status !== "unchanged");
  if (changed.length === 0) return "No change against the baseline.\n";
  const lines = [
    "| metric | baseline | current | delta | status |",
    "| --- | ---: | ---: | ---: | --- |",
  ];
  for (const d of changed) {
    lines.push(
      `| \`${d.key}\` | ${fmt(d.baseline)} | ${fmt(d.current)} | ${sign(d.delta)} | ${d.status} |`
    );
  }
  return `${lines.join("\n")}\n`;
}
