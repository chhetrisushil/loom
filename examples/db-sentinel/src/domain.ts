import { z } from "zod";

// ── The copilot's domain vocabulary — deliberately NOT kernel concepts ────────
//
// Findings are application domain events (ADR 0051 D4): emitted via ctx.emit
// with an app-owned schema, durable in the log, always inline (evidence goes by
// reference). The kernel never learns what a "finding" is.

export const FINDING_RECORDED = "FINDING_RECORDED";

export const findingSchema = z.object({
  category: z.literal("replication-lag"),
  severity: z.enum(["low", "high"]),
  confidence: z.number().min(0).max(1),
  target: z.object({ database: z.string(), metric: z.string() }),
  /** Claim-check refs citing the raw telemetry the conclusion rests on (TS-3: hash-verifiable). */
  evidence: z.array(z.object({ __loomContent: z.string() })),
  /** The deterministic projection the sentinel branched on — inline, replayable. */
  observed: z.object({ maxLagMs: z.number(), asOf: z.number() }),
  actingVersion: z.number().int().positive(),
});
export type Finding = z.infer<typeof findingSchema>;

// ── Carry-state contracts (DS-2/DS-3) — three versions to exercise migration ──

export const sentinelStateV1 = z.object({
  baselineLagMs: z.number(),
  wakes: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
});
export type SentinelStateV1 = z.infer<typeof sentinelStateV1>;

export const sentinelStateV2 = sentinelStateV1.extend({
  anomalyStreak: z.number().int().nonnegative(),
});
export type SentinelStateV2 = z.infer<typeof sentinelStateV2>;

export const sentinelStateV3 = sentinelStateV2.extend({
  lastFindingAt: z.number().nullable(),
});
export type SentinelStateV3 = z.infer<typeof sentinelStateV3>;

/** v(n) → v(n+1) payload transforms, registered with the durable-state contract. */
export const migrations = {
  1: (old: unknown): unknown => ({ ...(old as SentinelStateV1), anomalyStreak: 0 }),
  2: (old: unknown): unknown => ({ ...(old as SentinelStateV2), lastFindingAt: null }),
} as const;

export const sentinelInputSchema = z.object({
  thresholdLagMs: z.number().positive().default(500),
});
export type SentinelInput = z.infer<typeof sentinelInputSchema>;

export const sentinelOutputSchema = z.object({
  wake: z.number(),
  finding: z.boolean(),
  stale: z.boolean(),
});
export type SentinelOutput = z.infer<typeof sentinelOutputSchema>;
