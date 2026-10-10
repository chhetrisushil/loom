import { describe, expect, it } from "vitest";
import { analyzeReachNode, analyzeRunnerReach } from "./runnerReach";

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

  it("reports a minted step whose factory is unknown as unresolved — its toolId is runtime data", () => {
    const reach = analyzeRunnerReach(`
      const runner = async (ctx) => { await ctx.run(mintStep("hydrate#0"), {}); };
    `);
    expect(reach.unresolved).toEqual([{ expr: 'mintStep("hydrate#0")', kind: "step" }]);
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

    it("ctx stored, let-aliased or returned (a const alias is followed instead) is unresolved", () => {
      for (const body of ["let c = ctx;", "holder.ctx = ctx;", "return ctx;"]) {
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
  describe("round 2 — runners that are not a followable function (P2)", () => {
    const reachOf = (src: string) => analyzeRunnerReach(src);
    const callees = (r: { escapes?: { callee: string }[] }) =>
      (r.escapes ?? []).map((e) => e.callee);
    const notAnalysable = (r: { unresolved: { expr: string }[] }) =>
      r.unresolved.filter((u) => u.expr.startsWith("runner not analysable"));

    it("a wrapper call around an inline runner: the literal's first param is ctx, the wrapper is unresolved", () => {
      const r = reachOf(
        'const f = flow$({ id: "f", version: "1", runner: withRetry(async (c) => lib(c)) });'
      );
      expect(callees(r)).toEqual(["lib"]);
      expect(notAnalysable(r)).toHaveLength(1);
    });

    it("a `get runner()` accessor: its returned function is the runner; anything else is refused", () => {
      const ok = reachOf("class F { get runner() { return async (c) => lib(c); } }");
      expect(callees(ok)).toEqual(["lib"]);
      expect(notAnalysable(ok)).toHaveLength(0);
      const opaque = reachOf("class F { get runner() { return pick(); } }");
      expect(notAnalysable(opaque)).toHaveLength(1);
    });

    it("a wrapped runner bound to a const and referenced by name is followed", () => {
      const r = reachOf(
        "const r = withRetry(async (c) => lib(c));\nconst f = flow$({ runner: r });"
      );
      expect(callees(r)).toEqual(["lib"]);
      expect(notAnalysable(r)).toHaveLength(1);
    });

    it("a factory call with no function literal is refused, not skipped", () => {
      const r = reachOf("const f = flow$({ runner: makeRunner(lib) });");
      expect(notAnalysable(r)).toHaveLength(1);
      expect(notAnalysable(r)[0]?.expr).toContain("makeRunner(lib)");
    });

    it("a local factory whose every return is a function: the returned function is the runner, no refusal", () => {
      const r = reachOf(
        "function make(l) { return async (c) => l(c); }\nconst f = flow$({ runner: make(lib) });"
      );
      expect(callees(r)).toEqual(["l"]);
      expect(notAnalysable(r)).toHaveLength(0);
      const mixed = reachOf(
        "function make(l) { if (l) return async (c) => l(c); return other(); }\nconst f = flow$({ runner: make(lib) });"
      );
      expect(notAnalysable(mixed)).toHaveLength(1);
    });

    it("a class property runner with a function initializer is identified", () => {
      const r = reachOf("class F { runner = async (c) => lib(c); }");
      expect(callees(r)).toEqual(["lib"]);
    });

    it("an imported runner is refused", () => {
      const r = reachOf(
        'import { importedRunner } from "./r";\nconst f = flow$({ runner: importedRunner });'
      );
      expect(notAnalysable(r)).toHaveLength(1);
      expect(notAnalysable(r)[0]?.expr).toContain("importedRunner");
    });

    it("registerFlow arg 2 and a FlowRunner-typed initializer get the same refusal", () => {
      expect(notAnalysable(reachOf("registerFlow(def, imported);"))).toHaveLength(1);
      expect(
        notAnalysable(reachOf("const run: FlowRunner<A, B> = wrap(async (c) => lib(c));"))
      ).toHaveLength(1);
      expect(callees(reachOf("registerFlow(def, wrap(async (c) => lib(c)));"))).toEqual(["lib"]);
    });

    it("a followable runner (inline, local function, local const) raises no refusal", () => {
      for (const src of [
        "const f = flow$({ runner: async (c) => { await c.run(s, {}); } });",
        "async function go(c) { await c.run(s, {}); }\nconst f = flow$({ runner: go });",
        "const go = async (c) => { await c.run(s, {}); };\nconst f = flow$({ runner: go });",
      ]) {
        expect(notAnalysable(reachOf(src)), src).toHaveLength(0);
      }
    });
  });

  describe("round 2 — ctx-rooted callees and call shapes (P3)", () => {
    const body = (b: string) => `const runner = async (ctx) => { ${b} };`;
    const reachOf = (src: string) => analyzeRunnerReach(src);

    it("setTimeout(ctx.run, 0) / Reflect.apply(ctx.run, ctx, [s]) / ctx.emit('x', ctx) never produce a ctx-rooted escape", () => {
      for (const b of [
        "setTimeout(ctx.run, 0);",
        "Reflect.apply(ctx.run, ctx, [s]);",
        'ctx.emit("x", ctx);',
      ]) {
        const r = reachOf(body(b));
        expect(
          (r.escapes ?? []).filter((e) => e.root === "ctx"),
          b
        ).toEqual([]);
        expect(r.escapes, b).toBeUndefined();
        expect(r.unresolved.length, b).toBeGreaterThan(0);
      }
    });

    it("a comma-operator callee (0, lib)(ctx) names lib", () => {
      const r = reachOf(body("(0, lib)(ctx); (0, lib.go)(ctx);"));
      expect(r.escapes?.map((e) => e.callee)).toEqual(["lib", "lib.go"]);
      expect(r.escapes?.map((e) => e.root)).toEqual(["lib", "lib"]);
    });

    it("a const alias of ctx is followed; a let alias stays stored-unresolved", () => {
      const ok = reachOf(body("const k = ctx; lib(k);"));
      expect(ok.escapes?.map((e) => e.callee)).toEqual(["lib"]);
      expect(ok.unresolved).toEqual([]);
      const bad = reachOf(body("let k = ctx; lib(k);"));
      expect(bad.unresolved.some((u) => u.expr.includes("stored"))).toBe(true);
    });

    it("a tagged template hands-off is rendered readably", () => {
      const r = reachOf(body("tag`x ${ctx} y`;"));
      expect(r.unresolved.map((u) => u.expr).join("|")).toContain("tag`…`");
    });

    it("a 1000-deep reverse-declared helper chain still resolves the leaf escape", () => {
      let src = "const runner = async (ctx) => { h0(ctx); };\n";
      for (let i = 999; i >= 0; i--)
        src +=
          i === 999
            ? `function h${i}(c${i}) { lib(c${i}); }\n`
            : `function h${i}(c${i}) { h${i + 1}(c${i}); }\n`;
      const r = reachOf(src);
      expect(r.escapes?.map((e) => e.callee)).toEqual(["lib"]);
    });
  });
});

// ── L35: ctx.parallel's pair list ────────────────────────────────────────────

describe("ctx.parallel (L35)", () => {
  it("reads each [step, input] pair of an array literal like ctx.run", () => {
    const r = analyzeRunnerReach(`
      const a = step$({ id: "a", toolId: "tool.a" });
      const b = step$({ id: "b", toolId: "tool.b" });
      const runner = async (ctx) => { await ctx.parallel([[a, 1], [b, 2], [{ id: "c", toolId: "tool.c" }, 3]]); };
    `);
    expect(r.steps.map((s) => s.toolId)).toEqual(["tool.a", "tool.b", "tool.c"]);
    expect(r.unresolved).toEqual([]);
  });

  it("follows a const bound to the literal, and `as` wrappers", () => {
    const r = analyzeRunnerReach(`
      const a = step$({ id: "a", toolId: "tool.a" });
      const pairs = [[a, 1]];
      const runner = async (ctx) => { await ctx.parallel(pairs as never, { limit: 2 }); };
    `);
    expect(r.steps.map((s) => s.toolId)).toEqual(["tool.a"]);
    expect(r.unresolved).toEqual([]);
  });

  it("reports a non-literal list, a spread and an unresolvable pair - never silently empty", () => {
    const r = analyzeRunnerReach(`
      const a = step$({ id: "a", toolId: "tool.a" });
      const runner = async (ctx, items) => {
        await ctx.parallel(items.map((i) => [a, i]));
        await ctx.parallel([...more]);
        await ctx.parallel([[imported, 1], [a, 2]]);
        await ctx.parallel([somePair]);
      };
    `);
    expect(r.steps.map((s) => s.toolId)).toEqual(["tool.a"]);
    expect(r.unresolved.map((u) => u.expr)).toEqual([
      "parallel(items.map((i) => [a, i]))",
      "parallel(...more)",
      "imported",
      "parallel branch somePair",
    ]);
  });

  it("walks callback branches (their b.run is found like any run)", () => {
    const r = analyzeRunnerReach(`
      const a = step$({ id: "a", toolId: "tool.a" });
      const runner = async (ctx) => { await ctx.parallel([async (b) => b.run(a, 1)]); };
    `);
    expect(r.steps.map((s) => s.toolId)).toEqual(["tool.a"]);
    expect(r.unresolved).toEqual([]);
  });

  it("reads the element-access, destructured and .call forms too", () => {
    const r = analyzeRunnerReach(`
      const a = step$({ id: "a", toolId: "tool.a" });
      const b = step$({ id: "b", toolId: "tool.b" });
      const c = step$({ id: "c", toolId: "tool.c" });
      const runner = async (ctx) => {
        await ctx["parallel"]([[a, 1]]);
        const { parallel } = ctx;
        await parallel([[b, 1]]);
        await ctx.parallel.call(ctx, [[c, 1]]);
        await ctx.parallel.apply(ctx, [[[a, 1]]]);
      };
    `);
    expect(r.steps.map((s) => s.toolId).sort()).toEqual(["tool.a", "tool.b", "tool.c"]);
    expect(r.unresolved.map((u) => u.expr)).toEqual(["ctx.parallel.apply(…)"]);
  });
});

// ── L37: constant ids and step factories ─────────────────────────────────────

describe("constant ids and step factories (L37)", () => {
  it("resolves a toolId given by a same-module string constant", () => {
    const r = analyzeRunnerReach(`
      const TOOL = "llm.reshape";
      const s = step$({ id: "s", toolId: TOOL });
      const runner = async (ctx) => { await ctx.run(s, {}); await ctx.run({ id: "t", toolId: TOOL }, {}); };
    `);
    expect(r.steps.map((x) => x.toolId)).toEqual(["llm.reshape", "llm.reshape"]);
    expect(r.unresolved).toEqual([]);
  });

  it("resolves mcpInvoke$ whatever its (templated) step id: the EFFECT is mcp.invoke", () => {
    const r = analyzeRunnerReach(`
      import { mcpInvoke$ } from "@loom/plugin-mcp";
      const runner = async (ctx, steps) => {
        for (const s of steps) await ctx.run(mcpInvoke$(\`tool:\${s.id}\`), {});
        await ctx.run(mcpInvoke$("remap-sample"), {});
      };
    `);
    expect(r.steps.map((x) => x.toolId)).toEqual(["mcp.invoke", "mcp.invoke"]);
    expect(r.unresolved).toEqual([]);
  });

  it("a local function named like a known factory wins (shadowing is not guessed past)", () => {
    const r = analyzeRunnerReach(`
      function mcpInvoke$(id) { return somethingElse(id); }
      const runner = async (ctx) => { await ctx.run(mcpInvoke$("x"), {}); };
    `);
    expect(r.steps).toEqual([]);
    expect(r.unresolved).toHaveLength(1);
  });

  it("infers a same-module factory whose toolId is a parameter, with a templated step id", () => {
    const r = analyzeRunnerReach(`
      const LLM_RESHAPE = "llm.reshape";
      function llmStep$(id, toolId) { return step$({ id, name: id, toolId }); }
      const mk = (id, tool) => step$({ id, toolId: tool });
      const fixed = (id) => step$({ id, toolId: "audit.write" });
      const runner = async (ctx, attempt) => {
        await ctx.run(llmStep$(\`reshape@a\${attempt}\`, LLM_RESHAPE), {});
        await ctx.run(mk("m", "tool.m"), {});
        await ctx.run(fixed(\`f\${attempt}\`), {});
      };
    `);
    expect(r.steps.map((x) => x.toolId)).toEqual(["llm.reshape", "tool.m", "audit.write"]);
    expect(r.unresolved).toEqual([]);
  });

  it("a factory argument that is not constant stays unresolved", () => {
    const r = analyzeRunnerReach(`
      function llmStep$(id, toolId) { return step$({ id, toolId }); }
      const runner = async (ctx, name) => {
        await ctx.run(llmStep$("a", name), {});
        await ctx.run(llmStep$("b"), {});
      };
    `);
    expect(r.steps).toEqual([]);
    expect(r.unresolved.map((u) => u.expr)).toEqual(['llmStep$("a", name)', 'llmStep$("b")']);
  });

  it("does not trust a factory with several returns, or a reassigned / duplicated constant", () => {
    const r = analyzeRunnerReach(`
      function two(id, toolId) { if (id) return step$({ id, toolId }); return step$({ id, toolId: "x" }); }
      let LET = "tool.let";
      const DUP = "tool.dup";
      const f = (DUP) => 1;
      const runner = async (ctx) => {
        await ctx.run(two("a", "tool.a"), {});
        await ctx.run({ id: "l", toolId: LET }, {});
        await ctx.run({ id: "d", toolId: DUP }, {});
      };
    `);
    expect(r.steps).toEqual([]);
    expect(r.unresolved).toHaveLength(3);
  });

  it("resolves a const-bound factory call and a template of constants", () => {
    const r = analyzeRunnerReach(`
      const P = "llm";
      function llmStep$(id, toolId) { return step$({ id, toolId }); }
      const s = llmStep$("s", \`\${P}.x\`);
      const runner = async (ctx) => { await ctx.run(s, {}); await ctx.run({ id: "q", toolId: P + ".y" }, {}); };
    `);
    expect(r.steps.map((x) => x.toolId)).toEqual(["llm.x", "llm.y"]);
  });

  it("resolves scope.invokeTransient with a constant tool id", () => {
    const r = analyzeRunnerReach(`
      const T = "kb.search";
      const runner = async (ctx) => { await ctx.decide("d", async (scope) => scope.invokeTransient(T, {})); };
    `);
    expect(r.steps).toEqual([{ toolId: "kb.search", viaDecider: true }]);
  });

  it("pins the first-party fixed factory to the package constant", async () => {
    const { readFileSync } = await import("node:fs");
    const { KNOWN_STEP_FACTORIES } = await import("./runnerReach");
    const src = readFileSync(
      new URL("../../../plugins/mcp/src/mcpInvoke$.ts", import.meta.url),
      "utf8"
    );
    const m = /MCP_INVOKE_TOOL_ID = "([^"]+)"/.exec(src);
    expect(KNOWN_STEP_FACTORIES.mcpInvoke$).toEqual({ fixed: m?.[1] });
    const sb = readFileSync(
      new URL("../../../plugins/sandbox/src/sandboxEval$.ts", import.meta.url),
      "utf8"
    );
    const sm = /SANDBOX_TOOL_ID = "([^"]+)"/.exec(sb);
    expect(KNOWN_STEP_FACTORIES.sandboxEval$).toEqual({ argIndex: 1, default: sm?.[1] });
    expect(sb).toMatch(/toolId: string = SANDBOX_TOOL_ID/);
  });

  it("sandboxEval$ resolves to its default effect, or to a constant override", () => {
    const r = analyzeRunnerReach(`
      import { sandboxEval$ } from "@loom/plugin-sandbox";
      const T = "sandbox.custom";
      const runner = async (ctx, i, v) => {
        await ctx.run(sandboxEval$(\`reshape#\${i}\`), {});
        await ctx.run(sandboxEval$("a", T), {});
        await ctx.run(sandboxEval$("b", v), {});
      };
    `);
    expect(r.steps.map((x) => x.toolId)).toEqual(["sandbox.eval", "sandbox.custom"]);
    expect(r.unresolved.map((u) => u.expr)).toEqual(['sandboxEval$("b", v)']);
  });

  it("infers a parameter default from a same-module factory", () => {
    const r = analyzeRunnerReach(`
      const DEFAULT = "audit.write";
      function mk(id, toolId = DEFAULT) { return step$({ id, toolId }); }
      const runner = async (ctx) => { await ctx.run(mk("a"), {}); await ctx.run(mk("b", "x.y"), {}); };
    `);
    expect(r.steps.map((x) => x.toolId)).toEqual(["audit.write", "x.y"]);
  });
});

