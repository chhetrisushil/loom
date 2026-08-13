import * as fs from "node:fs";
import * as path from "node:path";
import { cmdCheck } from "./check";
import { cmdLintClaimCheck } from "./lintClaimCheck";
import { cmdVerify } from "./verify";

// ── `loom doctor` — one front door for the pre-flight checks ─────────────────
//
// The checks were already there: `loom check` (flow-graph, needs a manifest),
// `loom verify` (the @loom/verify rules, needs a config module), `loom lint
// claim-check` (needs a source dir). Three commands, three different inputs,
// and — measured across 22 shipped examples with 53 `defineConfig` call sites —
// zero apps running any of them. Fragmentation is the most plausible reason: a
// developer has to know all three exist before they can run one.
//
// This adds no checking capability whatsoever. It discovers the inputs, runs
// what it can, and — the part that matters — REPORTS WHAT IT SKIPPED AND WHY.
// A doctor that quietly runs one of three checks and prints "healthy" is worse
// than no doctor, because the green is cited as evidence. Every skip names the
// flag that would have enabled it.

export type DoctorStatus = "ok" | "failed" | "skipped";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  /** Why it was skipped, or what failed. */
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  /** False if any check FAILED. A skipped check never fails the run — it is reported. */
  ok: boolean;
}

/** First existing candidate, or undefined. */
function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((c) => fs.existsSync(c));
}

const CONFIG_CANDIDATES = [
  "loom.config.js",
  "loom.config.mjs",
  "dist/loom.config.js",
  "dist/config.js",
];

export async function cmdDoctor(opts: {
  dir?: string;
  config?: string;
  manifest?: string;
}): Promise<{ text: string; result: DoctorResult }> {
  const dir = path.resolve(opts.dir ?? ".");
  const checks: DoctorCheck[] = [];

  // 1. Flow-graph checks over the compiler manifest.
  const manifest =
    opts.manifest !== undefined
      ? path.resolve(opts.manifest)
      : firstExisting([
          path.join(dir, "loom-manifest.json"),
          path.join(dir, "dist", "loom-manifest.json"),
        ]);
  if (manifest === undefined) {
    checks.push({
      name: "flow-graph (loom check)",
      status: "skipped",
      detail: "no loom-manifest.json found — build with the Loom compiler, or pass --manifest",
    });
  } else {
    try {
      const { result } = cmdCheck(manifest);
      checks.push({
        name: "flow-graph (loom check)",
        status: result.ok ? "ok" : "failed",
        detail: result.ok ? manifest : result.issues.join("; "),
      });
    } catch (err) {
      checks.push({ name: "flow-graph (loom check)", status: "failed", detail: String(err) });
    }
  }

  // 2. The @loom/verify rules. Needs a BUILT config module — the one input that
  //    cannot be discovered from source alone.
  const config =
    opts.config !== undefined
      ? path.resolve(opts.config)
      : firstExisting(CONFIG_CANDIDATES.map((c) => path.join(dir, c)));
  if (config === undefined) {
    checks.push({
      name: "runtime verification (loom verify)",
      status: "skipped",
      detail:
        "no built config module found — pass --config <module> exporting a LoomApp (build to JS first, or run under tsx)",
    });
  } else {
    try {
      const { result } = await cmdVerify(config, manifest);
      const errors = result.findings.filter((f) => f.severity === "error").length;
      const warns = result.findings.filter((f) => f.severity === "warn").length;
      checks.push({
        name: "runtime verification (loom verify)",
        status: result.ok ? "ok" : "failed",
        detail: `${result.checked.length} rule(s), ${errors} error(s), ${warns} warning(s)`,
      });
    } catch (err) {
      checks.push({
        name: "runtime verification (loom verify)",
        status: "failed",
        detail: String(err),
      });
    }
  }

  // 3. Claim-check reach-through (CC-5) over the source tree.
  try {
    const { findings } = cmdLintClaimCheck(dir);
    checks.push({
      name: "claim-check reach-through (loom lint)",
      status: findings.length === 0 ? "ok" : "failed",
      detail: findings.length === 0 ? dir : `${findings.length} finding(s)`,
    });
  } catch (err) {
    checks.push({
      name: "claim-check reach-through (loom lint)",
      status: "failed",
      detail: String(err),
    });
  }

  const result: DoctorResult = { checks, ok: !checks.some((c) => c.status === "failed") };
  return { text: formatDoctor(result), result };
}

const GLYPH: Record<DoctorStatus, string> = { ok: "✓", failed: "✗", skipped: "–" };

export function formatDoctor(result: DoctorResult): string {
  const lines = result.checks.map((c) => `  ${GLYPH[c.status]} ${c.name}\n      ${c.detail}`);
  const skipped = result.checks.filter((c) => c.status === "skipped").length;
  // Say the coverage out loud. "3 ok" and "1 ok, 2 skipped" must not read the same.
  const summary = result.ok
    ? skipped === 0
      ? "all checks passed"
      : `passed, but ${skipped} check(s) could not run — coverage is partial`
    : "FAILED";
  return `loom doctor\n\n${lines.join("\n")}\n\n${summary}\n`;
}
