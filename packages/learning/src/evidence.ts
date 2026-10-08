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
//
// ORDER, precisely. The fold records WHAT each decision was, not WHEN: `_decisions` is a plain
// object keyed by decisionId, and the fold shapes are frozen (the wire-abi fold vectors and the
// `_decisions` entry shape are a cross-implementation contract), so no ordinal can be added
// without a kernel ABI change. The order of a decision whose real event is still in the log is its
// true `sequence` (exact). The order of a decision the checkpoint ABSORBED is the key order of the
// folded map, which is insertion order except that (a) JavaScript lists array-index-like keys
// ("0", "10", "2") first, ascending, and (b) a snapshot read back from a store that normalises
// JSON (Postgres `jsonb` orders keys by length then bytes) has already lost it. Nothing but the
// DISCOUNTED terminal credit (`trajectories` `discount < 1`) depends on that order — the
// direct-outcome credit, the default `discount = 1`, per-arm statistics and the policy evaluation
// are order-free. So a compacted execution's evidence is identical to the uncompacted one's
// whenever `discount = 1`, or its absorbed decisionIds are not array-index-like and the snapshot
// store keeps key order; otherwise the discount is applied in the folded-map order.

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
 *   does not record when a decision was made. Only the `discount < 1` terminal credit depends on
 *   the order of absorbed decisions, and that order is the folded map's key order — exact unless
 *   an absorbed decisionId is array-index-like ("10") or the snapshot store does not preserve
 *   object key order (see the ORDER note above).
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
  // R18 (fix round 1) - crypto-shredding is recorded as `variables._shredded`, and compaction folds
  // the PAYLOAD_SHREDDED event away. Without a marker here a shredded-then-compacted execution would
  // read as an ordinary one and its folded plaintext would be exported. Synthesize the marker so
  // every consumer that honours erasure (`exportJsonl`) sees it.
  const shredded = state.variables._shredded as { subjectId?: string; at?: number } | undefined;
  if (shredded !== undefined && !pass.some((e) => e.eventType === "PAYLOAD_SHREDDED")) {
    out.push({
      id: `${executionId}-shredded`,
      workflowId,
      executionId,
      eventType: "PAYLOAD_SHREDDED",
      sequence: Math.max(state.sequence, 1),
      timestamp: shredded.at ?? state.updatedAt,
      payload: shredded.subjectId !== undefined ? { subjectId: shredded.subjectId } : {},
    });
  }
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
