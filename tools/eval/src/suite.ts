import { createHash } from "node:crypto";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";

// ── An LLM evaluation harness (R18, ADR 0124) ────────────────────────────────
//
// `replayAsFixture` / `diffRuns` / `scoreRun` answer "did the flow change?" from a recorded log.
// They cannot answer "is the answer GOOD?" across a set of inputs, or "did this prompt change
// make it worse?". This is the suite runner for that: a set of cases, a subject under test
// (a flow, an agent, a bare provider call), pluggable graders, and a report that is a pure
// function of its inputs - no clock, no random, no network when the provider is a cassette - so
// a run can be diffed against yesterday's byte for byte and a regression is a failing assertion.

export interface EvalCase<I = unknown> {
  id: string;
  input: I;
  /** What a correct answer looks like; graders decide how to use it. */
  expected?: unknown;
  tags?: readonly string[];
}

/** What a grader sees about one case. */
export interface CaseRun<O = unknown> {
  case: EvalCase;
  output: O;
}

export interface GradeResult {
  /** In [0,1]. */
  score: number;
  pass: boolean;
  detail?: string;
}

export interface Grader<O = unknown> {
  readonly name: string;
  grade(run: CaseRun<O>): GradeResult | Promise<GradeResult>;
}

export interface GraderSpec<O = unknown> {
  grader: Grader<O>;
  /** Relative weight in the case score. Default 1. */
  weight?: number;
  /** A failing required grader fails the case whatever the weighted score. Default false. */
  required?: boolean;
}

export type Subject<I = unknown, O = unknown> = (input: I, c: EvalCase<I>) => Promise<O>;

export interface EvalSuiteOptions<I = unknown, O = unknown> {
  name: string;
  cases: readonly EvalCase<I>[];
  subject: Subject<I, O>;
  graders: readonly (Grader<O> | GraderSpec<O>)[];
  /** A case passes when every required grader passes AND its weighted score >= this. Default 1. */
  passScore?: number;
  /** Cases run at once. Default 1 (strict order). Results are always reported in case order. */
  concurrency?: number;
  /**
   * Content-addressed versions in force for this run, e.g. `{ prompt: promptVersion(...), model:
   * modelVersion(...) }` from `@loom/learning`. Carried into the report so two runs can be
   * compared by what produced them.
   */
  versions?: Record<string, { id: string; version: string }>;
}

export interface GraderOutcome extends GradeResult {
  grader: string;
  weight: number;
  required: boolean;
}

export interface CaseResult {
  id: string;
  tags: string[];
  status: "passed" | "failed" | "errored";
  score: number;
  graders: GraderOutcome[];
  /** The subject (or a grader) threw: the message, bounded. */
  error?: string;
}

export interface EvalSuiteReport {
  suite: string;
  versions?: Record<string, { id: string; version: string }>;
  cases: CaseResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    /** Mean case score over ALL cases (an errored case scores 0 - it never silently drops out). */
    meanScore: number;
    passRate: number;
    byTag: Record<string, { total: number; passed: number; meanScore: number }>;
    byGrader: Record<string, { evaluated: number; passed: number; meanScore: number }>;
  };
}

const MAX_CASES = 100_000;
const MAX_ERROR = 500;

const normalize = <O>(g: Grader<O> | GraderSpec<O>): GraderSpec<O> =>
  "grader" in g ? g : { grader: g };

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

async function runCase<I, O>(
  c: EvalCase<I>,
  opts: EvalSuiteOptions<I, O>,
  specs: GraderSpec<O>[],
  passScore: number
): Promise<CaseResult> {
  const tags = [...(c.tags ?? [])].sort();
  let output: O;
  try {
    output = await opts.subject(c.input, c);
  } catch (e) {
    return {
      id: c.id,
      tags,
      status: "errored",
      score: 0,
      graders: [],
      error: `subject threw: ${String((e as Error)?.message ?? e).slice(0, MAX_ERROR)}`,
    };
  }
  const outcomes: GraderOutcome[] = [];
  let weighted = 0;
  let totalWeight = 0;
  let requiredFailed = false;
  for (const spec of specs) {
    const weight = spec.weight ?? 1;
    const required = spec.required ?? false;
    let r: GradeResult;
    try {
      const raw = await spec.grader.grade({ case: c as EvalCase, output });
      r = {
        score: clamp01(raw.score),
        pass: raw.pass === true,
        ...(raw.detail !== undefined && { detail: raw.detail }),
      };
    } catch (e) {
      // A grader that throws fails closed: it is a failed check, not a skipped one.
      r = {
        score: 0,
        pass: false,
        detail: `grader threw: ${String((e as Error)?.message ?? e).slice(0, MAX_ERROR)}`,
      };
    }
    if (required && !r.pass) requiredFailed = true;
    weighted += weight * r.score;
    totalWeight += weight;
    outcomes.push({ grader: spec.grader.name, weight, required, ...r });
  }
  const score = totalWeight > 0 ? weighted / totalWeight : 0;
  const status = !requiredFailed && score >= passScore && specs.length > 0 ? "passed" : "failed";
  return { id: c.id, tags, status, score, graders: outcomes };
}

