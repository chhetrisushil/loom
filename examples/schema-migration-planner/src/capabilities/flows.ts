import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { runSchemaInspectorAgent } from "../agents/diagnosticsRunner";
import { inspectTable, runMigration, sleep } from "../agents/tools";
import type { Diagnosis, MigrationAssessment } from "../domain";
import { progressHub } from "../runtime/progressHub";
import {
  type MigrationDecision,
  type StrategyId,
  type StrategyOutcome,
  projectOutcome,
} from "../warroom/strategies";

// ── Capability flows ──────────────────────────────────────────────────────────
//
// Each capability is a real, durable Loom flow. Read-only diagnose/assess flows
// run to completion; the mutating apply/execute flows pause at ctx.suspend for a
// human (or the risk policy) to approve, then resume from the durable event log —
// the framework's signature human-in-the-loop checkpoint.
//
// Long-running work is narrated with progressHub.report(ctx.executionId, …); a
// backfill's numeric progress is streamed with progressHub.reportProgress(…). The
// A2A bus / Orchestrator / BranchOrchestrator subscribe to surface both live.

const report = (executionId: string, line: string): void => progressHub.report(executionId, line);

// ── diagnose-schema (ReAct: inspect the target table) ─────────────────────────
const DiagnoseSchemaStep = step$({
  id: "diagnose-schema-step",
  name: "Diagnose Schema",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({
    target: z.string(),
    rootCause: z.string(),
    severity: z.string(),
    metrics: z.record(z.number()),
  }),
  handler: handler$(async (input: { target: string }, ctx) => {
    report(ctx.executionId, `Inspecting table ${input.target}…`);
    await sleep(500);
    // Genuine ReAct loop: the Schema Inspector agent calls the inspect-table tool,
    // then reasons over the result (see agents/diagnosticsRunner.ts).
    const result = await runSchemaInspectorAgent(input.target, ctx);
    report(
      ctx.executionId,
      `ReAct loop: ${result.toolCalls} tool call over ${result.iterations} iterations.`
    );
    report(
      ctx.executionId,
      `Table: ${(result.stats.rowCount / 1_000_000).toFixed(0)}M rows, ${result.stats.sizeGb} GB, ` +
        `${result.stats.indexes} indexes, ${result.stats.writeQps} writes/s.`
    );
    report(ctx.executionId, `Analysis: ${result.summary}`);
    const diagnosis: Diagnosis = {
      target: input.target,
      rootCause: result.summary,
      severity: "warning",
      metrics: {
        rowCount: result.stats.rowCount,
        sizeGb: result.stats.sizeGb,
        indexes: result.stats.indexes,
        fkConstraints: result.stats.fkConstraints,
        writeQps: result.stats.writeQps,
      },
    };
    return diagnosis;
  }),
});

const DiagnoseSchemaRunner: FlowRunner<{ target: string }, Diagnosis> = (ctx, input) =>
  ctx.run(DiagnoseSchemaStep, { target: input.target }) as Promise<Diagnosis>;

export const DiagnoseSchemaFlow: RegisteredFlow<{ target: string }, Diagnosis> = {
  definition: flow$({
    id: "diagnose-schema",
    name: "Diagnose Schema",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string() }),
    outputSchema: z.object({
      target: z.string(),
      rootCause: z.string(),
      severity: z.enum(["info", "warning", "critical"]),
      metrics: z.record(z.number()),
    }),
    steps: [DiagnoseSchemaStep],
  }),
  runner: DiagnoseSchemaRunner,
};

