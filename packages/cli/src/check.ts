import * as fs from "node:fs";

/** The subset of the compiler manifest `loom check` reads. */
export interface CheckManifest {
  flows?: Record<string, { warnings?: string[] }>;
}

export interface CheckResult {
  issues: string[];
  ok: boolean;
}

/** Collect the compiler's per-flow warnings from a manifest. Pure. */
export function checkManifest(manifest: CheckManifest): CheckResult {
  const issues: string[] = [];
  for (const [flowId, flow] of Object.entries(manifest.flows ?? {})) {
    for (const warning of flow.warnings ?? []) {
      issues.push(`flow "${flowId}": ${warning}`);
    }
  }
  return { issues, ok: issues.length === 0 };
}

/**
 * `loom check --manifest <path>` — static flow-graph checks over the compiler
 * manifest (no app load). Richer checks (missing effects, dangling capability
 * maps) run at boot via `defineConfig({ validate: true })`, where the live
 * runtime is available.
 */
export function cmdCheck(manifestPath: string): { text: string; result: CheckResult } {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as CheckManifest;
  const result = checkManifest(manifest);
  const text = result.ok
    ? "✓ no issues"
    : `${result.issues.map((i) => `  ✗ ${i}`).join("\n")}\n\n${result.issues.length} issue(s)`;
  return { text, result };
}
