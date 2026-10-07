import { describe, expect, it } from "vitest";
import { DivergenceGuard } from "./DivergenceGuard";
import { FlowReplayDivergenceError } from "./types";

// ADR 0113 D3 — the guard's own rules, without a runtime around it.
const make = (
  mode: "off" | "warn" | "fail",
  order: string[],
  completed: string[] = order,
  warnings: string[] = []
) => new DivergenceGuard("x", mode, completed, order, (m) => warnings.push(m));

describe("DivergenceGuard", () => {
  it("fail: refuses while a recorded step is unasked, latches, and clears once all are asked", () => {
    const g = make("fail", ["a", "b"]);
    g.visit("a");
    expect(g.refusal("STEP_STARTED")).toBeInstanceOf(FlowReplayDivergenceError);
    g.visit("b"); // asking later does not un-refuse a run that already diverged
    expect(g.refusal("STEP_STARTED")).toBeInstanceOf(FlowReplayDivergenceError);
    const ok = make("fail", ["a", "b"]);
    ok.visit("b");
    ok.visit("a");
    expect(ok.refusal("STEP_STARTED")).toBeUndefined();
  });

  it("warn: reports ONCE, then stops judging (an early return, not a scan per append)", () => {
    const w: string[] = [];
    const g = make("warn", ["a", "b", "c"], undefined, w);
    expect(g.refusal("STEP_STARTED")).toBeUndefined();
    expect(g.refusal("EXECUTION_COMPLETED")).toBeUndefined();
    expect(w).toHaveLength(1);
  });

  it("exempts outcomes, terminals and decision records", () => {
    const g = make("fail", ["a"]);
    for (const k of ["STEP_COMPLETED", "STEP_FAILED", "EXECUTION_FAILED", "DECISION_RECORDED"]) {
      expect(g.refusal(k)).toBeUndefined();
    }
  });

  it("an existing frame is judged only against the frames recorded BEFORE it", () => {
    const g = make("fail", ["a", "b", "c"], ["a", "c"]); // b is recorded but not completed
    expect(g.refusal("STEP_STARTED", "b")).toBeInstanceOf(FlowReplayDivergenceError); // a unasked
    const h = make("fail", ["a", "b", "c"], ["a", "c"]);
    h.visit("a");
    expect(h.refusal("STEP_STARTED", "b")).toBeUndefined(); // c is AFTER b: not judged yet
  });

  it("an open scope judges only frames below its floor", () => {
    const g = make("fail", ["a", "b", "c"]);
    g.scopeOpen([]); // function branches only: nothing known to belong to it
    expect(g.refusal("STEP_STARTED")).toBeUndefined();
    g.visit("b"); // the scope asked for b: a (below it) was recorded before the scope
    expect(g.refusal("STEP_STARTED")).toBeInstanceOf(FlowReplayDivergenceError);
    const h = make("fail", ["a", "b", "c"]);
    h.scopeOpen(["b", "c", "zzz"]); // explicit steps b, c: floor = b
    expect((h.refusal("STEP_STARTED") as FlowReplayDivergenceError).skippedSteps).toEqual(["a"]);
    const j = make("fail", ["a", "b", "c"]);
    j.visit("a");
    j.scopeOpen(["b", "c"]);
    expect(j.refusal("STEP_STARTED")).toBeUndefined(); // b, c compared as a set at close
    j.scopeClose();
    expect(j.refusal("STEP_STARTED")).toBeInstanceOf(FlowReplayDivergenceError); // b, c never asked
  });

  it("a served decision exempts exactly innerSteps, or the <id>:/# convention without them", () => {
    const g = make("fail", ["d#inner", "x", "y"]);
    g.decisionServed("d", ["d#inner"]);
    g.visit("x");
    expect((g.refusal("EXECUTION_COMPLETED") as FlowReplayDivergenceError).skippedSteps).toEqual([
      "y",
    ]);
    const h = make("fail", ["a#skills:select", "a#skills#2", "other", "a#skillsX"]);
    h.decisionServed("a#skills", undefined);
    h.visit("other");
    expect((h.refusal("EXECUTION_COMPLETED") as FlowReplayDivergenceError).skippedSteps).toEqual([
      "a#skillsX", // not a prefix match: a different id that merely starts with the same text
    ]);
  });

  it("off: judges nothing", () => {
    const g = make("off", ["a"]);
    expect(g.refusal("STEP_STARTED")).toBeUndefined();
    expect(g.unvisited).toBe(0);
  });
});
