import * as fs from "node:fs";
import * as path from "node:path";
import type { LoomApp } from "@loom/app";
import { cmdCheck } from "./check";
import { cmdLintClaimCheck } from "./lintClaimCheck";
import { loadLoomApp } from "./stores";
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

export type DoctorStatus = "ok" | "failed" | "skipped" | "advisory";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  /** Why it was skipped, what failed, or what the advisory depends on. */
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
  const loadedApp = appLoader();

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
      // V5 — carry the rules' own coverage notes through the front door. Flattening a report
      // to "0 errors" is exactly how a partial check gets cited as a complete one, which is
      // the thing this command exists to prevent.
      const notes = result.findings.filter((f) => f.severity === "info");
      const counts = `${result.checked.length} rule(s), ${errors} error(s), ${warns} warning(s)`;
      checks.push({
        name: "runtime verification (loom verify)",
        status: result.ok ? (notes.length > 0 ? "advisory" : "ok") : "failed",
        detail:
          notes.length === 0
            ? counts
            : `${counts} — ${notes.length} rule(s) reported partial coverage: ${notes[0]?.message ?? ""}`,
      });
    } catch (err) {
      checks.push({
        name: "runtime verification (loom verify)",
        status: "failed",
        detail: String(err),
      });
    }
  }

  // 3. The memory store behind `app.memory` and every corpus. Two failure modes, both
  //    silent at boot and loud (or worse, quiet) much later.
  if (config === undefined) {
    checks.push({
      name: "memory store (durability + relevance recall)",
      status: "skipped",
      detail: "no built config module found — pass --config <module> exporting a LoomApp",
    });
  } else {
    checks.push(memoryStoreCheck(await loadedApp(config)));
  }

  // 4. Durable timers: can this deployment wake, and does anything own a wake.
  if (config === undefined) {
    for (const name of [TIMER_CHECK, OWNERSHIP_CHECK]) {
      checks.push({
        name,
        status: "skipped",
        detail: "no built config module found — pass --config <module> exporting a LoomApp",
      });
    }
  } else {
    checks.push(...timerChecks(await loadedApp(config)));
  }

  // 5. Claim-check reach-through (CC-5) over the source tree.
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

/**
 * Is the configured memory store durable, and can it retrieve by relevance?
 *
 * The default is an in-memory store, which is right for a test and is the shape ADR 0090
 * opened with: an agent that restarted remembered nothing, and nothing said so. That is
 * reported as a SKIP rather than a failure, because a browser app or a test suite wants
 * exactly that — but the skip names it, so a partial-coverage line appears instead of a
 * clean bill of health.
 *
 * A store that IS configured and has no `search` is a failure. `recallRelevant` and
 * `KnowledgeBase.retrieve` refuse such a store at run time rather than degrading to the
 * newest N (ADR 0090 D3), so the app is one relevance query away from throwing — and
 * somebody chose that backend deliberately, which is what makes it a misconfiguration
 * rather than a default.
 */
function memoryStoreCheck(loaded: Partial<LoomApp> | Error): DoctorCheck {
  const name = "memory store (durability + relevance recall)";
  try {
    if (loaded instanceof Error) throw loaded;
    const store = (loaded as { stores?: { memoryStore?: { search?: unknown } } }).stores
      ?.memoryStore;
    if (store === undefined) {
      return {
        name,
        status: "skipped",
        detail:
          "no `memoryStore` configured — agent memory and any corpus live in the in-memory default and are LOST ON RESTART; pass memoryStore: new SqliteMemoryStore(...) to persist them",
      };
    }
    if (typeof store.search !== "function") {
      return {
        name,
        status: "failed",
        detail:
          "the configured memoryStore does not implement the optional `search` — recallRelevant() and KnowledgeBase.retrieve() REFUSE such a store rather than degrading to the newest N, so any relevance retrieval will throw at run time",
      };
    }
    return { name, status: "ok", detail: "configured, durable, and implements search()" };
  } catch (err) {
    return { name, status: "failed", detail: String(err) };
  }
}

const TIMER_CHECK = "durable timers (can this deployment wake?)";
const OWNERSHIP_CHECK = "timer wake ownership (does anything own a wake?)";

/**
 * Two questions about timers that nothing else asks.
 *
 * Neither is a lint over source: both read what the COMPOSITION wired, which is the only
 * place the answer lives. `defineConfig` already warns at boot when schedules are declared
 * with no store — this is the same fact where an operator will see it before deploying, plus
 * the ownership question, which nothing warned about at all.
 */
