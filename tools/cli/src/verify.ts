import * as fs from "node:fs";
import * as path from "node:path";
import type { LoomApp } from "@loom/app";
import { type VerificationReport, formatReport } from "@loom/verify";

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

/** The subset of the compiler manifest this command reads. */
interface VerifyManifest {
  flows?: Record<string, { loopIdentity?: LoopIdentityFinding[] }>;
}

/** Extract the per-flow loop-identity findings from a compiler manifest. Pure. */
export function loopIdentityFromManifest(
  manifest: VerifyManifest
): Record<string, LoopIdentityFinding[]> {
  const byFlow: Record<string, LoopIdentityFinding[]> = {};
  for (const [flowId, flow] of Object.entries(manifest.flows ?? {})) {
    if (flow.loopIdentity !== undefined && flow.loopIdentity.length > 0) {
      byFlow[flowId] = flow.loopIdentity;
    }
  }
  return byFlow;
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
  const mod = require(path.resolve(configPath)) as { default?: unknown; app?: unknown } & Record<
    string,
    unknown
  >;
  const app = (mod.default ?? mod.app ?? mod) as Partial<LoomApp>;
  if (typeof app.verify !== "function") {
    throw new Error(
      "config module must default-export a LoomApp from defineConfig(...) (no verify() found)"
    );
  }

  // ADR 0061 — auto-read the compiler manifest's loopIdentity findings, if any.
  const resolved = resolveManifestPath(configPath, manifestPath);
  let banner = "";
  let loopIdentityByFlow: Record<string, LoopIdentityFinding[]> | undefined;
  if (resolved !== undefined) {
    const manifest = JSON.parse(fs.readFileSync(resolved, "utf-8")) as VerifyManifest;
    const findings = loopIdentityFromManifest(manifest);
    const flowCount = Object.keys(findings).length;
    if (flowCount > 0) {
      loopIdentityByFlow = findings;
      banner = `[manifest] ${resolved}: loop-identity findings for ${flowCount} flow(s) injected (ADR 0061)\n`;
    }
  }

  const report = app.verify(
    loopIdentityByFlow !== undefined ? { lint: { loopIdentityByFlow } } : undefined
  );
  const text = banner + formatReport(report);
  await app.close?.();
  return { text, result: report };
}
