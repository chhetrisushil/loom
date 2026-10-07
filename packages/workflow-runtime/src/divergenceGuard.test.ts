import { describe, expect, it } from "vitest";
import { DivergenceGuard, type RecordedFrame } from "./DivergenceGuard";
import { FlowReplayDivergenceError } from "./types";

// ADR 0113 D3 — the guard's own rules, without a runtime around it.
const frames = (
  ids: string[],
  completed: string[] = ids,
  scopes?: Record<string, string>
): RecordedFrame[] =>
  ids.map((id, i) => ({
    id,
    completed: completed.includes(id),
    seq: i + 1,
    ...(scopes !== undefined && { scope: scopes[id] ?? "" }),
  }));
const make = (
  mode: "off" | "warn" | "fail",
  ids: string[],
  completed: string[] = ids,
  warnings: string[] = [],
  scopes?: Record<string, string>
) => new DivergenceGuard("x", mode, frames(ids, completed, scopes), (m) => warnings.push(m));
const skipped = (e: unknown): string[] => (e as FlowReplayDivergenceError).skippedSteps as string[];

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

  it("ranks by the log's first-start order, not by the ids (integer-like ids)", () => {
    // B started first (and failed), then "1" and "2": B is the earliest frame.
    const g = new DivergenceGuard(
      "x",
      "fail",
      [
        { id: "B", completed: false, seq: 1 },
        { id: "1", completed: true, seq: 2 },
        { id: "2", completed: true, seq: 3 },
      ],
      () => {}
    );
    expect(g.refusal("STEP_STARTED", "B")).toBeUndefined(); // nothing recorded before B
  });

  it("legacy log (no scope paths): an open scope judges only frames below its floor", () => {
    const g = make("fail", ["a", "b", "c"]);
    g.scopeOpen("", [], false); // function branches only: nothing known to belong to it
    expect(g.refusal("STEP_STARTED")).toBeUndefined();
    g.visit("b"); // the scope asked for b: a (below it) was recorded before the scope
    expect(skipped(g.refusal("STEP_STARTED"))).toEqual(["a"]);
    const h = make("fail", ["a", "b", "c"]);
    h.scopeOpen("", ["b", "c", "zzz"], false);
    expect(skipped(h.refusal("STEP_STARTED"))).toEqual(["a"]);
    const j = make("fail", ["a", "b", "c"]);
    j.visit("a");
    j.scopeOpen("", ["b", "c"], false);
    expect(j.refusal("STEP_STARTED")).toBeUndefined(); // b, c compared as a set at close
    j.scopeClose();
    expect(j.refusal("STEP_STARTED")).toBeInstanceOf(FlowReplayDivergenceError);
  });

  describe("scope-aware (frames carry their scope path)", () => {
    const sc = { a: "", s1: "/0.0", s2: "/0.1", z: "" };
    it("a step starting in a scope is judged against recorded frames outside it that precede its start", () => {
      const g = make("fail", ["a", "s1", "s2", "z"], undefined, [], sc);
      g.scopeOpen("/0", [], false); // function branches: membership known only from the record
      expect(skipped(g.refusal("STEP_STARTED"))).toEqual(["a"]); // `a` precedes the scope; z follows it
      const h = make("fail", ["a", "s1", "s2", "z"], undefined, [], sc);
      h.visit("a");
      h.scopeOpen("/0", [], false);
      expect(h.refusal("STEP_STARTED")).toBeUndefined(); // s1, s2 are the scope's own: a set at close
      h.scopeClose();
      expect(skipped(h.refusal("STEP_STARTED"))).toEqual(["s1", "s2", "z"]);
    });

    it("a scope with no recorded frames judges every frame outside it", () => {
      const g = make("fail", ["a", "z"], undefined, [], { a: "", z: "" });
      g.scopeOpen("/0", [], false);
      expect(skipped(g.refusal("STEP_STARTED"))).toEqual(["a", "z"]);
    });

    it("a scope of explicit branches provably no longer asks for its own recorded frame", () => {
      const g = make("fail", ["s1", "s2"], undefined, [], { s1: "/0.0", s2: "/0.1" });
      g.scopeOpen("/0", ["s1", "c"], true); // s2 dropped, c added
      expect(skipped(g.refusal("STEP_STARTED"))).toEqual(["s2"]);
      const h = make("fail", ["s1", "s2"], undefined, [], { s1: "/0.0", s2: "/0.1" });
      h.scopeOpen("/0", ["s1"], false); // a function branch may still ask for s2
      expect(h.refusal("STEP_STARTED")).toBeUndefined();
    });

    it("nested scopes: frames of the outer scope stay a set while an inner one runs", () => {
      const g = make("fail", ["s1", "s2"], undefined, [], { s1: "/0.0", s2: "/0.1" });
      g.scopeOpen("/0", [], false);
      g.scopeOpen("/0.0/0", [], false);
      expect(g.refusal("STEP_STARTED")).toBeUndefined();
    });
  });

  it("a served decision exempts exactly innerSteps (an id unrelated to the decision's name)", () => {
    const g = make("fail", ["zz", "x", "y"]);
    g.decisionServed("d", { steps: ["zz"] });
    g.visit("x");
    expect(skipped(g.refusal("EXECUTION_COMPLETED"))).toEqual(["y"]);
    // an EMPTY list is a post-R7 record: the naming convention does NOT apply
    const h = make("fail", ["plan#a", "plan:b"]);
    h.decisionServed("plan", { steps: [] });
    expect(skipped(h.refusal("STEP_STARTED"))).toEqual(["plan#a", "plan:b"]);
  });

  it("without the field (a pre-R7 record) the <decisionId>:/# convention applies", () => {
    const h = make("fail", ["a#skills:select", "a#skills#2", "other", "a#skillsX"]);
    h.decisionServed("a#skills", undefined);
    h.visit("other");
    expect(skipped(h.refusal("EXECUTION_COMPLETED"))).toEqual(["a#skillsX"]);
  });

  it("an overflow record also exempts the frames first started during the decision", () => {
    const g = make("fail", ["a", "i1", "i2", "b"]); // seqs 1..4
    g.decisionServed("d", { steps: ["i1"], overflow: { from: 1, to: 4 } });
    g.visit("a");
    expect(skipped(g.refusal("EXECUTION_COMPLETED"))).toEqual(["b"]); // i2 (seq 3) exempt, b (4) not
  });

  it("off: judges nothing", () => {
    const g = make("off", ["a"]);
    expect(g.refusal("STEP_STARTED")).toBeUndefined();
    expect(g.unvisited).toBe(0);
  });
});
