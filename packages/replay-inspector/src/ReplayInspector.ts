import { maskPaths } from "@loom/classify";
import type { EventEnvelope, ExecutionFrame, ExecutionState } from "@loom/core";
import type { DiffOptions, DiffResult } from "./diff";
import { diffState } from "./diff";
import { pinOf } from "./pinning";
import { reconstructProjections } from "./projections";
import { reconstructMany } from "./reconstruct";
import type {
  ProjectionSlice,
  ProjectionSource,
  ReadOnlyEventStore,
  ReadOnlySnapshotStore,
  VersionPin,
} from "./types";

// ── The facade ────────────────────────────────────────────────────────────────
//
// Composes IX-2 (reconstruction), IX-3 (transition view), IX-5 (pinning) behind one
// object, and is where IX-1 and IX-7 are enforced in practice:
//
//   IX-1 — the constructor accepts only the narrowed `ReadOnly*` store views. There is
//   no code path in this package that can append, save, fence, resume, cancel, or
//   branch, because those methods are not in scope on the types it holds.
//
//   IX-7 — the inspector performs a bounded number of bounded reads per call and holds
//   no subscription, no timer, and no lock. `EventStore.subscribe` is excluded from the
//   narrowed type precisely so tailing cannot be added without widening the boundary
//   deliberately. Point it at a read replica; nothing here contends with a writer.
//
// The instance holds configuration only — stores, projection sources, options. No
// memo, no cache, no listener. Every intermediate (fold states, diff work stacks,
// projection buckets) is per-call and released on return, so a long-lived inspector
// cannot accumulate. That is a deliberate trade: re-reading is cheaper to reason about
// than a cache that must be invalidated on nothing, since the log is append-only but
// the SET of executions is not bounded.

export interface ReplayInspectorOptions {
  /** Read-only event log. Point at a replica (IX-7). */
  events: ReadOnlyEventStore;
  /** Optional; without it every reconstruction replays from the origin. */
  snapshots?: ReadOnlySnapshotStore;
  /**
   * Projection sources for IX-3, as recorded in `manifest.projections`. Omit `load` on
   * a source whose pinned chunk is not retrievable and its slices degrade explicitly.
   */
  projections?: readonly ProjectionSource[];
  /**
   * Dot-paths, rooted at `ExecutionState`, whose values are masked before anything is
   * returned or diffed — e.g. `variables._input.ssn`. Derive them from the flow's
   * contract with `pathsOfClass(schema, "sensitive")` (`@loom/classify`).
   *
   * Masking is applied BEFORE the diff, not after, so a redacted value cannot leak
   * through `before`/`after` on a change record. Two values that differ only inside a
   * masked path therefore compare equal, which is the correct behaviour: the inspector
   * must not reveal that a secret changed, only that a visible field did.
   *
   * This is defence in depth, not the access boundary. The access boundary is which
   * store the caller hands in — scope it with `TenantScopedEventStore` before it gets
   * here. The inspector never widens the scope it is given.
   */
  redactPaths?: readonly string[];
  /** Refuse rather than truncate above this many events per call. Default 1_000_000. */
  maxEvents?: number;
  /** Depth and size caps for the structural diff. */
  diff?: DiffOptions;
}

export interface InspectedState {
  position: number;
  state: ExecutionState;
  /** IX-5 — resolved from the fold, never inferred. Display it. */
  pin: VersionPin;
  foldedEvents: number;
}

export interface Transition {
  /** The event whose effect this transition shows. Absent iff no event has this sequence. */
  event?: EventEnvelope;
  before: InspectedState;
  after: InspectedState;
  /** Structural delta over the (redacted) `ExecutionState`. */
  delta: DiffResult;
  /**
   * The execution frames this event touched, after the transition — the concrete
   * "which step, which effect" half of the view. Empty when the event moved no frame
   * (a lifecycle or audit event).
   */
  frames: readonly ExecutionFrame[];
  /** IX-3 — one entry per configured projection. Never omits an unaffected projection. */
  projections: readonly ProjectionSlice[];
}

export class ReplayInspector {
  private readonly events: ReadOnlyEventStore;
  private readonly snapshots: ReadOnlySnapshotStore | undefined;
  private readonly projections: readonly ProjectionSource[];
  private readonly redactPaths: readonly string[];
  private readonly maxEvents: number | undefined;
  private readonly diffOptions: DiffOptions;

