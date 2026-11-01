// `@loom/sdk/sandbox` — the QuickJS sandbox plugin (ADR 0064), re-exported behind a
// subpath so the WASM engine (`quickjs-emscripten`) is pulled in only by consumers
// that explicitly want hardened eval (keeps a bare `@loom/sdk` import lean).
//
// It also carries the sandbox backend SPI (ADR 0144), so an app wiring its own backend next
// to (or instead of) QuickJS imports one subpath. A third-party backend package should depend
// on `@loom/sandbox` directly instead: this subpath loads the QuickJS plugin too.
export {
  QuickJsSandboxBackend,
  type QuickJsSandboxBackendOptions,
  SANDBOX_ERRORS,
  SANDBOX_TOOL_ID,
  SandboxEvalEffect,
  SandboxEvalInput,
  type SandboxEvalInputValue,
  type SandboxLimits,
  type SandboxSpec,
  type SandboxWorkers,
  SandboxWorkerStartupError,
  type ScriptReader,
  type Shape,
  registerSandboxEval,
  sandboxEval$,
  shapeHash,
  shapeOf,
} from "@loom/plugin-sandbox";
export {
  type RegisterSandboxBackendSpec,
  SANDBOX_BACKEND_SPI_VERSION,
  type SandboxBackend,
  type SandboxBackendCapabilities,
  SandboxEffect,
  type SandboxEffectOptions,
  type SandboxOutcome,
  type SandboxRequest,
  registerSandboxBackend,
} from "@loom/sandbox";
