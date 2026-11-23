export { EffectRuntime } from "./EffectRuntime";
// ADR 0152: one definition (replay-vm owns it; effect-runtime depends on replay-vm), re-exported for `ctx.seenOrigins()` consumers.
export { SEEN_ORIGINS_OVERFLOW } from "@loomwork/replay-vm";
export { LazyEffect } from "./effects/LazyEffect";
export { ToolEffect, type ToolEffectOptions } from "./effects/ToolEffect";
export { LlmEffect, type LlmEffectOptions } from "./effects/LlmEffect";
export { HumanEffect } from "./effects/HumanEffect";
export { EffectModeViolationError } from "./types";
export type {
  DeltaSink,
  Effect,
  EffectDelta,
  EffectContext,
  EffectKind,
  EffectMiddleware,
  EffectReasoningDefaults,
  EffectReasoningHook,
  EffectMode,
  EffectNext,
  ErrorChannelSchema,
  ResourceSnapshot,
  TransientIdentity,
  TransientInvokeOptions,
  Warmer,
} from "./types";
export {
  CapabilityDeniedError,
  capabilityIds,
  GrantTable,
  DelegationAuthorizer,
  signDelegation,
  verifyDelegation,
  attenuateDelegation,
  delegationDigest,
  principalBlocked,
  principalIdentityKey,
  identityKeyOf,
} from "./authz";
export { PolicyAuthorizer } from "./policy";
export type { PolicyRules, PolicyMatchRule, PolicyAuthorizerOptions } from "./policy";
export type {
  CapabilityAuthorizer,
  CapabilityDecision,
  CapabilityRequest,
  DelegatedGrant,
  DelegationAuthorizerOptions,
  EffectRuntimeOptions,
  GrantTableOptions,
  PrincipalChain,
} from "./authz";
