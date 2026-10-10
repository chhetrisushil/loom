import { isTerminalToolError, validateToolInput } from "@loom/agent";
import type { CapabilityCatalog } from "@loom/capability";
import { isTainted, tainted } from "@loom/classify";
import type { TaintedValue } from "@loom/classify";
import type { LlmContentPartInput } from "@loom/llm";
import type { BranchContext, ExecutionContext } from "@loom/workflow-runtime";
import { claimId } from "./claim";
import {
  PlanFailedError,
  type PlanModel,
  type PlannerPrompts,
  askForPlan,
  plannerSystemPrompt,
} from "./planGoal";
import {
  DEFAULT_PLAN_LIMITS,
  type PlanGraph,
  type PlanLimits,
  type PlanNode,
  RefResolutionError,
  assertValidPlanGraph,
  checkPrecondition,
  containsTaint,
  dependentsOf,
  resolveArgs,
  unwrapTaint,
  validatePlanGraph,
} from "./planGraph";

// ── R16 (ADR 0123) — the dependency-aware executor ──────────────────────────────────────────────
//
// Runs a validated `PlanGraph` in WAVES: each wave is every node whose dependencies have all
// completed (Kahn's algorithm, O(V+E) over the whole run), fanned out through one `ctx.parallel`
// scope (R6) with bounded concurrency, results in declaration order. A wave is a barrier, which is
// what makes the schedule a pure function of the recorded outcomes: a replay forms the same waves,
// asks the same questions, and serves every step and decision from the log (R7 "fail" never trips).
//
// Step ids are `<planId>:<nodeId>`; a node id is unique across every round of a plan, so a replan
// can never collide with a recorded frame.

/** Why a node did not produce an output. */
export type StepFailureKind = "step" | "precondition" | "args-invalid" | "ref-unresolved";

export interface StepFailure {
  kind: StepFailureKind;
  message: string;
  /** The error's class name, for a `step` failure. */
  name?: string;
  /** The declared error channel, when the step failed with a `TypedFailure`. */
  channel?: string;
}

export interface PlanStepCall {
  node: PlanNode;
  /** The arguments with every `$from` resolved, validated against the capability's schema. */
  args: Record<string, unknown>;
  /** `<planId>:<nodeId>` — use it as the durable step id. */
  stepId: string;
  /** The wave's branch context. */
  ctx: BranchContext;
}

/** What a failed round hands the reviser. */
export interface ReplanRequest {
  /** The goal as planned (a tainted goal stays tainted). */
  goal: string | TaintedValue<string>;
  /** The plan's id: namespaces the revision's decision (`<planId>:replan:<round>`). */
  planId: string;
  /** The catalog and the (resolved) limits the executor validates a revision against: use the same. */
  catalog: CapabilityCatalog;
  limits: PlanLimits;
  /** 1-based round number. */
  round: number;
  /** Completed steps and their outputs: NOT to be re-run; referenceable via `$from`. */
  completed: Readonly<Record<string, unknown>>;
  failures: Readonly<Record<string, StepFailure>>;
  /** Steps that never ran (blocked by a failure, or dropped from the old plan). */
  unrun: readonly PlanNode[];
  /** Every step id used so far (completed, failed or unrun): a revision may not reuse one. */
  usedIds: ReadonlySet<string>;
}

