import { FlowReplayDivergenceError } from "./types";

/** ADR 0113 D3 — how the replay-divergence detector reacts. */
export type DivergenceMode = "off" | "warn" | "fail";

/**
 * Appends that follow a decision already taken, and so are never "the first live append under a
 * diverged body": the outcome of a step the guard already let start, the terminal facts that report
 * a failure or a cancel (a refusal must not be masked by, nor mask, them), and the scope record
 * that closes a `parallel` whose branches the guard already let run.
 */
const EXEMPT = new Set([
  "STEP_COMPLETED",
  "STEP_FAILED",
  "STEP_CANCELLED",
  "EXECUTION_FAILED",
  "EXECUTION_CANCELLED",
  "PARALLEL_COMPLETED",
  // The record of a decision whose decider already ran: judged (if at all) by the NEXT step, park,
  // continuation or completion, which still gate before any durable effect (fix round 1).
  "DECISION_RECORDED",
]);

/** Names listed in the error; the rest are counted. */
const NAMED = 8;

/**
 * ADR 0113 D3 — the replay-divergence detector, one per live run.
 *
 * A re-run knows what the log says it did: every step the log records as COMPLETED must be asked
 * for again before the re-run starts new durable work. The guard holds the not-yet-asked-for ids
 * in a set (`visit` deletes one in O(1); the check advances a monotone cursor over the log's
 * first-start order), so the cost per append is O(1) amortised however long the log. MEMBERSHIP
 * only, no order: a benign reorder is not a fault; a recorded step the body never asked for is.
 *
 * What it judges, and what it deliberately does not (fix round 1):
 * - It gates STEP_STARTED, a park, a continuation and completion. It does NOT gate flow-level
 *   emits (an unprovable emit is re-appended on every re-run by design, ADR 0102) nor a live
 *   decision's record; a decider (transient, nothing durable) may therefore run under a diverged
 *   body, and the next step is refused before its effect.
 * - A STEP_STARTED for a step the log already holds a frame for (an untyped failure, re-run live by
 *   design) is judged only against the frames recorded BEFORE it: dropping an earlier step and
 *   re-running a later failed one with new input is still a divergence.
 * - While a `parallel` call is open its branches interleave, so frames of the scope compare as a
 *   set at close. Frames ranked below the scope's lowest asked-for frame (or, before any is asked
 *   for, below the lowest recorded frame among its explicit `[step, input]` branches) are judged
 *   as usual: they were recorded before the scope began.
 * - A decision served from the log skips its decider's steps. The record carries them
 *   (`innerSteps`, kernel-stamped) and a served decision exempts exactly those; for a record
 *   without the field (a pre-R7 log, or a crash before the record) the fallback is the naming
 *   convention `<decisionId>:…` / `<decisionId>#…` that `agentLoop$` follows.
 */
export class DivergenceGuard {
  private readonly order: string[];
  private readonly rank = new Map<string, number>();
  private readonly pending: Set<string>;
  /** Every rank below `lo` has been asked for or exempted. */
  private lo = 0;
  private scopeDepth = 0;
  /** The lowest rank known to belong to the open scope(s); `undefined` until one is. */
  private scopeFloor: number | undefined;
  /** Prefix index of pending ids (built once, only for a served decision with no `innerSteps`). */
  private prefixIndex: Map<string, string[]> | undefined;
  private failure: FlowReplayDivergenceError | undefined;
  private warned = false;

  /**
   * `expected` is the COMPLETED frames the re-run must ask for; `order` is every recorded frame
   * in first-start order (`ReplayVM.recordedFrameOrder`), which positions the non-completed ones.
   */
  constructor(
    private readonly executionId: string,
    private readonly mode: DivergenceMode,
    expected: readonly string[],
    order: readonly string[],
    private readonly warn: (message: string, error: FlowReplayDivergenceError) => void
  ) {
    this.order = mode === "off" ? [] : [...order];
    this.order.forEach((id, i) => {
      this.rank.set(id, i);
    });
    this.pending = new Set(mode === "off" ? [] : expected.filter((id) => this.rank.has(id)));
  }

