import type { EffectContext, EffectMiddleware } from "@loom/effect-runtime";
import {
  type Budget,
  type BudgetLedger,
  type BudgetScope,
  type KillSwitchRegistry,
  type Pricing,
  type RateLimitOptions,
  llmUsageTokens,
  nestedBudgetMiddleware,
  rateLimitMiddleware,
} from "@loom/middleware";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import type { VerifyConfig } from "./verifyAdapter";

// ── R9 — the strict profile and the autonomy envelope ─────────────────────────
//
// Every default in loom is permissive: no authorizer means every effect is allowed, no
// deadline means an execution may run forever, a child may spawn children without bound,
// and nothing meters spend. That is the right default for a demo and the wrong one for an
// agent that acts on its own. `security.strict` is the switch that flips the baseline.
//
// What it does NOT do is guess an app's policy. It refuses to START without the two
// authorizers (which only the app can write), and it turns on the bounds whose safe default
// does not depend on the workload. A bound that does depend on it (a rate limit, a per-agent
// lifetime budget) stays off until the app sets it — a wrong default there would throttle
// legitimate work, which is how a safety feature gets switched off.

/** The defaults `security.strict: true` applies. Each is overridable (or `false` to disable). */
export const STRICT_DEFAULTS = {
  /**
   * 24 hours. The deadline is anchored to the execution's start and COUNTS suspended time, so
   * a human-approval flow that parks for a day must not be cancelled by a default meant to
   * catch a stuck run. It is the backstop against "runs forever", not a latency target; tighten
   * it per flow (`flow$({ deadlineMs })`) or globally here. Must stay under 2^31-1 ms (~24.8
   * days), the longest timer the runtime can arm.
   */
  defaultDeadlineMs: 24 * 60 * 60 * 1000,
  /** Root = 0; a child of a child of a child… past 5 levels is a recursion, not a plan. */
  spawnMaxDepth: 5,
  /** Children one `awaitChildren`/`awaitAll` group may start. */
  spawnMaxFanOut: 32,
  /**
   * Tokens one execution may spend before its next effect is refused. 1M is far above any
   * single sane run (a 200k-context model on a 40-turn loop is ~8M input but metering counts
   * what the provider REPORTS per call, and a cached prefix is cheap) and low enough that a
   * loop re-sending a long transcript is stopped in minutes rather than at the invoice.
   * Needs a provider that reports `usage`; with none it meters 0 and bounds nothing — set
   * `envelope.budget.pricing` for another unit.
   */
  perExecutionMaxTokens: 1_000_000,
} as const;

export interface StrictOptions {
  /**
   * Deadline (ms) applied to every flow that declares none. `false` disables the default.
   * Default {@link STRICT_DEFAULTS.defaultDeadlineMs}. A flow's own `deadlineMs` always wins.
   *
   * NOTE the flow fingerprint: the deadline is applied by wrapping `runtime.start`/`resume`
   * (not by rewriting flow definitions), precisely so it does NOT change `flowHash` and does
   * not strand in-flight executions when strict is switched on.
   */
  defaultDeadlineMs?: number | false;
}

/**
 * The autonomy envelope: the bounds on how much a runaway agent can do. Under strict, `spawn`
 * and `budget.perExecution` have defaults; everything else is opt-in. `false` switches a
 * defaulted bound off explicitly (visible in the config, unlike a missing key).
 */
export interface AutonomyEnvelopeOptions {
  /**
   * Child-spawn bounds (`@loom/orchestration`). The app must hand them to its supervisor:
   * `superviseChildren({ runtime, flows, limits: app.envelope?.spawn })`, and may use
   * `boundOrchestration(app.envelope.spawn)` in flows for a parent-side refusal.
   */
  spawn?: { maxDepth?: number | false; maxFanOut?: number | false };
  /**
   * Spend bounds, enforced as admission control before each effect and recorded as
   * `RESOURCE_METERED`. Installs `nestedBudgetMiddleware`, which meters on its own — do NOT also
   * install `meteringMiddleware` (every effect would be metered twice). `false` installs none.
   */
  budget?:
    | false
    | {
        /** Per execution (the pure fold). Strict default: {@link STRICT_DEFAULTS.perExecutionMaxTokens} tokens. */
        perExecution?: Budget | false;
        /**
         * Per flow — "per agent". CUMULATIVE since process start across executions of that flow,
         * eventually consistent across nodes (a projection, not a fold): there is no reset, so it
         * suits a hard ceiling, not a rolling quota. No default.
         */
        perAgent?: Budget;
        /** Per `principal.tenant`, same cumulative semantics. Effects with no tenant are not counted. No default. */
        perTenant?: Budget;
        /** Cost model. Default: tokens reported by an LLM-shaped result's `usage`. */
        pricing?: Pricing;
      };
  /** Token-bucket effect rate limit (`rateLimitMiddleware`). No default: it is workload-specific. */
  rateLimit?: false | RateLimitOptions;
}

/**
 * Structurally identical to `@loom/orchestration`'s `SpawnLimits`, declared here so
 * `@loom/app` does not take a dependency on the orchestration package for two numbers.
 */
