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
// ORDER, precisely. Since EVENT_SCHEMA 1.24.0 (ADR 0128) the fold stamps `seq` — the envelope
// sequence of the first record — on each `_decisions` entry, and a decision the checkpoint ABSORBED
// is rebuilt in `seq` order with `seq` as its `sequence`: EXACT, whatever the id shape and whatever
// the snapshot store does to key order (Postgres `jsonb` reorders keys). An entry WITHOUT `seq`
// (folded by a pre-1.24.0 kernel, then compacted) is LEGACY and keeps today's behaviour: folded-map
// key order — insertion order except that array-index-like keys ("0", "10", "2") list first and a
// normalising store has already lost it. A legacy entry is placed immediately AFTER the
// stamped entry that precedes it in map order (one before any stamped entry leads, in map order):
// on a clean upgrade every legacy entry predates every stamped one, and in an interleaved rolling
// upgrade/rollback (a 1.23 node folding into a 1.24 snapshot adds an unstamped decision, or
// rebuilds a stamped one without `seq`) the entry stays next to the decision it followed.
// Only the DISCOUNTED terminal credit (`discount < 1`) depends on the order; the direct-outcome
// credit, the default `discount = 1`, per-arm statistics and the policy evaluation are order-free.

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
 * - `DECISION_RECORDED` / `OUTCOME_RECORDED` are rebuilt from `_decisions` / `_outcomes`, in log
 *   order. A decision whose real event is still in `log` keeps its true `sequence` and `timestamp`;
 *   one the checkpoint absorbed gets its recorded `seq` as `sequence` (a legacy entry without one: a negative
 *   ordinal before every stamped one, else the `seq` of the stamped entry it follows) and `state.startedAt` as `timestamp`, because the fold
 *   does not record when a decision was made. Decisions are emitted sorted by that `sequence`, so
 *   the `discount < 1` terminal credit is exact (see the ORDER note above).
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
  // ADR 0128 — order = stamped entries by `seq`; each LEGACY entry (no `seq`) goes immediately after
  // the stamped entry that precedes it in MAP order (a legacy entry before any stamped one leads).
  // A clean upgrade (all legacy first) is therefore unchanged, and an interleaved rolling
  // upgrade/rollback (a 1.23 node adds an unstamped decision to a stamped snapshot) keeps its
  // decision where it was made.
  type Entry = {
    id: string;
    folded: Record<string, unknown>;
    seq?: number;
    anchor: number;
    i: number;
  };
  const entries: Entry[] = [];
  let anchor = 0;
  for (const [i, [id, folded]] of Object.entries(decisions ?? {}).entries()) {
    const seq = folded.seq;
    if (typeof seq === "number" && Number.isSafeInteger(seq)) {
      anchor = seq;
      entries.push({ id, folded, seq, anchor: seq, i });
    } else entries.push({ id, folded, anchor, i });
  }
  // stamped: (seq, 0, i); legacy: (anchor, 1, i). `anchor` 0 < every real seq (>= 1).
  entries.sort(
    (a, b) =>
      a.anchor - b.anchor || Number(a.seq === undefined) - Number(b.seq === undefined) || a.i - b.i
  );
  let ordinal = 0;
  const leading = entries.filter((e) => e.seq === undefined && e.anchor === 0).length;
  for (const e of entries) {
    ordinal++;
    const original = real.get(e.id);
    const { seq: _seq, ...rest } = e.folded;
    // `sequence` stays an integer: a stamped entry's `seq`; a legacy entry before every stamped one
    // a negative ordinal (-n..-1); a legacy entry after a stamped one shares that entry's `seq`
    // (the emit order, a stable sort, keeps it after). A synthetic value, never a real position.
    const synthetic = e.seq ?? (e.anchor === 0 ? ordinal - leading - 1 : e.anchor);
    out.push({
      id: original?.id ?? `${executionId}-decision-${ordinal}`,
      workflowId,
      executionId,
      eventType: "DECISION_RECORDED",
      sequence: original?.sequence ?? synthetic,
      timestamp: original?.timestamp ?? state.startedAt,
      payload: { ...rest, decisionId: e.id },
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
