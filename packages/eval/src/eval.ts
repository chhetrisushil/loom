import type { EventEnvelope, ExecutionState } from "@loom/core";
import { ReplayVM } from "@loom/replay-vm";

/**
 * Fold a recorded event log back into its final ExecutionState — the "the log IS
 * the fixture" primitive. Because effect outputs are recorded in the log, this is
 * fully deterministic and makes NO live LLM/tool calls. Assert on the returned
 * state in a regression test.
 */
export function replayAsFixture(log: EventEnvelope[]): ExecutionState {
  // Identity (executionId/workflowId) is seeded at runtime, not folded from
  // events — recover it from the envelope so the fixture carries its own identity.
  const first = log[0];
  const initial = first
    ? { executionId: first.executionId, workflowId: first.workflowId }
    : undefined;
  return new ReplayVM(log, initial).getState();
}

/** Extract each step's recorded output (`stepId → output`) from a log. */
export function recordedStepOutputs(log: EventEnvelope[]): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const event of log) {
    if (event.eventType !== "STEP_COMPLETED") continue;
    const payload = event.payload as { stepId?: string; output?: unknown };
    if (typeof payload.stepId === "string") {
      outputs[payload.stepId] = payload.output;
    }
  }
  return outputs;
}

export interface RunDiff {
  kind: "status" | "output" | "step-output" | "missing-step" | "extra-step";
  stepId?: string;
  detail: string;
}

/**
 * Diff a candidate run against a golden run (both as event logs) — the engine
 * behind golden-fixture regression. Compares terminal status, the final output,
 * and every step's recorded output. A behaviour change in the flow surfaces as a
 * non-empty diff; `expect(diffRuns(golden, next)).toEqual([])` is the assertion.
 */
export function diffRuns(golden: EventEnvelope[], candidate: EventEnvelope[]): RunDiff[] {
  const diffs: RunDiff[] = [];
  const g = replayAsFixture(golden);
  const c = replayAsFixture(candidate);

  if (g.status !== c.status) {
    diffs.push({ kind: "status", detail: `status ${g.status} → ${c.status}` });
  }
  if (!deepEqual(g.variables._output, c.variables._output)) {
    diffs.push({
      kind: "output",
      detail: `output ${json(g.variables._output)} → ${json(c.variables._output)}`,
    });
  }

  const gOut = recordedStepOutputs(golden);
  const cOut = recordedStepOutputs(candidate);
  for (const stepId of Object.keys(gOut)) {
    if (!(stepId in cOut)) {
      diffs.push({ kind: "missing-step", stepId, detail: `step "${stepId}" not run in candidate` });
    } else if (!deepEqual(gOut[stepId], cOut[stepId])) {
      diffs.push({
        kind: "step-output",
        stepId,
        detail: `step "${stepId}" output ${json(gOut[stepId])} → ${json(cOut[stepId])}`,
      });
    }
  }
  for (const stepId of Object.keys(cOut)) {
    if (!(stepId in gOut)) {
      diffs.push({ kind: "extra-step", stepId, detail: `step "${stepId}" is new in candidate` });
    }
  }
  return diffs;
}

export interface ScoreResult {
  name: string;
  score: number;
  detail?: string;
}

export type Scorer = (state: ExecutionState) => ScoreResult;

/** Run named scorers over a folded run — quality evals over the recorded outcome. */
export function scoreRun(state: ExecutionState, scorers: Scorer[]): ScoreResult[] {
  return scorers.map((s) => s(state));
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function deepEqual(a: unknown, b: unknown): boolean {
  return json(a) === json(b);
}
