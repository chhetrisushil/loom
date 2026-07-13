import { maskPaths } from "@loom/classify";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import { recordedStepOutputs, replayAsFixture } from "@loom/eval";

// ── foldAt — time-travel primitive (pure) ─────────────────────────────────────

/**
 * Fold the log up to and including `sequence` (or the whole log when omitted) into
 * its `ExecutionState`. This is `loom debug`'s time-travel step: it reconstructs
 * exactly what the execution looked like at any point, deterministically, with no
 * live effects. Reuses `@loom/eval`'s identity-seeded fold.
 */
export function foldAt(events: EventEnvelope[], sequence?: number): ExecutionState {
  const prefix = sequence === undefined ? events : events.filter((e) => e.sequence <= sequence);
  return replayAsFixture(prefix);
}

// ── formatLog / describeState — the `loom logs` + `loom debug` views (pure) ────

const SUSPEND_TYPES = new Set(["EXECUTION_SUSPENDED"]);

// K10-R6 — CLI egress. The CLI reads a cold log with no flow schemas, so it can't derive the
// classification marks; the operator names the sensitive OUTPUT dot-paths explicitly via
// `--redact` (e.g. `--redact ssn,user.token`), masked before anything is printed.
function detailOf(event: EventEnvelope, redact: readonly string[]): string {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.eventType) {
    case "STEP_STARTED":
    case "STEP_COMPLETED":
    case "STEP_FAILED":
    case "STEP_CANCELLED":
      return String(p.stepId ?? "");
    case "EXECUTION_SUSPENDED": {
      const on = (p.on ?? (p as { condition?: { on?: string } }).condition?.on) as
        | string
        | undefined;
      return on ? `on ${on}` : "";
    }
    case "EXECUTION_COMPLETED":
      return truncate(JSON.stringify(maskPaths(p.output, redact)));
    case "EXECUTION_FAILED":
      return truncate(String(p.error ?? ""));
    default:
      return "";
  }
}

/**
 * Pretty-print the event stream as a timeline, marking suspend points. `redact` masks the
 * given output dot-paths (K10-R6) so sensitive fields don't leak to stdout.
 */
export function formatLog(events: EventEnvelope[], redact: readonly string[] = []): string {
  if (events.length === 0) return "(no events)";
  const lines = events.map((e) => {
    const marker = SUSPEND_TYPES.has(e.eventType) ? "⏸" : " ";
    const seq = `#${e.sequence}`.padEnd(5);
    const type = e.eventType.padEnd(20);
    return `${marker} ${seq} ${type} ${detailOf(e, redact)}`.trimEnd();
  });
  return lines.join("\n");
}

/**
 * Human summary of a folded state — the `loom debug --at <seq>` view. `redact` masks the
 * given output dot-paths (K10-R6) before the output is printed.
 */
export function describeState(state: ExecutionState, redact: readonly string[] = []): string {
  const frames = Object.entries(state.frames)
    .map(([id, f]) => `    ${id}: ${f.status}`)
    .join("\n");
  const rawOutput = state.variables._output;
  const output = rawOutput !== undefined ? maskPaths(rawOutput, redact) : undefined;
  return [
    `execution ${state.executionId}  (workflow ${state.workflowId})`,
    `status: ${state.status}   sequence: ${state.sequence}`,
    state.suspendedOn ? `suspended on: ${state.suspendedOn.on}` : undefined,
    frames ? `frames:\n${frames}` : "frames: (none)",
    output !== undefined ? `output: ${truncate(JSON.stringify(output))}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function truncate(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ── evaluateGoldens — the `loom eval` engine (pure) ───────────────────────────

export interface GoldenExpectation {
  status?: string;
  outputContains?: string;
  stepsCompleted?: string[];
}
export interface Golden {
  name: string;
  log: EventEnvelope[];
  expect?: GoldenExpectation;
}
export interface GoldenResult {
  name: string;
  passed: boolean;
  failures: string[];
}
export interface EvalReport {
  results: GoldenResult[];
  passed: number;
  failed: number;
  ok: boolean;
}

/**
 * Replay each golden log (deterministically, no live calls) and check it against
 * its expectations — the CI gate behind `loom eval`. Pure over already-loaded
 * goldens so it is trivially testable.
 */
export function evaluateGoldens(goldens: Golden[]): EvalReport {
  const results = goldens.map((g): GoldenResult => {
    const failures: string[] = [];
    const state = foldAt(g.log);
    const e = g.expect ?? {};
    if (e.status !== undefined && state.status !== e.status) {
      failures.push(`status: expected ${e.status}, got ${state.status}`);
    }
    if (e.outputContains !== undefined) {
      const out = JSON.stringify(state.variables._output ?? null);
      if (!out.includes(e.outputContains)) {
        failures.push(`output does not contain "${e.outputContains}" (was ${truncate(out)})`);
      }
    }
    if (e.stepsCompleted !== undefined) {
      const completed = recordedStepOutputs(g.log);
      for (const stepId of e.stepsCompleted) {
        if (!(stepId in completed)) failures.push(`step "${stepId}" did not complete`);
      }
    }
    return { name: g.name, passed: failures.length === 0, failures };
  });
  const failed = results.filter((r) => !r.passed).length;
  return { results, passed: results.length - failed, failed, ok: failed === 0 };
}
