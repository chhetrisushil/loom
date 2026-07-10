// @loom/orchestration — spawn a child workflow and durably await its result.
//
// `awaitChild(ctx, spec)` (parent-side) + `superviseChildren(deps)` (a supervisor wired
// into WorkflowRuntimeDeps.onEvent). Composed from execute/decide/suspend/resume — no
// new syscall, no new event type (P10).

export {
  type ChildSupervisor,
  type SupervisorDeps,
  CHILD_DONE,
  awaitChild,
  childIdFor,
  parentOf,
  superviseChildren,
} from "./orchestration";
