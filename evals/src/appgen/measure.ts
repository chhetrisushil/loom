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
import { APPGEN_CASES, type AppgenCase } from "./cases";
import { type Arm, type CaseOutcome, coverage, runCase } from "./subject";
import { type Typechecker, createTypechecker } from "./typecheck";

// ── The appgen metrics ────────────────────────────────────────────────────────
//
//   validity   plans that were accepted, applied inside the fixture and typecheck, over ALL cases (a case whose
//              cassette misses is errored and counts as invalid)
//   coverage   mean over cases of the recall of the expected shape (flows, steps, gates) in the APPLIED app
//
// Two arms over the same intents: `model` (the real `planChangesModel` over cassettes) and `deterministic` (the real
// `planChangesDeterministic`, a reference arm that needs no model at all).

export const store: CassetteStore = cassetteStore("appgen");

export interface SuiteOptions {
  readonly cases?: readonly AppgenCase[];
  readonly arm?: Arm;
  /** The cassette data per case (default: the committed file). The fail-proofs swap in a doctored one. */
  readonly cassette?: (c: AppgenCase) => CassetteData;
  /** One typechecker shared by the whole run (and, in a test file, across runs). */
  readonly typechecker?: Typechecker;
}

export interface SuiteRun {
  readonly arm: Arm;
  readonly report: EvalSuiteReport;
  readonly outcomes: ReadonlyMap<string, CaseOutcome>;
  readonly scores: Scores;
}

const validityGrader: Grader<CaseOutcome> = {
  name: "validity",
  grade: (run) => ({
    score: run.output.valid ? 1 : 0,
    pass: run.output.valid,
    ...(run.output.valid ? {} : { detail: run.output.reasons.join(" | ").slice(0, 400) }),
  }),
};

const coverageGrader: Grader<CaseOutcome> = {
  name: "coverage",
  grade(run) {
    const s = coverage((run.case.input as AppgenCase).expected, run.output.observed);
    return { score: s, pass: s === 1 };
  },
};

export async function runAppgenSuite(o: SuiteOptions = {}): Promise<SuiteRun> {
  const arm = o.arm ?? "model";
  const cases = o.cases ?? APPGEN_CASES;
  const typechecker = o.typechecker ?? createTypechecker();
  const data = o.cassette ?? ((c: AppgenCase) => store.load(c.id));
  const outcomes = new Map<string, CaseOutcome>();
  const evalCases: EvalCase<AppgenCase>[] = cases.map((c) => ({
    id: c.id,
    input: c,
    expected: c.expected,
    tags: c.tags,
  }));
  const report = await runEvalSuite({
    name: `appgen/${arm}`,
    cases: evalCases,
    subject: async (c) => {
      const out = await runCase({
        intent: c.intent,
        fixture: c.fixture,
        arm,
        typechecker,
        ...(arm === "model" && {
          provider: new CassetteProvider({ mode: "replay", data: data(c) }),
        }),
      });
      outcomes.set(c.id, out);
      return out;
    },
    graders: [
      { grader: validityGrader as Grader, required: true },
      { grader: coverageGrader as Grader },
    ],
  });
  // An errored case (a cassette miss) has no outcome: it scores 0 on both, it never drops out of the mean.
  const validity = cases.map((c) => (outcomes.get(c.id)?.valid === true ? 1 : 0));
  const cover = cases.map((c) => {
    const out = outcomes.get(c.id);
    return out === undefined ? 0 : coverage(c.expected, out.observed);
  });
  return {
    arm,
    report,
    outcomes,
    scores: { validity: mean(validity), coverage: mean(cover) },
  };
}

/** Author one case's cassette: the real `planChangesModel` over the hand-written script, recorded. */
export function authorAppgenCassette(
  c: AppgenCase,
  typechecker: Typechecker = createTypechecker(),
  script = c.script
): Promise<CassetteData> {
  return authorFromScript(
    (provider) =>
      runCase({
        intent: c.intent,
        fixture: c.fixture,
        arm: "model",
        typechecker,
        provider,
      }),
    script
  );
}

export async function measureAppgen(
  floors: Record<Arm, Thresholds>,
  o: SuiteOptions = {}
): Promise<MetricRow[]> {
  const typechecker = o.typechecker ?? createTypechecker();
  const rows: MetricRow[] = [];
  for (const arm of ["model", "deterministic"] as const) {
    const { scores } = await runAppgenSuite({ ...o, arm, typechecker });
    rows.push(...toRows(`appgen/${arm}`, scores, floors[arm]));
  }
  return rows;
}
