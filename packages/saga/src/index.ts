// @loom/saga — saga / compensation for Loom flows.
//
// Register compensators as a flow makes forward progress; run them in reverse on
// failure. Compensators are ordinary `ctx.run` steps, so rollback is replay-safe with
// NO new syscall and NO new event type (P10).

export { type Saga, createSaga, withSaga } from "./saga";
