import type { EventEnvelope, ExecutionState } from "@loom/core";
import { EFFECT_INDOUBT_RESOLVED } from "./types";

// ADR 0104 D2 — finding the gate passthroughs a pre-0104 kernel recorded that answered NO
// suspend point: a recovery (`EXECUTION_RECOVERED` + `EXECUTION_RESUMED {}`), an in-doubt
// verdict (the park is thrown from `ctx.run`), or a `resumeAs` onto an unparked execution. The
// fold still serves each one to a later gate, and must — replay is as written — so the most
// the runtime can do is say which executions carry one, and whether it is already spent.

export type StrayPassthroughVerdict =
  /** Every stray was followed by a gate park, so each was consumed by some gate. Audit it. */
  | { kind: "passed"; count: number }
  /** A stray has not been consumed yet: the flow's next gate will pass with it. Act now. */
  | { kind: "at-risk"; count: number }
  /** Entries predate the retained log (prefix truncated) and one looks like a recovery `{}`. */
  | { kind: "unverifiable"; count: number };

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function isEmptyObject(v: unknown): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
}

export interface StrayPassthroughOptions {
  /**
   * The effect kind a step id runs, when the runtime can tell (`undefined` = unknown: a dynamic
   * step not in `definition.steps` whose id is not itself a registered tool).
   */
  kindOfStep?: (stepId: string) => string | undefined;
  /** The caller is about to RE-OPEN a terminal execution (`resumeAs`): judge it as live. */
  reopening?: boolean;
}

export interface StrayPassthroughReport {
  verdict?: StrayPassthroughVerdict;
  /**
   * An open human step whose answer cannot be told apart from another entry: the pre-0104
   * kernel re-parked it after an answer (every answer after the first would reach a later
   * gate), or an unspent stray precedes it (the step would take the stray as its approval).
   * A resume of such an execution is refused (`ambiguous-legacy-answers`) unless the operator
   * has recorded how many entries to discard for it (`discardLegacyAnswers`).
   */
  ambiguousHumanStep?: string;
  /**
   * ADR 0105 — `null` resumes into a gate park after a parallel sibling's `STEP_FAILED` landed
   * while the execution was parked. EVENT_SCHEMA 1.20.0 folded that failure to a terminal
   * "failed", so its `resumeAs` recorded a status-only `EXECUTION_RESUMED(null)` there; since
   * 1.21.0 the execution reads `suspended` and the same entry is the parked gate's answer, so
   * the gate passes with `null` and no approval on replay. The log does not record which
   * kernel wrote it (a 1.21.0 caller answering the gate with an explicit `null` writes the same
   * shape), so at a plain `ctx.suspend` gate this is reported, not refused. At an OPEN human
   * step's park it would become the step's approval, so that case is not counted here: it sets
   * {@link ambiguousHumanStep} and the resume is refused (`ambiguous-legacy-answers`) unless an
   * authenticated `discardLegacyAnswers` says how many entries to discard.
   */
  ambiguousNullResumes?: number;
}

/** Reserved decision id of the operator's `discardLegacyAnswers` record for `stepId`. */
export function discardDecisionId(stepId: string): string {
  return `__loom_discard__:${stepId}`;
}

/**
 * Classify an execution's log. `events` is the retained log in sequence order and `state` the
 * folded state (snapshot + tail) it was read with. One linear pass; mirrors the fold's
 * `EXECUTION_RESUMED` rule (1.20.0) so the entry count lines up with `_resumePayloads`.
 *
 * A gate park (`ctx.suspend`) proves every earlier entry consumed: the suspend point found
 * none left. A HUMAN park proves nothing — a pre-0104 human step consumed no entry at all,
 * and since 0104 a human step takes an entry only once it has parked — so strays survive it.
 *
 * Which step a human park belongs to: since 0104 the kernel records it (`condition.stepId`).
 * A pre-0104 park has no such field; it is attributed to the step whose `STEP_STARTED`
 * immediately precedes it (a human effect throws synchronously after its step starts) unless
 * that step is known to run a non-human effect. Only such unattributed pre-0104 parks can be
 * re-parks — a 0104 human step completes with its first answer.
 */
