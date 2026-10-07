# ADR 0120 — LLM content parts and real tool-call threading

- Status: **Accepted** (on merge)
- Date: 2026-10-08
- Builds on: [ADR 0085](0085-untrusted-content-integrity-axis.md) (untrusted content), [ADR 0046](0046-content-store-seam-thin-authoritative-log.md)
  (ContentStore claim-checks), [ADR 0119](0119-decide-scope-streaming-deltas.md) (decide-scope deltas), R4 / R4b (tool
  menus and input schemas), R9 (`createLlmEffect({ stream })`).
- Closes: finding #5 of the agentic-readiness evaluation ("the LLM SPI is text-only"); unblocks loom-ui U9 media widgets.
- Placement: **1P, `@loom/llm` MAJOR** (the message `content` type widens, `LlmProvider` gains `capabilities`) plus the
  shipped providers, `@loom/agent`, `@loom/reasoning` and the conformance kit. **Not a kernel change**: no syscall, no event
  kind, no payload field. `EVENT_SCHEMA` and `KERNEL_ABI` are unchanged; a model call is still a journaled `ctx.execute`
  frame whose input and output are ordinary JSON.

## Context

`LlmMessage` was `{ role, content: string }`. Three consequences, all in the shipped code:

1. **No media.** An image, an audio clip or a PDF could not reach a model at all.
2. **No tool threading.** `agentLoop$` and `AgentRunner` recorded the assistant's tool turn as the literal string
   `"(tool calls)"` and returned every tool result as a free-standing `user` message holding JSON. The provider never saw
   a `tool_use` it could pair with a result, so Anthropic's `tool_use` / `tool_result` and OpenAI's `role: "tool"` were
   unreachable and the model had to infer the pairing from prose.
3. **No refusal.** A provider handed a modality it could not take had no way to say so; it would drop it.

## Decision

1. **Content is `string | LlmContentPart[]`, not always-parts.** The string form stays first-class and is passed through
   unchanged, so a text-only caller (every 1P planner/intent/knowledge/skill call site, the VCR `hashRequest`, every
   existing recording) is byte-identical, and old recordings need no migration. Always-parts would be cleaner for
   providers but would make every consumer that reads `m.content` as a string change at once for no behavioural gain.
   `textOf(content)` / `toParts(content)` read either form. Rejected: a union that also accepts a bare part.
2. **No `tool` role.** Tool calls are `tool_use` parts in an `assistant` message; their answers are `tool_result` parts in
   ONE `user` message after it (the Anthropic shape). Providers map the one canonical shape: OpenAI emits
   `role: "tool"` messages (first, as it requires) and `tool_calls`; Gemini emits `functionCall` / `functionResponse`.
   A `tool` role would have added a third message position that every guard would have to learn, where ADR 0085 is
   already stated as a rule about `user` messages: "tainted content may appear only in a `user` message, fenced".
3. **Parts.** `text`; `image`, `audio`, `file` (each `{ mediaType, source }`, `file` also `name?`); `tool_use`
   `{ id, name, input }`; `tool_result` `{ toolUseId, content: string | (text|media)[], isError? }`. A media `source` is
   `{ kind: "ref", ref: { address, size? } }` (claim-check) or `{ kind: "data", data }` (base64).
4. **Claim-check, not inlining (ADR 0046).** Real media is stored in the ContentStore and the journaled model-call input
   carries only the **address**. The address is deliberately NOT the store's `{ __loomContent }` marker: the resolving
   event store would substitute that marker with a JSON-decoded value on read, which is wrong for raw bytes and would put
   them back in front of the fold. Bytes are fetched **inside the effect, immediately before the provider call**
   (`createLlmEffect({ resolveContent })`, distinct addresses fetched once, concurrently). A replayed call is served from
   the log and never reaches that code, so replay neither needs the bytes nor changes when they are later erased; a
   LIVE call whose blob is absent fails loudly (`UnresolvedContentError`). No resolver configured means a ref is refused,
   not dropped. Providers only ever see `data` sources.
5. **A byte cap on inline data**: 64 KiB decoded (`MAX_INLINE_BYTES`, overridable per effect), checked by `guardRequest`;
   over it is `OversizedInlinePartError` naming the remedy. The same cap is applied when the agent loop turns a tool's
   output into a `tool_result`, BEFORE the part enters the transcript the loop re-journals every turn: a violation becomes
   an `isError` result the model can recover from. (The tool's own output is journaled by the tool frame; an author who
   returns oversized inline media there has already put it in that frame. The cap bounds the transcript, which is the
   quadratic part, and the doc says to return a ref.) The total resolved bytes per request are capped too (32 MiB;
   a ref that DECLARES a size over the cap is refused before any fetch).
