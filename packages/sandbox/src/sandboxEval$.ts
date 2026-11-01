import { step$ } from "@loom/core";
import type { StepDefinition } from "@loom/core";
import type { EffectRuntime } from "@loom/effect-runtime";
import { z } from "zod";
import { SandboxEffect, type SandboxEffectOptions } from "./SandboxEffect";
import { SANDBOX_ERRORS, SandboxEvalInput, type SandboxEvalInputValue } from "./errors";
import type { ScriptReader } from "./errors";
import type { SandboxBackend } from "./types";

/** The default effect id sandbox steps dispatch through. */
export const SANDBOX_TOOL_ID = "sandbox.eval";

export interface RegisterSandboxBackendSpec extends SandboxEffectOptions {
  /** The effect id this executor registers under. Default `"sandbox.eval"`. */
  id?: string;
}

/**
 * Register a sandbox backend as the sandbox executor. Channels ride the effect registry (ADR 0060
 * fallback) so dynamically-minted steps inherit them. Call `effect.warm()` at boot and
 * `effect.close()` at shutdown. This is how a 3P backend is wired, from flow code.
 */
export function registerSandboxBackend(
  effectRuntime: EffectRuntime,
  scripts: ScriptReader,
  backend: SandboxBackend,
  spec: RegisterSandboxBackendSpec = {}
): SandboxEffect {
  const { id, ...options } = spec;
  const effect = new SandboxEffect(scripts, backend, options);
  effectRuntime.register(id ?? SANDBOX_TOOL_ID, effect);
  return effect;
}

/**
 * Mint a step dispatching a content-addressed script through the sandbox.
 * Ids follow the ADR 0061 identity rule when minted per blueprint node
 * (`` sandboxEval$(`reshape#${i}`) ``); the script ref + expected shape hash
 * ride the RUN-TIME input, so a blueprint version pins its reshaping logic by
 * hash — repair that rewrites a script produces a NEW ref, never a mutation.
 */
export function sandboxEval$(
  id: string,
  toolId: string = SANDBOX_TOOL_ID
): StepDefinition<SandboxEvalInputValue, unknown> {
  return step$<SandboxEvalInputValue, unknown>({
    id,
    name: id,
    toolId,
    inputSchema: SandboxEvalInput,
    outputSchema: z.unknown(),
    errors: SANDBOX_ERRORS,
  });
}