/**
 * Load the app once per RUN, and hand the same result to every check that needs it — a
 * failure to load is one fact about the deployment, not one per check.
 *
 * Deliberately not a module-level cache: that would never invalidate, so a long-lived
 * process would answer from a stale composition and the map would only grow.
 */
function appLoader(): (configPath: string) => Promise<Partial<LoomApp> | Error> {
  let loaded: Promise<Partial<LoomApp> | Error> | undefined;
  return (configPath) => {
    loaded ??= loadLoomApp(configPath).catch((err: unknown) =>
      err instanceof Error ? err : new Error(String(err))
    );
    return loaded;
  };
}

function timerChecks(loaded: Partial<LoomApp> | Error): DoctorCheck[] {
  if (loaded instanceof Error) {
    return [TIMER_CHECK, OWNERSHIP_CHECK].map((name) => ({
      name,
      status: "failed" as const,
      detail: String(loaded),
    }));
  }
  const app = loaded;

  const timerStore = app.stores?.timerStore;
  const leaseStore = app.stores?.leaseStore;
  const schedules = app.schedules ?? [];
  // Gates are the one suspend surface that IS declared (ADR 0077 resumeSchemas); a timeout on
  // one lives in the runner body, where nothing static can see it.
  const gated = (app.runtime?.getFlowIds() ?? []).filter(
    (id) => Object.keys(app.runtime?.getFlow(id)?.definition.resumeSchemas ?? {}).length > 0
  );

  const timers: DoctorCheck =
    timerStore !== undefined
      ? {
          name: TIMER_CHECK,
          status: "ok",
          detail: `TimerStore wired${schedules.length > 0 ? `; ${schedules.length} schedule(s) can fire` : ""}`,
        }
      : schedules.length > 0
        ? {
            name: TIMER_CHECK,
            status: "failed",
            detail: `${schedules.length} schedule(s) declared and no \`timers: { store }\` — they can never fire`,
          }
        : gated.length > 0
          ? {
              name: TIMER_CHECK,
              status: "advisory",
              detail: `no \`timers: { store }\`, and ${gated.length} flow(s) declare resume gates — any \`ctx.sleep\` or \`suspend({ timeout })\` will never wake. Timeouts live in the runner body, so this is inference from the gates, not proof: \`suspension-safety\` sees real suspend points only when you build with the Loom compiler and pass --manifest (ADR 0086 reach analysis); without one it is silent about them rather than clean`,
            }
          : {
              name: TIMER_CHECK,
              status: "skipped",
              detail:
                "no `timers: { store }` and nothing declared that needs one (no schedules, no resume gates)",
            };

  const ownership: DoctorCheck =
    timerStore === undefined
      ? {
          name: OWNERSHIP_CHECK,
          status: "skipped",
          detail: "no timers configured, so there are no wakes to own",
        }
      : leaseStore !== undefined
        ? {
            name: OWNERSHIP_CHECK,
            status: "ok",
            detail: "`timers.leases` wired — a wake is claimed before it runs",
          }
        : {
            name: OWNERSHIP_CHECK,
            status: "advisory",
            detail:
              "a TimerStore with no `timers.leases`: if more than one process polls it, every node resumes the same due execution. Fencing (K9.4) makes that safe, not cheap — the loser still pays for its effects up to the point it loses. Harmless on a single node; wire `timers.leases` before there are two",
          };

  return [timers, ownership];
}

const GLYPH: Record<DoctorStatus, string> = { ok: "✓", failed: "✗", skipped: "–", advisory: "!" };

export function formatDoctor(result: DoctorResult): string {
  const lines = result.checks.map((c) => `  ${GLYPH[c.status]} ${c.name}\n      ${c.detail}`);
  const skipped = result.checks.filter((c) => c.status === "skipped").length;
  // Say the coverage out loud. "3 ok" and "1 ok, 2 skipped" must not read the same.
  const advisories = result.checks.filter((c) => c.status === "advisory").length;
  const caveats = [
    ...(skipped > 0 ? [`${skipped} could not run — coverage is partial`] : []),
    ...(advisories > 0 ? [`${advisories} advisory (depends on how you deploy)`] : []),
  ];
  // Caveats belong on BOTH branches: a failing run still needs to say what it could not
  // check, or fixing the failure reveals coverage the reader thought they already had.
  const base = result.ok ? "all checks passed" : "FAILED";
  const summary =
    caveats.length === 0
      ? base
      : result.ok
        ? `passed, but ${caveats.join("; ")}`
        : `FAILED — also: ${caveats.join("; ")}`;
  return `loom doctor\n\n${lines.join("\n")}\n\n${summary}\n`;
}
