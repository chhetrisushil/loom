import { describe, expect, it } from "vitest";
import {
  REACH_DECLARATION,
  assertReachMatches,
  declareReach,
  readReachDeclaration,
  recordReach,
} from "./reach";

describe("reach declarations (L32)", () => {
  it("uses the well-known Symbol.for key so a 3P library needs no import", () => {
    expect(REACH_DECLARATION).toBe(Symbol.for("loom.verify.reach"));
    const lib = { compose() {} };
    Object.defineProperty(lib, Symbol.for("loom.verify.reach"), { value: { run: ["a"] } });
    expect(readReachDeclaration(lib)).toEqual({ run: ["a"] });
  });

  it("declareReach attaches non-enumerably and works on functions", () => {
    const fn = declareReach(() => 1, { transient: ["t"] });
    expect(readReachDeclaration(fn)).toEqual({ transient: ["t"] });
    const obj = declareReach({ x: 1 }, { run: [] });
    expect(JSON.stringify(obj)).toBe('{"x":1}');
    expect(readReachDeclaration(obj)).toEqual({ run: [] });
  });

  it("accepts a plain literal, and treats malformed or absent declarations as undeclared", () => {
    expect(readReachDeclaration({ transient: ["t"] })).toEqual({ transient: ["t"] });
    expect(readReachDeclaration({})).toBeUndefined();
    expect(readReachDeclaration({ run: "x" })).toBeUndefined();
    expect(readReachDeclaration({ run: [1] })).toBeUndefined();
    expect(readReachDeclaration(declareReach({}, { run: 5 as never }))).toBeUndefined();
    expect(readReachDeclaration(null)).toBeUndefined();
    expect(readReachDeclaration("planner")).toBeUndefined();
  });
});

describe("empty declarations", () => {
  it("{ run: [], transient: [] } is a valid 'reaches nothing' declaration; {} is undeclared", () => {
    expect(readReachDeclaration({ run: [], transient: [] })).toEqual({ run: [], transient: [] });
    expect(readReachDeclaration(declareReach({}, { run: [] }))).toEqual({ run: [] });
    expect(readReachDeclaration({})).toBeUndefined();
  });
});

describe("recordReach / assertReachMatches (claim vs reality)", () => {
  const fakeCtx = () => ({
    executionId: "e1",
    run: async (step: { toolId: string }) => step.toolId,
    execute: async (task: { toolId: string }) => task.toolId,
    decide: async (_id: string, decider: (s: unknown) => unknown) =>
      decider({ invokeTransient: async (t: string) => t }),
  });
  // A library that runs one step and one transient call.
  const lib = async (ctx: ReturnType<typeof fakeCtx>) => {
    await ctx.run({ toolId: "a.step" });
    await ctx.decide("d", (s) =>
      (s as { invokeTransient(t: string): unknown }).invokeTransient("b.read")
    );
  };

  it("records what a library actually ran through a wrapped ctx, forwarding results and data", async () => {
    const rec = recordReach();
    const ctx = rec.ctx(fakeCtx());
    expect(ctx.executionId).toBe("e1");
    await lib(ctx);
    expect(rec.recorded).toEqual({ run: ["a.step"], transient: ["b.read"] });
  });

  it("passes when the declaration covers it, and fails when it under-declares (either kind)", async () => {
    const rec = recordReach();
    await lib(rec.ctx(fakeCtx()));
    expect(() =>
      assertReachMatches({ run: ["a.step"], transient: ["b.read"] }, rec.recorded)
    ).not.toThrow();
    expect(() => assertReachMatches({ run: ["a.step"] }, rec.recorded)).toThrow(
      /transient tool "b.read" ran but is not declared/
    );
    // right id, wrong kind
    expect(() =>
      assertReachMatches({ run: ["a.step", "b.read"], transient: [] }, rec.recorded)
    ).toThrow(/transient tool "b.read"/);
  });

  it("over-declaring is allowed unless exact", async () => {
    const rec = recordReach();
    await lib(rec.ctx(fakeCtx()));
    const wide = { run: ["a.step", "z"], transient: ["b.read"] };
    expect(() => assertReachMatches(wide, rec.recorded)).not.toThrow();
    expect(() => assertReachMatches(wide, rec.recorded, { exact: true })).toThrow(
      /"z" is declared but never ran/
    );
  });

  it("a library that reaches nothing matches the empty declaration", () => {
    expect(() =>
      assertReachMatches({ run: [], transient: [] }, recordReach().recorded)
    ).not.toThrow();
  });
  it("records ctx.execute of a task with no toolId — the runtime defaults it to `id`", async () => {
    const rec = recordReach();
    const ctx = rec.ctx({
      execute: async (_t: unknown) => 1,
      run: async (_t: unknown) => 1,
      parallel: async (_p: unknown) => [],
    });
    await ctx.execute({ _tag: "TaskDefinition", kind: "llm", id: "x" });
    await ctx.run({ id: "plain" });
    await ctx.execute({ kind: "llm", id: "ignored", toolId: "explicit" });
    expect(rec.recorded.run).toEqual(["explicit", "plain", "x"]);
  });

  it("records ctx.parallel pair tasks (toolId or defaulted id), and ignores malformed pairs", async () => {
    const rec = recordReach();
    const ctx = rec.ctx({ parallel: async (_p: unknown) => [] });
    await ctx.parallel([[{ toolId: "p.a" }, {}], [{ id: "p.b" }, {}], "not-a-pair", [42, {}]]);
    await ctx.parallel("not-an-array");
    expect(rec.recorded.run).toEqual(["p.a", "p.b"]);
  });
});

describe("stepArgs (L34)", () => {
  it("is a valid declaration on its own and malformed shapes are undeclared", () => {
    expect(readReachDeclaration({ stepArgs: [1] })).toEqual({ stepArgs: [1] });
    expect(readReachDeclaration({ stepArgs: [] })).toEqual({ stepArgs: [] });
    expect(readReachDeclaration({ stepArgs: [-1] })).toBeUndefined();
    expect(readReachDeclaration({ stepArgs: ["1"] })).toBeUndefined();
    expect(readReachDeclaration({ stepArgs: 1 })).toBeUndefined();
  });

  it("passedSteps covers a recorded run tool only under a stepArgs declaration", () => {
    const rec = { run: ["caller.step"], transient: [] };
    assertReachMatches({ stepArgs: [1] }, rec, { passedSteps: ["caller.step"] });
    expect(() => assertReachMatches({ stepArgs: [1] }, rec)).toThrow(/caller\.step/);
    expect(() => assertReachMatches({ stepArgs: [1] }, rec, { passedSteps: ["other"] })).toThrow(
      /caller\.step/
    );
    // Without stepArgs a passed step is NOT a free pass.
    expect(() => assertReachMatches({ run: [] }, rec, { passedSteps: ["caller.step"] })).toThrow(
      /caller\.step/
    );
  });
});
