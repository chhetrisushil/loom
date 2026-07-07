import { progressHub } from "@loom/app";
import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { auditDeps, checkPerf, deriveScope, scanSecurity, sleep } from "../agents/tools";
import type {
  AuditPlan,
  DepsResult,
  PerfResult,
  RiskLevel,
  ScopeResult,
  SecurityResult,
  SignoffResult,
} from "../domain";

// Each capability is a real, durable Loom flow. The `record-plan` flow records the
// composed plan into the event log; the read-only audits run to completion; the
// mutating `signoff-release` pauses at ctx.suspend for a human (or the risk policy)
// and resumes from the durable log — the framework's human-in-the-loop checkpoint.
//
// Convention: capabilityId === flow.definition.id, so an executeGraph node's
// `flowId` is just the capability id and bus routing is trivial.

const report = (executionId: string, line: string): void => progressHub.report(executionId, line);

// ── Schemas ───────────────────────────────────────────────────────────────────
const planSchema = z.object({
  goal: z.string(),
  service: z.string(),
  release: z.string(),
  steps: z.array(
    z.object({ capabilityId: z.string(), agentId: z.string(), rationale: z.string().optional() })
  ),
});
const svcRel = z.object({ service: z.string(), release: z.string() });
const withScope = z.object({
  service: z.string(),
  release: z.string(),
  scope: z.object({
    service: z.string(),
    release: z.string(),
    changedFiles: z.number(),
    surfaces: z.array(z.string()),
    summary: z.string(),
  }),
});

// ── record-plan — GAP-CLOSER #1: durably record the composed plan ─────────────
// The plan rides EXECUTION_STARTED.input (automatic backstop) AND is re-emitted as
// a self-describing PLAN_COMPOSED event, so "which agents were wired to solve this
// goal" is auditable/replayable in the log — not ephemeral conductor state.
const recordPlanRunner: FlowRunner<AuditPlan, AuditPlan> = async (ctx, input) => {
  ctx.emit("PLAN_COMPOSED", input);
  report(ctx.executionId, `Plan recorded: ${input.steps.map((s) => s.capabilityId).join(" → ")}`);
  return input;
};
export const RecordPlanFlow = {
  definition: flow$({
    id: "record-plan",
    name: "Record Plan",
    version: "1.0.0",
    inputSchema: planSchema,
    outputSchema: planSchema,
    steps: [],
  }),
  runner: recordPlanRunner,
} as RegisteredFlow;

// ── scope-audit ───────────────────────────────────────────────────────────────
const scopeStep = step$({
  id: "scope-step",
  name: "Scope",
  inputSchema: svcRel,
  outputSchema: z.object({}),
  handler: handler$(async (input: { service: string; release: string }, ctx) => {
    report(ctx.executionId, `Scoping ${input.service} @ ${input.release}…`);
    await sleep(10);
    return deriveScope(input.service, input.release) as unknown as Record<string, never>;
  }),
});
const scopeRunner: FlowRunner<{ service: string; release: string }, ScopeResult> = (ctx, input) =>
  ctx.run(scopeStep, input) as Promise<ScopeResult>;
export const ScopeAuditFlow = {
  definition: flow$({
    id: "scope-audit",
    name: "Scope Audit",
    version: "1.0.0",
    inputSchema: svcRel,
    outputSchema: z.object({}),
    steps: [scopeStep],
  }),
  runner: scopeRunner,
} as RegisteredFlow;

// ── security-audit / perf-audit / deps-audit (run in parallel via executeGraph) ─
const securityStep = step$({
  id: "security-step",
  name: "Security Scan",
  inputSchema: withScope,
  outputSchema: z.object({}),
  handler: handler$(async (input: { service: string }, ctx) => {
    report(ctx.executionId, `Scanning ${input.service} for vulnerabilities…`);
    await sleep(10);
    return scanSecurity(input.service) as unknown as Record<string, never>;
  }),
});
type AuditIn = z.infer<typeof withScope>;
const securityRunner: FlowRunner<AuditIn, SecurityResult> = (ctx, input) =>
  ctx.run(securityStep, input) as Promise<SecurityResult>;
export const SecurityAuditFlow = {
  definition: flow$({
    id: "security-audit",
    name: "Security Audit",
    version: "1.0.0",
    inputSchema: withScope,
    outputSchema: z.object({}),
    steps: [securityStep],
  }),
  runner: securityRunner,
} as RegisteredFlow;

const perfStep = step$({
  id: "perf-step",
  name: "Perf Check",
  inputSchema: withScope,
  outputSchema: z.object({}),
  handler: handler$(async (input: { service: string }, ctx) => {
    report(ctx.executionId, `Measuring performance for ${input.service}…`);
    await sleep(10);
    return checkPerf(input.service) as unknown as Record<string, never>;
  }),
});
const perfRunner: FlowRunner<AuditIn, PerfResult> = (ctx, input) =>
  ctx.run(perfStep, input) as Promise<PerfResult>;
export const PerfAuditFlow = {
  definition: flow$({
    id: "perf-audit",
    name: "Perf Audit",
    version: "1.0.0",
    inputSchema: withScope,
    outputSchema: z.object({}),
    steps: [perfStep],
  }),
  runner: perfRunner,
} as RegisteredFlow;

const depsStep = step$({
  id: "deps-step",
  name: "Deps Audit",
  inputSchema: withScope,
  outputSchema: z.object({}),
  handler: handler$(async (input: { service: string }, ctx) => {
    report(ctx.executionId, `Auditing dependencies for ${input.service}…`);
    await sleep(10);
    return auditDeps(input.service) as unknown as Record<string, never>;
  }),
});
const depsRunner: FlowRunner<AuditIn, DepsResult> = (ctx, input) =>
  ctx.run(depsStep, input) as Promise<DepsResult>;
export const DepsAuditFlow = {
  definition: flow$({
    id: "deps-audit",
    name: "Deps Audit",
    version: "1.0.0",
    inputSchema: withScope,
    outputSchema: z.object({}),
    steps: [depsStep],
  }),
  runner: depsRunner,
} as RegisteredFlow;

// ── signoff-release — durable human-in-the-loop gate ──────────────────────────
const signoffInput = z.object({
  service: z.string(),
  release: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  rationale: z.string(),
});
const signoffRunner: FlowRunner<
  { service: string; release: string; risk: RiskLevel; rationale: string },
  SignoffResult
> = async (ctx, input) => {
  report(
    ctx.executionId,
    `Sign-off requested for ${input.service} @ ${input.release} (risk: ${input.risk}).`
  );

  // Durable checkpoint: the flow persists and hands control back until resumed.
  const decision = (await ctx.suspend({
    on: "ApprovalGranted",
    correlationKey: `${input.service}@${input.release}`,
    timeout: 24 * 60 * 60 * 1000,
  })) as { approved: boolean; approvedBy: string };

  if (!decision.approved) {
    report(ctx.executionId, `Release blocked by ${decision.approvedBy}.`);
    return {
      signedOff: false,
      risk: input.risk,
      approvedBy: decision.approvedBy,
      summary: "blocked",
    };
  }
  report(ctx.executionId, `Signed off by ${decision.approvedBy} — release approved.`);
  return {
    signedOff: true,
    risk: input.risk,
    approvedBy: decision.approvedBy,
    summary: "approved",
  };
};
export const SignoffReleaseFlow = {
  definition: flow$({
    id: "signoff-release",
    name: "Sign off Release",
    version: "1.0.0",
    inputSchema: signoffInput,
    outputSchema: z.object({}),
    steps: [],
  }),
  runner: signoffRunner,
} as RegisteredFlow;
