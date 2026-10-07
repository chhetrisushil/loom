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

/** One recorded frame, in the log's first-start order. `completed` = the re-run must ask for it. */
export interface RecordedFrame {
  readonly id: string;
  readonly completed: boolean;
  /** Journal sequence of its first `STEP_STARTED`. */
  readonly seq?: number;
  /** The cancellation-scope path it first started in (`""` = root); absent = unknown. */
  readonly scope?: string;
}

/** What a served decision's record says about the steps its decider ran. */
export interface DecisionInner {
  readonly steps: readonly string[];
  /** Past the record's cap: frames first started in `(from, to)` are also the decider's. */
  readonly overflow?: { readonly from: number; readonly to: number };
}

interface OpenScope {
  readonly path: string;
  /** The ids a scope of explicit `[step, input]` branches asks for; `undefined` for any function branch. */
  readonly explicit: ReadonlySet<string> | undefined;
  /** Rank of the first recorded frame that belongs to it (`undefined` = none recorded). */
  readonly start: number | undefined;
  readonly belonging: readonly string[];
}

/**
 * ADR 0113 D3 — the replay-divergence detector, one per live run.
 *
 * A re-run knows what the log says it did: every step the log records as COMPLETED must be asked
 * for again before the re-run starts new durable work. The guard holds the not-yet-asked-for ids
 * in a set (`visit` deletes one in O(1); the check advances a monotone cursor over the log's
 * first-start order), so the cost per append is O(1) amortised however long the log. MEMBERSHIP
 * only, no order: a benign reorder is not a fault; a recorded step the body never asked for is.
 *
 * What it judges, and what it deliberately does not:
 * - It gates STEP_STARTED, a park, a continuation and completion. It does NOT gate flow-level
 *   emits (an unprovable emit is re-appended on every re-run by design, ADR 0102) nor a live
 *   decision's record; a decider (transient, nothing durable) may therefore run under a diverged
 *   body, and the next step is refused before its effect.
 * - A STEP_STARTED for a step the log already holds a frame for (an untyped failure, re-run live by
 *   design) is judged only against the frames recorded BEFORE it.
 * - SCOPES. While a `parallel` call is open its branches interleave, so the frames that belong to
 *   it compare as a SET at close. A step that starts live inside it is judged against every
 *   recorded frame that does NOT belong to an open scope and was first started before the scope's
 *   recorded start (a scope with no recorded frames: all of them), plus the scope's own recorded
 *   frames a scope of explicit branches provably no longer asks for. Membership comes from the
 *   scope path the kernel records on each frame (`kernel.features.scopes`); a log without it falls
 *   back to a floor (the lowest rank the scope is known to touch), which judges less.
 * - A decision served from the log skips its decider's steps. The record carries them
 *   (`innerSteps`, kernel-stamped, possibly empty) and a served decision exempts exactly those. Past
 *   the record's cap the record flags an overflow and the frames first started during the decision
 *   are exempt too (bounded fail-open). A record WITHOUT the field (a pre-R7 log) falls back to the
 *   naming convention `<decisionId>:...` / `<decisionId>#...` that `agentLoop$` follows.
 */
export class DivergenceGuard {
  private readonly order: string[];
  private readonly rank = new Map<string, number>();
  private readonly seqs: Array<number | undefined>;
  private readonly scopeOf: Map<string, string>;
  /** Every recorded frame carries a scope path: membership is knowable. */
  private readonly scopeAware: boolean;
  private readonly pending: Set<string>;
  /** Every rank below `lo` has been asked for or exempted. */
  private lo = 0;
  private readonly open: OpenScope[] = [];
  /** Recorded scope frames a fully explicit open scope no longer asks for: always judged. */
  private forced = new Set<string>();
  /** Fallback floor for a log without scope paths. */
  private scopeFloor: number | undefined;
  /** Prefix index of pending ids (built once, only for a served decision with no `innerSteps`). */
  private prefixIndex: Map<string, string[]> | undefined;
  private failure: FlowReplayDivergenceError | undefined;
  private warned = false;

  constructor(
    private readonly executionId: string,
    private readonly mode: DivergenceMode,
    frames: readonly RecordedFrame[],
    private readonly warn: (message: string, error: FlowReplayDivergenceError) => void
  ) {
    const kept = mode === "off" ? [] : frames;
    this.order = kept.map((f) => f.id);
    this.seqs = kept.map((f) => f.seq);
    this.scopeOf = new Map();
    this.order.forEach((id, i) => {
      this.rank.set(id, i);
    });
    for (const f of kept) if (f.scope !== undefined) this.scopeOf.set(f.id, f.scope);
    this.scopeAware = kept.length > 0 && this.scopeOf.size === kept.length;
    this.pending = new Set(kept.filter((f) => f.completed).map((f) => f.id));
  }