// ── L34: a hand-off's step arguments ─────────────────────────────────────────

describe("hand-off step arguments (L34)", () => {
  it("records the arguments that resolve to a step, by position", () => {
    const r = analyzeRunnerReach(`
      import { mcpInvoke$ } from "@loom/plugin-mcp";
      const a = step$({ id: "a", toolId: "tool.a" });
      const runner = async (ctx, items) => {
        await fanout$(ctx, a, items, { limit: 2 });
        await fanout$(ctx, mcpInvoke$(\`f#\${items.length}\`), items);
      };
    `);
    expect(r.escapes).toEqual([
      {
        callee: "fanout$",
        root: "fanout$",
        via: "ctx",
        args: [{ index: 1, step: { toolId: "tool.a", stepId: "a" } }],
      },
      {
        callee: "fanout$",
        root: "fanout$",
        via: "ctx",
        args: [{ index: 1, step: { toolId: "mcp.invoke" } }],
      },
    ]);
  });

  it("two hand-offs to one callee with different steps are BOTH kept", () => {
    const r = analyzeRunnerReach(`
      const a = step$({ id: "a", toolId: "tool.a" });
      const b = step$({ id: "b", toolId: "tool.b" });
      const runner = async (ctx) => { await fanout$(ctx, a, []); await fanout$(ctx, b, []); };
    `);
    expect(r.escapes?.map((e) => e.args?.[0]?.step.toolId)).toEqual(["tool.a", "tool.b"]);
  });

  it("an unresolved step argument is simply absent (the verifier reports the position)", () => {
    const r = analyzeRunnerReach(`
      const runner = async (ctx, s, items) => { await fanout$(ctx, s, items); };
    `);
    expect(r.escapes).toEqual([{ callee: "fanout$", root: "fanout$", via: "ctx" }]);
  });
});

