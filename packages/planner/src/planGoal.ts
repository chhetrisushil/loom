import { toolInputJsonSchema } from "@loom/agent";
import type { CapabilityCatalog } from "@loom/capability";
import { tainted } from "@loom/classify";
import type { TaintedValue } from "@loom/classify";
import { UNTRUSTED_CONTENT_SYSTEM_NOTE, guardRequest } from "@loom/llm";
import type {
  LlmContent,
  LlmMessageInput,
  LlmProvider,
  LlmRequestInput,
  LlmResponse,
} from "@loom/llm";
import type { DecideScope, ExecutionContext } from "@loom/workflow-runtime";
import {
  DEFAULT_PLAN_LIMITS,
  type PlanGraph,
  type PlanIssue,
  type PlanLimits,
  type PlanNode,
  boundRationale,
  validatePlanGraph,
} from "./planGraph";

// ── R16 (ADR 0123) — journaled planning ─────────────────────────────────────────────────────────
//
// `planGoal` asks a model for a `PlanGraph` INSIDE `ctx.decide`: the model is consulted once, the
// validated plan is recorded, and a replay serves it without a model call. There is no silent
// fallback. An unparseable or invalid answer is fed back to the model (bounded attempts); when the
// attempts run out the decision records a typed failure and `planGoal` throws `PlanFailedError` —
// on the first run and, served from the record, on every replay. A heuristic fallback exists only as
// an explicit option, and the decision records that it was used.

/** Runs one planner model call from inside a decider. */
export type PlanModel = (scope: DecideScope, request: LlmRequestInput) => Promise<LlmResponse>;

/**
 * The model call as an effect: authorized, metered, kill-switched and `guardRequest`-checked by the
 * ring (register `createAgentModelEffect(provider)` / `createLlmEffect` under `toolId`).
 */
export function effectPlanModel(toolId: string): PlanModel {
  return (scope, request) => scope.invokeTransient<LlmRequestInput, LlmResponse>(toolId, request);
}

/** A bare provider, behind the prompt boundary (`guardRequest`). No authz/metering: prefer {@link effectPlanModel}. */
export function providerPlanModel(provider: LlmProvider): PlanModel {
  return (_scope, request) => provider.complete(guardRequest(request));
}

/** Why planning gave up. */
export type PlanFailureReason = "unparseable" | "invalid" | "empty";

/** Thrown when no valid plan could be produced. Deterministic on replay (it is recorded). */
export class PlanFailedError extends Error {
  readonly reason: PlanFailureReason;
  readonly attempts: number;
  readonly issues: readonly PlanIssue[];
  constructor(
    reason: PlanFailureReason,
    attempts: number,
    issues: readonly PlanIssue[],
    detail?: string
  ) {
    super(
      `planning failed (${reason}) after ${attempts} attempt(s)${detail !== undefined ? `: ${detail}` : ""}`
    );
    this.name = "PlanFailedError";
    this.reason = reason;
    this.attempts = attempts;
    this.issues = issues;
    Object.setPrototypeOf(this, PlanFailedError.prototype);
  }
}

export interface PlanGoalInput {
  /** The goal. A tainted goal (ADR 0085) rides in a fenced `user` message; it is never in the system prompt. */
  goal: string | TaintedValue<string>;
  catalog: CapabilityCatalog;
  model: PlanModel;
  /** Decision-id / step-id namespace. Unique per plan within one execution. Default `"plan"`. */
  planId?: string;
  /** Model attempts, each after the first carrying the previous rejection as feedback. Default 3. */
  maxAttempts?: number;
  limits?: Partial<PlanLimits>;
  /**
   * EXPLICIT opt-in fallback, used only after every attempt failed. It must return a plan; the
   * result is validated like a model plan, and the decision records `source: "fallback"`.
   */
  fallback?: (goal: string) => PlanGraph;
  /** Cap on the model's reply, in characters, before parsing. Default 128 KiB. */
  maxReplyChars?: number;
}

