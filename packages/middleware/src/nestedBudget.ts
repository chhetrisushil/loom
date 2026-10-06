import type { EffectContext, EffectMiddleware } from "@loom/effect-runtime";
import {
  type Budget,
  type Pricing,
  QuotaExceededError,
  type ResourceDelta,
  overCustomBudget,
} from "./metering";

// ── K12.3 — nested budgets (tenant → workflow → execution) ────────────────────
//
// The K3 per-execution budget is a pure fold of ONE execution's log
// (`ctx.resources`). A tenant- or workflow-level budget aggregates spend across
// MANY executions' logs — so it is admission control over a PROJECTION
// (eventually consistent), NOT a replay-pure per-execution fold. This is a
// deliberate category change (the amendment states it explicitly): the verdict
// is still durable and logged (QUOTA_EXCEEDED, P9), but the tenant/workflow
// totals live in a ledger the app maintains from the RESOURCE_METERED stream,
// not in any single fold. The most-restrictive bound wins, and each trip is
// attributed to its level.

export interface ScopeSpend {
  tokens: number;
  costUsd: number;
  // ADR 0032 (R1) — additional dimensions, accumulated additively across a scope.
  memBytes?: number;
  wallMs?: number;
  netBytes?: number;
  /** ADR 0115 — open dimensions, accumulated by name (own-property keys only). */
  custom?: Record<string, number>;
}

/**
 * A projection of spend per scope key (e.g. `tenant:acme`, `workflow:audit`).
 * The app updates it from the RESOURCE_METERED event stream (across all of a
 * tenant's executions) — typically in `defineConfig({ onEvent })`. It is
 * eventually consistent by nature; two nodes may briefly under-count, which is
 * the accepted trade-off for cross-execution budgets.
 */
export class BudgetLedger {
  private readonly spend = new Map<string, ScopeSpend>();

  add(scopeKey: string, delta: ResourceDelta): void {
    const cur = this.spend.get(scopeKey) ?? { tokens: 0, costUsd: 0 };
    const memBytes = (cur.memBytes ?? 0) + (delta.memBytes ?? 0);
    const wallMs = (cur.wallMs ?? 0) + (delta.wallMs ?? 0);
    const netBytes = (cur.netBytes ?? 0) + (delta.netBytes ?? 0);
    let custom = cur.custom;
    if (delta.custom !== undefined) {
      custom = { ...cur.custom };
      for (const [name, v] of Object.entries(delta.custom)) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
        if (name === "__proto__" || name === "constructor" || name === "prototype") continue;
        custom[name] = (Object.hasOwn(custom, name) ? (custom[name] as number) : 0) + v;
      }
    }
    this.spend.set(scopeKey, {
      tokens: cur.tokens + (delta.tokens ?? 0),
      ...(custom !== undefined && { custom }),
      costUsd: cur.costUsd + (delta.costUsd ?? 0),
      ...(memBytes > 0 && { memBytes }),
      ...(wallMs > 0 && { wallMs }),
      ...(netBytes > 0 && { netBytes }),
    });
  }

  spent(scopeKey: string): ScopeSpend {
    return this.spend.get(scopeKey) ?? { tokens: 0, costUsd: 0 };
  }

  /** Fold a RESOURCE_METERED event into the given scope keys (from an onEvent hook). */
  applyMetered(scopeKeys: readonly string[], payload: unknown): void {
    const p = payload as {
      tokens?: number;
      costUsd?: number;
      memBytes?: number;
      wallMs?: number;
      netBytes?: number;
      custom?: Record<string, number>;
    };
    const delta: ResourceDelta = {
      ...(p.custom !== undefined &&
        typeof p.custom === "object" &&
        p.custom !== null && { custom: p.custom }),
      ...(p.tokens !== undefined && { tokens: p.tokens }),
      ...(p.costUsd !== undefined && { costUsd: p.costUsd }),
      ...(p.memBytes !== undefined && { memBytes: p.memBytes }),
      ...(p.wallMs !== undefined && { wallMs: p.wallMs }),
      ...(p.netBytes !== undefined && { netBytes: p.netBytes }),
    };
    for (const key of scopeKeys) this.add(key, delta);
  }
}

