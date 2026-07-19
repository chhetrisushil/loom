// `@loom/sdk/sandbox` — the QuickJS sandbox plugin (ADR 0064), re-exported behind a
// subpath so the WASM engine (`quickjs-emscripten`) is pulled in only by consumers
// that explicitly want hardened eval (keeps a bare `@loom/sdk` import lean).
export {
  SANDBOX_ERRORS,
  SANDBOX_TOOL_ID,
  SandboxEvalEffect,
  SandboxEvalInput,
  type SandboxEvalInputValue,
  type SandboxLimits,
  type SandboxSpec,
  type ScriptReader,
  type Shape,
  registerSandboxEval,
  sandboxEval$,
  shapeHash,
  shapeOf,
} from "@loom/plugin-sandbox";
