import { UNTRUSTED_CONTENT_SYSTEM_NOTE } from "@loom/llm";
import type { LlmMessageInput, LlmRequestInput } from "@loom/llm";
import type { Passage } from "./types";

/**
 * Retrieved passages as model messages: one `user` message per passage, each still
 * carrying the taint it was ingested with.
 *
 * This shape is the whole safety argument, and it is the shape almost nobody writes first.
 * The natural thing — join the passages into one string under a "here is the relevant
 * documentation" header, and put it in the SYSTEM prompt — is refused by `guardRequest`
 * with an `UntrustedContentError`, because the system prompt is the operator's voice and a
 * corpus anyone can edit is not the operator. Two properties make this function the fix
 * rather than a wrapper around the same mistake:
 *
 *  - ONE message per passage, never a join. Taint is attached to a VALUE, so joining means
 *    unwrapping first, and provenance stops travelling exactly where it starts mattering.
 *  - the `user` role, which is the only position `guardRequest` fences rather than refuses.
 *
 * `guardRequest` then labels each fenced block with the passage's origin before any
 * provider sees it, so the model is told which passages are data and where each came from.
 */
export function passageMessages(passages: readonly Passage[]): LlmMessageInput[] {
  return passages.map((passage) => ({ role: "user" as const, content: passage.text }));
}

export interface GroundedRequestOptions {
  /** The operator's instructions. Trusted content — a plain string, never a passage. */
  instructions: string;
  /** The question, appended after the passages so it reads last. */
  question: string;
  passages: readonly Passage[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * A complete grounded-answer request: operator instructions plus the untrusted-content
 * note in `system`, the retrieved passages as fenced `user` messages, the question last.
 *
 * `instructions` is typed `string` rather than `LlmContent` on purpose. The system slot is
 * where a passage must never land, and a signature that accepts a tainted value there
 * would move the refusal from compile time to run time — the check exists either way, but
 * only one of the two tells you before you ship.
 */
export function groundedRequest(opts: GroundedRequestOptions): LlmRequestInput {
  return {
    system: `${opts.instructions} ${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
    messages: [
      ...passageMessages(opts.passages),
      { role: "user" as const, content: opts.question },
    ],
    ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
  };
}