export interface ExecutePlanConfig {
  catalog: CapabilityCatalog;
  /** Step-id namespace; unique per plan within an execution. Default `"plan"`. */
  planId?: string;
  /** Max steps in flight per wave. Default 4. */
  limit?: number;
  /**
   * `"fail-fast"` (default): after a wave with a failure (and no replan left) nothing further starts.
   * `"continue-independent"`: keep running every node that does not depend, transitively, on a failure.
   * Either way a wave's in-flight siblings finish (they are one scope).
   */
  onFailure?: "fail-fast" | "continue-independent";
  /**
   * Run one step. It MUST be a durable frame (`call.ctx.execute(task, args)`): the executor calls it
   * a second time to read the output of a step whose outcome is already recorded, and relies on the
   * log serving it. Default: a `tool` task with `toolId = capabilityId` through the effect ring.
   */
  invoke?: (call: PlanStepCall) => Promise<unknown>;
  limits?: Partial<PlanLimits>;
  /** Bounded replanning. Absent ⇒ a failure is final per `onFailure`. */
  replan?: {
    /** Max revisions. */
    max: number;
    /** Produce the replacement for everything not yet completed. See {@link makeReviser}. */
    revise: (ctx: ExecutionContext, request: ReplanRequest) => Promise<PlanGraph>;
    /** Cap on distinct nodes across all rounds. Default `4 × limits.maxNodes`. */
    maxTotalNodes?: number;
  };
  /**
   * Optional reflection after each wave. Make any model call inside it go through `ctx.decide`.
   * `"replan"` asks for a revision even without a failure (needs `replan`); `"stop"` ends the run.
   */
  reflect?: (
    ctx: ExecutionContext,
    wave: { round: number; completed: string[]; failed: string[] }
  ) => Promise<"continue" | "replan" | "stop" | undefined>;
}

export interface PlanRun {
  status: "completed" | "failed" | "stopped";
  outputs: Record<string, unknown>;
  failures: Record<string, StepFailure>;
  /** Steps that never ran. */
  skipped: string[];
  replans: number;
  /** Every node of every round, in the order introduced. */
  nodes: PlanNode[];
  /** Why the run did not complete (replan exhausted / refused, reflect stop). */
  reason?: string;
}

const MAX_FAILURE_CHARS = 300;

type NodeResult =
  | { id: string; ok: true; output: unknown }
  | { id: string; ok: false; failure: StepFailure };

function describe(e: unknown): StepFailure {
  const name = e instanceof Error ? e.name : "Error";
  const msg = e instanceof Error ? e.message : String(e);
  const channel = (e as { channel?: unknown } | null)?.channel;
  return {
    kind: "step",
    name: name.slice(0, 64),
    message: msg.slice(0, MAX_FAILURE_CHARS),
    ...(typeof channel === "string" && { channel: channel.slice(0, 64) }),
  };
}

const defaultInvoke = (call: PlanStepCall): Promise<unknown> =>
  call.ctx.execute(
    {
      _tag: "TaskDefinition",
      kind: "tool",
      id: call.stepId,
      toolId: call.node.capabilityId,
    } as never,
    call.args
  );

/**
 * Run a plan graph to completion, failure, or a stop. See the module notes for the schedule.
 *
 * Replay-safe: the schedule is a pure function of recorded outcomes. Steps are durable frames; a
 * step's FAILURE is recorded through `ctx.decide` (`<stepId>:outcome`) so a resume serves it instead
 * of re-running the capability; a replan is one recorded decision. Completed steps are never
 * re-executed, within a run or across a replay.
 */
