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
]);

/** Names listed in the error; the rest are counted. */
const NAMED = 8;

/**
 * ADR 0113 D3 — the replay-divergence detector, one per live run.
 *
 * A re-run knows what the log says it did: every step the log records as COMPLETED must be asked
 * for again before the re-run does anything new. The guard holds the not-yet-asked-for ids in a set
 * (`visit` deletes one in O(1); the check advances a monotone cursor), so the cost per append is
 * O(1) amortised however long the log. MEMBERSHIP only, no order: a benign reorder, or overlapping
 * work, is not a fault; a recorded step the body never asked for is.
 *
 * `deferred` is true while a `parallel` call is open: the branches of a scope interleave, so a live
 * append from one branch can legitimately precede a sibling's served frame. The check waits for the
 * scope to close (the ids are compared as a SET), and applies at the next append after it.
 *
 * SERVED DECISIONS. A decision served from the log skips its decider, and with it every step the
 * decider ran (`agentLoop$`'s `#skills:select` is a `ctx.execute` inside `ctx.decide`): the log holds
 * those frames, the re-run never asks for them, and nothing in the fold says which decision they
 * belonged to. So a served decision opens an UNCERTAIN window: the frames recorded after the
 * re-run's high-water mark (the furthest recorded frame it has asked for, in the log's first-start
 * order) may be that decider's, and are not judged until the re-run asks for a later frame, which
 * closes the window and exempts the ones it jumped over. Frames the re-run has already moved past
 * stay judged. This is fail-open on purpose: a missed divergence costs a warning that did not
 * fire; a false one refuses a healthy execution under `fail`.
 */
export class DivergenceGuard {
  private readonly order: string[];
  private readonly rank = new Map<string, number>();
  private readonly pending: Set<string>;
  /** Every rank below `lo` has been asked for or exempted. */
  private lo = 0;
  /** The furthest rank the re-run has asked for. */
  private hwm = -1;
  /** While a served decision's window is open: frames ranked above this are not judged. */
  private uncertain: number | undefined;
  private failure: FlowReplayDivergenceError | undefined;
  private warned = false;

  /** `expected` is in the log's first-start order (`ReplayVM.expectedReplayFrames`). */
  constructor(
    private readonly executionId: string,
    private readonly mode: DivergenceMode,
    expected: readonly string[],
    private readonly deferred: () => boolean,
    private readonly warn: (message: string, error: FlowReplayDivergenceError) => void
  ) {
    this.order = mode === "off" ? [] : [...expected];
    this.order.forEach((id, i) => {
      this.rank.set(id, i);
    });
    this.pending = new Set(this.order);
  }

  /** The re-run asked for step `id` (served or live). */
  visit(id: string): void {
    const r = this.rank.get(id);
    if (r === undefined) return; // not a recorded completed step
    if (this.uncertain !== undefined && r > this.uncertain) {
      // The window's frames were skipped by a served decision's decider, not by the body.
      for (let k = this.uncertain + 1; k < r; k++) this.pending.delete(this.order[k] as string);
      this.uncertain = undefined;
    }
    this.pending.delete(id);
    if (r > this.hwm) this.hwm = r;
  }

  /** The re-run served a decision from the log: its decider's frames will never be asked for. */
  decisionServed(): void {
    if (this.pending.size === 0) return;
    if (this.uncertain === undefined || this.hwm < this.uncertain) this.uncertain = this.hwm;
  }

  /** How many recorded completed steps this re-run has not yet asked for (judged or not). */
  get unvisited(): number {
    return this.pending.size;
  }

  /** The refusal this run was given (`fail` mode), if any: set even when the body swallowed it. */
  get latched(): FlowReplayDivergenceError | undefined {
    return this.failure;
  }

  /** Rank of the lowest pending frame the guard may judge, or -1. Amortised O(1). */
  private judged(): number {
    while (this.lo < this.order.length && !this.pending.has(this.order[this.lo] as string)) {
      this.lo++;
    }
    if (this.lo >= this.order.length) return -1;
    return this.uncertain === undefined || this.lo <= this.uncertain ? this.lo : -1;
  }

  /**
   * The error to raise before a live append of `eventType`, or `undefined` to let it through.
   * `warn` mode reports once and always proceeds; `fail` mode latches, so a body that swallowed
   * the first refusal is refused again at its next append.
   */
  refusal(eventType: string): FlowReplayDivergenceError | undefined {
    if (this.mode === "off" || EXEMPT.has(eventType)) return undefined;
    if (this.failure !== undefined) return this.failure;
    if (this.pending.size === 0 || this.deferred()) return undefined;
    const first = this.judged();
    if (first < 0) return undefined;
    const names: string[] = [];
    let count = 0;
    for (let k = first; k < this.order.length; k++) {
      if (this.uncertain !== undefined && k > this.uncertain) break;
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
    if (!this.warned) {
      this.warned = true;
      this.warn(error.message, error);
    }
    return undefined;
  }

  /** The {@link refusal}, thrown. */
  check(eventType: string): void {
    const error = this.refusal(eventType);
    if (error !== undefined) throw error;
  }
}
