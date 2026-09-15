import * as fs from "node:fs";
import * as path from "node:path";
import type { LoomApp } from "@loom/app";
import { type VerificationReport, formatReport } from "@loom/verify";
import { loadLoomApp as loadModuleForVerify } from "./stores";

/**
 * `loom verify --config <module> [--manifest <loom-manifest.json>]` — pre-flight
 * verification over a built app.
 *
 * The config module must export a `LoomApp` (the result of `defineConfig({...})`) as its
 * default export (or as `app`). We call `app.verify()` — read-only, off-log — print the
 * report, and exit non-zero on any error-severity finding. Build the config to JS first
 * or run under tsx.
 *
 * The compiler manifest's per-flow `loopIdentity` findings (ADR 0061 — loop-scoped
 * ctx.run/execute whose step id cannot vary per iteration) are AUTO-INJECTED into the
 * determinism rule: pass `--manifest` explicitly, or omit it and a `loom-manifest.json`
 * next to the config module (or in the cwd) is picked up automatically.
 *
 * Note: if the module's own `defineConfig` sets `verify: "error"`, requiring it throws at
 * boot; `main` catches and prints that. This command is for on-demand verification
 * independent of the config's own mode.
 */

/** One ADR 0061 finding as the compiler manifest records it. */
interface LoopIdentityFinding {
  callee: string;
  loopKind: string;
  reason: string;
  location?: string;
}

interface NonDeterministicFinding {
  callee: string;
  insideDecide: boolean;
  location?: string;
}

interface RunnerReachEntry {
  steps: Array<{ stepId?: string; toolId: string }>;
  unresolved: Array<{ expr: string; kind: "step" | "suspend"; location?: string }>;
  suspends: Array<{ id?: string; correlationKey?: string; timed?: boolean; wakeAt?: boolean }>;
}

/** The subset of the compiler manifest this command reads. */
interface VerifyManifest {
  flows?: Record<
    string,
    {
      loopIdentity?: LoopIdentityFinding[];
      nonDeterministic?: NonDeterministicFinding[];
      runnerReach?: RunnerReachEntry;
    }
  >;
}

/** Everything the manifest can feed the rules, extracted per flow. Pure. */
export interface ManifestLint {
  loopIdentityByFlow: Record<string, LoopIdentityFinding[]>;
  nonDeterministicByFlow: Record<string, NonDeterministicFinding[]>;
  runnerReachByFlow: Record<string, RunnerReachEntry>;
}

/**
 * Extract every per-flow analysis the compiler recorded.
 *
 * All three need the runner SOURCE, which only the compiler has. Reading them
 * from the manifest is what makes the determinism, capability-compat,
 * effect-class and suspension-safety rules work without an application
 * hand-plumbing its own source into a linter — a wiring step that, measured
 * across 22 shipped examples, nobody performed.
 */
export function lintFromManifest(manifest: VerifyManifest): ManifestLint {
  const out: ManifestLint = {
    loopIdentityByFlow: {},
    nonDeterministicByFlow: {},
    runnerReachByFlow: {},
  };
  for (const [flowId, flow] of Object.entries(manifest.flows ?? {})) {
    if (flow.loopIdentity !== undefined && flow.loopIdentity.length > 0) {
      out.loopIdentityByFlow[flowId] = flow.loopIdentity;
    }
    if (flow.nonDeterministic !== undefined && flow.nonDeterministic.length > 0) {
      out.nonDeterministicByFlow[flowId] = flow.nonDeterministic;
    }
    if (flow.runnerReach !== undefined) {
      out.runnerReachByFlow[flowId] = flow.runnerReach;
    }
  }
  return out;
}

/** Back-compat projection of {@link lintFromManifest}. */
export function loopIdentityFromManifest(
  manifest: VerifyManifest
): Record<string, LoopIdentityFinding[]> {
  return lintFromManifest(manifest).loopIdentityByFlow;
}

/** Explicit path, or auto-detect `loom-manifest.json` beside the config / in the cwd. */
function resolveManifestPath(configPath: string, manifestPath?: string): string | undefined {
  if (manifestPath !== undefined) return path.resolve(manifestPath);
  for (const candidate of [
    path.join(path.dirname(path.resolve(configPath)), "loom-manifest.json"),
    path.resolve("loom-manifest.json"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function cmdVerify(
  configPath: string,
  manifestPath?: string
): Promise<{ text: string; result: VerificationReport }> {
  const mod = (await loadModuleForVerify(configPath)) as {
    default?: unknown;
    app?: unknown;
  } & Record<string, unknown>;
  const app = (mod.default ?? mod.app ?? mod) as Partial<LoomApp>;
  if (typeof app.verify !== "function") {
    throw new Error(
      "config module must default-export a LoomApp from defineConfig(...) (no verify() found)"
    );
  }

  // ADR 0061 — auto-read the compiler manifest's loopIdentity findings, if any.
  const resolved = resolveManifestPath(configPath, manifestPath);
  let banner = "";
  let lint: ManifestLint | undefined;
  if (resolved !== undefined) {
    const manifest = JSON.parse(fs.readFileSync(resolved, "utf-8")) as VerifyManifest;
    const found = lintFromManifest(manifest);
    const parts: string[] = [];
    const n = (r: Record<string, unknown>) => Object.keys(r).length;
    if (n(found.loopIdentityByFlow) > 0) {
      parts.push(`loop-identity for ${n(found.loopIdentityByFlow)} flow(s) (ADR 0061)`);
    }
    if (n(found.nonDeterministicByFlow) > 0) {
      parts.push(`non-determinism for ${n(found.nonDeterministicByFlow)} flow(s)`);
    }
    if (n(found.runnerReachByFlow) > 0) {
      parts.push(`runner reach for ${n(found.runnerReachByFlow)} flow(s) (ADR 0086)`);
    }
    if (parts.length > 0) {
      lint = found;
      banner = `[manifest] ${resolved}: ${parts.join(", ")} injected\n`;
    }
  }

  const report = app.verify(lint !== undefined ? { lint } : undefined);
  const text = banner + formatReport(report);
  await app.close?.();
  return { text, result: report };
}
