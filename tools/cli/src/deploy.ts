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

/** The optional effect-registry view the idempotency advisory needs (K9). */
export interface EffectRegistryView {
  declaredIdempotence(toolId: string): boolean | undefined;
  kindOf(toolId: string): string | undefined;
}

interface FlowEnumeratingResolver extends FlowResolver {
  getFlowIds?(): string[];
}

/**
 * K9 advisory (deferred from the K9 issue to the deploy-check census):
 * enumerate tool-kind effects bound by the deployment's flows that carry NO
 * `idempotent` declaration. Effects are at-least-once — an undeclared mutating
 * tool silently re-runs on crash recovery. Advisory only: never fails the gate.
 */
export function idempotencyAdvisory(
  resolver: FlowEnumeratingResolver,
  effects: EffectRegistryView
): string[] {
  if (resolver.getFlowIds === undefined) return [];
  const undeclared = new Set<string>();
  for (const flowId of resolver.getFlowIds()) {
    const flow = resolver.getFlow(flowId);
    if (!flow) continue;
    for (const step of flow.definition.steps as Array<{ id: string; toolId?: string }>) {
      const toolId = step.toolId ?? step.id;
      if (effects.kindOf(toolId) === "tool" && effects.declaredIdempotence(toolId) === undefined) {
        undeclared.add(toolId);
      }
    }
  }
  return [...undeclared].sort();
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
  const resolver = (mod.default ?? mod.resolver ?? mod) as FlowEnumeratingResolver;
  const report = runDeployCheck(logs, resolver);
  let text = formatReport(report);
  // K9 advisory — runs when the config module also exports its EffectRuntime
  // (`module.exports = { resolver: runtime, effectRuntime }`).
  const effects = mod.effectRuntime as EffectRegistryView | undefined;
  if (effects?.declaredIdempotence !== undefined && effects.kindOf !== undefined) {
    const undeclared = idempotencyAdvisory(resolver, effects);
    if (undeclared.length > 0) {
      text += `\n\nadvisory: ${undeclared.length} tool effect(s) with no idempotent declaration (at-least-once re-run on recovery): ${undeclared.join(", ")}`;
    }
  }
  return { text, report };
}
