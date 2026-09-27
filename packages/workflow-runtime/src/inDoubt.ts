import type { EffectInDoubtResolution } from "./types";

// ADR 0104 — an in-doubt verdict answers ONE park: the EFFECT_INDOUBT fact recorded for one
// attempt of one step. It is recorded as a kernel-written DECISION_RECORDED keyed by exactly
// that pair, never as a gate passthrough: the park is thrown from `ctx.run`, not
// `ctx.suspend`, so a passthrough entry would be served to the flow's NEXT gate as its answer.
// Keying by attempt is what makes a verdict go stale: after a "retry-fresh" attempt crashes,
// the step is in doubt again at a new attempt that no verdict has answered.

/**
 * The decision-id namespace the kernel reserves for its own records (ADR 0104). A flow that
 * could `ctx.decide("__loom_indoubt__:a:1", …)` could forge an operator verdict and have a
 * non-idempotent step adopted with an output nobody confirmed; so every flow-side writer of
 * DECISION_RECORDED (`ctx.decide`, and `ctx.emit` — which `AgentRunner` uses) refuses it,
 * the way `assertNotReserved` refuses the kernel's control-stream execution ids.
 */
export const RESERVED_DECISION_PREFIX = "__loom_";

export function assertUnreservedDecisionId(decisionId: unknown): void {
  if (typeof decisionId === "string" && decisionId.startsWith(RESERVED_DECISION_PREFIX)) {
    throw new Error(
      `decision id "${decisionId}" is reserved: "${RESERVED_DECISION_PREFIX}" prefixes the kernel's own decision records`
    );
  }
}

/** Reserved decision id for the verdict on `stepId`'s in-doubt `attempts`. Internal. */
export function inDoubtDecisionId(stepId: string, attempts: number): string {
  return `__loom_indoubt__:${stepId}:${attempts}`;
}

/** The verdict shape, or `undefined` when the payload is not a verdict for `stepId`. */
export function asInDoubtVerdict(
  payload: unknown,
  stepId: string
): EffectInDoubtResolution | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const p = payload as Partial<EffectInDoubtResolution>;
  if (p.stepId !== stepId) return undefined;
  if (
    p.resolution !== "completed-with-result" &&
    p.resolution !== "retry-fresh" &&
    p.resolution !== "fail"
  ) {
    return undefined;
  }
  return p as EffectInDoubtResolution;
}
