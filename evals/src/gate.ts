import type { MetricRow } from "./scoreboard";

/** Metric name to measured value. */
export type Scores = Readonly<Record<string, number>>;
/** Metric name to the committed floor. A score below its floor fails the gate. */
export type Thresholds = Readonly<Record<string, number>>;

/**
 * The metrics whose score is below the committed floor, by name. A threshold with no score is ALSO a
 * failure (named with `(missing)`): a gate whose metric nothing computes would pass silently, which is the
 * vacuous-check pattern.
 */
export function failingMetrics(scores: Scores, thresholds: Thresholds): string[] {
  const out: string[] = [];
  for (const [name, floor] of Object.entries(thresholds)) {
    const v = scores[name];
    if (v === undefined) out.push(`${name} (missing)`);
    else if (v < floor) out.push(name);
  }
  return out;
}

/** Scoreboard rows for one `area/subject`: every score is gated iff it has a threshold. */
export function toRows(prefix: string, scores: Scores, thresholds: Thresholds): MetricRow[] {
  return Object.entries(scores).map(([name, value]) => ({
    key: `${prefix}/${name}`,
    value,
    gated: Object.hasOwn(thresholds, name),
  }));
}