  /** The re-run asked for step `id` (served or live). */
  visit(id: string): void {
    if (this.open.length > 0 && !this.scopeAware) {
      const r = this.rank.get(id);
      if (r !== undefined && (this.scopeFloor === undefined || r < this.scopeFloor)) {
        this.scopeFloor = r;
      }
    }
    this.pending.delete(id);
  }

  /**
   * A `parallel` call opened. `stepIds` are the ids of its explicit `[step, input]` branches and
   * `allExplicit` says every branch is one (so the set it asks for is fully known); `path` is the
   * scope's path (ADR 0112).
   */
  scopeOpen(path: string, stepIds: readonly string[], allExplicit: boolean): void {
    if (this.mode === "off") return;
    const belonging: string[] = [];
    let start: number | undefined;
    if (this.scopeAware) {
      for (const [id, p] of this.scopeOf) {
        if (p === path || p.startsWith(`${path}.`) || p.startsWith(`${path}/`)) {
          belonging.push(id);
          const r = this.rank.get(id) as number;
          if (start === undefined || r < start) start = r;
        }
      }
    } else if (this.open.length === 0) {
      this.scopeFloor = undefined;
      for (const id of stepIds) {
        const r = this.rank.get(id);
        if (r !== undefined && (this.scopeFloor === undefined || r < this.scopeFloor)) {
          this.scopeFloor = r;
        }
      }
    }
    const explicit = allExplicit ? new Set(stepIds) : undefined;
    this.open.push({ path, explicit, start, belonging });
    for (const id of belonging) {
      if (explicit !== undefined && !explicit.has(id) && this.pending.has(id)) this.forced.add(id);
    }
  }

  scopeClose(): void {
    if (this.mode === "off") return;
    this.open.pop();
    if (this.open.length === 0) {
      this.forced = new Set();
      this.scopeFloor = undefined;
      return;
    }
    this.forced = new Set(
      this.open.flatMap((o) =>
        o.explicit === undefined
          ? []
          : o.belonging.filter((id) => !(o.explicit as Set<string>).has(id))
      )
    );
  }

  /**
   * A decision was served from the log: its decider never runs, so the steps it ran are never asked
   * for. Exempts exactly the record's `innerSteps` (plus, past its cap, the frames first started
   * during the decision); a record without the field gets the naming-convention fallback.
   */
  decisionServed(decisionId: string, inner: DecisionInner | undefined): void {
    if (this.pending.size === 0) return;
    if (inner !== undefined) {
      for (const id of inner.steps) this.pending.delete(id);
      if (inner.overflow !== undefined) {
        const { from, to } = inner.overflow;
        // `seqs` is nondecreasing (unranked frames, `undefined`, sort first as -1): binary-search the
        // first frame started after `from`, then walk to `to`.
        let lo = 0;
        let hi = this.seqs.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if ((this.seqs[mid] ?? -1) > from) hi = mid;
          else lo = mid + 1;
        }
        for (let k = lo; k < this.seqs.length; k++) {
          const seq = this.seqs[k];
          if (seq === undefined || seq >= to) break;
          this.pending.delete(this.order[k] as string);
        }
      }
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

  /** Is the pending frame at `rank` one the guard may judge now, given `bound` (and open scopes)? */
  private judgeable(k: number, bound: number): boolean {
    const id = this.order[k] as string;
    if (this.open.length === 0) return k < bound;
    if (this.scopeAware) {
      if (this.forced.has(id)) return true;
      // A scope's own frames rank at or after the earliest open scope's recorded start, so they fall
      // outside this bound by construction: they compare as a set at close.
      let scopeBound = Number.POSITIVE_INFINITY;
      for (const o of this.open)
        if (o.start !== undefined && o.start < scopeBound) scopeBound = o.start;
      return k < Math.min(bound, scopeBound);
    }
    return k < Math.min(bound, this.scopeFloor ?? -1);
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
    while (this.lo < this.order.length && !this.pending.has(this.order[this.lo] as string)) {
      this.lo++;
    }
    const names: string[] = [];
    let count = 0;
    for (let k = this.lo; k < this.order.length; k++) {
      const id = this.order[k] as string;
      if (!this.pending.has(id) || !this.judgeable(k, bound)) {
        if (this.open.length === 0 && k >= bound) break;
        continue;
      }
      count++;
      if (names.length < NAMED) names.push(id);
      else break; // enough to name; the count then reads "at least" (a scan per append stays bounded)
    }
    if (count === 0) return undefined;
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