describe("imported constants and factories (L37)", () => {
  it("follows a relative import to the constant and the factory it names", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const ts = (await import("typescript")).default;
    const { createImportResolver } = await import("./importResolve");
    const { analyzeReachNode } = await import("./runnerReach");
    const dir = mkdtempSync(join(tmpdir(), "loom-reach-"));
    try {
      mkdirSync(join(dir, "llm"));
      writeFileSync(
        join(dir, "llm", "effects.ts"),
        `import { step$ } from "@loom/core";
         export const LLM_REPAIR = "llm.repair";
         export const NOT_CONST = String(1);
         export function llmStep$(id: string, toolId: string) { return step$({ id, toolId }); }
         export function multi(id: string) { if (id) return step$({ id, toolId: "a" }); return step$({ id, toolId: "b" }); }`
      );
      const file = join(dir, "flow.ts");
      const src = `
        import { LLM_REPAIR, NOT_CONST, llmStep$, multi } from "./llm/effects.js";
        import { other } from "@pkg/elsewhere";
        const runner = async (ctx, n) => {
          await ctx.run(llmStep$(\`repair@a\${n}\`, LLM_REPAIR), {});
          await ctx.run(llmStep$("x", NOT_CONST), {});
          await ctx.run(multi("m"), {});
          await ctx.run(other("o"), {});
        };`;
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true);
      const importResolver = createImportResolver(sf, file);
      const withImports = analyzeReachNode(sf, undefined, { importResolver });
      expect(withImports.steps.map((s) => s.toolId)).toEqual(["llm.repair"]);
      expect(withImports.unresolved.map((u) => u.expr)).toEqual([
        'llmStep$("x", NOT_CONST)',
        'multi("m")',
        'other("o")',
      ]);
      // Without the resolver the same module is all unresolved (same-module only).
      expect(analyzeReachNode(sf).steps).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("false resolutions are unresolved, never a guess (L34 fix round)", () => {
  const unresolvedOnly = (src: string): void => {
    const r = analyzeRunnerReach(src);
    expect(r.steps).toEqual([]);
    expect(r.unresolved.length).toBeGreaterThan(0);
  };

  it("known factories resolve only from their own package, aliased or via the SDK", () => {
    const direct = analyzeRunnerReach(`
      import { mcpInvoke$ as m } from "@loom/plugin-mcp";
      import { mcpInvoke$ as viaSdk } from "@loom/sdk";
      import { sandboxEval$ } from "@loom/sdk/sandbox";
      const runner = async (ctx) => {
        await ctx.run(m("a")); await ctx.run(viaSdk("b")); await ctx.run(sandboxEval$("c"));
      };`);
    expect(direct.steps.map((s) => s.toolId)).toEqual(["mcp.invoke", "mcp.invoke", "sandbox.eval"]);
    expect(direct.unresolved).toEqual([]);
  });

  it("P1-a: overloaded local mcpInvoke$ is not the plugin's", () => {
    unresolvedOnly(`
      import { step$ } from "@loom/core";
      function mcpInvoke$(id: string): any;
      function mcpInvoke$(id: string, x?: number): any { return step$({ id, toolId: "my.tool" }); }
      const runner = async (ctx) => { await ctx.run(mcpInvoke$("a")); };`);
  });
  it("P1-a: a relative wrapper named mcpInvoke$ is not the plugin's", () => {
    unresolvedOnly(`
      import { mcpInvoke$ } from "./w";
      const runner = async (ctx) => { await ctx.run(mcpInvoke$("a")); };`);
  });
  it("P1-a: another package's export aliased to mcpInvoke$ is not the plugin's", () => {
    unresolvedOnly(`
      import { other as mcpInvoke$ } from "@acme/x";
      const runner = async (ctx) => { await ctx.run(mcpInvoke$("a")); };`);
  });
  it("P1-a: a property call .mcpInvoke$ is not the plugin's", () => {
    unresolvedOnly(`
      const runner = async (ctx) => { await ctx.run(mine.mcpInvoke$("a")); };`);
  });
  it("P1-a: a parameter named mcpInvoke$ is not the plugin's", () => {
    unresolvedOnly(`
      import { mcpInvoke$ as real } from "@loom/plugin-mcp";
      const runner = async (ctx, mcpInvoke$) => { await ctx.run(mcpInvoke$("a")); };`);
  });
  it("P1-a: the plugin's name imported but redeclared elsewhere in the module is unresolved", () => {
    unresolvedOnly(`
      import { mcpInvoke$ } from "@loom/plugin-mcp";
      const other = (mcpInvoke$) => 1;
      const runner = async (ctx) => { await ctx.run(mcpInvoke$("a")); };`);
  });

  const withConst = async (
    src: (file: string) => string
  ): Promise<{ steps: string[]; unresolved: number }> => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const ts = (await import("typescript")).default;
    const { createImportResolver } = await import("./importResolve");
    const dir = mkdtempSync(join(tmpdir(), "loom-reach-fix-"));
    try {
      writeFileSync(join(dir, "c.ts"), `export const T = "real.tool";`);
      const file = join(dir, "flow.ts");
      const sf = ts.createSourceFile(file, src(file), ts.ScriptTarget.ESNext, true);
      const r = analyzeReachNode(sf, undefined, { importResolver: createImportResolver(sf, file) });
      return { steps: r.steps.map((s) => s.toolId), unresolved: r.unresolved.length };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("P1-b: an imported constant is used when unshadowed (control)", async () => {
    const r = await withConst(
      () =>
        `import { T } from "./c"; const runner = async (ctx) => { await ctx.run({ id: "x", toolId: T }); };`
    );
    expect(r).toEqual({ steps: ["real.tool"], unresolved: 0 });
  });
  it("P1-b: a parameter named like the imported constant", async () => {
    const r = await withConst(
      () => `import { T } from "./c";
        const runner = async (ctx) => { await f(ctx, "dyn"); };
        async function f(ctx, T: string) { await ctx.run({ id: "x", toolId: T }); }`
    );
    expect(r.steps).toEqual([]);
    expect(r.unresolved).toBeGreaterThan(0);
  });
  it("P1-b: a destructured binding named like the imported constant", async () => {
    const r = await withConst(
      () => `import { T } from "./c";
        const runner = async (ctx, o) => { const { T } = o; await ctx.run({ id: "x", toolId: T }); };`
    );
    expect(r.steps).toEqual([]);
    expect(r.unresolved).toBeGreaterThan(0);
  });
  it("P1-b: a for-of const named like the imported constant", async () => {
    const r = await withConst(
      () => `import { T } from "./c";
        const runner = async (ctx, o) => { for (const T of o.tools) await ctx.run({ id: "x", toolId: T }); };`
    );
    expect(r.steps).toEqual([]);
    expect(r.unresolved).toBeGreaterThan(0);
  });
  it("P1-b: a catch variable named like the imported constant", async () => {
    const r = await withConst(
      () => `import { T } from "./c";
        const runner = async (ctx) => { try { x(); } catch (T) { await ctx.run({ id: "x", toolId: T }); } };`
    );
    expect(r.steps).toEqual([]);
    expect(r.unresolved).toBeGreaterThan(0);
  });

  const factoryFrom = async (
    dep: string,
    use: string
  ): Promise<{ steps: string[]; unresolved: number }> => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const ts = (await import("typescript")).default;
    const { createImportResolver } = await import("./importResolve");
    const dir = mkdtempSync(join(tmpdir(), "loom-reach-fac-"));
    try {
      writeFileSync(join(dir, "d.ts"), dep);
      const file = join(dir, "flow.ts");
      const src = `import { mk } from "./d"; const runner = async (ctx) => { await ctx.run(${use}); };`;
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true);
      const r = analyzeReachNode(sf, undefined, { importResolver: createImportResolver(sf, file) });
      return { steps: r.steps.map((s) => s.toolId), unresolved: r.unresolved.length };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("P1-c: a factory parameter shadowing a module constant is the parameter", async () => {
    const r = await factoryFrom(
      `const K = "mod.tool"; export function mk(K: string) { return step$({ toolId: K }); }`,
      `mk("dyn")`
    );
    // The effect id is the ARGUMENT ("dyn"), never the module constant.
    expect(r.steps).toEqual(["dyn"]);
    const dynamic = await factoryFrom(
      `const K = "mod.tool"; export function mk(K: string) { return step$({ toolId: K }); }`,
      "mk(ctx.input.t)"
    );
    expect(dynamic.steps).toEqual([]);
    expect(dynamic.unresolved).toBeGreaterThan(0);
  });
  it("P1-c: a body-declared name shadowing a module constant is unresolved", async () => {
    const r = await factoryFrom(
      `const T = "a"; export function mk(id: string) { const T = "z"; return step$({ id, toolId: T }); }`,
      `mk("x")`
    );
    expect(r.steps).toEqual([]);
    expect(r.unresolved).toBeGreaterThan(0);
  });
  it("P1-c: the same-module factory path rejects body-declared identifiers too", () => {
    unresolvedOnly(`
      const T = "a";
      function mk(id) { const T = "z"; return step$({ id, toolId: T }); }
      const runner = async (ctx) => { await ctx.run(mk("x")); };`);
    unresolvedOnly(`
      const K = "mod.tool";
      function mk(K) { return step$({ toolId: K }); }
      const runner = async (ctx, d) => { await ctx.run(mk(d)); };`);
  });

  it("P2-a: a parallel list mutated after binding is unresolved", () => {
    const r = analyzeRunnerReach(`
      const a = step$({ id: "a", toolId: "tool.a" });
      const b = step$({ id: "b", toolId: "tool.b" });
      const runner = async (ctx) => {
        const xs = [[a, 1]];
        xs.push([b, 2]);
        await ctx.parallel(xs);
      };`);
    expect(r.steps).toEqual([]);
    expect(r.unresolved.map((u) => u.expr)).toEqual(["parallel(xs)"]);
  });

  it("P2-b: a step binding shadowed by a parameter is not followed", () => {
    const r = analyzeRunnerReach(`
      const step = step$({ toolId: "safe.tool" });
      function g(ctx, step) { fanout$(ctx, step, []); }
      const runner = async (ctx, s) => { g(ctx, s); };`);
    expect(JSON.stringify(r.escapes ?? [])).not.toContain("safe.tool");
  });
  it("P2-b: two same-named step bindings are ambiguous, not last-wins", () => {
    const r = analyzeRunnerReach(`
      function f(ctx) { const step = step$({ toolId: "one.tool" }); fanout$(ctx, step, []); }
      function g(ctx) { const step = step$({ toolId: "two.tool" }); fanout$(ctx, step, []); }
      const runner = async (ctx) => { f(ctx); g(ctx); };`);
    expect(JSON.stringify(r)).not.toMatch(/one\.tool|two\.tool/);
  });

  it("P2-c: a class named like an outer const shadows it", () => {
    unresolvedOnly(`
      const T = "outer.tool";
      const runner = async (ctx) => { { class T {} await ctx.run({ toolId: T }); } };`);
  });
});

describe("an import and a same-named local elsewhere are ambiguous (L34 re-review)", () => {
  const unresolvedOnly = (src: string): void => {
    const r = analyzeRunnerReach(src);
    expect(r.steps).toEqual([]);
    expect(r.unresolved.length).toBeGreaterThan(0);
  };

  it("an imported step with a same-named binding in another function", () => {
    unresolvedOnly(`
      import { step$ } from "@loom/core";
      import { a } from "./steps";
      function w() { const a = step$({ id: "a", toolId: "t.local" }); return a; }
      const runner = async (ctx) => { await ctx.run(a, {}); };`);
  });
  it("an imported factory with a same-named arrow in another function", () => {
    unresolvedOnly(`
      import { step$ } from "@loom/core";
      import { mk } from "./steps";
      function w() { const mk = (id) => step$({ id, toolId: "t.local" }); return mk; }
      const runner = async (ctx) => { await ctx.run(mk("a")); };`);
  });
  it("an imported factory with a same-named nested function declaration", () => {
    unresolvedOnly(`
      import { step$ } from "@loom/core";
      import { mk } from "./steps";
      function w() { function mk(id) { return step$({ id, toolId: "t.local" }); } return mk; }
      const runner = async (ctx) => { await ctx.run(mk("a")); };`);
  });
  it("the plugin's mcpInvoke$ with a same-named local in another function", () => {
    unresolvedOnly(`
      import { step$ } from "@loom/core";
      import { mcpInvoke$ } from "@loom/plugin-mcp";
      function w(ctx) { const mcpInvoke$ = (id) => step$({ id, toolId: "x.y" }); return mcpInvoke$; }
      const runner = async (ctx) => { await ctx.run(mcpInvoke$("a")); };`);
  });
  it("a default import with a same-named local factory elsewhere", () => {
    unresolvedOnly(`
      import { step$ } from "@loom/core";
      import mk from "./steps";
      function w() { const mk = (id) => step$({ id, toolId: "t.local" }); return mk; }
      const runner = async (ctx) => { await ctx.run(mk("a")); };`);
  });
});