export interface SpawnLimits {
  maxDepth?: number;
  maxFanOut?: number;
}

/** What `app.envelope` exposes: the resolved bounds the app hands to its supervisor. */
export interface ResolvedEnvelope {
  spawn: SpawnLimits;
  /** The cross-execution spend projection behind `perAgent`/`perTenant` (read it for dashboards). */
  ledger: BudgetLedger;
}

const noDefault = (v: number | false | undefined, dflt: number | undefined): number | undefined =>
  v === false ? undefined : (v ?? dflt);

export function resolveSpawn(
  spawn: AutonomyEnvelopeOptions["spawn"],
  strict: boolean
): SpawnLimits {
  const maxDepth = noDefault(spawn?.maxDepth, strict ? STRICT_DEFAULTS.spawnMaxDepth : undefined);
  const maxFanOut = noDefault(
    spawn?.maxFanOut,
    strict ? STRICT_DEFAULTS.spawnMaxFanOut : undefined
  );
  return {
    ...(maxDepth !== undefined && { maxDepth }),
    ...(maxFanOut !== undefined && { maxFanOut }),
  };
}

/** The per-execution budget in force (strict default applied), or undefined. */
function perExecutionBudget(
  budget: AutonomyEnvelopeOptions["budget"],
  strict: boolean
): Budget | undefined {
  if (budget === false) return undefined;
  const pe = budget?.perExecution;
  if (pe === false) return undefined;
  if (pe !== undefined) return pe;
  return strict ? { maxTokens: STRICT_DEFAULTS.perExecutionMaxTokens } : undefined;
}

/**
 * The effect middleware the envelope contributes, in the order they must run:
 * rate limit (cheapest refusal first), then budget. The kill switch is placed by the caller
 * outside redaction; user middleware goes after these.
 */
export function envelopeMiddleware(
  envelope: AutonomyEnvelopeOptions | undefined,
  strict: boolean,
  ledger: BudgetLedger
): EffectMiddleware[] {
  const out: EffectMiddleware[] = [];
  if (envelope?.rateLimit !== undefined && envelope.rateLimit !== false) {
    out.push(rateLimitMiddleware(envelope.rateLimit));
  }
  const budget = envelope?.budget;
  if (budget !== false) {
    const perExecution = perExecutionBudget(budget, strict);
    const perAgent = budget?.perAgent;
    const perTenant = budget?.perTenant;
    if (perExecution !== undefined || perAgent !== undefined || perTenant !== undefined) {
      const pricing: Pricing =
        budget?.pricing ?? (({ result }) => ({ tokens: llmUsageTokens(result) }));
      out.push(
        nestedBudgetMiddleware({
          pricing,
          ledger,
          // Outermost (broadest) first, so the most restrictive breach is the one reported.
          scopesOf: (ctx: EffectContext): BudgetScope[] => {
            const scopes: BudgetScope[] = [];
            const tenant = ctx.principal?.tenant;
            if (perTenant !== undefined && tenant !== undefined) {
              scopes.push({ level: "tenant", key: `tenant:${tenant}`, budget: perTenant });
            }
            if (perAgent !== undefined) {
              scopes.push({
                level: "workflow",
                key: `workflow:${ctx.workflowId}`,
                budget: perAgent,
              });
            }
            if (perExecution !== undefined) {
              scopes.push({ level: "execution", key: "", budget: perExecution });
            }
            return scopes;
          },
        })
      );
    }
  }
  return out;
}

/** True when the app configured nothing that bounds spend (drives the advisory + strict check). */
export function budgetConfigured(
  envelope: AutonomyEnvelopeOptions | undefined,
  strict: boolean
): boolean {
  const budget = envelope?.budget;
  if (budget === false) return false;
  return (
    perExecutionBudget(budget, strict) !== undefined ||
    budget?.perAgent !== undefined ||
    budget?.perTenant !== undefined
  );
}

export interface PostureInputs {
  authorizer: unknown;
  executionAuthorizer: unknown;
  verify: VerifyConfig | undefined;
  envelope: AutonomyEnvelopeOptions | undefined;
  killSwitch: KillSwitchRegistry | undefined;
}

const verifyMode = (v: VerifyConfig | undefined): string | undefined =>
  v === undefined ? undefined : typeof v === "string" ? v : (v.mode ?? "warn");

/**
 * What `strict` refuses to start without. These are the pieces only the app can supply (an
 * authorizer encodes ITS policy), so strict cannot default them — it can only refuse their
 * absence, loudly, at composition time rather than at the first unauthorized effect.
 */
