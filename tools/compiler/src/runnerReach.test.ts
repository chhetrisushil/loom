import { describe, expect, it } from "vitest";
import { analyzeRunnerReach } from "./runnerReach";

describe("runner-body reach analysis", () => {
  it("resolves a ctx.run target bound to a step$ in the same region", () => {
    const reach = analyzeRunnerReach(`
      const charge = step$({ id: "charge", toolId: "payments.charge" });
      export const runner = async (ctx) => { await ctx.run(charge, { amount: 1 }); };
    `);
    expect(reach.steps).toEqual([{ toolId: "payments.charge", stepId: "charge" }]);
    expect(reach.unresolved).toEqual([]);
  });

  it("resolves through a project wrapper, because it matches on shape not on the name step$", () => {
    const reach = analyzeRunnerReach(`
      const audit = myStep$({ id: "audit", toolId: "audit.write" });
      export const runner = async (ctx) => { await ctx.run(audit, {}); };
    `);
    expect(reach.steps).toEqual([{ toolId: "audit.write", stepId: "audit" }]);
  });

  it("reads an inline step object literal", () => {
    const reach = analyzeRunnerReach(`
      const runner = async (ctx) => {
        await ctx.run({ id: "inline", toolId: "llm.summarize" }, {});
      };
    `);
    expect(reach.steps).toEqual([{ toolId: "llm.summarize", stepId: "inline" }]);
  });

  // ── The half that matters more: what it CANNOT resolve is reported, not dropped.

  it("reports an imported binding as unresolved rather than silently omitting it", () => {
    const reach = analyzeRunnerReach(`
      import { chargeCard } from "./steps";
      const runner = async (ctx) => { await ctx.run(chargeCard, {}); };
    `);
    expect(reach.steps).toEqual([]);
    expect(reach.unresolved).toEqual([{ expr: "chargeCard", kind: "step" }]);
  });

  it("reports a minted step as unresolved — its toolId is runtime data", () => {
    const reach = analyzeRunnerReach(`
      const runner = async (ctx) => { await ctx.run(mcpInvoke$("hydrate#0"), {}); };
    `);
    expect(reach.unresolved).toEqual([{ expr: 'mcpInvoke$("hydrate#0")', kind: "step" }]);
  });

  it("bounds the recorded expression text", () => {
    const long = `someHelper(${"x".repeat(200)})`;
    const reach = analyzeRunnerReach(`const r = async (ctx) => { await ctx.run(${long}, {}); };`);
    expect(reach.unresolved[0]?.expr.length).toBeLessThanOrEqual(80);
    expect(reach.unresolved[0]?.expr.endsWith("…")).toBe(true);
  });

  // ── Suspend points: the input FlowSpec.suspends never had a producer for.

  it("reads a suspend condition's on / correlationKey / timeout / wakeAt", () => {
    const reach = analyzeRunnerReach(`
      const runner = async (ctx) => {
        await ctx.suspend({ on: "Approved", correlationKey: "ticket-7" });
        await ctx.suspend({ on: "Late", timeout: 5000 });
        await ctx.suspend({ on: "Timed", timeout: 5000, wakeAt: 123 });
      };
    `);
    expect(reach.suspends).toEqual([
      { id: "Approved", correlationKey: "ticket-7" },
      { id: "Late", timed: true },
      { id: "Timed", timed: true, wakeAt: true },
    ]);
  });

  it("survives the ctx.suspend<T> generic form", () => {
    const reach = analyzeRunnerReach(`
      const runner = async (ctx) => { await ctx.suspend<Approval>({ on: "Approved" }); };
    `);
    expect(reach.suspends).toEqual([{ id: "Approved" }]);
  });

  it("reports a condition built outside the call as unresolved, not as absent", () => {
    // A flow that suspends must never look like a flow that does not.
    const reach = analyzeRunnerReach(`
      const runner = async (ctx) => { await ctx.suspend(gateCondition); };
    `);
    expect(reach.suspends).toEqual([]);
    expect(reach.unresolved).toEqual([{ expr: "gateCondition", kind: "suspend" }]);
  });

  it("ignores ctx.sleep / sleepUntil — the kernel authors those conditions", () => {
    // `sleep` suspends on TIMER_FIRED with wakeAt always set. Recording them
    // would manufacture findings about code the developer never wrote.
    const reach = analyzeRunnerReach(`
      const runner = async (ctx) => { await ctx.sleep(1000); await ctx.sleepUntil(t); };
    `);
    expect(reach.suspends).toEqual([]);
    expect(reach.unresolved).toEqual([]);
  });

  it("finds targets nested in loops, branches and closures", () => {
    const reach = analyzeRunnerReach(`
      const a = step$({ id: "a", toolId: "t.a" });
      const runner = async (ctx) => {
        for (const x of xs) { if (x) { await ctx.run(a, x); } }
        await Promise.all(xs.map((x) => ctx.run(a, x)));
      };
    `);
    // Both call sites — the guarded loop body and the closure inside `map`.
    expect(reach.steps).toEqual([
      { toolId: "t.a", stepId: "a" },
      { toolId: "t.a", stepId: "a" },
    ]);
  });

  it("is a no-op on a runner that reaches nothing", () => {
    const reach = analyzeRunnerReach("const runner = async () => ({ ok: true });");
    expect(reach).toEqual({ steps: [], unresolved: [], suspends: [] });
  });
});
