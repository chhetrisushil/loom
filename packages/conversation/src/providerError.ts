import { LlmHttpError, LlmStreamError } from "@loom/llm";

/**
 * A failure of the conversation's OWN model call: the provider answered with an HTTP error of any
 * status, or reported an error inside a 200 stream. `@loom/agent`'s `isTerminalToolError` calls
 * some of these terminal (401/403/429/5xx, stream errors) because for a TOOL loop they are a stop
 * for the runtime's retry policy; for the conversation they are a failed turn with the fixed
 * `model-error` reason, and the conversation keeps accepting turns. Checked BEFORE
 * `isTerminalToolError`; a park, cancel, authority stop or divergence is not a provider error.
 */
export function isProviderError(err: unknown): boolean {
  return err instanceof LlmHttpError || err instanceof LlmStreamError;
}
