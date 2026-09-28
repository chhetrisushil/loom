import type { EventEnvelope, ExecutionState } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";

// ── IX-1 — the read-only boundary, enforced by the type system ────────────────
//
// The inspector depends on STRUCTURALLY NARROWED views of the two store SPIs, not on
// the SPIs themselves. `EventStore` carries `append`/`acquireFence`/`copyPrefix` on the
// same interface as `read`/`readFrom`/`readRange`, and `SnapshotStore` carries
// `save`/`deleteExecution` beside its loaders — so "the dependency graph contains no
// write method" is not a checkable property (a dependency graph is over modules, not
// methods). A `Pick` is: `append` is not in scope anywhere in this package, and `tsc`
// is the enforcement. `src/index.test.ts` asserts the shape so the narrowing cannot be
// widened by accident.
//
// `subscribe` is deliberately EXCLUDED even though it is read-shaped: a live
// subscription is a retained listener (a leak surface) and a source of load on the
// writer path (IX-7 non-perturbation). The inspector never tails.

/**
 * The only event-log capability the inspector has: bounded, ordered reads, plus the optional
 * O(1) tip (`head`) it uses to tell "past the tip" from "inside compacted history" (ADR 0106).
 */
export type ReadOnlyEventStore = Pick<EventStore, "read" | "readFrom" | "readRange" | "head">;

/** The only snapshot capability the inspector has: point-in-time loads. */
export type ReadOnlySnapshotStore = Pick<
  SnapshotStore,
  "loadLatest" | "loadAt" | "loadLatestBefore"
>;

export type { EventEnvelope, ExecutionState, Snapshot };

// ── IX-5 — version pinning, three cases ───────────────────────────────────────
//
// Two of these were in the original requirement; the third is real and was missing.
// `EXECUTION_STARTED.flowHash` is OPTIONAL — additive at EVENT_SCHEMA 1.4.0, "folds
// treat absence as legacy" — so an execution started before 1.4.0 carries no pin at
// all. That is a distinct fact from "pinned but the artifact is gone", and reporting
// it as either a blank or an inferred current version is exactly the silent-fallback
// failure IX-5 exists to prevent.

export type PinStatus =
  /** `variables._flowHash` present: the execution names the code it started under. */
  | "pinned"
  /** Pre-EVENT_SCHEMA-1.4.0 log: no `flowHash` was ever recorded. Not an error. */
  | "unpinned-legacy";

export interface VersionPin {
  status: PinStatus;
  /** From the fold; `""` when neither a snapshot nor an envelope supplied one. */
  workflowId: string;
  /**
   * Best-effort. `workflowVersion` is seeded into the fold by the caller or a
   * snapshot and is never written by an event handler, so a log read without a
   * snapshot cannot recover it. Empty string means "not recorded", never "current".
   */
  workflowVersion: string;
  /** The K11 content hash this execution is pinned to. Absent iff `unpinned-legacy`. */
  flowHash?: string;
}

// ── IX-3 — projection reconstruction, with explicit degradation ───────────────
//
// Q1 returned "only `ExecutionState`": `Snapshot.state` is typed `ExecutionState` and
// projection state is held per-(projectionId, executionId) in the projection runtime,
// never persisted through the snapshot SPI. So a projection fold has NO anchor and
// always replays from zero — mitigated by pre-filtering the log to the projection's
// declared `eventTypes` (available from the manifest WITHOUT loading the fold chunk).
//
// Q3 returned "chunks are Vite build artifacts emitted into `build.outDir`" — deploy
// output, not versioned retrievable objects. So for an execution pinned to a superseded
// version the fold body may simply be unavailable. That is reported, never worked
// around: falling back to the CURRENT version's fold would reproduce IX-5's forbidden
// failure one level down.

export type ProjectionSliceStatus =
  /** The pinned fold ran; `state` is authoritative for this point in the log. */
  | "ok"
  /** The projection declares none of the event types in range; `state` is its initial. */
  | "unaffected"
  /** The pinned fold body could not be resolved. `state` is absent — never guessed. */
  | "unavailable";

export interface ProjectionSlice {
  projectionId: string;
  status: ProjectionSliceStatus;
  /** Present iff `status !== "unavailable"`. */
  state?: unknown;
  /** Present iff `status === "unavailable"`: why, in operator-readable terms. */
  reason?: string;
  /** How many events this projection actually folded to reach `state`. */
  foldedEvents: number;
}

/**
 * What the inspector needs to know about a projection WITHOUT loading its fold code.
 * Mirrors `manifest.projections[id]`: `eventTypes` is the compiler-recorded key set,
 * readable from the manifest, and `load` is the lazy chunk import. Supplying `load` is
 * optional — omit it and every slice for that projection degrades to `unavailable`,
 * which is the correct behaviour when the pinned chunk is not retrievable.
 */
export interface ProjectionSource {
  id: string;
  /** Statically extracted handled event types. Used to pre-filter the log. */
  eventTypes: readonly string[];
  initialState: unknown;
  /**
   * Resolve the fold map for the PINNED version. Throwing (or being absent) yields
   * `status: "unavailable"` rather than a fallback to current code.
   */
  load?: () => Promise<Record<string, (state: unknown, event: EventEnvelope) => unknown>>;
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * A bounded read refused. Thrown rather than truncated: a silently short read
 * produces a plausible-looking wrong state, which is the failure mode this whole
 * series exists to avoid.
 */
export class InspectorBudgetError extends Error {
  constructor(
    readonly executionId: string,
    readonly requested: number,
    readonly limit: number
  ) {
    super(
      `replay-inspector: reconstructing "${executionId}" needs ${requested} events, ` +
        `over the ${limit}-event budget; raise maxEvents deliberately or narrow the range`
    );
    this.name = "InspectorBudgetError";
    Object.setPrototypeOf(this, InspectorBudgetError.prototype);
  }
}

/**
 * ADR 0106 — the state at `position` cannot be reconstructed: compaction removed events
 * `missingFrom..missingThrough` below it, and no snapshot at or above `missingThrough` anchors
 * the fold. Folding across the gap would return a plausible-looking wrong state. Positions at
 * or above a compaction checkpoint reconstruct normally; a kept (pinned-kind) event BELOW the
 * checkpoint is a position like this — its event survives, the state around it does not.
 */
export class CompactedHistoryError extends Error {
  constructor(
    readonly executionId: string,
    readonly position: number,
    readonly missingFrom: number,
    /** The hole runs at least through here (exactly, unless found by the tip probe). */
    readonly missingThrough: number
  ) {
    super(
      `replay-inspector: "${executionId}" at ${position} is inside compacted history — events ${missingFrom}..${missingThrough} were compacted away and no snapshot at or above ${missingThrough} anchors that position`
    );
    this.name = "CompactedHistoryError";
    Object.setPrototypeOf(this, CompactedHistoryError.prototype);
  }
}
