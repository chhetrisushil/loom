// @loom/plugin-sandbox — hardened eval of LLM-authored reshaping code (ADR 0064).
//
// QuickJS-in-WASM: capability-empty by construction (no fs/net/process/timers —
// no-I/O is a property, not a scrub list). Content-addressed scripts, in-engine
// resource limits, output shape-hash validation, typed failure channels.

export { SandboxEvalEffect } from "./SandboxEvalEffect";
export { SandboxWorkerPool, type SandboxWorkerPoolOptions } from "./SandboxWorkerPool";
export type { EvalLimits, EvalOutcome, ScriptThrow, TrippedGuard } from "./evalCore";
export { SANDBOX_TOOL_ID, registerSandboxEval, sandboxEval$ } from "./sandboxEval$";
export { type Shape, shapeHash, shapeOf } from "./shape";
export {
  SANDBOX_ERRORS,
  SandboxEvalInput,
  type SandboxEvalInputValue,
  type SandboxLimits,
  type SandboxSpec,
  type SandboxWorkers,
  type ScriptReader,
} from "./types";
