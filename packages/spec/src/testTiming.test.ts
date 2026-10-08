import { type Dirent, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: a blocking test never gates on wall-clock noise ─────────
//
// CI runs every package's suite concurrently on a shared runner. A test that
// compares single-digit-millisecond timings — a RATIO of two samples, or a tight
// ceiling on an operation that normally takes a few ms — measures the runner's
// load as much as the code: one GC pause or descheduling multiplies a sample.
// Main went red four times in two days on exactly this (`foldScale` O(n) ratios
// at 10.7×, 20.9×, 26.9×, 12.4× against a bound of 10, with nothing regressed),
// and raising the floor once did not fix it. The class is mechanized here.
//
// The rules, for every `*.test.ts` under packages/plugins/tools that is NOT a
// `*.perf.test.ts` (the perf suite is excluded from `pnpm test`, runs in
// `pnpm test:perf` — a non-blocking CI step — and in the nightly flake hunt):
//   1. no `performance.now()` — sub-millisecond timing belongs to the perf suite;
//   2. no ratio of timings (`expect(a / b)` in a file that reads the clock);
//   3. an upper bound on elapsed `Date.now()` time must carry a
//      `// timing-bound: <what the slow path costs>` justification on the same
//      line, and a literal bound must be at least MIN_BOUND_MS. Prefer no bound at
//      all: when the slow path is a hang (a never-settling effect, a stalled
//      lookup), completing within the test timeout IS the proof. A lower bound
//      (`toBeGreaterThan`) is not restricted — a timer cannot fire early.
// Deterministic evidence (call counts, rows scanned, round trips) beats any clock.
//
// Detector notes: it tracks identifiers assigned from `Date.now() - …` so
// `const elapsed = Date.now() - t0; expect(elapsed).toBeLessThan(…)` is caught;
// it is a lint, not a parser, and is exercised below on content that MUST fail.

const REPO_ROOT = resolve(__dirname, "../../..");
const ROOTS = ["packages", "plugins", "tools"];
const SKIP = new Set(["node_modules", "dist", ".turbo", ".vite", "coverage", "build", ".git"]);
const MIN_BOUND_MS = 5_000;

interface TimingViolation {
  line: number;
  rule: "performance-now" | "timing-ratio" | "unjustified-bound" | "bound-too-tight";
  text: string;
}

const UPPER = /\.toBeLessThan(?:OrEqual)?\(\s*([0-9_]+)?/;

function findTimingViolations(source: string): TimingViolation[] {
  const lines = source.split("\n");
  const out: TimingViolation[] = [];
  const readsClock = /\bDate\.now\(\)|\bperformance\.now\(\)/.test(source);
  // identifiers assigned from an elapsed-time expression
  const elapsedIds = new Set<string>();
  for (const l of lines) {
    const m =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Date|performance)\.now\(\)\s*-/.exec(l);
    if (m?.[1] !== undefined) elapsedIds.add(m[1]);
  }
  lines.forEach((text, i) => {
    const line = i + 1;
    const code = text.replace(/\/\/.*$/, "");
    if (/\bperformance\.now\(\)/.test(code)) out.push({ line, rule: "performance-now", text });
    const exp = /\bexpect\(([^;]*?)\)\s*\.\s*toBe(?:Less|Greater)Than/.exec(code);
    if (exp === null) return;
    const arg = exp[1] ?? "";
    if (readsClock && /[^/*]\/[^/*]/.test(arg)) out.push({ line, rule: "timing-ratio", text });
    const timed =
      /\bDate\.now\(\)/.test(arg) ||
      [...elapsedIds].some((id) => new RegExp(`\\b${id.replace(/\$/g, "\\$")}\\b`).test(arg));
    const upper = UPPER.exec(code);
    if (!timed || upper === null) return;
    if (!/\/\/\s*timing-bound:\s*\S/.test(text)) {
      out.push({ line, rule: "unjustified-bound", text });
      return;
    }
    const literal = upper[1];
    if (literal !== undefined && Number(literal.replace(/_/g, "")) < MIN_BOUND_MS)
      out.push({ line, rule: "bound-too-tight", text });
  });
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // vanished mid-walk (another package's scratch dir)
  }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith(".tmp")) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (
      e.name.endsWith(".test.ts") &&
      !e.name.endsWith(".perf.test.ts") &&
      p !== __filename // this file spells the forbidden shapes as detector fixtures
    )
      out.push(p);
  }
}

describe("blocking tests never gate on wall-clock noise (fitness)", () => {
  it("the detector fails on each forbidden shape and passes the allowed ones", () => {
    const bad = [
      "const t = performance.now();",
      "const t0 = Date.now(); expect(t20 / t5).toBeLessThan(10);",
      "const elapsed = Date.now() - t0;\nexpect(elapsed).toBeLessThan(100);",
      "expect(Date.now() - t0).toBeLessThan(1000);",
      "expect(Date.now() - t0).toBeLessThan(1000); // timing-bound: too tight",
    ];
    expect(bad.map((s) => findTimingViolations(s).map((v) => v.rule))).toEqual([
      ["performance-now"],
      ["timing-ratio"],
      ["unjustified-bound"],
      ["unjustified-bound"],
      ["bound-too-tight"],
    ]);
    const good = [
      "expect(Date.now() - t0).toBeGreaterThan(1500);",
      "expect(Date.now() - t0).toBeLessThan(10_000); // timing-bound: a hang waits 20 s",
      "expect(Date.now() - t0).toBeLessThan(CEILING_MS); // timing-bound: quadratic took 42 s",
      "expect(rows.length).toBeLessThan(50);",
      "const half = total / 2; expect(half).toBeLessThan(3);",
    ];
    for (const s of good) expect(findTimingViolations(s)).toEqual([]);
  });

  it("finds the test files (the sweep cannot silently match nothing)", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(resolve(REPO_ROOT, r), files);
    expect(files.length).toBeGreaterThan(200);
  });

  it("no blocking test asserts on a timing ratio, performance.now() or an unjustified/tight elapsed bound", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(resolve(REPO_ROOT, r), files);
    const offenders: string[] = [];
    for (const f of files) {
      let src: string;
      try {
        src = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const v of findTimingViolations(src))
        offenders.push(`${relative(REPO_ROOT, f)}:${v.line} [${v.rule}] ${v.text.trim()}`);
    }
    expect(
      offenders,
      "move timing ratios / performance.now() to a *.perf.test.ts; prefer deterministic evidence; justify any elapsed upper bound with `// timing-bound:` and keep it ≥ 5000 ms"
    ).toEqual([]);
  });
});
