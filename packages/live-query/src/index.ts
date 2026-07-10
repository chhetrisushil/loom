// @loom/live-query — live reads of in-flight executions.
//
// `snapshot(id)` folds current state on demand; `subscribe(id, cb)` pushes the state
// again on every new event. A read-model over loadState + EventStore.subscribe — no
// syscall, no new event type (P10).

export { type LiveQuery, type LiveQueryDeps, type StateReader, liveQuery } from "./liveQuery";