/**
 * Run a suite. Deterministic: with a deterministic subject and graders (a cassette provider and
 * non-sampling judges), the report is byte-identical across runs.
 */
export async function runEvalSuite<I = unknown, O = unknown>(
  opts: EvalSuiteOptions<I, O>
): Promise<EvalSuiteReport> {
  if (opts.cases.length > MAX_CASES) throw new Error(`runEvalSuite: more than ${MAX_CASES} cases`);
  const ids = new Set<string>();
  for (const c of opts.cases) {
    if (ids.has(c.id)) throw new Error(`runEvalSuite: duplicate case id "${c.id}"`);
    ids.add(c.id);
  }
  if (opts.graders.length === 0) throw new Error("runEvalSuite: at least one grader is required");
  const passScore = opts.passScore ?? 1;
  const specs = opts.graders.map(normalize);
  for (const s of specs) {
    const w = s.weight ?? 1;
    // A negative weight would invert a grader (a failure raising the score); NaN poisons every case.
    if (!Number.isFinite(w) || w < 0) {
      throw new Error(
        `runEvalSuite: grader "${s.grader.name}" has an invalid weight ${w} (finite, >= 0)`
      );
    }
  }
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));

  const results = new Array<CaseResult>(opts.cases.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= opts.cases.length) return;
      results[i] = await runCase(opts.cases[i] as EvalCase<I>, opts, specs, passScore);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, opts.cases.length) }, worker));

  // Tags and grader names are caller text: accumulate in Maps and build the report objects with
  // `Object.fromEntries`, which defines own properties, so a tag named `__proto__` is a key like
  // any other and cannot rewrite a prototype.
  const byTag = new Map<string, { total: number; passed: number; meanScore: number }>();
  const byGrader = new Map<string, { evaluated: number; passed: number; meanScore: number }>();
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let sum = 0;
  for (const r of results) {
    sum += r.score;
    if (r.status === "passed") passed += 1;
    else if (r.status === "failed") failed += 1;
    else errored += 1;
    for (const tag of r.tags) {
      const t = byTag.get(tag) ?? { total: 0, passed: 0, meanScore: 0 };
      t.meanScore = (t.meanScore * t.total + r.score) / (t.total + 1);
      t.total += 1;
      if (r.status === "passed") t.passed += 1;
      byTag.set(tag, t);
    }
    for (const g of r.graders) {
      const s = byGrader.get(g.grader) ?? { evaluated: 0, passed: 0, meanScore: 0 };
      s.meanScore = (s.meanScore * s.evaluated + g.score) / (s.evaluated + 1);
      s.evaluated += 1;
      if (g.pass) s.passed += 1;
      byGrader.set(g.grader, s);
    }
  }
  const total = results.length;
  return {
    suite: opts.name,
    ...(opts.versions !== undefined && { versions: opts.versions }),
    cases: results,
    summary: {
      total,
      passed,
      failed,
      errored,
      meanScore: total === 0 ? 0 : sum / total,
      passRate: total === 0 ? 0 : passed / total,
      byTag: Object.fromEntries(byTag),
      byGrader: Object.fromEntries(byGrader),
    },
  };
}

// ── Reports ─────────────────────────────────────────────────────────────────

function sortedJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val !== null && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val
  );
}

/** A stable digest of a report: equal digests mean equal results. */
export function reportDigest(report: EvalSuiteReport): string {
  return `sha256:${createHash("sha256").update(sortedJson(report)).digest("hex")}`;
}

export interface Regression {
  id: string;
  kind: "score-dropped" | "now-failing" | "missing" | "now-errored";
  from?: number;
  to?: number;
}

/**
 * Compare a candidate run to a baseline of the same suite. A regression is a case that got
 * worse: its score dropped by more than `tolerance` (default 0), it flipped from passed to
 * failed/errored, or it vanished. A case only in the candidate is not a regression.
 */
