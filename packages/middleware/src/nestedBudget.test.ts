import type { EffectContext, ResourceSnapshot } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import { QuotaExceededError, meteringMiddleware } from "./metering";
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

describe("open dimensions in nested budgets (ADR 0115)", () => {
  it("accumulates a custom dimension in the ledger and trips a tenant ceiling on it", async () => {
    const ledger = new BudgetLedger();
    ledger.applyMetered(["tenant:acme"], { costUsd: 0, custom: { credits: 4 } });
    ledger.applyMetered(["tenant:acme"], { custom: { credits: 3, constructor: 9 } });
    expect(ledger.spent("tenant:acme").custom).toEqual({ credits: 7 });
    const mw = nestedBudgetMiddleware({
      ledger,
      pricing: () => ({}),
      scopesOf: () => [
        { level: "tenant", key: "tenant:acme", budget: { maxCustom: { credits: 7 } } },
      ],
    });
    await expect(mw(ctx(), {}, async () => "x")).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("skips built-in and invalid names and caps distinct names at 32 per scope", () => {
    const ledger = new BudgetLedger();
    ledger.applyMetered(["t"], { custom: { tokens: 5, "Bad Name": 1, ok: 1 } });
    expect(ledger.spent("t").custom).toEqual({ ok: 1 });
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`d${i}`, 1]));
    ledger.applyMetered(["u"], { custom: many });
    ledger.applyMetered(["u"], { custom: { d0: 2, d39: 1 } });
    const custom = ledger.spent("u").custom as Record<string, number>;
    expect(Object.keys(custom)).toHaveLength(32);
    expect(custom.d0).toBe(3);
    expect(custom.d39).toBeUndefined();
  });

  it("Budget.maxCustom may not name a built-in dimension", () => {
    expect(() =>
      meteringMiddleware({ pricing: () => ({}), budget: { maxCustom: { tokens: 5 } } })
    ).toThrow(/built-in dimension/);
    expect(() =>
      meteringMiddleware({ pricing: () => ({}), budget: { maxCustom: { credits: 5 } } })
    ).not.toThrow();
  });

  it("refuses a bad scope maxCustom before evaluating any scope (even behind a tripped one)", async () => {
    const next = vi.fn(async () => "x");
    const mw = nestedBudgetMiddleware({
      ledger: new BudgetLedger(),
      pricing: () => ({}),
      scopesOf: () => [
        { level: "tenant", key: "t", budget: { maxCostUsd: 0 } }, // would trip first
        { level: "workflow", key: "w", budget: { maxCustom: { tokens: 5 } } },
      ],
    });
    await expect(mw(ctx(), {}, next)).rejects.toThrow(/built-in dimension/);
    expect(next).not.toHaveBeenCalled();
  });

  it("a later mutation of a metering budget's maxCustom has no effect", async () => {
    const maxCustom: Record<string, number> = { credits: 5 };
    const mw = meteringMiddleware({ pricing: () => ({}), budget: { maxCustom } });
    maxCustom.tokens = 1; // would be refused if validated now; must not be enforced
    maxCustom.credits = 1000;
    const next = vi.fn(async () => "ok");
    await expect(mw(ctx({ resources: { ...zero, custom: { credits: 5 } } }), {}, next)).rejects.toBeInstanceOf(
      QuotaExceededError
    );
  });
});
