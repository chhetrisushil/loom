// @loom/dst — Deterministic Simulation Testing for the Loom kernel.
//
// Drive the durable-execution kernel under seeded, adversarial fault schedules and
// assert its invariants hold; reproduce and minimize any failure bit-for-bit. This
// package is test/dev-only — it is imported by NO runtime package, so it adds zero
// production overhead by construction (dependency direction), not by a flag.

export { type Rng, splitmix64, seedFromLabel } from "./rng";
export { type VirtualClock, virtualClock } from "./clock";
export {
  type FaultKind,
  type FaultModel,
  type FaultDraw,
  type FaultSource,
  type FaultInjectingStore,
  faultInjectingStore,
} from "./faultStore";
export {
  type Invariant,
  type InvariantContext,
  type InvariantResult,
  INVARIANTS,
  ALL_INVARIANTS,
} from "./invariants";
export {
  type SimWorld,
  type SimWorldOptions,
  type RegisterFlows,
  simWorld,
} from "./simWorld";
export {
  type DstProperty,
  type DstReport,
  type DstViolation,
  checkProperty,
  replaySchedule,
} from "./property";