6. **Capabilities, fail closed.** `LlmProvider.capabilities?: { image?, audio?, file? }`, each a list of media types
   (`image/png`, `image/*`, `*`). Absent means text and tool calls only. `assertRequestSupported` throws
   `UnsupportedModalityError` BEFORE any resolution or network call, at every site that hands a request to a provider:
   `createLlmEffect`, `AgentRunner`, `ReasoningRuntime` (a third-party provider need not check itself), and at the top of
   each shipped provider's `complete` / `stream` (direct callers). Shipped declarations: Anthropic images + PDF, OpenAI
   images + wav/mp3 + PDF, Gemini images + audio + PDF/text; each overridable by config (a model without vision).
   `runLlmProviderConformance` gains a case: a provider that did not declare `image/png` MUST refuse an image request.
   **This fails a 3P provider that silently drops media until it adds `assertRequestSupported(request, this.capabilities)`
   (the scaffold now emits it).**
7. **`guardRequest` enforces part structure and provenance in the same walk.** `tool_use` only in `assistant`;
   `tool_result` only in `user` and only for an id an earlier assistant message declared (an orphan result is refused here
   rather than as a provider 400); media only in `user`; the media type well-formed and matching its modality; inline data
   valid base64 under the cap. ADR 0085 carries over unchanged: a tainted `tool_result` string or text part is fenced in
   its `user` message; a tainted `tool_use.input` is refused (a forged model call); tainted text in `system` / `assistant`
   parts is refused. **Media cannot carry fence tags**, so a part may be marked `untrusted: { origin }`; in a `user`
   message it is bracketed by a fence-open and a fence-close text part (and the flag is stripped before the provider),
   anywhere else it is refused. As with text, the refusal is structural and the bracket is a label.
8. **The response shape is unchanged** (`content`, `toolCalls`, `stopReason`, `usage`): `toolCalls` already are the
   `tool_use` parts, and a derived `parts` field could only disagree with them. `assistantMessageOf(response)` builds the
   assistant turn (text, then one `tool_use` per call). **Streaming** gains `LlmStreamChunk.toolDelta` (the call's `id` and
   `name`, then input JSON fragments) for Anthropic and OpenAI, surfaced by `collectStream({ onToolDelta })` and
   `createLlmEffect({ onToolDelta })`. It is transient like text deltas and is NOT routed through ADR 0119's governed
   `ctx.onDelta` channel: the delta validators inspect text, so a tool-input fragment on that channel would be ungoverned
   in a way the doc could not honestly describe. The assembled call still arrives whole on the terminal chunk, which is
   all that is journaled. Gemini's `generateContent` has no stream here and is unchanged in that respect.
9. **Agent threading.** `agentLoop$` and `AgentRunner` push `assistantMessageOf(response)` and ONE `user` message of
   `tool_result` parts per turn (the placeholder is gone). `isError` is set for a menu/schema refusal, a declined or
   undigestible approval, and (runner) a thrown tool. A result is still the `{ tool, result }` JSON envelope in text, with
   the ADR 0085 taint re-applied outside the serialization. A tool returns media with `mediaResult(parts)`; a tainted
   `mediaResult` taints its text and marks its media `untrusted`. The `agentLoop$` approval gate parks before the results
   message is pushed, so a park mid-turn leaves the transcript as it was. **Compaction** never starts the kept suffix on a
   `tool_result` message: the cut is moved back to include the assistant turn that made the calls, so a fold cannot orphan a
   result (the kept tail may therefore exceed `keepRecent` by one message). The compaction effect now receives messages
   whose `content` may be parts.
10. **Replay and durability.** The model-call frame's input is `{ messages, tools, system }` as before; it now holds parts,
    with media as addresses. Recorded responses are unchanged and are served as-is, so an old recording (string content,
    `"(tool calls)"` turns) still folds and replays. The replay-divergence detector (ADR 0113) compares step ids, not
    inputs, so an in-flight `agentLoop$` execution recorded before this change resumes: its completed turns are served from
    the log and its next turn is built in the new shape from the recorded responses. Nothing about the log shape changed.
11. **Not decided here (follow-ups).** Audio/file `tool_result` mapping for providers whose tool message is text-only is a
    workaround (OpenAI: media rides in a trailing `user` message; Gemini: extra `inlineData` parts beside the
    `functionResponse`). Provider-hosted file ids (OpenAI Files, Anthropic Files API, Gemini fileData URIs) and URL sources are
    out of scope: they are a different trust and lifetime model from content addressing. Model output other than text and
    tool calls (generated images/audio) is not represented. Gemini's `parametersJsonSchema` and `functionCall.id` follow the
    current API reference and were not exercised against the live service (the tests stub `fetch`).

## Consequences

- **Breaking for `@loom/llm` consumers**: see the CHANGELOG. A provider written against the old text-only `LlmMessage`
  that reads `m.content` as a string must use `textOf`; a media-capable provider declares `capabilities`.
- The transcript an agent re-journals each turn is now bounded in bytes for media (addresses, not bytes) and still grows
  with turns; compaction remains the answer, now pair-aware.
- A model cannot be asked about media on a provider that has not declared it; that is a refusal, never a degradation.
- The kernel is untouched.

## Questions for the user

1. Should `capabilities` default to "images allowed" for the three shipped providers (as shipped) or be opt-in per model, given
   that a text-only model behind the same provider class will 400 from the API rather than be refused locally? (Overridable today.)
2. The 64 KiB inline cap: is that the right order of magnitude, or should inline be limited to tiny icons (e.g. 8 KiB)?