export function compareReports(
  baseline: EvalSuiteReport,
  candidate: EvalSuiteReport,
  opts: { tolerance?: number } = {}
): Regression[] {
  const tol = opts.tolerance ?? 0;
  const cand = new Map(candidate.cases.map((c) => [c.id, c]));
  const out: Regression[] = [];
  for (const b of baseline.cases) {
    const c = cand.get(b.id);
    if (c === undefined) {
      out.push({ id: b.id, kind: "missing" });
    } else if (b.status === "passed" && c.status === "errored") {
      out.push({ id: b.id, kind: "now-errored", from: b.score, to: c.score });
    } else if (b.status === "passed" && c.status === "failed") {
      out.push({ id: b.id, kind: "now-failing", from: b.score, to: c.score });
    } else if (c.score < b.score - tol) {
      out.push({ id: b.id, kind: "score-dropped", from: b.score, to: c.score });
    }
  }
  return out;
}

export function formatSuiteReport(report: EvalSuiteReport): string {
  const s = report.summary;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `Suite ${report.suite}: ${s.passed}/${s.total} passed (${pct(s.passRate)}), mean score ${s.meanScore.toFixed(4)}${s.errored > 0 ? `, ${s.errored} errored` : ""}`,
  ];
  for (const [k, v] of Object.entries(report.versions ?? {}))
    lines.push(`  ${k}: ${v.id}@${v.version}`);
  for (const [tag, t] of Object.entries(s.byTag).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`  [${tag}] ${t.passed}/${t.total}, mean ${t.meanScore.toFixed(4)}`);
  }
  for (const c of report.cases) {
    if (c.status === "passed") continue;
    lines.push(`  ${c.status.toUpperCase()} ${c.id} (score ${c.score.toFixed(3)})`);
    if (c.error !== undefined) lines.push(`    ${c.error}`);
    for (const g of c.graders)
      if (!g.pass) lines.push(`    - ${g.grader}: ${g.detail ?? "failed"}`);
  }
  return lines.join("\n");
}

// ── Recorded / stub providers ────────────────────────────────────────────────

export class CassetteMissError extends Error {
  constructor(readonly key: string) {
    super(
      `no recorded response for request ${key}; re-record the cassette (mode "record") after changing a prompt, model parameter or case input`
    );
    this.name = "CassetteMissError";
    Object.setPrototypeOf(this, CassetteMissError.prototype);
  }
}

/** The part of a request that determines the answer. `signal` is not part of the identity. */
function requestKey(req: LlmRequest): string {
  const { signal: _signal, ...rest } = req;
  return `req:${createHash("sha256").update(sortedJson(rest)).digest("hex").slice(0, 32)}`;
}

export type CassetteData = Record<string, LlmResponse>;

/**
 * An `LlmProvider` that serves recorded responses. `replay` (default) NEVER calls a model: a
 * request with no recording throws {@link CassetteMissError} - the eval fails loudly rather than
 * reaching the network or inventing an answer. `record` forwards to `inner` and stores what comes
 * back, for you to commit.
 */
export class CassetteProvider implements LlmProvider {
  private readonly data: Map<string, LlmResponse>;
  readonly misses: string[] = [];

  constructor(
    private readonly opts: {
      mode?: "replay" | "record";
      inner?: LlmProvider;
      data?: CassetteData;
    } = {}
  ) {
    if (opts.mode === "record" && opts.inner === undefined) {
      throw new Error("CassetteProvider: record mode needs an inner provider");
    }
    this.data = new Map(Object.entries(opts.data ?? {}));
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const key = requestKey(request);
    const hit = this.data.get(key);
    if (hit !== undefined) return structuredClone(hit);
    if (this.opts.mode === "record" && this.opts.inner !== undefined) {
      const res = await this.opts.inner.complete(request);
      this.data.set(key, structuredClone(res));
      return res;
    }
    this.misses.push(key);
    throw new CassetteMissError(key);
  }

  /** The cassette as plain JSON, keys sorted, ready to commit. */
  toJSON(): CassetteData {
    return Object.fromEntries([...this.data].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}

/** A provider that answers from a pure function of the request: for tests of the harness itself. */
export function stubProvider(answer: (req: LlmRequest) => string | LlmResponse): LlmProvider {
  return {
    async complete(req) {
      const a = answer(req);
      return typeof a === "string" ? { content: a, stopReason: "end_turn" } : a;
    },
  };
}