  constructor(options: ReplayInspectorOptions) {
    this.events = options.events;
    this.snapshots = options.snapshots;
    this.projections = options.projections ?? [];
    this.redactPaths = options.redactPaths ?? [];
    this.maxEvents = options.maxEvents;
    this.diffOptions = options.diff ?? {};
  }

  /** Apply configured masking. Returns the same object when nothing is configured, so
   *  the zero-redaction path costs nothing. */
  private redact(state: ExecutionState): ExecutionState {
    if (this.redactPaths.length === 0) return state;
    return maskPaths(state, this.redactPaths) as ExecutionState;
  }

  private budget(): { maxEvents?: number } {
    // Built conditionally: `exactOptionalPropertyTypes` distinguishes an absent key
    // from an explicit `undefined`, and the callees default on absence.
    return this.maxEvents === undefined ? {} : { maxEvents: this.maxEvents };
  }

  /**
   * IX-2 — state at a single position, with its pin.
   *
   * `position` is a sequence number; the result reflects every event with
   * `sequence <= position`. Anchored at the nearest preceding snapshot when one exists.
   */
  async stateAt(executionId: string, position: number): Promise<InspectedState> {
    const [point] = await this.timeline(executionId, [position]);
    return point as InspectedState;
  }

  /**
   * IX-2 — states at many positions in ONE pass: one snapshot load and one bounded log
   * read total, then one fold per position. This is the primitive a timeline UI should
   * call; iterating `stateAt` instead re-reads the log per row.
   */
  async timeline(executionId: string, positions: readonly number[]): Promise<InspectedState[]> {
    const points = await reconstructMany(
      this.events,
      this.snapshots,
      executionId,
      positions,
      this.budget()
    );
    return points.map((p) => {
      const state = this.redact(p.state);
      // Pin is read from the UNREDACTED state: `variables._flowHash` is a reserved
      // kernel key, and a caller who redacts broadly must still see what they are
      // looking at. It is a content hash, not user data.
      return { position: p.position, state, pin: pinOf(p.state), foldedEvents: p.foldedEvents };
    });
  }

  /** IX-5 — the pin alone, for a display header. Costs one reconstruction; prefer
   *  reading `.pin` off a state you already have. */
  async pinAt(executionId: string, position: number): Promise<VersionPin> {
    return (await this.stateAt(executionId, position)).pin;
  }

  /**
   * IX-3 — what the event at `sequence` did: the state delta, the frames it moved, and
   * every configured projection's slice after it.
   *
   * Both endpoints come from a single `reconstructMany` call, so the "before" state is
   * not a second full replay.
   */
  async transitionAt(executionId: string, sequence: number): Promise<Transition> {
    const [before, after] = await this.timeline(executionId, [sequence - 1, sequence]);
    const b = before as InspectedState;
    const a = after as InspectedState;

    // Diff the REDACTED states so a masked value can never surface in a change record.
    const delta = diffState(b.state, a.state, this.diffOptions);

    const event = await this.eventAt(executionId, sequence);
    const frames = event === undefined ? [] : framesTouched(b.state, a.state);

    const projections = await reconstructProjections(
      this.events,
      executionId,
      this.projections,
      sequence,
      this.budget()
    );

    return event === undefined
      ? { before: b, after: a, delta, frames, projections }
      : { event, before: b, after: a, delta, frames, projections };
  }

  /** The single envelope at `sequence`, or undefined. Uses the store's bounded range
   *  read when available so this is an indexed lookup, not a log scan. */
  private async eventAt(executionId: string, sequence: number): Promise<EventEnvelope | undefined> {
    if (this.events.readRange !== undefined) {
      const [hit] = await this.events.readRange(executionId, sequence, sequence);
      return hit;
    }
    const tail = await this.events.readFrom(executionId, sequence);
    const head = tail[0];
    return head !== undefined && head.sequence === sequence ? head : undefined;
  }
}

/**
 * Frames whose identity changed across the transition. Compared by reference first —
 * the fold copies on write, so an untouched frame is the SAME object and this is O(1)
 * per frame rather than a deep compare.
 */
function framesTouched(before: ExecutionState, after: ExecutionState): readonly ExecutionFrame[] {
  const out: ExecutionFrame[] = [];
  for (const stepId of Object.keys(after.frames)) {
    const next = after.frames[stepId] as ExecutionFrame;
    const prev = Object.hasOwn(before.frames, stepId) ? before.frames[stepId] : undefined;
    if (prev !== next) out.push(next);
  }
  return out;
}
