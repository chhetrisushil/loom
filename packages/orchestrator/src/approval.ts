export interface ApprovalDecision {
  approved: boolean;
  approvedBy: string;
}

/**
 * The auto-approval policy encoded in a natural-language goal — "…fix it if
 * remediation is low risk", "auto-fix", etc. Identical across every example
 * orchestrator; extracted here so the (error-prone) regex lives in one tested
 * place.
 */
export function autoApprovalAllowed(goal: string): boolean {
  return /low risk|automatically|auto[- ]?fix|auto/i.test(goal);
}

export interface DecideApprovalInput {
  goal: string;
  /** The assessed risk of the action, e.g. "low" | "medium" | "high". */
  riskLevel: string;
}

export interface DecideApprovalHandlers {
  /** Side effect for the auto-approved branch (e.g. log it). */
  onAutoApprove?: () => void;
  /** Side effect for the manual branch (e.g. surface the pending approval). */
  onManualRequired?: () => void;
  /** Resolve when the operator decides. Called only on the manual branch. */
  waitForManual: () => Promise<ApprovalDecision>;
}

/**
 * The human-in-the-loop approval *policy* — auto-approve a low-risk action when
 * the goal permits it, otherwise defer to a human. The policy is the reusable,
 * byte-identical part; the surface effects (logging, rendering the pending
 * approval, wiring the resolver) are the app's and are passed as handlers, so
 * this composes into any orchestrator without inheriting a shape.
 */
export function decideApproval(
  input: DecideApprovalInput,
  handlers: DecideApprovalHandlers
): Promise<ApprovalDecision> {
  if (input.riskLevel === "low" && autoApprovalAllowed(input.goal)) {
    handlers.onAutoApprove?.();
    return Promise.resolve({ approved: true, approvedBy: "risk-policy" });
  }
  handlers.onManualRequired?.();
  return handlers.waitForManual();
}
