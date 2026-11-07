import { nestedTaintOrigin } from "@loom/classify";

/**
 * A tainted value was passed as an agent's `context`. The context is flattened with `JSON.stringify`
 * into a plain string in the user message, so the prompt boundary cannot see the mark, and third-party
 * text would reach the model unfenced, with its own closing tags unescaped. Refused rather than fenced,
 * because fencing that message would also fence the caller's own prompt.
 */
export class UntrustedContextError extends Error {
  override readonly name = "UntrustedContextError";
  /** Not retryable: the same input is refused every time. */
  readonly retryable = false;
  constructor(readonly origin: string) {
    super(
      `agent input.context holds untrusted content (origin ${origin}) and would reach the model unfenced. Pass the untrusted text as \`prompt\` with \`promptOrigin\` on agentLoop$, or as a tainted message in \`history\`. If you have checked it and mean to trust it, call unwrapTainted() on it first, so that decision is visible in your code.`
    );
  }
}

/** Throws {@link UntrustedContextError} if `context` holds taint at any depth, or is too big to prove clean. */
export function assertContextIsClean(context: unknown): void {
  if (context == null) return;
  const origin = nestedTaintOrigin(context);
  if (origin !== undefined) throw new UntrustedContextError(origin);
}