// ── assess-migration ──────────────────────────────────────────────────────────
// The Risk Assessor weighs the schema change. A nullable, metadata-only column is
// low risk (auto-apply); a NOT NULL backfill over a huge table is high risk with
// several viable strategies — which routes it to the branch-and-promote board.
const AssessStep = step$({
  id: "assess-migration-step",
  name: "Assess Migration",
  inputSchema: z.object({ target: z.string(), complex: z.boolean() }),
  outputSchema: z.object({
    action: z.string(),
    riskLevel: z.string(),
    rationale: z.string(),
  }),
  handler: handler$(async (input: { target: string; complex: boolean }, ctx) => {
    report(ctx.executionId, `Assessing migration risk on ${input.target}…`);
    await sleep(450);
    const assessment: MigrationAssessment = input.complex
      ? {
          action: "Backfill NOT NULL column (choose a strategy)",
          riskLevel: "high",
          rationale:
            "40M-row rewrite under active writes; multiple viable strategies with different lock/duration/reversibility — compare and pick one.",
        }
      : {
          action: "Add nullable column (metadata-only)",
          riskLevel: "low",
          rationale: "No table rewrite, no backfill, sub-second — safe to auto-apply under policy.",
        };
    report(ctx.executionId, `Assessment: ${assessment.action} — risk ${assessment.riskLevel}.`);
    return assessment;
  }),
});

const assessRunner: FlowRunner<{ target: string; complex: boolean }, MigrationAssessment> = (
  ctx,
  input
) => ctx.run(AssessStep, input) as Promise<MigrationAssessment>;

export const AssessMigrationFlow: RegisteredFlow<
  { target: string; complex: boolean },
  MigrationAssessment
> = {
  definition: flow$({
    id: "assess-migration",
    name: "Assess Migration",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string(), complex: z.boolean() }),
    outputSchema: z.object({
      action: z.string(),
      riskLevel: z.enum(["low", "medium", "high"]),
      rationale: z.string(),
    }),
    steps: [AssessStep],
  }),
  runner: assessRunner,
};

// The resume payload delivered when a simple apply's ctx.suspend returns.
interface ApprovalDecision {
  approved: boolean;
  approvedBy: string;
}

// ── apply-migration (simple, metadata-only) — durable HITL checkpoint ─────────
const ApplyMigrationStep = step$({
  id: "apply-migration-step",
  name: "Apply Migration",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ applied: z.boolean(), summary: z.string(), lockSeconds: z.number() }),
  handler: handler$(async (input: { target: string }, ctx) => {
    await sleep(600);
    const res = runMigration(input.target);
    report(ctx.executionId, res.summary);
    return { applied: true, summary: res.summary, lockSeconds: res.lockSeconds };
  }),
});

const applyMigrationRunner: FlowRunner<
  { target: string },
  { applied: boolean; summary: string; lockSeconds?: number | undefined }
> = async (ctx, input) => {
  report(ctx.executionId, `Prepared: add nullable column on ${input.target}. Awaiting sign-off…`);
  const decision = (await ctx.suspend({
    on: "ApprovalGranted",
    correlationKey: input.target,
    timeout: 24 * 60 * 60 * 1000,
  })) as unknown as ApprovalDecision;
  if (!decision.approved) {
    report(ctx.executionId, `Migration rejected by ${decision.approvedBy}.`);
    return { applied: false, summary: `Rejected by ${decision.approvedBy}.` };
  }
  report(ctx.executionId, `Approved by ${decision.approvedBy} — applying…`);
  return ctx.run(ApplyMigrationStep, { target: input.target });
};

export const ApplyMigrationFlow: RegisteredFlow<
  { target: string },
  { applied: boolean; summary: string; lockSeconds?: number | undefined }
> = {
  definition: flow$({
    id: "apply-migration",
    name: "Apply Migration",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string() }),
    outputSchema: z.object({
      applied: z.boolean(),
      summary: z.string(),
      lockSeconds: z.number().optional(),
    }),
    steps: [ApplyMigrationStep],
  }),
  runner: applyMigrationRunner,
};

// ── plan-migration — the capability the planner emits for a complex migration ──
// The Orchestrator intercepts this step and hands it to the Migration Board
// (branch/simulate/promote), so this flow is never actually dispatched; it exists
// so the capability catalog has a backing flow. Kept trivial and valid.
const planMigrationRunner: FlowRunner<{ target: string }, { applied: boolean; summary: string }> = (
  ctx,
  input
) => {
  report(ctx.executionId, `Planning migration on ${input.target} via the Migration Board…`);
  return Promise.resolve({
    applied: false,
    summary: "Planned via the Migration Board (branch, simulate, promote).",
  });
};

