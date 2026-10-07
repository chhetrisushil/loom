import type { EventEnvelope, ExecutionState } from "@loom/core";
import { FLOW_DIVERGED_GATE } from "@loom/replay-vm";
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

const TERMINAL = new Set(["completed", "failed", "cancelled", "continued"]);

function isWaitAddressedResume(e: {
  payload: unknown;
  metadata?: Record<string, unknown>;
}): boolean {
  const p = e.payload;
  return (
    e.metadata?.kernel === true &&
    p !== null &&
    typeof p === "object" &&
    !Array.isArray(p) &&
    typeof (p as { waitId?: unknown }).waitId === "string" &&
    Object.hasOwn(p, "payload")
  );
}

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
  const scanner = new StrayScanner(options.kindOfStep);
  scanner.feed(events);
  return scanner.report(state, options);
}

/**
 * R1a — the scan of {@link inspectStrayPassthroughs} as a resumable object: `feed` events in
 * sequence order (any number of calls), `report` against the folded state. Feeding a log in
 * pieces is, by construction, the same single pass as feeding it whole — every piece of
 * cross-event state lives in a field — so the runtime can keep a scanner per execution and feed
 * it only the events appended since, instead of re-reading the whole log on every resume.
 * `report` does not mutate the scanner.
 */
export class StrayScanner {
  /** Sequence of the last event fed (`-1` = none). */
  through = -1;
  /** Envelope id of the event at `through` — proves a later read continues the SAME log. */
  throughId: string | undefined = undefined;
  private readonly kindOf: (stepId: string) => string | undefined;
  private status = "pending";
  private parkedOn: string | undefined;
  private parkedHuman: string | undefined; // the human step this park belongs to
  private previousType: string | undefined;
  private previousStepId: string | undefined;
  private readonly unspentAtStart = new Map<string, number>(); // first STEP_STARTED of each step
  private readonly humans = new Map<
    string,
    { answers: number; reparked: boolean; open: boolean }
  >();
  private appended = 0;
  private strays = 0;
  private unspent = 0; // strays not yet followed by a gate park
  private parkAfterHidden = false; // a gate park anywhere in the retained log
  private failedWhileParked = false; // mirrors the fold's `_failedWhileParked` (ADR 0105)

  constructor(kindOfStep?: (stepId: string) => string | undefined) {
    // No resolver = no human steps known (the human-blind classification); the runtime always
    // passes one, and treats an unresolvable step as possibly human.
    this.kindOf = kindOfStep ?? (() => "tool");
  }

  feed(events: readonly EventEnvelope[]): void {
    for (const e of events) {
      // Idempotent: an event at or before `through` was already consumed (two resumes of one
      // execution can share a scanner and read overlapping tails).
      if (e.sequence <= this.through) continue;
      this.step(e);
      this.previousType = e.eventType;
      this.previousStepId =
        e.eventType === "STEP_STARTED"
          ? (e.payload as { stepId?: string } | null)?.stepId
          : undefined;
      this.through = e.sequence;
      this.throughId = e.id;
    }
  }

