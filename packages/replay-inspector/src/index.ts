// @loom/replay-inspector — IX series (read-only replay inspector).
//
// Explicit named re-exports, not `export *`: a barrel of `export *` compiles to a
// runtime `__exportStar(require(...))` that bundlers cannot statically trace, which is
// why `@loom/core` does the same. See its index.ts for the full note.

export { ReplayInspector } from "./ReplayInspector";
export type {
  InspectedState,
  ReplayInspectorOptions,
  Transition,
} from "./ReplayInspector";

export { diffState, formatPath } from "./diff";
export type { ChangeKind, DiffOptions, DiffResult, StateChange, TruncationReason } from "./diff";

export { anchorFor, reconstructAt, reconstructMany } from "./reconstruct";
export type {
  ReconstructionAnchor,
  ReconstructionPoint,
  ReconstructOptions,
} from "./reconstruct";

export { canServePin, describePin, pinOf } from "./pinning";

export { indexByEventType, reconstructProjections } from "./projections";
export type { ProjectionReconstructOptions } from "./projections";

export { CompactedHistoryError, InspectorBudgetError } from "./types";
export type {
  PinStatus,
  ProjectionSlice,
  ProjectionSliceStatus,
  ProjectionSource,
  ReadOnlyEventStore,
  ReadOnlySnapshotStore,
  VersionPin,
} from "./types";