export const PlanMigrationFlow: RegisteredFlow<
  { target: string },
  { applied: boolean; summary: string }
> = {
  definition: flow$({
    id: "plan-migration",
    name: "Plan Migration",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string() }),
    outputSchema: z.object({ applied: z.boolean(), summary: z.string() }),
    steps: [],
  }),
  runner: planMigrationRunner,
};

// ── execute-migration — the branchable durable flow ───────────────────────────
//
// This is the flow the Migration Board forks. It runs to a single durable gate
// (ctx.suspend) that carries no strategy of its own: the *decision* delivered on
// resume names which mutually-exclusive strategy this execution is running, and
// whether it is a dry-run simulation (against a shadow schema) or the real apply.
//
// That shape is what makes the gate forkable: fork the suspended execution N times
// and resume each child with a different MigrationDecision, and each branch runs
// its own strategy from the identical pre-gate prefix — copy-on-write branching.
// In simulate mode the step streams live backfill progress so the operator watches
// several shadow-migrations advance at once.

const TARGET_ROWS = 40_000_000;
const PROGRESS_TICKS = 5;

const MigrationStep = step$({
  id: "migration-step",
  name: "Run Migration",
  inputSchema: z.object({
    target: z.string(),
    strategy: z.enum(["online-ddl", "shadow-copy", "dual-write"]),
    simulate: z.boolean(),
  }),
  outputSchema: z.object({
    strategy: z.string(),
    label: z.string(),
    simulated: z.boolean(),
    applied: z.boolean(),
    risk: z.string(),
    lockSeconds: z.number(),
    durationMinutes: z.number(),
    rowsCopied: z.number(),
    rollbackable: z.boolean(),
    summary: z.string(),
  }),
  handler: handler$(
    async (input: { target: string; strategy: StrategyId; simulate: boolean }, ctx) => {
      report(
        ctx.executionId,
        `${input.simulate ? "Simulating" : "Applying"} "${input.strategy}" on ${input.target} ` +
          `(${input.simulate ? "shadow schema" : "live"})…`
      );
      const rowCount = inspectTable(input.target).rowCount ?? TARGET_ROWS;
      // Stream live backfill progress — this is what fills the branch's progress
      // bar while several strategies simulate concurrently.
      for (let i = 1; i <= PROGRESS_TICKS; i++) {
        await sleep(input.simulate ? 140 : 220);
        progressHub.reportProgress(ctx.executionId, Math.round((i / PROGRESS_TICKS) * 100));
      }
      const outcome = projectOutcome(input.strategy, input.simulate, input.target, rowCount);
      report(ctx.executionId, outcome.summary);
      return outcome;
    }
  ),
});

// The flow's declared output is the common `{applied, summary}` shape; the real
// runtime value stored in `_output` is the full StrategyOutcome the step returns
// (the runtime stores the runner's return verbatim), which the BranchOrchestrator
// reads back.
type MigrationResult = { applied: boolean; summary: string };

const migrationExecutionRunner: FlowRunner<{ target: string }, MigrationResult> = async (
  ctx,
  input
) => {
  report(
    ctx.executionId,
    `Prepared migration for ${input.target}. Awaiting a strategy decision at the gate…`
  );
  const decision = (await ctx.suspend({
    on: "MigrationDecision",
    correlationKey: input.target,
    timeout: 24 * 60 * 60 * 1000,
  })) as unknown as MigrationDecision;
  if (!decision.approved) {
    report(ctx.executionId, `Migration abandoned by ${decision.approvedBy}.`);
    return { applied: false, summary: `Abandoned by ${decision.approvedBy}.` };
  }
  return ctx.run(MigrationStep, {
    target: input.target,
    strategy: decision.strategy,
    simulate: decision.simulate,
  }) as Promise<StrategyOutcome>;
};

export const MigrationExecutionFlow: RegisteredFlow<{ target: string }, MigrationResult> = {
  definition: flow$({
    id: "execute-migration",
    name: "Execute Migration",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string() }),
    outputSchema: z.object({
      applied: z.boolean(),
      summary: z.string(),
    }),
    steps: [MigrationStep],
  }),
  runner: migrationExecutionRunner,
};
