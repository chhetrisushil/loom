import { textOf } from "../parts";
import type { LlmRequest } from "../types";

/**
 * The ONE system-prompt rule every provider applies (documented on `LlmRequest.system`): a non-empty
 * `request.system` wins and the system-role messages in `messages` are dropped; an empty string counts
 * as unset; with no `request.system`, the system-role messages' text is joined in order with a blank
 * line. `undefined` means send no system prompt. Callers drop system-role messages from the turns
 * they map either way.
 */
export function resolveSystem(request: LlmRequest): string | undefined {
  if (request.system !== undefined && request.system !== "") return request.system;
  const joined = request.messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .filter((t) => t !== "")
    .join("\n\n");
  return joined === "" ? undefined : joined;
}