export async function executePlan(
  ctx: ExecutionContext,
  plan: PlanGraph,
  config: ExecutePlanConfig
): Promise<PlanRun> {
  const limits: PlanLimits = { ...DEFAULT_PLAN_LIMITS, ...config.limits };
  const planId = config.planId ?? "plan";
  const concurrency = config.limit ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("executePlan limit must be a positive integer");
  }
  const invoke = config.invoke ?? defaultInvoke;
  const mode = config.onFailure ?? "fail-fast";
  const maxReplans = config.replan?.max ?? 0;
  if (!Number.isSafeInteger(maxReplans) || maxReplans < 0 || maxReplans > 16) {
    throw new RangeError("executePlan replan.max must be an integer in 0..16");
  }
  const maxTotal = config.replan?.maxTotalNodes ?? limits.maxNodes * 4;

  assertValidPlanGraph(plan, { catalog: config.catalog, limits: config.limits ?? {} });

  claimId(ctx, "exec", planId);
  const outputs = new Map<string, unknown>();
  const failures = new Map<string, StepFailure>();
  const usedIds = new Set<string>();
  const allNodes: PlanNode[] = [];
  let current: PlanNode[] = [];
  let pending = new Map<string, PlanNode>();
  let indeg = new Map<string, number>();
  let dependents = new Map<string, string[]>();
  let replans = 0;
  let round = 0;
  let reason: string | undefined;
  let stopped = false;

  const adopt = (nodes: readonly PlanNode[]): void => {
    pending = new Map();
    current = [...nodes];
    for (const n of nodes) {
      pending.set(n.id, n);
      usedIds.add(n.id);
      allNodes.push(n);
    }
    dependents = dependentsOf(nodes);
    indeg = new Map();
    for (const n of nodes) {
      let d = 0;
      for (const dep of new Set(n.dependsOn ?? [])) if (!outputs.has(dep)) d++;
      indeg.set(n.id, d);
    }
  };
  adopt(plan.nodes);

  /** Remove `id` and everything that transitively depends on it from `pending`; O(V+E) over the run. */
  const skipFrom = (id: string): void => {
    const stack = [...(dependents.get(id) ?? [])];
    while (stack.length > 0) {
      const n = stack.pop() as string;
      if (!pending.has(n)) continue;
      pending.delete(n);
      for (const m of dependents.get(n) ?? []) stack.push(m);
    }
  };

  const runNode = async (b: BranchContext, node: PlanNode): Promise<NodeResult> => {
    const stepId = `${planId}:${node.id}`;
    const fail = (failure: StepFailure): NodeResult => ({ id: node.id, ok: false, failure });
    let args: Record<string, unknown>;
    try {
      args = resolveArgs(node.args, outputs);
    } catch (e) {
      if (e instanceof RefResolutionError) {
        return fail({ kind: "ref-unresolved", message: e.message.slice(0, MAX_FAILURE_CHARS) });
      }
      throw e;
    }
    for (const p of node.preconditions ?? []) {
      const miss = checkPrecondition(p, outputs);
      if (miss !== undefined) {
        return fail({ kind: "precondition", message: miss.slice(0, MAX_FAILURE_CHARS) });
      }
    }
    const cap = config.catalog.get(node.capabilityId);
    if (cap === undefined) {
      return fail({ kind: "args-invalid", message: `no capability "${node.capabilityId}"` });
    }
    // ADR 0085: a tainted value is refused by default. A capability that opts in (`acceptsTainted`) has
    // its schema checked against the PAYLOAD and receives the wrapper, so the taint travels with it.
    const hasTaint = containsTaint(args);
    if (hasTaint && cap.acceptsTainted !== true) {
      return fail({
        kind: "args-invalid",
        message: `an argument is tainted (untrusted, or too large to inspect) and "${cap.id}" does not accept tainted input`,
      });
    }
    const chk = validateToolInput(cap.inputSchema, hasTaint ? unwrapTaint(args) : args);
    if (!chk.ok) {
      return fail({
        kind: "args-invalid",
        message: chk.issues
          .map((i) => `${i.path || "(root)"}: ${i.message}`)
          .join("; ")
          .slice(0, MAX_FAILURE_CHARS),
      });
    }

    const call: PlanStepCall = { node, args, stepId, ctx: b };
    // Live: the decider runs the step once and keeps its output. Served from the log: the decider did
    // not run, so the step's output is read back from its completed frame (one more `invoke`).
    let live: { output: unknown } | undefined;
    const recorded = await b.decide<{ ok: true } | { failed: StepFailure }>(
      `${stepId}:outcome`,
      async () => {
        try {
          live = { output: await invoke(call) };
          return { ok: true as const };
        } catch (e) {
          // Authority, safety, park, cancel and divergence are the runtime's: not recorded as a
          // plan failure, never retried by a replan.
          if (isTerminalToolError(e)) throw e;
          return { failed: describe(e) };
        }
      },
      { source: "planner.step" }
    );
    if ("failed" in recorded) return fail(recorded.failed);
    return { id: node.id, ok: true, output: live !== undefined ? live.output : await invoke(call) };
  };

  for (;;) {
    // ── wave ──
    const ready: PlanNode[] = [];
    for (const n of pending.values()) if (indeg.get(n.id) === 0) ready.push(n);
    if (ready.length === 0) break;
    round++;

    const results = await ctx.parallel<NodeResult[]>(
      ready.map((node) => (b: BranchContext) => runNode(b, node)),
      { limit: concurrency, failFast: false }
    );

    const done: string[] = [];
    const bad: string[] = [];
    for (const r of results) {
      pending.delete(r.id);
      if (r.ok) {
        outputs.set(r.id, r.output);
        done.push(r.id);
        for (const m of dependents.get(r.id) ?? []) {
          if (pending.has(m)) indeg.set(m, (indeg.get(m) as number) - 1);
        }
      } else {
        failures.set(r.id, r.failure);
        bad.push(r.id);
      }
    }
    for (const id of bad) skipFrom(id);

    let verdict: "continue" | "replan" | "stop" | undefined;
    if (config.reflect !== undefined) {
      verdict = await config.reflect(ctx, { round, completed: done, failed: bad });
    }
    if (verdict === "stop") {
      reason = "stopped by reflect";
      stopped = true;
      break;
    }

    const wantReplan = bad.length > 0 || verdict === "replan";
    if (wantReplan && config.replan !== undefined && replans < maxReplans) {
      replans++;
      // `unrun` = what was waiting (it includes nodes skipped because of the failure).
      const unrun = current.filter((n) => !outputs.has(n.id) && !failures.has(n.id));
      let revised: PlanGraph;
      try {
        revised = await config.replan.revise(ctx, {
          goal: plan.goal,
          planId,
          catalog: config.catalog,
          limits,
          round: replans,
          completed: Object.fromEntries(outputs),
          failures: Object.fromEntries(failures),
          unrun,
          usedIds: new Set(usedIds),
        });
        const external = new Set(outputs.keys());
        const v = validatePlanGraph(revised, {
          catalog: config.catalog,
          limits: config.limits ?? {},
          external,
          reserved: usedIds,
        });
        if (!v.ok) {
          throw new PlanFailedError("invalid", 1, v.issues, "the revised plan is invalid");
        }
        if (revised.nodes.length === 0) {
          throw new PlanFailedError("empty", 1, [], "the reviser gave up (no steps)");
        }
        if (allNodes.length + revised.nodes.length > maxTotal) {
          throw new PlanFailedError("invalid", 1, [], "replanning exceeded the total node budget");
        }
      } catch (e) {
        if (e instanceof PlanFailedError) {
          reason = e.message;
          break;
        }
        throw e;
      }
      // The unrun nodes of the old plan are superseded, not skipped.
      adopt(revised.nodes);
      continue;
    }
    if (bad.length > 0 && mode === "fail-fast") break;
    // continue-independent: `skipFrom` already removed the blocked cone; loop on.
  }

  // Judged on the FINAL plan: a failure that a later round replaced is history (it stays in
  // `failures` as evidence), and a node that neither ran nor failed never ran.
  const skipped = current.filter((n) => !outputs.has(n.id) && !failures.has(n.id)).map((n) => n.id);
  const status: PlanRun["status"] = stopped
    ? "stopped"
    : reason === undefined && current.every((n) => outputs.has(n.id))
      ? "completed"
      : "failed";
  return {
    status,
    outputs: Object.fromEntries(outputs),
    failures: Object.fromEntries(failures),
    skipped,
    replans,
    nodes: allNodes,
    ...(reason !== undefined && { reason }),
  };
}

