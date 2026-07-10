import type { EffectContext, ResourceSnapshot } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import { QuotaExceededError } from "./metering";
import { BudgetLedger, type BudgetScope, nestedBudgetMiddleware } from "./nestedBudget";

const zero: ResourceSnapshot = { tokens: 0, costUsd: 0, ms: 0, count: 0 };

function ctx(
  overrides: Partial<EffectContext> = {},
  emit = vi.fn()
): EffectContext & { emit: ReturnType<typeof vi.fn> } {
  return {
    executionId: "e1",
    workflowId: "audit",
    stepId: "s",
    attempt: 1,
    emit,
    resources: zero,
    principal: { tenant: "acme" },
    ...overrides,
  } as EffectContext & { emit: ReturnType<typeof vi.fn> };
}

function scopes(ctx: EffectContext): BudgetScope[] {
  const tenant = (ctx.principal as { tenant?: string } | undefined)?.tenant ?? "none";
  return [
    { level: "tenant", key: `tenant:${tenant}`, budget: { maxCostUsd: 10 } },
    { level: "workflow", key: `workflow:${ctx.workflowId}`, budget: { maxCostUsd: 5 } },
    { level: "execution", key: "", budget: { maxCostUsd: 2 } },
  ];
}

describe("K12.3 — nested budgets (tenant → workflow → execution)", () => {
  it("meters an effect and records the delta into the broader scopes' projection", async () => {
    const ledger = new BudgetLedger();
    const mw = nestedBudgetMiddleware({
      ledger,
      scopesOf: scopes,
      pricing: () => ({ costUsd: 1 }),
    });
    const c = ctx();
    await mw(c, {}, async () => "ok");

    expect(c.emit).toHaveBeenCalledWith(
      "RESOURCE_METERED",
      expect.objectContaining({ costUsd: 1 })
    );
    expect(ledger.spent("tenant:acme").costUsd).toBe(1);
    expect(ledger.spent("workflow:audit").costUsd).toBe(1);
  });

  it("denies at the EXECUTION level (most restrictive) via the pure per-execution fold", async () => {
    const ledger = new BudgetLedger();
    const mw = nestedBudgetMiddleware({ ledger, scopesOf: scopes, pricing: () => ({}) });
    const next = vi.fn(async () => "ok");
    // execution already spent $2 (its own budget) — but tenant/workflow are fine.
    const c = ctx({ resources: { ...zero, costUsd: 2 } });
    await expect(mw(c, {}, next)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(next).not.toHaveBeenCalled();
    expect(c.emit).toHaveBeenCalledWith(
      "QUOTA_EXCEEDED",
      expect.objectContaining({ level: "execution" })
    );
  });

  it("denies at the TENANT level when the cross-execution projection is over budget", async () => {
    const ledger = new BudgetLedger();
    ledger.add("tenant:acme", { costUsd: 10 }); // other executions already spent the tenant's $10
    const mw = nestedBudgetMiddleware({ ledger, scopesOf: scopes, pricing: () => ({}) });
    const next = vi.fn(async () => "ok");
    const c = ctx(); // this execution has spent nothing itself
    await expect(mw(c, {}, next)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(next).not.toHaveBeenCalled();
    // Attributed to the TENANT level (the trip's level, most restrictive here).
    expect(c.emit).toHaveBeenCalledWith(
      "QUOTA_EXCEEDED",
      expect.objectContaining({ level: "tenant" })
    );
  });

  it("most-restrictive wins: the outermost breached level (tenant) denies first", async () => {
    const ledger = new BudgetLedger();
    ledger.add("tenant:acme", { costUsd: 10 }); // tenant over
    ledger.add("workflow:audit", { costUsd: 5 }); // workflow also over
    const mw = nestedBudgetMiddleware({ ledger, scopesOf: scopes, pricing: () => ({}) });
    const c = ctx();
    await expect(
      mw(
        c,
        {},
        vi.fn(async () => "ok")
      )
    ).rejects.toBeInstanceOf(QuotaExceededError);
    // Scopes are checked outermost-first, so the tenant trip is recorded.
    expect(c.emit).toHaveBeenCalledWith(
      "QUOTA_EXCEEDED",
      expect.objectContaining({ level: "tenant" })
    );
  });

  it("BudgetLedger.applyMetered folds a RESOURCE_METERED payload across scope keys", () => {
    const ledger = new BudgetLedger();
    ledger.applyMetered(["tenant:acme", "workflow:audit"], { tokens: 100, costUsd: 0.5 });
    expect(ledger.spent("tenant:acme")).toEqual({ tokens: 100, costUsd: 0.5 });
    expect(ledger.spent("workflow:audit")).toEqual({ tokens: 100, costUsd: 0.5 });
  });
});
