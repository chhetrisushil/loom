import { beforeAll, describe, expect, it } from "vitest";
import { type Scores, failingMetrics } from "../gate";
import {
  REAL_SETUP,
  SETUPS,
  reversedRankerFactory,
  scoreToolSearch,
  toolSearchWith,
} from "./measure";
import { TOOL_SEARCH_THRESHOLDS } from "./thresholds";

// ADR 0131 D4.1: a retrieval regression gate in the normal suite. The REAL configuration must clear the
// committed floors; each DEGRADED configuration (verification (b)) must fall below them and the failure must
// NAME the metric that proves it. Every degraded test is paired with the real run clearing the same floors in
// the same file, so the failure is the degradation and not a broken harness.

describe("tool search eval (ADR 0125 D13/D15)", () => {
  const scores: Record<string, Scores> = {};

  beforeAll(async () => {
    scores.real = await scoreToolSearch(toolSearchWith(SETUPS.real));
    scores.factory = await scoreToolSearch(toolSearchWith(SETUPS.factory));
    scores.reversed = await scoreToolSearch(
      toolSearchWith({ ...REAL_SETUP, ranker: reversedRankerFactory })
    );
    scores.noStoplist = await scoreToolSearch(toolSearchWith({ ...REAL_SETUP, stopwords: [] }));
    scores.noAnnotations = await scoreToolSearch(toolSearchWith({}));
  });

  it("the real built-in ranker clears every floor", () => {
    expect(failingMetrics(scores.real as Scores, TOOL_SEARCH_THRESHOLDS)).toEqual([]);
  });

  it("a custom ranker FACTORY built from the sanitized docs clears the same floors (two-ranker path)", () => {
    expect(failingMetrics(scores.factory as Scores, TOOL_SEARCH_THRESHOLDS)).toEqual([]);
  });

  it("FAIL-PROOF: a ranker returning its results reversed falls below the floors, naming recall and mrr", () => {
    const failing = failingMetrics(scores.reversed as Scores, TOOL_SEARCH_THRESHOLDS);
    expect(failing).toContain("mrr");
    expect(failing).toContain("recall@3");
    expect(failing).toContain("mrr:plain");
  });

  it("FAIL-PROOF: an emptied stoplist falls below the floors, naming the stoplist page precision", () => {
    const failing = failingMetrics(scores.noStoplist as Scores, TOOL_SEARCH_THRESHOLDS);
    expect(failing).toContain("precision:stoplist");
    // Finding, pinned: ranking alone (MRR) does not notice the stoplist; the page it returns does.
    expect(failing).not.toContain("mrr:stoplist");
  });

  it("FAIL-PROOF: ignoring the host annotations falls below the floors, naming the annotation slice", () => {
    expect(failingMetrics(scores.noAnnotations as Scores, TOOL_SEARCH_THRESHOLDS)).toContain(
      "mrr:annotation"
    );
  });

  it("the degradations are real: each one scores strictly below the real ranker on the metric it names", () => {
    const real = scores.real as Scores;
    expect((scores.reversed as Scores).mrr).toBeLessThan(real.mrr as number);
    expect((scores.noStoplist as Scores)["precision:stoplist"]).toBeLessThan(
      real["precision:stoplist"] as number
    );
    expect((scores.noAnnotations as Scores)["mrr:annotation"]).toBeLessThan(
      real["mrr:annotation"] as number
    );
  });
});
