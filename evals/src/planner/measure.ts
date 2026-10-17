import {
  type CassetteData,
  CassetteProvider,
  type EvalCase,
  type EvalSuiteReport,
  type Grader,
  runEvalSuite,
} from "@loom/eval";
import { type CassetteStore, authorFromScript, cassetteStore } from "../cassetteFiles";
import { type Scores, type Thresholds, toRows } from "../gate";
import { mean } from "../metrics";
import type { MetricRow } from "../scoreboard";
import { PLANNER_CASES, type PlannerCase } from "./cases";
import { type PlannerOutcome, runPlannerCase, sameGraph } from "./subject";

// ── The planner metrics ───────────────────────────────────────────────────────
//
//   routeAccuracy      cases where IntentRuntime routed to the expected capability BY THE MODEL, or correctly
//                      found none (a model's NONE is final; there is no keyword fallback), over ALL cases
//   graphCorrectness   cases whose planned graph is EXACTLY the expected one (ids, capabilities, args incl. `$from`
//                      bindings, dependsOn; node order; rationale text excluded), or whose expected refusal happened
//
// An errored case (a cassette miss) scores 0 on both: it never drops out of the mean.

export const store: CassetteStore = cassetteStore("planner");

export const routeOk = (c: PlannerCase, o: PlannerOutcome): boolean =>
  c.route === null ? o.route === null : o.route === c.route && o.routedBy === "model";
export const graphOk = (c: PlannerCase, o: PlannerOutcome): boolean => sameGraph(o.graph, c.graph);

export interface SuiteOptions {
  readonly cases?: readonly PlannerCase[];
  /** The cassette data per case (default: the committed file). The fail-proofs swap in a doctored one. */
  readonly cassette?: (c: PlannerCase) => CassetteData;
}

export interface SuiteRun {
  readonly report: EvalSuiteReport;
  readonly outcomes: ReadonlyMap<string, PlannerOutcome>;
  readonly scores: Scores;
}

const routeGrader: Grader<PlannerOutcome> = {
  name: "route",
  grade(run) {
    const c = run.case.input as PlannerCase;
    const ok = routeOk(c, run.output);
    return {
      score: ok ? 1 : 0,
      pass: ok,
      ...(ok
        ? {}
        : { detail: `expected ${c.route}, got ${run.output.route} (by ${run.output.routedBy})` }),
    };
  },
};

const graphGrader: Grader<PlannerOutcome> = {
  name: "graph",
  grade(run) {
    const c = run.case.input as PlannerCase;
    const ok = graphOk(c, run.output);
    return {
      score: ok ? 1 : 0,
      pass: ok,
      ...(ok ? {} : { detail: `got ${JSON.stringify(run.output.graph).slice(0, 300)}` }),
    };
  },
};

export async function runPlannerSuite(o: SuiteOptions = {}): Promise<SuiteRun> {
  const cases = o.cases ?? PLANNER_CASES;
  const data = o.cassette ?? ((c: PlannerCase) => store.load(c.id));
  const outcomes = new Map<string, PlannerOutcome>();
  const evalCases: EvalCase<PlannerCase>[] = cases.map((c) => ({
    id: c.id,
    input: c,
    expected: { route: c.route, graph: c.graph },
    tags: c.tags,
  }));
  const report = await runEvalSuite({
    name: "planner",
    cases: evalCases,
    subject: async (c) => {
      const out = await runPlannerCase(
        c.intent,
        new CassetteProvider({ mode: "replay", data: data(c) })
      );
      outcomes.set(c.id, out);
      return out;
    },
    graders: [
      { grader: routeGrader as Grader, required: true },
      { grader: graphGrader as Grader, required: true },
    ],
  });
  const score = (ok: (c: PlannerCase, out: PlannerOutcome) => boolean): number =>
    mean(
      cases.map((c) => {
        const out = outcomes.get(c.id);
        return out !== undefined && ok(c, out) ? 1 : 0;
      })
    );
  return {
    report,
    outcomes,
    scores: { routeAccuracy: score(routeOk), graphCorrectness: score(graphOk) },
  };
}

/** Author one case's cassette: the real runtimes over the hand-written script, recorded. */
export function authorPlannerCassette(c: PlannerCase, script = c.script): Promise<CassetteData> {
  return authorFromScript((provider) => runPlannerCase(c.intent, provider), script);
}

export async function measurePlanner(
  floors: Thresholds,
  o: SuiteOptions = {}
): Promise<MetricRow[]> {
  const { scores } = await runPlannerSuite(o);
  return toRows("planner/cassette", scores, floors);
}
