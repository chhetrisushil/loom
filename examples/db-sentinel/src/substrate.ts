// ── The telemetry substrate — OUTSIDE Loom by design (requirements P-4) ───────
//
// Collectors/rollup jobs live outside the framework; Loom's responsibility
// begins at the tool$ boundary where the sentinel READS aggregates. Here the
// substrate is a pure function of simulated time, so the whole year replays
// bit-identically under DST.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** 2026-01-01T00:00:00Z — the simulation epoch. */
export const SIM_START = Date.UTC(2026, 0, 1);

export interface OutageWindow {
  from: number;
  to: number;
}

export interface TelemetryRead {
  /** P-3 — staleness is a recorded, replayable outcome, never a hang. */
  stale: boolean;
  asOf: number;
  maxLagMs: number;
  rows: { relation: string; lagMs: number; detail: string }[];
}

/** Anomaly model: replication lag spikes on the 7th of every month (UTC). */
export function isAnomalyTime(t: number): boolean {
  return new Date(t).getUTCDate() === 7;
}

const ROWS = 120;
const PAD = "x".repeat(48);

/**
 * Deterministic pg_stat aggregate read at time `t`. Normal payloads are large
 * (over the claim-check inline cap — they belong in the content store);
 * outage-window reads return a small, honest stale marker instead of hanging.
 */
export function readPgStats(t: number, outages: readonly OutageWindow[]): TelemetryRead {
  const outage = outages.find((w) => t >= w.from && t < w.to);
  if (outage !== undefined) {
    return { stale: true, asOf: outage.from, maxLagMs: 0, rows: [] };
  }
  const maxLagMs = isAnomalyTime(t) ? 900 + (t % 7) : 40 + (t % 7);
  const rows = Array.from({ length: ROWS }, (_, i) => ({
    relation: `public.table_${i}`,
    lagMs: i === 0 ? maxLagMs : (i * 7 + (t % 13)) % 60,
    detail: PAD,
  }));
  return { stale: false, asOf: t, maxLagMs, rows };
}

/** The digest declared alongside the read tool (CC-2): the DETERMINISTIC projection. */
export function telemetryDigest(read: TelemetryRead): {
  stale: boolean;
  asOf: number;
  maxLagMs: number;
  sampleCount: number;
} {
  return {
    stale: read.stale,
    asOf: read.asOf,
    maxLagMs: read.maxLagMs,
    sampleCount: read.rows.length,
  };
}