export interface MakeReviserConfig {
  model: PlanModel;
  /** R19 - override the planner's fixed English prompt text (system / step limit / capabilities heading / rejection line). The replan round header and data labels stay English. */
  prompts?: PlannerPrompts;
  maxAttempts?: number;
  maxReplyChars?: number;
}

const summarise = (v: unknown): string => {
  let s: string;
  try {
    // The fenced payload, never the wrapper's JSON.
    s = JSON.stringify(unwrapTaint(v)) ?? "undefined";
  } catch {
    s = "[unserialisable]";
  }
  return s.length > 1500 ? `${s.slice(0, 1500)}…` : s;
};

/**
 * The model-backed reviser for {@link ExecutePlanConfig.replan}. One recorded decision per round,
 * named from the REQUEST's plan (`<req.planId>:replan:<n>`), so one reviser can serve any number of
 * plans in an execution without one adopting another's revision. The catalog and limits are the
 * request's too: the revision is validated against exactly what the executor enforces, and a
 * rejection is fed back to the model (bounded retries). Everything the failure context contains is
 * tool- or model-authored (a step's output, an error message, the old plan's rationale), so each item
 * is a tainted part of the `user` message, fenced by the prompt boundary and labelled with its origin
 * (`plan:failure:<id>`, `plan:output:<id>`, ...); nothing of it enters the system prompt.
 */