export function inspectStrayPassthroughs(
  events: readonly EventEnvelope[],
  state: ExecutionState,
  options: StrayPassthroughOptions = {}
): StrayPassthroughReport {
  // No resolver = no human steps known (the human-blind classification); the runtime always
  // passes one, and treats an unresolvable step as possibly human.
  const kindOf = options.kindOfStep ?? (() => "tool");
  let status = "pending";
  let parkedOn: string | undefined;
  let parkedHuman: string | undefined; // the human step this park belongs to
  let previous: EventEnvelope | undefined;
  const unspentAtStart = new Map<string, number>(); // first STEP_STARTED of each step
  const humans = new Map<
    string,
    { answers: number; reparked: boolean; open: boolean; tainted?: boolean }
  >();
  let appended = 0;
  let strays = 0;
  let unspent = 0; // strays not yet followed by a gate park
  let parkAfterHidden = false; // a gate park anywhere in the retained log
  let failedWhileParked = false; // a STEP_FAILED folded since the current park (ADR 0105)
  let ambiguousNulls = 0;

  for (const e of events) {
    switch (e.eventType) {
      case "EXECUTION_STARTED":
        status = "running";
        break;
      case "STEP_STARTED": {
        const stepId = (e.payload as { stepId?: string } | null)?.stepId;
        if (stepId !== undefined && !unspentAtStart.has(stepId)) {
          unspentAtStart.set(stepId, unspent);
        }
        break;
      }
      case "STEP_COMPLETED":
      case "STEP_FAILED":
      case "STEP_CANCELLED": {
        const stepId = (e.payload as { stepId?: string } | null)?.stepId;
        const h = stepId !== undefined ? humans.get(stepId) : undefined;
        if (h !== undefined) h.open = false;
        // A step event never moves execution status (ADR 0105): EXECUTION_FAILED does. A
        // failure that lands while parked is a parallel sibling's (the flow body is parked).
        if (e.eventType === "STEP_FAILED" && status === "suspended") failedWhileParked = true;
        break;
      }
      case "EXECUTION_SUSPENDED": {
        const condition = (e.payload as { condition?: { on?: string; stepId?: string } } | null)
          ?.condition;
        const on = condition?.on;
        status = "suspended";
        parkedOn = on;
        parkedHuman = undefined;
        failedWhileParked = false;
        if (on === EFFECT_INDOUBT_RESOLVED) break;
        let legacy = false;
        if (typeof condition?.stepId === "string") {
          parkedHuman = condition.stepId;
        } else if (previous?.eventType === "STEP_STARTED") {
          const stepId = (previous.payload as { stepId?: string } | null)?.stepId;
          const kind = stepId !== undefined ? kindOf(stepId) : "tool";
          if (stepId !== undefined && (kind === undefined || kind === "human")) {
            parkedHuman = stepId;
            legacy = true;
          }
        }
        if (parkedHuman !== undefined) {
          const h = humans.get(parkedHuman) ?? { answers: 0, reparked: false, open: true };
          if (legacy && h.answers > 0) h.reparked = true;
          h.open = true;
          humans.set(parkedHuman, h);
        } else {
          unspent = 0;
          parkAfterHidden = true;
        }
        break;
      }
      case "EXECUTION_RESUMED": {
        const answersGate = status === "suspended" && parkedOn !== EFFECT_INDOUBT_RESOLVED;
        const statusOnly = e.payload === null && !answersGate;
        if (e.payload === null && answersGate && failedWhileParked) {
          // ADR 0105 — at a HUMAN park this null would become the step's approval on replay:
          // routed to the ambiguous-human-step refusal below. At a plain gate: reported.
          const h = parkedHuman !== undefined ? humans.get(parkedHuman) : undefined;
          if (h !== undefined) h.tainted = true;
          else ambiguousNulls++;
        }
        failedWhileParked = false;
        if (e.payload !== undefined && !statusOnly) {
          appended++;
          if (!answersGate) {
            strays++;
            unspent++;
          } else if (parkedHuman !== undefined) {
            const h = humans.get(parkedHuman);
            if (h !== undefined) h.answers++;
          }
        }
        status = "running";
        parkedOn = undefined;
        parkedHuman = undefined;
        break;
      }
      case "EXECUTION_FAILED":
        status = "failed";
        break;
      case "EXECUTION_COMPLETED":
        status = "completed";
        break;
      case "EXECUTION_CANCELLED":
        status = "cancelled";
        break;
    }
    previous = e;
  }

  const decisions = (state.variables._decisions as Record<string, unknown> | undefined) ?? {};
  let ambiguousHumanStep: string | undefined;
  let humanAtRisk = 0;
  for (const [stepId, h] of humans) {
    if (!h.open) {
      // A step the log already completed is past refusing; say what it may have taken.
      if (h.tainted === true) ambiguousNulls++;
      continue;
    }
    const strayBefore = (unspentAtStart.get(stepId) ?? 0) > 0;
    if (!strayBefore && !h.reparked && h.tainted !== true) continue;
    // A re-parked step's answers are not its own to take one-by-one: on the 0104 kernel the
    // first would complete it and the rest would reach later gates.
    if (h.reparked) humanAtRisk += h.answers;
    if (!Object.hasOwn(decisions, discardDecisionId(stepId))) ambiguousHumanStep ??= stepId;
  }

  const terminal = TERMINAL.has(state.status) && options.reopening !== true;
  const report = (verdict?: StrayPassthroughVerdict): StrayPassthroughReport => ({
    ...(verdict !== undefined && { verdict }),
    ...(ambiguousHumanStep !== undefined && !terminal && { ambiguousHumanStep }),
    ...(ambiguousNulls > 0 && !terminal && { ambiguousNullResumes: ambiguousNulls }),
  });
  const atRisk = unspent + humanAtRisk;
  if (atRisk > 0 && !terminal) return report({ kind: "at-risk", count: atRisk });
  if (strays > 0 && !terminal) return report({ kind: "passed", count: strays });

  // Entries the retained log does not explain: the prefix was retained away and the snapshot
  // still holds them. A park in the retained tail proves them spent; otherwise flag the ones
  // shaped like the pre-0104 recovery payload.
  const recorded = (state.variables._resumePayloads as unknown[] | undefined) ?? [];
  const hidden = recorded.length - appended;
  if (hidden > 0 && !terminal && !parkAfterHidden) {
    let empties = 0;
    for (let i = 0; i < hidden; i++) if (isEmptyObject(recorded[i])) empties++;
    if (empties > 0) return report({ kind: "unverifiable", count: empties });
  }
  return report();
}

