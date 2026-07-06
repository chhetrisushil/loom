import type { EventEnvelope } from "@loom/core";
import { replayAsFixture } from "@loom/eval";

/** The minimal view of a new flow definition needed to check compatibility. */
export interface FlowDefinitionView {
  version: string;
  steps: Array<{ id: string }>;
}

/**
 * Structural view of the new deployment's flow registry. A real `WorkflowRuntime`
 * satisfies this (via `getFlow`), so you pass the runtime you just booted with the
 * NEW code.
 */
export interface FlowResolver {
  getFlow(flowId: string): { definition: FlowDefinitionView } | undefined;
}

export type Severity = "breaking" | "warning" | "info";

export interface CompatibilityIssue {
  executionId: string;
  workflowId: string;
  severity: Severity;
  kind: "flow-missing" | "step-removed" | "suspended-carryover";
  detail: string;
}

export interface CompatibilityReport {
  /** Number of executions checked. */
  checked: number;
  issues: CompatibilityIssue[];
  /** True when no `breaking` issue was found — safe to promote. */
  ok: boolean;
}

/**
 * Replay a corpus of historical event logs against the NEW flow definitions and
 * report changes that would break a resume — the "48-hour approval with a deploy
 * in the middle" safety check. It runs NO live effects; it folds each recorded
 * log (see {@link replayAsFixture}) and compares structurally against the new
 * definitions.
 *
 * Detected hazards:
 *  - `flow-missing`  — the flow no longer exists → any in-flight run is stranded.
 *  - `step-removed`  — a step that already ran was renamed/removed → its recorded
 *                      output is orphaned and the new runner would re-execute live.
 *  - `suspended-carryover` — an in-flight (suspended) execution must resume on the
 *                      new code; flagged so you look at it.
 *
 * Gate promotion on `report.ok` (no breaking issues).
 */
export function simulateDeploy(logs: EventEnvelope[][], next: FlowResolver): CompatibilityReport {
  const issues: CompatibilityIssue[] = [];

  for (const log of logs) {
    if (log.length === 0) continue;
    const state = replayAsFixture(log);
    const executionId = state.executionId;
    const workflowId = state.workflowId;

    const flow = next.getFlow(workflowId);
    if (!flow) {
      issues.push({
        executionId,
        workflowId,
        severity: "breaking",
        kind: "flow-missing",
        detail: `flow "${workflowId}" no longer exists in the new deployment`,
      });
      continue;
    }

    const newStepIds = new Set(flow.definition.steps.map((s) => s.id));
    for (const ranStepId of Object.keys(state.frames)) {
      if (!newStepIds.has(ranStepId)) {
        issues.push({
          executionId,
          workflowId,
          severity: "breaking",
          kind: "step-removed",
          detail: `step "${ranStepId}" already ran but is gone from the new flow (rename/remove) — recorded output would be orphaned`,
        });
      }
    }

    if (state.status === "suspended") {
      const on = state.suspendedOn?.on ?? "unknown";
      issues.push({
        executionId,
        workflowId,
        severity: "warning",
        kind: "suspended-carryover",
        detail: `in-flight execution suspended on "${on}" must resume on the new code`,
      });
    }
  }

  return {
    checked: logs.filter((l) => l.length > 0).length,
    issues,
    ok: !issues.some((i) => i.severity === "breaking"),
  };
}
