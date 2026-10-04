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

    it("P3-2: handing ctx.decide to a library is recorded as an escape (L32); the verifier reports it unresolved unless the callee declares reach", () => {
      const reach = analyzeRunnerReach(
        "const r = async (ctx, q) => { await kb.retrieve(q, { decide: ctx.decide }); };"
      );
      expect(reach.unresolved).toEqual([]);
      expect(reach.escapes).toEqual([{ callee: "kb.retrieve", root: "kb", via: "decide" }]);
      expect(reach.steps).toEqual([]);
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

  // ── L32: ctx handed to code outside the region ────────────────────────────

  describe("ctx escapes (L32)", () => {
    const escapes = (src: string) => analyzeRunnerReach(src).escapes ?? [];

    it("records ctx passed as an argument, with callee and root", () => {
      const r = analyzeRunnerReach(`
        const runner = async (ctx, input) => { await planner.compose(input, ctx); };
      `);
      expect(r.escapes).toEqual([{ callee: "planner.compose", root: "planner", via: "ctx" }]);
      expect(r.unresolved).toEqual([]);
    });

    it("records ctx inside an object/array argument and `new`", () => {
      expect(escapes("const r = async (ctx) => { await lib.go({ ctx, n: 1 }); };")).toHaveLength(1);
      expect(
        escapes("const r = async (ctx) => { lib.go([ctx]); new Agent(ctx); };").map((e) => e.callee)
      ).toEqual(["lib.go", "Agent"]);
    });

    it("records `{ decide: ctx.decide }` as a decide escape instead of an unresolved alias", () => {
      const r = analyzeRunnerReach(
        "const r = async (ctx) => { await kb.retrieve(q, { decide: ctx.decide }); };"
      );
      expect(r.escapes).toEqual([{ callee: "kb.retrieve", root: "kb", via: "decide" }]);
      expect(r.unresolved).toEqual([]);
    });

    it("a decide alias with no receiving call stays unresolved", () => {
      const r = analyzeRunnerReach("const r = async (ctx) => { const f = ctx.decide; };");
      expect(r.escapes).toBeUndefined();
      expect(r.unresolved[0]?.expr).toContain("decide alias");
    });

    it("ctx stored, aliased or returned is unresolved", () => {
      for (const body of ["const c = ctx;", "holder.ctx = ctx;", "return ctx;"]) {
        const r = analyzeRunnerReach(`const r = async (ctx) => { ${body} };`);
        expect(r.unresolved.some((u) => u.expr.startsWith("ctx stored"))).toBe(true);
      }
    });

    it("passing ctx to a same-module function is NOT an escape (its body is analysed in-region)", () => {
      const r = analyzeRunnerReach(`
        async function helper(ctx) { await ctx.run({ id: "a", toolId: "t.a" }, {}); }
        const r = async (ctx) => { await helper(ctx); };
      `);
      expect(r.escapes).toBeUndefined();
      expect(r.steps).toEqual([{ toolId: "t.a", stepId: "a" }]);
    });

    it("ordinary ctx use is not an escape", () => {
      expect(
        escapes(`
          const r = async (ctx, input) => {
            if (typeof ctx === "undefined" || ctx === null) return;
            const { decide } = ctx;
            await ctx.run({ id: "a", toolId: "t.a" }, input);
            await ctx.suspend({ on: "X" });
          };
        `)
      ).toEqual([]);
    });

    it("deduplicates by callee and via, and recognises a non-ctx name via ctx methods", () => {
      expect(
        escapes("const r = async (c) => { await c.decide('x', d); lib.a(c); lib.a(c); };")
      ).toHaveLength(1);
    });
  });

  // ── L32 review round 1: silent misses from textual ctx-name detection ──────

  describe("ctx escapes — name-independent detection (round 1 P1)", () => {
    const wrap = (runner: string, extra = "") =>
      `${extra}\nconst f = { definition: flow$({ id: "f", version: "1" }), runner: ${runner} };`;
    const reachOf = (src: string) => analyzeRunnerReach(src);
    const lib = (r: { escapes?: { callee: string }[] }) => (r.escapes ?? []).map((e) => e.callee);

    it("a runner's first parameter is ctx whatever it is called", () => {
      expect(lib(reachOf(wrap("async (c) => lib(c)")))).toEqual(["lib"]);
      expect(lib(reachOf(wrap("async (context) => planner.compose(x, context)")))).toEqual([
        "planner.compose",
      ]);
      expect(lib(reachOf(wrap("async function (c) { await lib(c); }")))).toEqual(["lib"]);
    });

    it("registerFlow(def, runner) and a FlowRunner-typed binding identify the runner", () => {
      expect(lib(reachOf("registerFlow(def, async (c) => { await lib(c); });"))).toEqual(["lib"]);
      expect(lib(reachOf("const run: FlowRunner<A, B> = async (c) => { await lib(c); };"))).toEqual(
        ["lib"]
      );
      expect(
        lib(reachOf("const run = async (k) => { await lib(k); };\nregisterFlow(def, run);"))
      ).toEqual(["lib"]);
      expect(lib(reachOf("const o = { runner(c) { return lib(c); } };"))).toEqual(["lib"]);
    });

    it("rest of a destructured ctx IS the ctx; the method values are tracked", () => {
      expect(lib(reachOf(wrap("async ({ run, ...rest }) => lib(rest)")))).toEqual(["lib"]);
      expect(lib(reachOf(wrap("async (ctx) => { const { ...r } = ctx; lib(r); }")))).toEqual([
        "lib",
      ]);
      const r = reachOf(wrap("async ({ decide, ...rest }) => lib(rest)"));
      expect(lib(r)).toEqual(["lib"]);
      expect(r.unresolved.some((u) => u.expr.includes("decide alias"))).toBe(true);
    });

    it("a type alias of ExecutionContext is recognised", () => {
      expect(
        lib(reachOf("type Ctx = ExecutionContext;\nconst x = async (c: Ctx) => lib(c);"))
      ).toEqual(["lib"]);
    });

    it("a same-module helper with ANOTHER param name is followed (fixpoint, transitive)", () => {
      expect(lib(reachOf(wrap("async (ctx) => h(ctx)", "const h = (x) => lib(x);")))).toEqual([
        "lib",
      ]);
      expect(
        lib(reachOf(wrap("async (ctx) => h(ctx)", "function h(c) { return lib(c); }")))
      ).toEqual(["lib"]);
      expect(
        lib(
          reachOf(
            wrap("async (k) => g(k)", "const g = (a) => h(a);\nfunction h(b) { return lib(b); }")
          )
        )
      ).toEqual(["lib"]);
    });

    it("ctx.run inside a helper with another param name resolves its step", () => {
      const r = reachOf(
        wrap(
          "async (ctx) => h(ctx)",
          'const h = async (x) => { await x.run({ id: "a", toolId: "t.a" }, {}); };'
        )
      );
      expect(r.steps).toEqual([{ toolId: "t.a", stepId: "a" }]);
    });

    it("ctx reaching a same-module callee whose parameter cannot be followed is unresolved", () => {
      for (const helper of [
        "const h = ({ a }) => a;",
        "const h = (...args) => lib(args[0]);",
        "const h = () => lib(arguments);",
        "const h = ([a]) => a;",
      ]) {
        const r = reachOf(wrap("async (ctx) => h(ctx)", helper));
        expect(
          r.unresolved.some((u) => u.expr.includes("same-module h")),
          helper
        ).toBe(true);
      }
    });

    it("ctx wrapped in a literal passed to a same-module function is unresolved", () => {
      const r = reachOf(wrap("async (ctx) => h({ c: ctx })", "const h = (o) => lib(o.c);"));
      expect(r.unresolved.some((u) => u.expr.includes("same-module h"))).toBe(true);
    });
  });

  describe("ctx methods handed out (round 1 P2-1)", () => {
    const reachOf = (src: string) => analyzeRunnerReach(src);
    const body = (b: string) => `const r = async (ctx) => { ${b} };`;

    it("lib(ctx.run) / lib(ctx['run']) / const { run } = ctx; lib(run) are escapes naming the member", () => {
      for (const b of [
        "lib(ctx.run);",
        'lib(ctx["run"]);',
        "const { run } = ctx; lib(run);",
        "const { run: go } = ctx; lib({ go });",
      ]) {
        const r = reachOf(body(b));
        expect(r.escapes, b).toEqual([{ callee: "lib", root: "lib", via: "ctx", member: "run" }]);
        expect(r.unresolved, b).toEqual([]);
      }
    });

    it("lib({ run: ctx.run.bind(ctx) }) names lib, not ctx.run.bind", () => {
      const r = reachOf(body("lib({ run: ctx.run.bind(ctx) });"));
      expect(r.escapes).toEqual([{ callee: "lib", root: "lib", via: "ctx", member: "run" }]);
    });

    it("a ctx method stored is unresolved", () => {
      const r = reachOf(body("const g = ctx.run; holder.f = ctx.suspend;"));
      expect(r.unresolved.filter((u) => u.expr.startsWith("ctx.")).length).toBe(2);
    });

    it("ctx handed through Reflect.apply / setTimeout is unwrapped to the real target", () => {
      expect(reachOf(body("Reflect.apply(lib.go, null, [ctx]);")).escapes).toEqual([
        { callee: "lib.go", root: "lib", via: "ctx" },
      ]);
      expect(reachOf(body("setTimeout(lib, 0, ctx);")).escapes?.[0]?.callee).toBe("lib");
      expect(reachOf(body("lib.go.call(null, ctx);")).escapes?.[0]?.callee).toBe("lib.go");
    });

    it("a pass-through whose target is not static is unresolved", () => {
      for (const b of [
        "Reflect.apply(fns[0], null, [ctx]);",
        "Promise.resolve(ctx);",
        "setTimeout(() => 1, 0, ctx);",
      ]) {
        const r = reachOf(body(b));
        expect(r.escapes, b).toBeUndefined();
        expect(r.unresolved.length, b).toBeGreaterThan(0);
      }
    });

    it("a destructured or element-access run is still analysed as ctx.run", () => {
      const r = reachOf(
        `const s = step$({ id: "a", toolId: "t.a" });\n${body(
          'const { run } = ctx; await run(s, {}); await ctx["run"](s, {}); await ctx.run.call(ctx, s, {});'
        )}`
      );
      expect(r.steps.map((x) => x.toolId)).toEqual(["t.a", "t.a", "t.a"]);
      expect(r.unresolved).toEqual([]);
    });

    it("ctx.run.apply and a dynamic ctx[k] are unresolved; data properties are not escapes", () => {
      expect(reachOf(body("await ctx.run.apply(ctx, [s, {}]);")).unresolved.length).toBe(1);
      expect(reachOf(body("await ctx[k](1);")).unresolved.length).toBe(1);
      const r = reachOf(body("lib(ctx.executionId, ctx.workflowId);"));
      expect(r.escapes).toBeUndefined();
      expect(r.unresolved).toEqual([]);
    });
  });
});