/** The verdict alone (see {@link inspectStrayPassthroughs}). */
export function classifyStrayPassthroughs(
  events: readonly EventEnvelope[],
  state: ExecutionState,
  options: StrayPassthroughOptions = {}
): StrayPassthroughVerdict | undefined {
  return inspectStrayPassthroughs(events, state, options).verdict;
}

/** The operator-facing sentence for a verdict. */
export function strayPassthroughMessage(executionId: string, v: StrayPassthroughVerdict): string {
  switch (v.kind) {
    case "at-risk":
      return `execution "${executionId}": ${v.count} gate passthrough(s) recorded by a pre-ADR 0104 kernel answered no gate (a crash recovery, an in-doubt verdict, or a resumeAs onto an unparked execution) and are NOT yet spent — the flow's next gate will pass with that payload and no approval. Act now: cancel or inspect the execution. The log is replayed as written for determinism.`;
    case "passed":
      return `execution "${executionId}": ${v.count} gate passthrough(s) recorded by a pre-ADR 0104 kernel answered no gate and were already served to a later gate as its answer. Replayed as written for determinism — audit which gate passed without an approval.`;
    case "unverifiable":
      return `execution "${executionId}": ${v.count} gate passthrough(s) of {} predate the retained log (the prefix was retained away), and the pre-ADR 0104 recovery wrote exactly {}. If one came from a recovery, the flow's next gate will pass with it and no approval — inspect the execution.`;
  }
}

/** The operator-facing sentence for {@link StrayPassthroughReport.ambiguousNullResumes}. */
export function ambiguousNullResumeMessage(executionId: string, count: number): string {
  return `execution "${executionId}": ${count} null resume(s) were recorded at a parked gate after a parallel step failed while it was parked. An EVENT_SCHEMA 1.20.0 kernel folded that failure to "failed", and its resumeAs recorded exactly this entry as a status-only re-open; since 1.21.0 (ADR 0105) it is the parked gate's answer, so that gate passes with null and no approval on replay. If this execution was migrated with resumeAs under 1.20.0, cancel or inspect it; if an operator answered the gate with an explicit null, nothing is wrong.`;
}
