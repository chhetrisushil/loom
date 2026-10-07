import type { EventEnvelope, ExecutionState } from "@loom/core";

// ── Learning evidence from the FOLD, not the log ─────────────────────────────
//
// `trajectories` reads `DECISION_RECORDED` / `OUTCOME_RECORDED` events. Compaction folds those
// events into the checkpoint and frees them (ADR 0106), and it keeps NOTHING extra in place for
// learning (ADR 0116 amendment, round 3): the folded state already holds everything a trajectory
// needs — `_decisions` (choice, alternatives, context, policy + propensity, per decisionId) and
// `_outcomes` (key, success, score, decisionId, recordedBy, late). Keeping every decision event
// in place instead made a long agent run's log unreclaimable by compaction (2000 decisions of 2 KB
// stayed at 4 MB). So a learner builds an execution's evidence from its folded state, which is
// complete whether or not the log was ever compacted:
//
//     trajectories(evidenceEvents(await runtime.loadState(id), await store.read(id)))
//
// A log read alone (`trajectories(await store.read(id))`) is exact only for a log that was never
// compacted.

const EVIDENCE = new Set(["DECISION_RECORDED", "OUTCOME_RECORDED"]);

const TERMINAL_OF_STATUS: Record<string, string> = {
  completed: "EXECUTION_COMPLETED",
  failed: "EXECUTION_FAILED",
  cancelled: "EXECUTION_CANCELLED",
  continued: "EXECUTION_CONTINUED",
};

/**
 * The events `trajectories` needs for ONE execution, derived from its folded `state`.
 *
 * - `DECISION_RECORDED` / `OUTCOME_RECORDED` are rebuilt from `_decisions` / `_outcomes`, in fold
 *   order (which is log order). A decision whose real event is still in `log` keeps its true
 *   `sequence` and `timestamp`; one the checkpoint absorbed gets its ordinal as `sequence` (always
 *   below every event the log still holds) and `state.startedAt` as `timestamp`, because the fold
 *   does not record when a decision was made. Nothing `trajectories` reads for credit assignment
 *   depends on either.
 * - Every other event of `log` passes through unchanged — the terminal event is the one that
 *   matters (compaction never removes it); a log's own `DECISION_RECORDED` / `OUTCOME_RECORDED`
 *   events are dropped, the state being authoritative and complete.
 * - A terminal execution whose terminal event is gone from `log` (a log compacted by a kernel
 *   older than ADR 0116) gets one synthesized from `state.status`.
 */
export function evidenceEvents(
  state: ExecutionState,
  log: readonly EventEnvelope[] = []
): EventEnvelope[] {
  const { executionId, workflowId } = state;
  const real = new Map<string, EventEnvelope>();
  const pass: EventEnvelope[] = [];
  for (const e of log) {
    if (e.eventType === "DECISION_RECORDED") {
      const id = (e.payload as { decisionId?: unknown } | undefined)?.decisionId;
      if (typeof id === "string") real.set(id, e);
    } else if (!EVIDENCE.has(e.eventType)) pass.push(e);
  }
  const out: EventEnvelope[] = [];
  const decisions = state.variables._decisions as
    | Record<string, Record<string, unknown>>
    | undefined;
  let ordinal = 0;
  for (const [decisionId, folded] of Object.entries(decisions ?? {})) {
    ordinal++;
    const original = real.get(decisionId);
    out.push({
      id: original?.id ?? `${executionId}-decision-${ordinal}`,
      workflowId,
      executionId,
      eventType: "DECISION_RECORDED",
      sequence: original?.sequence ?? ordinal,
      timestamp: original?.timestamp ?? state.startedAt,
      payload: { ...folded, decisionId },
    });
  }
  const outcomes = state.variables._outcomes as Array<Record<string, unknown>> | undefined;
  let n = 0;
  for (const folded of outcomes ?? []) {
    n++;
    out.push({
      id: `${executionId}-outcome-${n}`,
      workflowId,
      executionId,
      eventType: "OUTCOME_RECORDED",
      sequence: n,
      timestamp: state.startedAt,
      payload: folded,
      // The fold trusts `recordedBy` / `late` only from a kernel-stamped envelope.
      ...(("recordedBy" in folded || "late" in folded) && { metadata: { kernel: true } }),
    });
  }
  out.push(...pass);
  const terminal = TERMINAL_OF_STATUS[state.status];
  if (terminal !== undefined && !pass.some((e) => e.eventType === terminal)) {
    out.push({
      id: `${executionId}-terminal`,
      workflowId,
      executionId,
      eventType: terminal,
      sequence: Math.max(state.sequence, 1),
      timestamp: state.updatedAt,
      payload: {},
      ...(terminal === "EXECUTION_CONTINUED" && { metadata: { kernel: true } }),
    });
  }
  return out;
}
