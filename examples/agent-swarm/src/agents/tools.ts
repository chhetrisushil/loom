import { tool$ } from "@loom/core";
import { z } from "zod";
import type { DepsResult, PerfResult, ScopeResult, SecurityResult } from "../domain";

// Small deterministic sleep so narration is legible; never affects recorded state.
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Deterministic mock domain work ────────────────────────────────────────────
// Keyed off the service so tests are stable: checkout → medium risk (has a
// finding), payments → low risk (clean). No Date.now()/Math.random in results.

export function deriveScope(service: string, release: string): ScopeResult {
  return {
    service,
    release,
    changedFiles: service === "checkout" ? 12 : 4,
    surfaces: ["api", "db"],
    summary: `${service} @ ${release}: ${service === "checkout" ? 12 : 4} files across api + db`,
  };
}

export function scanSecurity(service: string): SecurityResult {
  return service === "checkout"
    ? { findings: 1, severity: "medium", detail: "outdated TLS config on the public API" }
    : { findings: 0, severity: "none", detail: "no findings" };
}

export function checkPerf(service: string): PerfResult {
  const regressionPct = service === "checkout" ? 3 : 1;
  return { regressionPct, verdict: regressionPct <= 5 ? "within budget" : "over budget" };
}

export function auditDeps(service: string): DepsResult {
  return service === "checkout"
    ? { outdated: 2, vulnerabilities: 0 }
    : { outdated: 0, vulnerabilities: 0 };
}

// ── The agents' tools (tool$ definitions advertised on each agent$) ────────────
const io = { inputSchema: z.object({ service: z.string() }), outputSchema: z.object({}) };
export const ScopeTool = tool$({
  id: "scope-tool",
  name: "Scope",
  description: "Compute the audit scope from the changeset",
  ...io,
});
export const SecurityTool = tool$({
  id: "security-tool",
  name: "Security Scan",
  description: "Scan for vulnerabilities and misconfigurations",
  ...io,
});
export const PerfTool = tool$({
  id: "perf-tool",
  name: "Perf Check",
  description: "Measure performance regression vs budget",
  ...io,
});
export const DepsTool = tool$({
  id: "deps-tool",
  name: "Deps Audit",
  description: "Audit dependency freshness and advisories",
  ...io,
});
export const SignoffTool = tool$({
  id: "signoff-tool",
  name: "Sign-off",
  description: "Apply the release sign-off decision",
  ...io,
});
