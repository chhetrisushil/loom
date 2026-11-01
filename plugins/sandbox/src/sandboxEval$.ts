import type { EffectRuntime } from "@loom/effect-runtime";
import { SANDBOX_TOOL_ID, sandboxEval$ } from "@loom/sandbox";
import { SandboxEvalEffect } from "./SandboxEvalEffect";
import type { SandboxSpec, ScriptReader } from "./types";

// Moved to @loom/sandbox (ADR 0144); re-exported so existing imports keep working.
export { SANDBOX_TOOL_ID, sandboxEval$ };

/**
 * Register the sandbox executor. Channels ride the effect registry (ADR 0060
 * fallback) so dynamically-minted steps inherit them. Call
 * `effect.warm()` (or wire the M6 warmer) at boot to pre-compile the WASM
 * module off the first request.
 *
 * `spec.workers` moves evaluation onto worker threads (ADR 0089) — off by
 * default. A host that enables it should also call `effect.close()` at
 * shutdown, since the pool holds live threads.
 */
export function registerSandboxEval(
  effectRuntime: EffectRuntime,
  scripts: ScriptReader,
  spec: SandboxSpec = {}
): SandboxEvalEffect {
  const effect = new SandboxEvalEffect(scripts, spec.limits ?? {}, spec.workers ?? {});
  effectRuntime.register(spec.id ?? SANDBOX_TOOL_ID, effect);
  return effect;
}