const SYSTEM = [
  "You are a planner. Compose a plan that achieves the goal using ONLY the capabilities listed.",
  'Reply with JSON only: {"nodes":[{"id":string,"capabilityId":string,"args":object,"dependsOn":[stepId],"preconditions":[{"ref":"stepId.path","test":"exists|truthy|equals","value":scalar}],"rationale":string}]}.',
  "A step id matches ^[A-Za-z][A-Za-z0-9_-]{0,63}$ and is unique.",
  'To use an earlier step\'s output as an argument write {"$from":"<stepId>.<path>"} in place of the value, and list that step in dependsOn.',
  "Never write a value you do not know; bind it with $from. Steps with no dependency between them run in parallel. Prefer the fewest steps.",
  UNTRUSTED_CONTENT_SYSTEM_NOTE,
].join("\n");

const MAX_SCHEMA_CHARS = 3000;

function menu(catalog: CapabilityCatalog): string {
  return catalog
    .all()
    .map((c) => {
      let schema = JSON.stringify(toolInputJsonSchema(c.inputSchema));
      if (schema.length > MAX_SCHEMA_CHARS) schema = `${schema.slice(0, MAX_SCHEMA_CHARS)}…`;
      return `- ${c.id}: ${c.intent}\n  input: ${schema}`;
    })
    .join("\n");
}

function systemPrompt(catalog: CapabilityCatalog, limits: PlanLimits): string {
  return `${SYSTEM}\nAt most ${limits.maxNodes} steps.\n\nCapabilities:\n${menu(catalog)}`;
}

const NODE_KEYS = [
  "id",
  "capabilityId",
  "args",
  "dependsOn",
  "preconditions",
  "rationale",
] as const;

/** Extract the plan object from a model reply. Returns a reason string on failure. */
export function parsePlanReply(
  content: string,
  goal: string,
  limits: PlanLimits,
  maxChars: number
): { ok: true; plan: PlanGraph } | { ok: false; why: string } {
  if (content.length > maxChars) return { ok: false, why: "reply too large" };
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, why: "no JSON object in the reply" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return { ok: false, why: "the reply is not valid JSON" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as PlanGraph).nodes)
  ) {
    return { ok: false, why: 'the reply has no "nodes" array' };
  }
  const raw = (parsed as { nodes: unknown[] }).nodes;
  if (raw.length > limits.maxNodes) return { ok: false, why: "too many steps" };
  const nodes: PlanNode[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      return { ok: false, why: "a step is not an object" };
    }
    const node: Record<string, unknown> = {};
    for (const k of NODE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(r, k)) node[k] = (r as Record<string, unknown>)[k];
    }
    if (node.rationale !== undefined) {
      const b = boundRationale(node.rationale, limits.maxRationaleChars);
      node.rationale = b; // undefined (not a string) is dropped by JSON and by validation
    }
    nodes.push(node as unknown as PlanNode);
  }
  return { ok: true, plan: { goal, nodes } };
}

const textOfGoal = (g: string | TaintedValue<string>): string =>
  typeof g === "string" ? g : g.value;

function issueText(issues: readonly PlanIssue[]): string {
  return issues
    .slice(0, 8)
    .map((i) => `${i.code}${i.nodeId !== undefined ? ` (${i.nodeId})` : ""}: ${i.message}`)
    .join("\n")
    .slice(0, 1500);
}

type PlanDecision =
  | { ok: true; plan: PlanGraph; attempts: number; source: "model" | "fallback" }
  | {
      ok: false;
      reason: PlanFailureReason;
      attempts: number;
      issues: PlanIssue[];
      detail?: string;
    };

/**
 * The shared bounded ask-validate-retry loop behind {@link planGoal} and the replanner.
 * `validate` decides whether a parsed plan is acceptable.
 */