  private step(e: EventEnvelope): void {
    switch (e.eventType) {
      case "EXECUTION_STARTED":
        this.status = "running";
        break;
      case "STEP_STARTED": {
        const stepId = (e.payload as { stepId?: string } | null)?.stepId;
        if (stepId !== undefined && !this.unspentAtStart.has(stepId)) {
          this.unspentAtStart.set(stepId, this.unspent);
        }
        break;
      }
      case "STEP_COMPLETED":
      case "STEP_FAILED":
      case "STEP_CANCELLED": {
        const stepId = (e.payload as { stepId?: string } | null)?.stepId;
        const h = stepId !== undefined ? this.humans.get(stepId) : undefined;
        if (h !== undefined) h.open = false;
        // A step event never moves execution status (ADR 0105): EXECUTION_FAILED does. A
        // failure that lands while parked (a parallel sibling's) makes a following `null`
        // resume status-only — the fold's `_failedWhileParked` rule.
        if (e.eventType === "STEP_FAILED" && this.status === "suspended") {
          this.failedWhileParked = true;
        }
        break;
      }
      case "EXECUTION_SUSPENDED": {
        const condition = (e.payload as { condition?: { on?: string; stepId?: string } } | null)
          ?.condition;
        const on = condition?.on;
        this.status = "suspended";
        this.parkedOn = on;
        this.parkedHuman = undefined;
        this.failedWhileParked = false;
        if (on === EFFECT_INDOUBT_RESOLVED || on === FLOW_DIVERGED_GATE) break;
        let legacy = false;
        if (typeof condition?.stepId === "string") {
          this.parkedHuman = condition.stepId;
        } else if (this.previousType === "STEP_STARTED") {
          const stepId = this.previousStepId;
          const kind = stepId !== undefined ? this.kindOf(stepId) : "tool";
          if (stepId !== undefined && (kind === undefined || kind === "human")) {
            this.parkedHuman = stepId;
            legacy = true;
          }
        }
        if (this.parkedHuman !== undefined) {
          const h = this.humans.get(this.parkedHuman) ?? {
            answers: 0,
            reparked: false,
            open: true,
          };
          if (legacy && h.answers > 0) h.reparked = true;
          h.open = true;
          this.humans.set(this.parkedHuman, h);
        } else {
          this.unspent = 0;
          this.parkAfterHidden = true;
        }
        break;
      }
      case "EXECUTION_RESUMED": {
        // EVENT_SCHEMA 1.23.0 (ADR 0110 D3): a kernel-stamped, wait-addressed resume answers a wait
        // of a multi-wait park and never enters `_resumePayloads`, so it is not a passthrough.
        if (isWaitAddressedResume(e)) {
          this.failedWhileParked = false;
          this.status = "running";
          this.parkedOn = undefined;
          this.parkedHuman = undefined;
          break;
        }
        const answersGate =
          this.status === "suspended" &&
          this.parkedOn !== EFFECT_INDOUBT_RESOLVED &&
          this.parkedOn !== FLOW_DIVERGED_GATE;
        // Mirrors the fold's `isStatusOnlyResume` (1.20.0 + 1.21.0), so the entry count lines
        // up with `_resumePayloads`.
        const statusOnly = e.payload === null && (!answersGate || this.failedWhileParked);
        this.failedWhileParked = false;
        if (e.payload !== undefined && !statusOnly) {
          this.appended++;
          if (!answersGate) {
            this.strays++;
            this.unspent++;
          } else if (this.parkedHuman !== undefined) {
            const h = this.humans.get(this.parkedHuman);
            if (h !== undefined) h.answers++;
          }
        }
        this.status = "running";
        this.parkedOn = undefined;
        this.parkedHuman = undefined;
        break;
      }
      case "EXECUTION_FAILED":
        this.status = "failed";
        this.failedWhileParked = false;
        break;
      case "EXECUTION_COMPLETED":
        this.status = "completed";
        this.failedWhileParked = false;
        break;
      case "EXECUTION_CANCELLED":
        this.status = "cancelled";
        this.failedWhileParked = false;
        break;
      case "EXECUTION_CONTINUED":
        // Mirrors the fold: only a kernel-stamped envelope ends the execution.
        if (e.metadata?.kernel === true) {
          this.status = "continued";
          this.failedWhileParked = false;
        }
        break;
    }
  }

  report(
    state: ExecutionState,
    options: Pick<StrayPassthroughOptions, "reopening"> = {}
  ): StrayPassthroughReport {
    const decisions = (state.variables._decisions as Record<string, unknown> | undefined) ?? {};
    let ambiguousHumanStep: string | undefined;
    let humanAtRisk = 0;
    for (const [stepId, h] of this.humans) {
      if (!h.open) continue;
      const strayBefore = (this.unspentAtStart.get(stepId) ?? 0) > 0;
      if (!strayBefore && !h.reparked) continue;
      // A re-parked step's answers are not its own to take one-by-one: on the 0104 kernel the
      // first would complete it and the rest would reach later gates.
      if (h.reparked) humanAtRisk += h.answers;
      if (!Object.hasOwn(decisions, discardDecisionId(stepId))) ambiguousHumanStep ??= stepId;
    }

    const terminal = TERMINAL.has(state.status) && options.reopening !== true;
    const make = (verdict?: StrayPassthroughVerdict): StrayPassthroughReport => ({
      ...(verdict !== undefined && { verdict }),
      ...(ambiguousHumanStep !== undefined && !terminal && { ambiguousHumanStep }),
    });
    const atRisk = this.unspent + humanAtRisk;
    if (atRisk > 0 && !terminal) return make({ kind: "at-risk", count: atRisk });
    if (this.strays > 0 && !terminal) return make({ kind: "passed", count: this.strays });

    // Entries the retained log does not explain: the prefix was retained away and the snapshot
    // still holds them. A park in the retained tail proves them spent; otherwise flag the ones
    // shaped like the pre-0104 recovery payload.
    const recorded = (state.variables._resumePayloads as unknown[] | undefined) ?? [];
    const hidden = recorded.length - this.appended;
    if (hidden > 0 && !terminal && !this.parkAfterHidden) {
      let empties = 0;
      for (let i = 0; i < hidden; i++) if (isEmptyObject(recorded[i])) empties++;
      if (empties > 0) return make({ kind: "unverifiable", count: empties });
    }
    return make();
  }
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