export function makeReviser(
  cfg: MakeReviserConfig
): NonNullable<ExecutePlanConfig["replan"]>["revise"] {
  return async (ctx, req) => {
    const { catalog, limits } = req;
    const decision = await ctx.decide(
      `${req.planId}:replan:${req.round}`,
      async (scope) => {
        const parts: LlmContentPartInput[] = [
          { type: "text", text: "Goal:" },
          { type: "text", text: isTainted(req.goal) ? req.goal : tainted(req.goal, "plan:goal") },
          {
            type: "text",
            text: `Round ${req.round}. Replace every step that has not completed. Do not repeat completed steps; reference their outputs with {"$from":"<stepId>.<path>"} and list them in dependsOn. Do not reuse any step id already used: ${[...req.usedIds].slice(0, 64).join(", ")}.`,
          },
          { type: "text", text: "Completed steps and their outputs (untrusted data):" },
        ];
        for (const [id, out] of Object.entries(req.completed)) {
          parts.push({
            type: "text",
            text: tainted(`${id}: ${summarise(out)}`, `plan:output:${id}`),
          });
        }
        parts.push({ type: "text", text: "Failures (untrusted data):" });
        for (const [id, f] of Object.entries(req.failures)) {
          parts.push({
            type: "text",
            text: tainted(`${id} [${f.kind}]: ${f.message}`, `plan:failure:${id}`),
          });
        }
        parts.push({ type: "text", text: "Steps that did not run (untrusted data):" });
        for (const n of req.unrun) {
          parts.push({
            type: "text",
            text: tainted(
              `${n.id} -> ${n.capabilityId}: ${n.rationale ?? ""}`,
              `plan:unrun:${n.id}`
            ),
          });
        }
        const external = new Set(Object.keys(req.completed));
        return askForPlan(scope, {
          model: cfg.model,
          system: plannerSystemPrompt(catalog, limits, cfg.prompts),
          ...(cfg.prompts?.rejected !== undefined && { rejected: cfg.prompts.rejected }),
          opening: [{ role: "user", content: parts }],
          goal: req.goal,
          limits,
          maxAttempts: cfg.maxAttempts ?? 3,
          maxReplyChars: cfg.maxReplyChars ?? 128 * 1024,
          validate: (plan) => {
            const v = validatePlanGraph(plan, {
              catalog,
              limits,
              external,
              reserved: req.usedIds,
            });
            return v.ok ? [] : v.issues;
          },
        });
      },
      { source: "planner.replan" }
    );
    if (!decision.ok) {
      throw new PlanFailedError(
        decision.reason,
        decision.attempts,
        decision.issues,
        decision.detail
      );
    }
    return decision.plan;
  };
}