/** One level of the nesting: a labelled scope key + its budget. */
export interface BudgetScope {
  /** e.g. "tenant", "workflow", "execution" — recorded in the trip for attribution. */
  level: string;
  /** The ledger key this level accumulates under (execution uses ctx.resources instead). */
  key: string;
  budget: Budget;
}

export interface NestedBudgetOptions {
  /** Cost model — same shape as `meteringMiddleware`. */
  pricing: Pricing;
  /** The cross-execution spend projection (tenant/workflow levels). */
  ledger: BudgetLedger;
  /**
   * Resolve the nested scopes for an effect, OUTERMOST (broadest) first. The
   * execution level should use `key: ""` — its spend is read from the pure
   * per-execution fold (`ctx.resources`), not the ledger.
   */
  scopesOf: (ctx: EffectContext) => BudgetScope[];
  /** Injectable clock for the measured `ms`. */
  clock?: () => number;
}

function over(spent: ScopeSpend, b: Budget): boolean {
  return (
    (b.maxCostUsd !== undefined && spent.costUsd >= b.maxCostUsd) ||
    (b.maxTokens !== undefined && spent.tokens >= b.maxTokens) ||
    (b.maxMemBytes !== undefined && (spent.memBytes ?? 0) >= b.maxMemBytes) ||
    (b.maxWallMs !== undefined && (spent.wallMs ?? 0) >= b.maxWallMs) ||
    (b.maxNetBytes !== undefined && (spent.netBytes ?? 0) >= b.maxNetBytes) ||
    overCustomBudget(spent.custom, b.maxCustom) !== null
  );
}

/**
 * K12.3 — nested-budget admission control. Before an effect runs, every scope
 * (tenant → workflow → execution) is checked; the FIRST (most-restrictive)
 * breach denies with a `QUOTA_EXCEEDED` fact attributed to that `level`, and the
 * effect never runs. Otherwise the effect runs, is priced, and its delta is
 * recorded into the ledger's non-execution scopes (the execution level is
 * metered by the durable fold as usual) and emitted as `RESOURCE_METERED`.
 *
 * The execution level reads spend from `ctx.resources` (the pure fold, K3); the
 * broader levels read from the ledger projection.
 */
export function nestedBudgetMiddleware(options: NestedBudgetOptions): EffectMiddleware {
  const now = options.clock ?? (() => Date.now());
  return async (ctx: EffectContext, input: unknown, next): Promise<unknown> => {
    const scopes = options.scopesOf(ctx);

    // Admission control — most-restrictive wins, attributed to its level.
    for (const scope of scopes) {
      const spent: ScopeSpend =
        scope.level === "execution"
          ? {
              tokens: ctx.resources?.tokens ?? 0,
              costUsd: ctx.resources?.costUsd ?? 0,
              ...(ctx.resources?.memBytes !== undefined && { memBytes: ctx.resources.memBytes }),
              ...(ctx.resources?.wallMs !== undefined && { wallMs: ctx.resources.wallMs }),
              ...(ctx.resources?.netBytes !== undefined && { netBytes: ctx.resources.netBytes }),
              ...(ctx.resources?.custom !== undefined && {
                custom: ctx.resources.custom as Record<string, number>,
              }),
            }
          : options.ledger.spent(scope.key);
      if (over(spent, scope.budget)) {
        const reason = `${scope.level} budget exceeded (${scope.key || ctx.executionId})`;
        ctx.emit("QUOTA_EXCEEDED", { stepId: ctx.stepId, reason, level: scope.level });
        throw new QuotaExceededError(reason);
      }
    }

    const start = now();
    const result = await next();
    const ms = now() - start;

    const delta = options.pricing({ stepId: ctx.stepId, input, result, ms });
    ctx.emit("RESOURCE_METERED", {
      ...(delta.tokens !== undefined && { tokens: delta.tokens }),
      ...(delta.costUsd !== undefined && { costUsd: delta.costUsd }),
      ...(delta.custom !== undefined && { custom: delta.custom }),
      ms: delta.ms ?? ms,
    });
    // Update the projection for the broader (non-execution) levels immediately,
    // so within a node successive effects see the running total (the durable
    // fold + cross-node ledger reconcile via the RESOURCE_METERED stream).
    for (const scope of scopes) {
      if (scope.level !== "execution") options.ledger.add(scope.key, delta);
    }
    return result;
  };
}
