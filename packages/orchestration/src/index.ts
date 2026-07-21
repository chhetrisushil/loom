// @loom/orchestration — spawn child workflows from a parent and durably await their results.
//
// `awaitChild(ctx, spec)` (one child) / `awaitChildren(ctx, group)` (N concurrent children,
// outputs in input order) — parent-side — plus `superviseChildren(deps)` (a supervisor wired
// into WorkflowRuntimeDeps.onEvent). Composed from execute/decide/suspend/resume — no new
// syscall, no new event type (P10).

export {
  type ChildResult,
  type ChildSupervisor,
  type SupervisorDeps,
  CHILD_DONE,
  CHILD_FAILED,
  awaitChild,
  awaitChildren,
  childIdFor,
  depthOf,
  parentOf,
  superviseChildren,
} from "./orchestration";
export { fanout$, type FanoutOptions } from "./fanout";
