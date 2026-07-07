import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

// A small, durable "index rebuild" flow — the unit of work we run on every compute
// backend. Deterministic + offline. Two variants:
//   • rebuild-index        — runs to completion (used for the 3-backend equivalence)
//   • rebuild-index-gated  — suspends for approval (used for suspend/resume over HTTP)

const tableInput = z.object({ table: z.string() });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// bloat is a deterministic function of the table name, so results are stable.
function bloatOf(table: string): number {
  let h = 0;
  for (const ch of table) h = (h + ch.charCodeAt(0)) % 60;
  return 20 + h; // 20–79 %
}

const analyzeStep = step$({
  id: "analyze-index",
  name: "Analyze index",
  inputSchema: tableInput,
  outputSchema: z.object({ table: z.string(), bloatPct: z.number(), rows: z.number() }),
  handler: handler$(async (input: { table: string }) => {
    await sleep(5);
    return { table: input.table, bloatPct: bloatOf(input.table), rows: 1_200_000 };
  }),
});

const rebuildStep = step$({
  id: "rebuild-index-step",
  name: "Rebuild index",
  inputSchema: z.object({ table: z.string(), bloatPct: z.number() }),
  outputSchema: z.object({ table: z.string(), rebuilt: z.boolean(), reclaimedMb: z.number() }),
  handler: handler$(async (input: { table: string; bloatPct: number }) => {
    await sleep(5);
    return { table: input.table, rebuilt: true, reclaimedMb: Math.round(input.bloatPct * 3) };
  }),
});

export interface RebuildInput {
  table: string;
}
export interface RebuildOutput {
  table: string;
  bloatPct: number;
  reclaimedMb: number;
  rebuilt: boolean;
  approvedBy?: string;
}

const rebuildRunner: FlowRunner<RebuildInput, RebuildOutput> = async (ctx, input) => {
  const analysis = (await ctx.run(analyzeStep, input)) as { bloatPct: number };
  const result = (await ctx.run(rebuildStep, {
    table: input.table,
    bloatPct: analysis.bloatPct,
  })) as {
    rebuilt: boolean;
    reclaimedMb: number;
  };
  return { table: input.table, bloatPct: analysis.bloatPct, ...result };
};

export const RebuildIndexFlow = {
  definition: flow$({
    id: "rebuild-index",
    name: "Rebuild Index",
    version: "1.0.0",
    inputSchema: tableInput,
    outputSchema: z.object({}),
    steps: [analyzeStep, rebuildStep],
  }),
  runner: rebuildRunner,
} as RegisteredFlow;

const gatedRunner: FlowRunner<RebuildInput, RebuildOutput> = async (ctx, input) => {
  const analysis = (await ctx.run(analyzeStep, input)) as { bloatPct: number };
  // Durable checkpoint — the stateless worker suspends here and can resume on ANY
  // backend from the shared log (the point of compute pluggability).
  const decision = (await ctx.suspend({
    on: "ApprovalGranted",
    correlationKey: input.table,
    timeout: 24 * 60 * 60 * 1000,
  })) as { approved: boolean; approvedBy: string };
  if (!decision.approved) {
    return {
      table: input.table,
      bloatPct: analysis.bloatPct,
      reclaimedMb: 0,
      rebuilt: false,
      approvedBy: decision.approvedBy,
    };
  }
  const result = (await ctx.run(rebuildStep, {
    table: input.table,
    bloatPct: analysis.bloatPct,
  })) as {
    rebuilt: boolean;
    reclaimedMb: number;
  };
  return {
    table: input.table,
    bloatPct: analysis.bloatPct,
    ...result,
    approvedBy: decision.approvedBy,
  };
};

export const RebuildIndexGatedFlow = {
  definition: flow$({
    id: "rebuild-index-gated",
    name: "Rebuild Index (gated)",
    version: "1.0.0",
    inputSchema: tableInput,
    outputSchema: z.object({}),
    steps: [analyzeStep, rebuildStep],
  }),
  runner: gatedRunner,
} as RegisteredFlow;
