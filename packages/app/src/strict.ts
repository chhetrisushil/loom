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
   * Applies to executions STARTED under strict only (it wraps `runtime.start`, not flow
   * definitions, so `flowHash` is unchanged and in-flight executions are not stranded). It is
   * NOT durable per execution: the kernel re-arms a resumed execution from the flow's own
   * `deadlineMs` (or the resume caller's option), never from the start-time default or an
   * explicit start deadline — so a strict-started flow with no `deadlineMs` of its own is
   * unbounded again after its first resume. Declare `flow$({ deadlineMs })` for a deadline
   * that survives resume; a durable per-execution deadline is a kernel change (not in R9's 1P half).
   */
  defaultDeadlineMs?: number | false;
  /**
   * R3 — fail-closed execution authorization. Under strict, a `start`/`resume`/`cancel`/`loadState`
   * that carries NO principal is not waved through: it reaches `security.executionAuthorizer`
   * with `principal: undefined`, and a policy that does not explicitly allow anonymous refuses
   * it (`executionPolicy()` does by default). Kernel-internal callers (timers, recovery, child
   * supervisor, local worker) present the runtime's system grant instead and are unaffected.
   * `false` restores the permissive principal-less bypass (visible in the config). Default true.
   */
  requirePrincipal?: false;
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

const rateLimitConfigured = (e: AutonomyEnvelopeOptions | undefined): boolean =>
  e?.rateLimit !== undefined && e.rateLimit !== false;

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
  if (!budgetConfigured(p.envelope, true) && !rateLimitConfigured(p.envelope)) {
    // An opt-out of metering is allowed only if something else bounds spend.
    problems.push(
      "no spend bound is in effect (`execution.envelope.budget`/`perExecution` switched off with no `perAgent`/`perTenant`, and no `rateLimit`) — set at least one budget or a `rateLimit`."
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
 * Apply a default execution deadline to every flow that declares none — by wrapping
 * `runtime.start` ONLY, NOT by rewriting definitions (the deadline is part of the flow
 * fingerprint, so rewriting would invalidate every in-flight execution the day strict is turned
 * on). An explicit `options.deadlineMs` and a flow's own `deadlineMs` both win.
 *
 * `resume`, `resumeAs` and `restoreFromState` are deliberately NOT wrapped. The kernel anchors a
 * deadline to the execution's logged start but never stores the deadline itself, so every
 * resume (a human approval, a timer, `recoverAbandoned`, a worker, a parent resume) re-arms
 * `options.deadlineMs ?? flow.deadlineMs`. Injecting the default there would cancel any
 * execution parked longer than it — including one started WITHOUT strict, or started with a
 * longer explicit deadline. So the default is a property of executions STARTED under strict in
 * this process; it is not durable per execution (a durable deadline is a kernel change).
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
  const explicit = (options: unknown): boolean =>
    (options as { deadlineMs?: number } | undefined)?.deadlineMs !== undefined;

  const start = rt.start as Loose;
  rt.start = (flow, input, options) =>
    explicit(options)
      ? start.call(runtime, flow, input, options)
      : start.call(runtime, flow, input, {
          ...(options as object | undefined),
          deadlineMs: declaredOf(flow) ?? defaultMs,
        });
}