export async function askForPlan(
  scope: DecideScope,
  args: {
    model: PlanModel;
    system: string;
    opening: LlmMessageInput[];
    goalText: string;
    limits: PlanLimits;
    maxAttempts: number;
    maxReplyChars: number;
    /** Return issues to reject the parsed plan. */
    validate: (plan: PlanGraph) => PlanIssue[];
    allowEmpty?: boolean;
  }
): Promise<PlanDecision> {
  const messages: LlmMessageInput[] = [...args.opening];
  let last: { reason: PlanFailureReason; issues: PlanIssue[]; detail?: string } = {
    reason: "unparseable",
    issues: [],
  };
  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    // A throw here (authz, quota, kill switch, cancellation, a provider fault) is the run's, not a
    // retry: it propagates and nothing is recorded.
    const reply: LlmResponse = await args.model(scope, { system: args.system, messages });
    const parsed = parsePlanReply(reply.content, args.goalText, args.limits, args.maxReplyChars);
    let feedback: string;
    if (!parsed.ok) {
      last = { reason: "unparseable", issues: [], detail: parsed.why };
      feedback = parsed.why;
    } else if (parsed.plan.nodes.length === 0 && args.allowEmpty !== true) {
      last = { reason: "empty", issues: [] };
      feedback = "the plan has no steps";
    } else {
      const issues = args.validate(parsed.plan);
      if (issues.length === 0) {
        return { ok: true, plan: parsed.plan, attempts: attempt, source: "model" };
      }
      last = { reason: "invalid", issues };
      feedback = issueText(issues);
    }
    // The rejection echoes model-authored fragments (ids, capability names): data, fenced.
    messages.push({
      role: "user",
      content: [
        { type: "text", text: "Your previous plan was rejected. Fix it and reply with JSON only:" },
        { type: "text", text: tainted(feedback, "plan:validation-feedback") },
      ],
    });
  }
  return { ok: false, attempts: args.maxAttempts, ...last };
}

/**
 * Plan a goal as a validated {@link PlanGraph}, journaled through `ctx.decide`.
 *
 * Replay-safe: the decider (and so the model) runs once; a replay serves the recorded plan — or the
 * recorded failure — and makes zero model calls. The decision id is `<planId>:plan`.
 *
 * @throws PlanFailedError when no valid plan was produced (and no `fallback` was supplied).
 */
export async function planGoal(
  ctx: Pick<ExecutionContext, "decide">,
  input: PlanGoalInput
): Promise<PlanGraph> {
  const limits: PlanLimits = { ...DEFAULT_PLAN_LIMITS, ...input.limits };
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
    throw new RangeError("planGoal maxAttempts must be an integer in 1..8");
  }
  const goalText = textOfGoal(input.goal);
  const planId = input.planId ?? "plan";
  const decision = await ctx.decide<PlanDecision>(
    `${planId}:plan`,
    async (scope) => {
      const opening: LlmMessageInput[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Goal:" },
            { type: "text", text: input.goal as LlmContent },
          ],
        },
      ];
      const r = await askForPlan(scope, {
        model: input.model,
        system: systemPrompt(input.catalog, limits),
        opening,
        goalText,
        limits,
        maxAttempts,
        maxReplyChars: input.maxReplyChars ?? 128 * 1024,
        validate: (plan) => {
          const v = validatePlanGraph(plan, { catalog: input.catalog, limits });
          return v.ok ? [] : v.issues;
        },
      });
      if (r.ok || input.fallback === undefined) return r;
      const fb = input.fallback(goalText);
      const v = validatePlanGraph(fb, { catalog: input.catalog, limits });
      if (!v.ok) return { ...r, issues: v.issues, detail: "the fallback plan is invalid too" };
      return { ok: true, plan: fb, attempts: r.attempts, source: "fallback" };
    },
    { source: "planner.plan", rationale: `plan for goal (${goalText.slice(0, 120)})` }
  );
  if (!decision.ok) {
    throw new PlanFailedError(decision.reason, decision.attempts, decision.issues, decision.detail);
  }
  return decision.plan;
}

/**
 * An explicit, deterministic fallback: the catalog's keyword ranking as a CHAIN of argument-less
 * steps (each depends on the previous). Only sound for capabilities whose input is all-optional —
 * anything else fails validation and `planGoal` throws, which is the point: there is no silent path.
 */
export function heuristicFallback(
  catalog: CapabilityCatalog,
  maxSteps = 5
): (goal: string) => PlanGraph {
  return (goal) => {
    const matches = catalog.find(goal).slice(0, maxSteps);
    return {
      goal,
      nodes: matches.map((m, i) => ({
        id: `s${i + 1}`,
        capabilityId: m.capability.id,
        args: {},
        ...(i > 0 && { dependsOn: [`s${i}`] }),
        rationale: `matched goal (score ${m.score})`,
      })),
    };
  };
}

export { systemPrompt as plannerSystemPrompt };