export function strictProblems(p: PostureInputs): string[] {
  const problems: string[] = [];
  if (p.authorizer === undefined) {
    problems.push(
      "`security.authorizer` is required — with none, every effect is allowed. Supply a GrantTable (or any CapabilityAuthorizer); `policies` alone is not enough, a flow with no policy is unaffected by it."
    );
  }
  if (p.executionAuthorizer === undefined) {
    problems.push(
      "`security.executionAuthorizer` is required — with none, anyone holding the runtime may start, resume or cancel any execution."
    );
  }
  if (verifyMode(p.verify) === "off") {
    problems.push(
      '`checks.verify` is "off" — strict runs pre-flight verification ("error" by default, "warn" allowed).'
    );
  }
  if (p.envelope?.budget === false && p.envelope.rateLimit === undefined) {
    // An explicit opt-out of metering is allowed only if something else bounds spend.
    problems.push(
      "`execution.envelope.budget: false` removes the only spend bound — set a budget, or a `rateLimit`, instead."
    );
  }
  return problems;
}

/**
 * The single advisory a non-strict app gets: what its permissive defaults leave unbounded.
 * `undefined` when nothing is worth saying.
 */
export function permissiveNotice(p: PostureInputs): string | undefined {
  const gaps: string[] = [];
  if (p.authorizer === undefined) gaps.push("no `security.authorizer` (every effect is allowed)");
  if (p.executionAuthorizer === undefined) {
    gaps.push("no `security.executionAuthorizer` (any caller may start/resume/cancel)");
  }
  gaps.push("no default execution deadline");
  if (p.envelope?.spawn?.maxDepth === undefined || p.envelope.spawn.maxFanOut === undefined) {
    gaps.push("no child-spawn depth/breadth cap");
  }
  if (!budgetConfigured(p.envelope, false)) gaps.push("no spend budget");
  if (p.killSwitch === undefined) gaps.push("no kill switch");
  const mode = verifyMode(p.verify);
  if (mode === undefined || mode === "off") gaps.push("pre-flight verification is off");
  return `permissive defaults — ${gaps.join("; ")}. Set \`security.strict: true\` to enforce a safe baseline, or \`security.strict: false\` to acknowledge this and silence the notice.`;
}

/**
 * Apply a default execution deadline to every flow that declares none — by wrapping the four
 * entry points that arm a deadline, NOT by rewriting definitions (the deadline is part of the
 * flow fingerprint, so rewriting would invalidate every in-flight execution the day strict is
 * turned on). An explicit `options.deadlineMs` and a flow's own `deadlineMs` both win.
 *
 * `resume` does not receive the flow, so it is read from the execution's own state — one extra
 * read, paid only under strict, and only when no explicit deadline was given.
 */
export function withDefaultDeadline(runtime: WorkflowRuntime, defaultMs: number): void {
  type Loose = (...a: unknown[]) => Promise<unknown>;
  const rt = runtime as unknown as Record<string, Loose>;

  const declaredOf = (flow: unknown): number | undefined => {
    if (typeof flow === "string") return runtime.getFlow(flow)?.definition.deadlineMs;
    const f = flow as { _tag?: string; id?: string; definition?: { deadlineMs?: number } };
    if (f._tag === "FlowDefinition") {
      return (
        (f as { deadlineMs?: number }).deadlineMs ??
        runtime.getFlow(f.id ?? "")?.definition.deadlineMs
      );
    }
    return f.definition?.deadlineMs;
  };
  const withDeadline = (options: unknown, ms: number): unknown => ({
    ...(options as object | undefined),
    deadlineMs: ms,
  });
  const explicit = (options: unknown): boolean =>
    (options as { deadlineMs?: number } | undefined)?.deadlineMs !== undefined;

  const start = rt.start as Loose;
  rt.start = (flow, input, options) =>
    explicit(options)
      ? start.call(runtime, flow, input, options)
      : start.call(runtime, flow, input, withDeadline(options, declaredOf(flow) ?? defaultMs));

  // `resume(executionId, event, options)`: the flow comes from the execution's own state.
  const resume = rt.resume as Loose;
  rt.resume = async (...args: unknown[]) => {
    if (explicit(args[2])) return resume.apply(runtime, args);
    const state = await runtime.loadState(args[0] as string);
    const declared =
      state === null ? undefined : runtime.getFlow(state.workflowId)?.definition.deadlineMs;
    const next = [...args];
    next[2] = withDeadline(args[2], declared ?? defaultMs);
    return resume.apply(runtime, next);
  };

  // `resumeAs(executionId, newFlowId, event, options)`: the target flow is an argument.
  const resumeAs = rt.resumeAs as Loose;
  rt.resumeAs = (...args: unknown[]) => {
    if (explicit(args[3])) return resumeAs.apply(runtime, args);
    const next = [...args];
    next[3] = withDeadline(
      args[3],
      runtime.getFlow(args[1] as string)?.definition.deadlineMs ?? defaultMs
    );
    return resumeAs.apply(runtime, next);
  };

  // `restoreFromState(state, event?, options?)`.
  const restore = rt.restoreFromState as Loose;
  rt.restoreFromState = (...args: unknown[]) => {
    if (explicit(args[2])) return restore.apply(runtime, args);
    const wf = (args[0] as { workflowId?: string }).workflowId;
    const declared = wf === undefined ? undefined : runtime.getFlow(wf)?.definition.deadlineMs;
    const next = [...args];
    next[2] = withDeadline(args[2], declared ?? defaultMs);
    return restore.apply(runtime, next);
  };
}
