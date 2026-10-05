import { canonicalJson, fnv1a64 } from "@loom/core";
import type { ExecutionState } from "@loom/core";
import type { ResumeEvent } from "./types";

/**
 * R13 (ADR 0117) — bind an approval to what the approver saw.
 *
 * Approving "the pending tool call" is a time-of-check/time-of-use gap: the approver's UI
 * rendered proposal A, the execution is now parked on proposal B (a retry, a re-plan, another
 * turn), and a bare `{ approved: true }` approves B unseen. The fix is to name the proposal in
 * the gate: the parking side records `viewDigest(proposal)` in its suspend condition (durable,
 * fold-visible, no new event), the approver echoes it, and the runtime refuses a resume whose
 * echo does not match — before the append, nothing recorded.
 *
 * The digest is `fnv1a64` over `canonicalJson` (core's one canonicalization + hash). It detects
 * STALENESS and accident; it is not a MAC and not collision-resistant against an adversary who
 * controls both proposals. Authenticity of WHO approved is the `ResumeAuthenticator`'s job
 * (`signedResumeAuthenticator`, which signs the echoed digest along with the rest of the event).
 */
export function viewDigest(view: unknown): string {
  return `v1:${fnv1a64(canonicalJson(view))}`;
}

/**
 * The digest a tool-call approval gate declares. `gateKey` pins the execution and position
 * (agentLoop$ passes its `<executionId>#turn:<n>:tool:<j>` correlation key), so an approval
 * for one execution's call cannot be replayed at another's identical call.
 */
export function approvalViewDigest(gateKey: string, toolId: string, input: unknown): string {
  return viewDigest({ gate: gateKey, tool: toolId, input });
}

/**
 * Build the resume event that answers the gate an execution is parked on, echoing its
 * `viewDigest` (when it declared one). `decision` is the gate's own answer, e.g.
 * `{ approved: true }`. Read `state` AT THE TIME the approver is shown the proposal and keep it
 * with the UI — that is what makes the echo mean "this is what I saw".
 */
export function answerApproval(
  state: Pick<ExecutionState, "suspendedOn" | "executionId">,
  decision: Record<string, unknown>
): ResumeEvent {
  const gate = state.suspendedOn;
  if (gate === undefined) {
    throw new Error(`execution "${state.executionId}" is not parked at a gate; nothing to answer`);
  }
  return {
    eventType: gate.on,
    payload: {
      ...decision,
      ...(gate.viewDigest !== undefined && { viewDigest: gate.viewDigest }),
    },
  };
}
