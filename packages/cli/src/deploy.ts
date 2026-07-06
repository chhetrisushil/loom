import * as fs from "node:fs";
import * as path from "node:path";
import type { EventEnvelope } from "@loom/core";
import { type CompatibilityReport, type FlowResolver, simulateDeploy } from "@loom/deploy-sim";

/** Load stored logs from a directory of `*.json` files (each an EventEnvelope[]). */
export function loadLogs(dir: string): EventEnvelope[][] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as EventEnvelope[]);
}

/** Pure wrapper over deploy-sim — the CI gate engine. */
export function runDeployCheck(logs: EventEnvelope[][], next: FlowResolver): CompatibilityReport {
  return simulateDeploy(logs, next);
}

function formatReport(report: CompatibilityReport): string {
  if (report.issues.length === 0) {
    return `✓ ${report.checked} execution(s) — safe to promote`;
  }
  const lines = report.issues.map(
    (i) => `  ${i.severity === "breaking" ? "✗" : "•"} [${i.kind}] ${i.executionId}: ${i.detail}`
  );
  return `${lines.join("\n")}\n\n${report.checked} checked, ${report.issues.length} issue(s), ${
    report.ok ? "safe" : "NOT SAFE"
  } to promote`;
}

/**
 * `loom deploy check --logs <dir> --config <module>` — replay historical logs
 * against the new flow definitions before promoting. The config module exports a
 * `getFlow`-shaped resolver (a WorkflowRuntime booted with the new code); build it
 * to JS first or run under tsx.
 */
export function cmdDeployCheck(
  logsDir: string,
  configPath: string
): { text: string; report: CompatibilityReport } {
  const logs = loadLogs(logsDir);
  const mod = require(path.resolve(configPath)) as { default?: unknown } & Record<string, unknown>;
  const resolver = (mod.default ?? mod.resolver ?? mod) as FlowResolver;
  const report = runDeployCheck(logs, resolver);
  return { text: formatReport(report), report };
}
