import { step$ } from "@loom/core";
import type { StepDefinition } from "@loom/core";
import type { EffectRuntime } from "@loom/effect-runtime";
import { z } from "zod";
import { SandboxEvalEffect } from "./SandboxEvalEffect";
import {
  SANDBOX_ERRORS,
  type SandboxEvalInputValue,
  SandboxEvalInput,
  type SandboxSpec,
  type ScriptReader,
} from "./types";

/** The default effect id sandbox steps dispatch through. */
export const SANDBOX_TOOL_ID = "sandbox.eval";

/**
 * Register the sandbox executor. Channels ride the effect registry (ADR 0060
 * fallback) so dynamically-minted steps inherit them. Call
 * `effect.warm()` (or wire the M6 warmer) at boot to pre-compile the WASM
 * module off the first request.
 */
export function registerSandboxEval(
  effectRuntime: EffectRuntime,
  scripts: ScriptReader,
  spec: SandboxSpec = {}
): SandboxEvalEffect {
  const effect = new SandboxEvalEffect(scripts, spec.limits ?? {});
  effectRuntime.register(spec.id ?? SANDBOX_TOOL_ID, effect);
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
