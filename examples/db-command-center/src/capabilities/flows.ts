import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { runDiagnosticsAgent } from "../agents/diagnosticsRunner";
import { fetchReplicaStatus, restartPool, scaleReplicas, sleep } from "../agents/tools";
import type { Diagnosis, RemediationAssessment } from "../domain";
import { progressHub } from "../runtime/progressHub";
import { llm } from "../runtime/services";

// ── Capability flows ──────────────────────────────────────────────────────────
//
// Each capability is a real, durable Loom flow. Read-only diagnosis/assessment
// flows run to completion; the mutating apply/scale flows pause at ctx.suspend
// for a human (or the risk policy) to approve, then resume from the durable
// event log — the framework's signature human-in-the-loop checkpoint.
//
// Long-running work is narrated with progressHub.report(ctx.executionId, …); the
// A2A bus / Orchestrator subscribe to surface those lines in near-real-time.

const report = (executionId: string, line: string): void => progressHub.report(executionId, line);

// ── diagnose-cpu ──────────────────────────────────────────────────────────────
const DiagnoseCpuStep = step$({
  id: "diagnose-cpu-step",
  name: "Diagnose CPU",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({
    target: z.string(),
    rootCause: z.string(),
    severity: z.string(),
    metrics: z.record(z.number()),
  }),
  handler: handler$(async (input: { target: string }, ctx) => {
    report(ctx.executionId, `Querying live metrics for ${input.target}…`);
    await sleep(500);
    // Genuine ReAct loop: the Diagnostics agent calls the db-metrics tool, then
    // reasons over the result (see agents/diagnosticsRunner.ts).
    const result = await runDiagnosticsAgent(input.target, ctx);
    report(
      ctx.executionId,
      `ReAct loop: ${result.toolCalls} tool call over ${result.iterations} iterations.`
    );
    report(
      ctx.executionId,
      `Metrics: CPU ${result.metrics.cpuPct}%, pool ${result.metrics.poolUsed}/${result.metrics.poolMax}.`
    );
    report(ctx.executionId, `Root cause: ${result.rootCause}`);
    const diagnosis: Diagnosis = {
      target: input.target,
      rootCause: result.rootCause,
      severity: "critical",
      metrics: {
        cpuPct: result.metrics.cpuPct,
        memPct: result.metrics.memPct,
        poolUsed: result.metrics.poolUsed,
        poolMax: result.metrics.poolMax,
      },
    };
    return diagnosis;
  }),
});

// ── diagnose-replica-lag ──────────────────────────────────────────────────────
const DiagnoseReplicaStep = step$({
  id: "diagnose-replica-step",
  name: "Diagnose Replica Lag",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({
    target: z.string(),
    rootCause: z.string(),
    severity: z.string(),
    metrics: z.record(z.number()),
  }),
  handler: handler$(async (input: { target: string }, ctx) => {
    report(ctx.executionId, `Sampling replica status for ${input.target}…`);
    await sleep(500);
    const status = fetchReplicaStatus(input.target);
    report(
      ctx.executionId,
      `Replicas: ${status.replicas}, lag ${status.lagMs}ms, WAL queue ${status.walQueue}.`
    );
    const narration = await llm.complete({
      system: "You are a database SRE narrator.",
      messages: [
        {
          role: "user",
          content: `Explain the read-replica lag on ${input.target} given lag ${status.lagMs}ms and WAL queue ${status.walQueue}.`,
        },
      ],
    });
    report(ctx.executionId, `Root cause: ${narration.content}`);
    const diagnosis: Diagnosis = {
      target: input.target,
      rootCause: narration.content,
      severity: "warning",
      metrics: {
        lagMs: status.lagMs,
        replicas: status.replicas,
        walQueue: status.walQueue,
        writeQps: status.writeQps,
      },
    };
    return diagnosis;
  }),
});

// ── assess-remediation ────────────────────────────────────────────────────────
// The Remediation agent weighs the risk of the proposed fix. Pool recycling is
// low risk (graceful, reversible); replica scaling touches capacity and is rated
// medium — which routes it to human approval.
const AssessStep = step$({
  id: "assess-remediation-step",
  name: "Assess Remediation",
  inputSchema: z.object({ target: z.string(), domain: z.string() }),
  outputSchema: z.object({
    action: z.string(),
    riskLevel: z.string(),
    rationale: z.string(),
  }),
  handler: handler$(async (input: { target: string; domain: string }, ctx) => {
    report(ctx.executionId, `Assessing remediation risk for the ${input.domain} incident…`);
    await sleep(450);
    const assessment: RemediationAssessment =
      input.domain === "replica"
        ? {
            action: "Scale read replicas +2",
            riskLevel: "medium",
            rationale:
              "Adds infrastructure and cost; reversible but affects capacity — recommend operator approval.",
          }
        : {
            action: "Recycle connection pool and raise ceiling",
            riskLevel: "low",
            rationale: "Graceful, in-place, and reversible — safe to auto-apply under policy.",
          };
    report(ctx.executionId, `Assessment: ${assessment.action} — risk ${assessment.riskLevel}.`);
    return assessment;
  }),
});

// ── apply-remediation (CPU) — durable HITL checkpoint ─────────────────────────
const RestartPoolStep = step$({
  id: "restart-pool-step",
  name: "Recycle Pool",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ applied: z.boolean(), summary: z.string(), newCpuPct: z.number() }),
  handler: handler$(async (input: { target: string }, ctx) => {
    await sleep(600);
    const res = restartPool(input.target);
    report(ctx.executionId, res.summary);
    return { applied: true, summary: res.summary, newCpuPct: res.newCpuPct };
  }),
});

