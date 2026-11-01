// @loom/sandbox — the sandbox backend SPI (ADR 0144).
//
// A backend is the ENGINE: it runs one verified script against one bounded input and reports what
// happened. `SandboxEffect` owns every guarantee around it (limits, content address, channels,
// replay form) so a QuickJS, Cloud Run, Firecracker or in-house backend inherits them unchanged.

export { SANDBOX_BACKEND_SPI_VERSION } from "./version";
export type {
  SandboxBackend,
  SandboxBackendCapabilities,
  SandboxOutcome,
  SandboxRequest,
} from "./types";
export {
  DEFAULT_BACKEND_GRACE_MS,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MEMORY_BYTES,
  DEFAULT_WALL_CLOCK_MS,
  SandboxEffect,
  type SandboxEffectLimits,
  type SandboxEffectOptions,
} from "./SandboxEffect";
export {
  SANDBOX_TOOL_ID,
  registerSandboxBackend,
  sandboxEval$,
  type RegisterSandboxBackendSpec,
} from "./sandboxEval$";
export {
  SANDBOX_ERRORS,
  SandboxEvalInput,
  type SandboxEvalInputValue,
  type ScriptReader,
} from "./errors";
export { SANDBOX_MESSAGE_LIMIT, SANDBOX_NAME_LIMIT, boundText } from "./boundText";
export { type Shape, shapeHash, shapeOf } from "./shape";
export { validateOutcome } from "./outcome";
