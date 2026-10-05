import { createHash } from "node:crypto";
import { canonicalJson } from "@loom/core";
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
 * The digest is SHA-256 over `canonicalJson` (core's one canonicalization), tagged `v2:`. It
 * detects STALENESS — a different proposal parked since the approver looked — and, being a
 * collision-resistant hash, a proposal an adversary crafted to collide with the one shown. It
 * is not a MAC: it proves nothing about WHO approved (that is the `ResumeAuthenticator`'s job;
 * `signedResumeAuthenticator` signs the echoed digest along with the rest of the event).
 *
 * `v1:` (FNV-1a 64, the first cut of this seam) is no longer produced. The runtime compares the
 * echoed string for EXACT equality with the one recorded in the suspend condition, so an
 * execution that parked with a `v1:` digest before this change is still answered by echoing
 * it (`answerApproval` echoes whatever the state holds); nothing re-derives a `v1:` digest.
 *
 * Throws `TypeError` for a view `canonicalJson` refuses (nested deeper than 1024, non-finite
 * number): a caller that digests untrusted data catches it.
 */
export function viewDigest(view: unknown): string {
  return `v2:${createHash("sha256").update(canonicalJson(view)).digest("hex")}`;
}

/**
 * The digest a tool-call approval gate declares. `gateKey` pins the execution and position
 * (agentLoop$ passes its `<executionId>#turn:<n>:tool:<j>` correlation key), so an approval
 * for one execution's call cannot be replayed at another's identical call.
 *
 * A UI that shows the approver the proposal renders it from the tool call the model made (the
 * assistant message in the log, which holds `toolId` and `input`) and recomputes this digest
 * from exactly what it renders — it does not take the digest on trust. The proposal itself is
 * NOT copied into the suspend condition: tool input is model output of arbitrary size, and the
 * condition is folded into every state read, snapshot and replay; the digest is the binding,
 * the log is the record. Throws like {@link viewDigest}.
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
