import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

// ── Schemas ───────────────────────────────────────────────────────────────────
const ReleaseInput = z.object({
  service: z.string(),
  changeType: z.enum(["config", "hotfix", "schema"]),
});
const ReleaseOutput = z.object({
  released: z.boolean(),
  risk: z.enum(["low", "medium", "high"]),
  approvedBy: z.string().optional(),
});
type In = z.infer<typeof ReleaseInput>;
type Out = z.infer<typeof ReleaseOutput>;

// A deterministic risk model — the kind of pure logic that lives in a step.
const RISK = { config: "low", hotfix: "medium", schema: "high" } as const;

// ── Steps (co-located handlers → auto-registered as effects) ──────────────────
const assessStep = step$({
  id: "assess",
  name: "Assess risk",
  inputSchema: ReleaseInput,
  outputSchema: z.object({ level: z.enum(["low", "medium", "high"]), rationale: z.string() }),
  handler: handler$(async (input: In) => {
    const level = RISK[input.changeType];
    return { level, rationale: `${input.changeType} change on ${input.service} → ${level} risk` };
  }),
});

const notifyStep = step$({
  id: "notify",
  name: "Notify approver",
  inputSchema: z.object({ service: z.string(), level: z.string() }),
  outputSchema: z.object({ notified: z.boolean() }),
  handler: handler$(async (input: { service: string; level: string }, ctx) => {
    ctx.emit("approver_notified", { service: input.service, level: input.level });
    return { notified: true };
  }),
  retry: { maxAttempts: 3 }, // per-step retry policy (see also effect middleware in src/config.ts)
});

const applyStep = step$({
  id: "apply",
  name: "Apply release",
  inputSchema: z.object({ service: z.string() }),
  outputSchema: z.object({ applied: z.boolean() }),
  handler: handler$(async (input: { service: string }) => ({ applied: true })),
});

// ── Runner: plain async orchestration ─────────────────────────────────────────
const runner: FlowRunner<In, Out> = async (ctx, input) => {
  ctx.ui.set("phase", "assessing");
  const risk = await ctx.run(assessStep, input);
  ctx.ui.merge("assessment", {
    service: input.service,
    level: risk.level,
    rationale: risk.rationale,
  });

  // Low-risk changes ship without a gate; everything else pauses for a human.
  if (risk.level === "low") {
    ctx.ui.set("phase", "applying");
    await ctx.run(applyStep, { service: input.service });
    ctx.ui.set("phase", "released");
    return { released: true, risk: risk.level };
  }

  await ctx.run(notifyStep, { service: input.service, level: risk.level });
  ctx.ui.set("phase", "awaiting-approval");

  // Durable checkpoint — persists, hands control back to the caller until resumed.
  const decision = (await ctx.suspend({
    on: "ApprovalGranted",
    correlationKey: input.service,
    timeout: 24 * 60 * 60 * 1000,
  })) as { approved: boolean; approvedBy: string };

  if (!decision.approved) {
    ctx.ui.set("phase", "rejected");
    return { released: false, risk: risk.level, approvedBy: decision.approvedBy };
  }

  ctx.ui.set("phase", "applying");
  await ctx.run(applyStep, { service: input.service });
  ctx.ui.set("phase", "released");
  return { released: true, risk: risk.level, approvedBy: decision.approvedBy };
};

// Exported as a bare `RegisteredFlow`: a runner's input is contravariant, and the
// Zod enum makes the parameterized type reject at `runtime.start` call sites. The
// runtime treats every flow uniformly, so this is the idiomatic shape to export.
export const releaseApprovalFlow = {
  definition: flow$({
    id: "release-approval",
    name: "Release Approval",
    version: "1.0.0",
    inputSchema: ReleaseInput,
    outputSchema: ReleaseOutput,
    steps: [assessStep, notifyStep, applyStep],
  }),
  runner,
} as RegisteredFlow;
