import { tool$ } from "@loom/core";
import { z } from "zod";

// ── Mock schema-migration tools ───────────────────────────────────────────────
//
// The concrete effects a domain agent can call. In production these would be an
// information_schema query, a gh-ost/pt-osc dry-run, a migration runner, etc.;
// here they return deterministic data so the demo is fully offline. Each is a
// tool$ definition (so it can be attached to an agent$ and offered to the model)
// plus a plain implementation the EffectRuntime runs.

export const InspectTableTool = tool$({
  id: "inspect-table",
  name: "Inspect Table",
  description: "Fetch row count, size, indexes, FK constraints and write load for a target table",
  kind: "tool",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({
    rowCount: z.number(),
    sizeGb: z.number(),
    indexes: z.number(),
    fkConstraints: z.number(),
    writeQps: z.number(),
  }),
});

export const EstimateMigrationTool = tool$({
  id: "estimate-migration",
  name: "Estimate Migration",
  description: "Estimate the risk and blast radius of a proposed schema change on a target table",
  kind: "tool",
  inputSchema: z.object({ target: z.string(), complex: z.boolean() }),
  outputSchema: z.object({ summary: z.string(), riskLevel: z.string() }),
});

export const RunMigrationTool = tool$({
  id: "run-migration",
  name: "Run Migration",
  description: "Execute a schema migration on a target table and report the realized cost",
  kind: "tool",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ summary: z.string(), lockSeconds: z.number() }),
});

// ── Implementations ───────────────────────────────────────────────────────────
// Deterministic mock data. The headline number is the target table's row count —
// a large, actively-written table is what makes the migration decision hard.

export function inspectTable(_target: string): {
  rowCount: number;
  sizeGb: number;
  indexes: number;
  fkConstraints: number;
  writeQps: number;
} {
  return { rowCount: 40_000_000, sizeGb: 48, indexes: 3, fkConstraints: 2, writeQps: 1200 };
}

export function estimateMigration(
  _target: string,
  complex: boolean
): { summary: string; riskLevel: string } {
  return complex
    ? {
        summary:
          "Backfilling a NOT NULL column over 40M rows under active writes — a naive blocking ALTER would lock writes for ~7 min. Multiple viable strategies with different lock/duration/reversibility trade-offs; operator decision recommended.",
        riskLevel: "high",
      }
    : {
        summary:
          "Adding a nullable column is a metadata-only change: no table rewrite, no backfill, sub-second. Safe to auto-apply under policy.",
        riskLevel: "low",
      };
}

export function runMigration(target: string): { summary: string; lockSeconds: number } {
  return {
    summary: `Added the nullable column to ${target} (metadata-only, <1s, no rewrite).`,
    lockSeconds: 0,
  };
}

// A small delay used to simulate genuinely long-running agent work.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
