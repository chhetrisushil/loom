# @loomwork/llm

A provider-agnostic model interface (`LlmProvider`), three HTTP providers (Anthropic, OpenAI, Gemini),
and `createLlmEffect`, which wraps a provider as a journaled effect. Use it when a flow needs a model
call that is recorded in the log, replayed instead of re-called, and checked before it leaves the
process. The providers use `fetch` directly and add no vendor SDK. For tool-using loops see
`@loomwork/agent`; for routing across several models see `@loomwork/reasoning`.

```ts
import { tainted } from "@loomwork/classify";
import { AnthropicProvider, UNTRUSTED_CONTENT_SYSTEM_NOTE, createLlmEffect } from "@loomwork/llm";

const provider = new AnthropicProvider({ model: "claude-opus-4-8" }); // key from ANTHROPIC_API_KEY

export const summarize = createLlmEffect<{ ticket: string }, string>({
  provider,
  buildRequest: ({ ticket }) => ({
    system: `You summarize support tickets.\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
    maxTokens: 300,
    // Tainted text is fenced as data before it reaches the model.
    messages: [{ role: "user", content: tainted(ticket, "customer-email") }],
  }),
  parseResponse: (response) => response.content, // the default
  stream: true,
});
```

## Surface

- **Providers.** `AnthropicProvider`, `OpenAiProvider`, `GeminiProvider`, each taking
  `{ apiKey?, model?, baseUrl?, capabilities?, headers? }`. Anything with `complete(request)` (and
  optionally `stream`) is an `LlmProvider`, so a test double or another vendor needs no adapter.
- **The effect.** `createLlmEffect({ provider, buildRequest, parseResponse?, stream?, resolveContent?,
  reasoning?, onDelta?, guard? })`.
- **Messages.** `content` is a string, a tainted string, or an array of parts: text, image, audio,
  file (by `ref` address or inline base64), `tool_use`, `tool_result`. `textOf`, `toParts` and
  `assistantMessageOf` read and build them.
- **Capabilities.** A provider declares which media types it takes; a request outside that throws
  `UnsupportedModalityError` before any network call.
- **Reasoning capture.** `reasoning: { store }` keeps model reasoning text in a sidecar store, off the
  step value; `readReasoning` reads it back (ADR 0133).
- **Streaming.** `collectStream`, `assembleStream`, `LLM_INTERRUPTED` (a cut-off generation keeps its
  partial text as a typed failure).
- **Errors.** `LlmHttpError` (`status`, `kind: "auth"`), `LlmResponseLimitError`, `LlmStreamError`,
  `InvalidLlmRequestError`, `OversizedInlinePartError`, `UntrustedContentError`.

## Behaviour that surprises people

- **Streaming is opt-in.** `stream` defaults to off; with it on, a provider that has no `stream`
  falls back to `complete`. Deltas passed to `onDelta` are not journaled and are not replayed.
- **Tainted content may appear only in a `user` message.** Anywhere else `guardRequest` throws
  `UntrustedContentError`. In a `user` message it is wrapped in an `<untrusted-input>` fence. The fence
  is a label the model can still be talked across, and it only helps if your system prompt says what it
  means: add `UNTRUSTED_CONTENT_SYSTEM_NOTE` yourself, the library does not write your prompt.
- **Media is claim-checked.** The journaled request holds a ref's address, not bytes. A `ref` needs a
  `resolveContent` that authorizes the caller, or the call throws `UnresolvedContentError` before
  any network call. Inline data is capped (64 KiB per part, 256 KiB per request by default).
- **Media capability is an allowlist by model id.** The shipped providers declare image/file support
  only for model ids they recognise, and none when `baseUrl` is not the vendor default.
  Pass `capabilities` to override.
- **Constructors do not check the key.** The Anthropic provider reads `ANTHROPIC_API_KEY` when no
  `apiKey` is given and falls back to an empty string; the failure arrives as an `LlmHttpError` on
  the first call.
- **Redirects are never followed**, since that would re-send the body and credentials. The response
  body of a failed call is not put on the error, because it can echo the prompt. Response, stream and
  line sizes are bounded (defaults 8 MiB, 128 MiB, 1 MiB, adjustable per provider).
- **`headers` cannot override** the headers a provider sets itself (`x-api-key`, `authorization`, and
  similar); doing so throws at construction.

## See also

- API reference: section "`@loomwork/llm` — provider-agnostic models" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guide: [isolation and untrusted content](../../docs/user-guide/isolation-and-untrusted-content.md).
- ADRs: [0085 untrusted content](../../docs/adr/0085-untrusted-content-integrity-axis.md),
  [0120 content parts](../../docs/adr/0120-llm-content-parts-and-tool-threading.md),
  [0060 typed failures](../../docs/adr/0060-typed-failure-channels.md).

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).