// ── scale-read-replicas (replica) — durable HITL checkpoint ───────────────────
const ScaleReplicasStep = step$({
  id: "scale-replicas-step",
  name: "Scale Replicas",
  inputSchema: z.object({ target: z.string(), addReplicas: z.number() }),
  outputSchema: z.object({ applied: z.boolean(), summary: z.string(), newLagMs: z.number() }),
  handler: handler$(async (input: { target: string; addReplicas: number }, ctx) => {
    await sleep(700);
    const res = scaleReplicas(input.target, input.addReplicas);
    report(ctx.executionId, res.summary);
    return { applied: true, summary: res.summary, newLagMs: res.newLagMs };
  }),
});

// The resume payload delivered when ctx.suspend returns (operator or policy).
interface ApprovalDecision {
  approved: boolean;
  approvedBy: string;
}

// ── Flow assembly ─────────────────────────────────────────────────────────────

function diagnosisFlow(
  id: string,
  name: string,
  step: typeof DiagnoseCpuStep | typeof DiagnoseReplicaStep
): RegisteredFlow<{ target: string }, Diagnosis> {
  const runner: FlowRunner<{ target: string }, Diagnosis> = (ctx, input) =>
    ctx.run(step, { target: input.target }) as Promise<Diagnosis>;
  return {
    definition: flow$({
      id,
      name,
      version: "1.0.0",
      inputSchema: z.object({ target: z.string() }),
      outputSchema: z.object({
        target: z.string(),
        rootCause: z.string(),
        severity: z.enum(["info", "warning", "critical"]),
        metrics: z.record(z.number()),
      }),
      steps: [step],
    }),
    runner,
  };
}

export const DiagnoseCpuFlow = diagnosisFlow("diagnose-cpu", "Diagnose CPU", DiagnoseCpuStep);
export const DiagnoseReplicaFlow = diagnosisFlow(
  "diagnose-replica-lag",
  "Diagnose Replica Lag",
  DiagnoseReplicaStep
);

const assessRunner: FlowRunner<{ target: string; domain: string }, RemediationAssessment> = (
  ctx,
  input
) => ctx.run(AssessStep, input) as Promise<RemediationAssessment>;

export const AssessRemediationFlow: RegisteredFlow<
  { target: string; domain: string },
  RemediationAssessment
> = {
  definition: flow$({
    id: "assess-remediation",
    name: "Assess Remediation",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string(), domain: z.string() }),
    outputSchema: z.object({
      action: z.string(),
      riskLevel: z.enum(["low", "medium", "high"]),
      rationale: z.string(),
    }),
    steps: [AssessStep],
  }),
  runner: assessRunner,
};

// apply-remediation: suspend for approval, then recycle the pool.
const applyRemediationRunner: FlowRunner<
  { target: string },
  { applied: boolean; summary: string; newCpuPct?: number | undefined }
> = async (ctx, input) => {
  report(
    ctx.executionId,
    `Prepared: recycle connection pool on ${input.target}. Awaiting sign-off…`
  );
  const decision = (await ctx.suspend({
    on: "ApprovalGranted",
    correlationKey: input.target,
    timeout: 24 * 60 * 60 * 1000,
  })) as unknown as ApprovalDecision;
  if (!decision.approved) {
    report(ctx.executionId, `Remediation rejected by ${decision.approvedBy}.`);
    return { applied: false, summary: `Rejected by ${decision.approvedBy}.` };
  }
  report(ctx.executionId, `Approved by ${decision.approvedBy} — applying…`);
  return ctx.run(RestartPoolStep, { target: input.target });
};

export const ApplyRemediationFlow: RegisteredFlow<
  { target: string },
  { applied: boolean; summary: string; newCpuPct?: number | undefined }
> = {
  definition: flow$({
    id: "apply-remediation",
    name: "Apply Remediation",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string() }),
    outputSchema: z.object({
      applied: z.boolean(),
      summary: z.string(),
      newCpuPct: z.number().optional(),
    }),
    steps: [RestartPoolStep],
  }),
  runner: applyRemediationRunner,
};

// scale-read-replicas: suspend for approval, then scale.
const scaleReplicasRunner: FlowRunner<
  { target: string; addReplicas: number },
  { applied: boolean; summary: string; newLagMs?: number | undefined }
> = async (ctx, input) => {
  report(
    ctx.executionId,
    `Prepared: add ${input.addReplicas} read replica(s) to ${input.target}. Awaiting sign-off…`
  );
  const decision = (await ctx.suspend({
    on: "ApprovalGranted",
    correlationKey: input.target,
    timeout: 24 * 60 * 60 * 1000,
  })) as unknown as ApprovalDecision;
  if (!decision.approved) {
    report(ctx.executionId, `Scaling rejected by ${decision.approvedBy}.`);
    return { applied: false, summary: `Rejected by ${decision.approvedBy}.` };
  }
  report(ctx.executionId, `Approved by ${decision.approvedBy} — scaling…`);
  return ctx.run(ScaleReplicasStep, input);
};

export const ScaleReplicasFlow: RegisteredFlow<
  { target: string; addReplicas: number },
  { applied: boolean; summary: string; newLagMs?: number | undefined }
> = {
  definition: flow$({
    id: "scale-read-replicas",
    name: "Scale Read Replicas",
    version: "1.0.0",
    inputSchema: z.object({ target: z.string(), addReplicas: z.number() }),
    outputSchema: z.object({
      applied: z.boolean(),
      summary: z.string(),
      newLagMs: z.number().optional(),
    }),
    steps: [ScaleReplicasStep],
  }),
  runner: scaleReplicasRunner,
};
