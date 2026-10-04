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
  // ── L31: scope.invokeTransient inside a ctx.decide decider ────────────────

  describe("decider scope reach (L31)", () => {
    const via = (toolId: string) => ({ toolId, viaDecider: true });

    it("counts scope.invokeTransient with a literal toolId as reached", () => {
      const reach = analyzeRunnerReach(`
        const r = async (ctx) => {
          await ctx.decide("plan", (scope) => scope.invokeTransient("llm.plan", { q: 1 }));
        };
      `);
      expect(reach.steps).toEqual([via("llm.plan")]);
      expect(reach.unresolved).toEqual([]);
    });

    it("handles async function bodies, function expressions and template literals", () => {
      const reach = analyzeRunnerReach(`
        const r = async (ctx) => {
          await ctx.decide("a", async (s) => { const x = await s.invokeTransient(\`t.a\`, {}); return x; });
          await ctx.decide("b", function (s) { return s.invokeTransient("t.b", {}); });
        };
      `);
      expect(reach.steps).toEqual([via("t.a"), via("t.b")]);
      expect(reach.unresolved).toEqual([]);
    });

    it("handles a destructured invokeTransient, including a rename", () => {
      const reach = analyzeRunnerReach(`
        const r = async (ctx) => {
          await ctx.decide("a", ({ invokeTransient }) => invokeTransient("t.a", {}));
          await ctx.decide("b", ({ invokeTransient: call }) => call("t.b", {}));
        };
      `);
      expect(reach.steps).toEqual([via("t.a"), via("t.b")]);
      expect(reach.unresolved).toEqual([]);
    });

    it("finds calls nested in closures inside the decider", () => {
      const reach = analyzeRunnerReach(`
        const r = async (ctx) => {
          await ctx.decide("a", (s) => Promise.all(["x"].map(() => s.invokeTransient("t.a", {}))));
        };
      `);
      expect(reach.steps).toEqual([via("t.a")]);
    });

    it("refuses a non-literal toolId: reported as unresolved, never dropped", () => {
      const reach = analyzeRunnerReach(`
        const r = async (ctx, tool) => {
          await ctx.decide("a", (s) => s.invokeTransient(tool, {}));
          await ctx.decide("b", (s) => s.invokeTransient(\`llm.\${tool}\`, {}));
          await ctx.decide("c", (s) => s.invokeTransient(TOOLS.plan, {}));
        };
      `);
      expect(reach.steps).toEqual([]);
      expect(reach.unresolved.map((u) => u.expr)).toEqual([
        "invokeTransient(tool)",
        "invokeTransient(`llm.${tool}`)",
        "invokeTransient(TOOLS.plan)",
      ]);
      expect(reach.unresolved.every((u) => u.kind === "step")).toBe(true);
    });

    it("refuses a scope that escapes the decider (passed on, aliased, element access)", () => {
      const reach = analyzeRunnerReach(`
        const r = async (ctx) => {
          await ctx.decide("a", (s) => plan(s));
          await ctx.decide("b", (s) => { const t = s; return t.invokeTransient("t.b", {}); });
          await ctx.decide("c", (s) => s["invokeTransient"]("t.c", {}));
          await ctx.decide("d", ({ invokeTransient }) => invokeTransient.call(null, "t.d", {}));
          await ctx.decide("e", ({ ...rest }) => rest.invokeTransient("t.e", {}));
        };
      `);
      expect(reach.steps).toEqual([]);
      expect(reach.unresolved).toHaveLength(5);
    });

    it("a decider that never touches a scope (zero params, or ignored) reaches nothing and is not flagged", () => {
      const reach = analyzeRunnerReach(`
        const r = async (ctx) => {
          await ctx.decide("a", () => pick());
          await ctx.decide("b", (_scope) => pick());
        };
      `);
      expect(reach).toEqual({ steps: [], unresolved: [], suspends: [] });
    });

    it("follows a decider passed by reference when it is declared in the same region", () => {
      const reach = analyzeRunnerReach(`
        const planner = (s) => s.invokeTransient("llm.plan", {});
        function other(s) { return s.invokeTransient("llm.other", {}); }
        const r = async (ctx) => {
          await ctx.decide("a", planner);
          await ctx.decide("b", other);
        };
      `);
      expect(reach.steps).toEqual([via("llm.plan"), via("llm.other")]);
      expect(reach.unresolved).toEqual([]);
    });

    it("refuses a decider passed by reference whose body it cannot see", () => {
      const reach = analyzeRunnerReach(`
        import { planner } from "./planner";
        const r = async (ctx) => {
          await ctx.decide("a", planner);
          await ctx.decide("b", makeDecider());
        };
      `);
      expect(reach.steps).toEqual([]);
      expect(reach.unresolved.map((u) => u.expr)).toEqual([
        "decide(planner)",
        "decide(makeDecider())",
      ]);
    });

    it("does not confuse other invokeTransient receivers outside a decider", () => {
      const reach = analyzeRunnerReach(`
        const r = async (ctx, runtime) => { await runtime.invokeTransient("t.x", {}); };
      `);
      expect(reach).toEqual({ steps: [], unresolved: [], suspends: [] });
    });

    // ── fix round 1 ──────────────────────────────────────────────────────────
    it("P3-1: a name declared twice in the region is unresolved, not last-wins", () => {
      const reach = analyzeRunnerReach(`
        const d = (s) => s.invokeTransient("t.a");
        { const d = (s) => 1; }
        const r = async (ctx) => { await ctx.decide("x", d); };
      `);
      expect(reach.unresolved.map((u) => u.expr)).toEqual(["decide(d)"]);
    });

    it("P3-1: a let/var or reassigned decider name is unresolved", () => {
      const letCase = analyzeRunnerReach(`
        let d = (s) => s.invokeTransient("t.a");
        const r = async (ctx) => { await ctx.decide("x", d); };
      `);
      expect(letCase.unresolved.map((u) => u.expr)).toEqual(["decide(d)"]);
      const reassigned = analyzeRunnerReach(`
        const d = (s) => s.invokeTransient("t.a");
        d = (s) => 1;
        const r = async (ctx) => { await ctx.decide("x", d); };
      `);
      expect(reassigned.unresolved.map((u) => u.expr)).toEqual(["decide(d)"]);
    });

    it("P3-2: an aliased or indirect ctx.decide is unresolved, never silent", () => {
      for (const body of [
        "const d = ctx.decide.bind(ctx); await d('x', (s) => s.invokeTransient('t.a'));",
        "const { decide } = ctx; await decide('x', (s) => s.invokeTransient('t.a'));",
        "await ctx['decide']('x', (s) => s.invokeTransient('t.a'));",
        "await ctx.decide(...args);",
        "const f = ctx.decide; await f('x', g);",
      ]) {
        const reach = analyzeRunnerReach(`const r = async (ctx, args) => { ${body} };`);
        expect(reach.unresolved.length, body).toBeGreaterThan(0);
      }
      const param = analyzeRunnerReach(
        "const r = async ({ decide }) => { await decide('x', (s) => s.invokeTransient('t.a')); };"
      );
      expect(param.unresolved.length).toBeGreaterThan(0);
    });

    it("P3-2: a plain ctx.decide call is not flagged by the alias check", () => {
      const reach = analyzeRunnerReach(
        "const r = async (ctx) => { await ctx.decide('x', (s) => s.invokeTransient('t.a')); await ctx.decide?.('y', (s) => 1); };"
      );
      expect(reach.unresolved).toEqual([]);
      expect(reach.steps).toEqual([via("t.a")]);
    });

    it("destructure edge cases that could bind invokeTransient are unresolved", () => {
      for (const param of ["{ invokeTransient: { x } }", "{ [k]: c }"]) {
        const reach = analyzeRunnerReach(
          `const r = async (ctx, k) => { await ctx.decide("x", (${param}) => 1); };`
        );
        expect(reach.unresolved.length, param).toBeGreaterThan(0);
      }
    });

    it("string-keyed destructure of invokeTransient to a plain name is followed", () => {
      const reach = analyzeRunnerReach(
        'const r = async (ctx) => { await ctx.decide("x", ({ "invokeTransient": c }) => c("t.s")); };'
      );
      expect(reach.steps).toEqual([via("t.s")]);
      expect(reach.unresolved).toEqual([]);
    });

    it("locks in optional-chain and generic call shapes", () => {
      const reach = analyzeRunnerReach(`
        const r = async (ctx) => {
          await ctx.decide("a", (s) => s?.invokeTransient("t.q1"));
          await ctx.decide("b", (s) => s.invokeTransient?.("t.q2"));
          await ctx.decide("c", (s) => s.invokeTransient<X, Y>("t.q3"));
        };
      `);
      expect(reach.steps).toEqual([via("t.q1"), via("t.q2"), via("t.q3")]);
      expect(reach.unresolved).toEqual([]);
    });
  });
});