  /** The re-run asked for step `id` (served or live). */
  visit(id: string): void {
    if (this.scopeDepth > 0) {
      const r = this.rank.get(id);
      if (r !== undefined && (this.scopeFloor === undefined || r < this.scopeFloor)) {
        this.scopeFloor = r;
      }
    }
    this.pending.delete(id);
  }

  /** A `parallel` call opened; `stepIds` are the ids of its explicit `[step, input]` branches. */
  scopeOpen(stepIds: readonly string[]): void {
    if (this.mode === "off") return;
    if (this.scopeDepth++ === 0) {
      this.scopeFloor = undefined;
      for (const id of stepIds) {
        const r = this.rank.get(id);
        if (r !== undefined && (this.scopeFloor === undefined || r < this.scopeFloor)) {
          this.scopeFloor = r;
        }
      }
    }
  }

  scopeClose(): void {
    if (this.mode === "off") return;
    if (--this.scopeDepth === 0) this.scopeFloor = undefined;
  }

  /**
   * A decision was served from the log: its decider never runs, so the steps it ran are never asked
   * for. Exempts exactly `innerSteps` when the record carries them, else the naming-convention
   * fallback.
   */
  decisionServed(decisionId: string, innerSteps: readonly string[] | undefined): void {
    if (this.pending.size === 0) return;
    if (innerSteps !== undefined) {
      for (const id of innerSteps) this.pending.delete(id);
      return;
    }
    if (this.prefixIndex === undefined) {
      const index = new Map<string, string[]>();
      for (const id of this.pending) {
        for (let k = 0; k < id.length; k++) {
          const c = id.charCodeAt(k);
          if (c !== 58 /* : */ && c !== 35 /* # */) continue;
          const prefix = id.slice(0, k);
          const list = index.get(prefix);
          if (list === undefined) index.set(prefix, [id]);
          else list.push(id);
        }
      }
      this.prefixIndex = index;
    }
    for (const id of this.prefixIndex.get(decisionId) ?? []) this.pending.delete(id);
  }

  /** How many recorded completed steps this re-run has not yet asked for (judged or not). */
  get unvisited(): number {
    return this.pending.size;
  }

  /** The refusal this run was given (`fail` mode), if any: set even when the body swallowed it. */
  get latched(): FlowReplayDivergenceError | undefined {
    return this.failure;
  }

  /** Rank of the lowest pending frame below `bound`, or -1. Amortised O(1). */
  private judged(bound: number): number {
    while (this.lo < this.order.length && !this.pending.has(this.order[this.lo] as string)) {
      this.lo++;
    }
    return this.lo < this.order.length && this.lo < bound ? this.lo : -1;
  }

  /**
   * The error to raise before a live append of `eventType`, or `undefined` to let it through.
   * `before` names a step the log already holds a frame for: only frames recorded before it are
   * judged. `warn` mode reports once and then stops judging (O(1) afterwards); `fail` mode
   * latches, so a body that swallowed the first refusal is refused again.
   */
  refusal(eventType: string, before?: string): FlowReplayDivergenceError | undefined {
    if (this.mode === "off" || EXEMPT.has(eventType)) return undefined;
    if (this.failure !== undefined) return this.failure;
    if (this.mode === "warn" && this.warned) return undefined;
    if (this.pending.size === 0) return undefined;
    let bound = Number.POSITIVE_INFINITY;
    if (before !== undefined) bound = this.rank.get(before) ?? bound;
    if (this.scopeDepth > 0) bound = Math.min(bound, this.scopeFloor ?? -1);
    const first = this.judged(bound);
    if (first < 0) return undefined;
    const names: string[] = [];
    let count = 0;
    for (let k = first; k < this.order.length && k < bound; k++) {
      const id = this.order[k] as string;
      if (!this.pending.has(id)) continue;
      count++;
      if (names.length < NAMED) names.push(id);
    }
    const error = new FlowReplayDivergenceError(this.executionId, names, count, eventType);
    if (this.mode === "fail") {
      this.failure = error;
      return error;
    }
    this.warned = true;
    this.warn(error.message, error);
    return undefined;
  }

  /** The {@link refusal}, thrown. */
  check(eventType: string, before?: string): void {
    const error = this.refusal(eventType, before);
    if (error !== undefined) throw error;
  }
}
