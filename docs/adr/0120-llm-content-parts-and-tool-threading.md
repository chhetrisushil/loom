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
   (`createLlmEffect({ resolveContent })`, distinct addresses fetched once, four at a time). A replayed call is served from
   the log and never reaches that code, so replay neither needs the bytes nor changes when they are later erased; a
   LIVE call whose blob is absent fails loudly (`UnresolvedContentError`). No resolver configured means a ref is refused,
   not dropped. Providers only ever see `data` sources. **A resolver MUST authorize the ref**: the ContentStore is
   content-addressed with no tenancy, so whoever can name an address can read it. `ContentResolver(ref, context)` is told
   `{ executionId, stepId, principal, origin: "tool" | "app", maxBytes, signal }`, enough for a store to check that the
   asking execution may read the blob. A ref named by an untrusted party never reaches a resolver (decision 7).
   **When resolution fails** (absent, over budget, size differs from the ref's declared `size`, a throwing resolver): for a
   ref inside a `tool_result` the part becomes a text error (`content_unavailable`, with the address) and the result is
   `isError`, so a tool's media going missing is feedback the model can act on, like any tool failure; for a ref the
   application put in a message itself the call fails with `UnresolvedContentError` (the app asked for that content;
   continuing without it answers a different question).
5. **A byte cap on inline data**: 64 KiB decoded (`MAX_INLINE_BYTES`, overridable per effect), checked by `guardRequest`;
   over it is `OversizedInlinePartError` naming the remedy. The same cap is applied when the agent loop turns a tool's
   output into a `tool_result`, BEFORE the part enters the transcript the loop re-journals every turn: a violation becomes
   an `isError` result the model can recover from. (The tool's own output is journaled by the tool frame; an author who
   returns oversized inline media there has already put it in that frame. The cap bounds the transcript, which is the
   quadratic part, and the doc says to return a ref.) Inline media is also capped **per request, in total** (256 KiB,
   `MAX_INLINE_TOTAL_BYTES`) so many small parts cannot add up to a log-sized payload; the agent loop tracks the transcript's
   running inline total and turns a result that would overflow it into an `isError` result rather than letting the next
   `guardRequest` fail the run. The total resolved bytes per request are capped too (32 MiB) as a RUNNING budget: fetches
   start four at a time, each is told what is left, the first to overshoot aborts the rest (their `signal` fires and no
   queued fetch starts), a ref that declares a size over the cap is refused before any fetch, and a blob whose size differs
   from the declared one is refused (a declared `size` must be a non-negative safe integer or absent: anything else is refused by
   the guard and by the resolver). The overshoot is bounded, not zero: at most four fetches are in flight when the budget is spent,
   so a resolver that ignores `maxBytes` can hold at most that many blobs before the abort lands; resolvers SHOULD honour
   `maxBytes`. **The resolve context is required**: `resolveContent` and its context come together (`ReasonOptions` is a union
   that makes one without the other a type error; `resolveRequestContent` refuses at runtime when `executionId` is absent), and a
   resolver MUST deny a read whose `executionId` / `principal` it cannot attribute.
6. **Capabilities, fail closed.** `LlmProvider.capabilities?: { image?, audio?, file? }`, each a list of media types
   (`image/png`, `image/*`, `*`). Absent means text and tool calls only. `assertRequestSupported` throws
   `UnsupportedModalityError` BEFORE any resolution or network call, at every site that hands a request to a provider:
   `createLlmEffect`, `AgentRunner`, `ReasoningRuntime` (a third-party provider need not check itself), and at the top of
   each shipped provider's `complete` / `stream` (direct callers). Shipped declarations: Anthropic images + PDF, OpenAI
   images + wav/mp3 + PDF, Gemini images + audio + PDF/text; each overridable by config (a model without vision).
   `runLlmProviderConformance` gains three cases: a provider that did not declare `image/png` MUST refuse an image request
   from `complete` AND from `stream`, and a provider that DID declare it must put the image on the wire (observed at `fetch`):
   declaring a modality and dropping it is the same silent loss. Declarations are an **allowlist by model family**
   (user decision): media is on only for the vendor's known media-capable families (OpenAI `gpt-4o*`, `gpt-4.1*`, `gpt-5*`,
   `o1` / `o3` except `-mini` / `-preview`, `o4*`, dated non-preview `gpt-4-turbo`; Anthropic `claude-3` and later; Gemini 1.5+ and
   2.x, and the `-latest` aliases) and OpenAI audio only for `audio` models. **Every other id declares nothing**: plain `gpt-4` and its
   dated snapshots, `gpt-3.5`, `gemini-1.0-pro-latest`, a local alias or an unknown future id are refused locally rather than
   400'd by the API (a new family needs one line in the table before it is trusted with media). A provider on a **non-default
   `baseUrl`** (an OpenAI-compatible server, a proxy) declares nothing either, since the model id says nothing about what is
   behind it. `config.capabilities` always wins, `capabilities: {}` is text-only, and passing `capabilities` is how a compatible
   server opts in.
   **This fails a 3P provider that silently drops media until it adds `assertRequestSupported(request, this.capabilities)`
   (the scaffold now emits it).**
7. **`guardRequest` enforces part structure and provenance in the same walk.** `tool_use` only in `assistant`;
   `tool_result` only in `user` and only for an id an earlier assistant message declared (an orphan result is refused here
   rather than as a provider 400); media only in `user`; the media type well-formed and matching its modality; inline data
   valid base64 under the cap. ADR 0085 carries over unchanged: a tainted `tool_result` string or text part is fenced in
   its `user` message; a tainted `tool_use.input` is refused (a forged model call); tainted text in `system` / `assistant`
   parts is refused. **Media cannot carry fence tags**, so a part may be marked `untrusted: { origin }`; in a `user`
   message it is bracketed by a fence-open and a fence-close text part (and the flag is stripped before the provider),
   anywhere else it is refused. As with text, the refusal is structural and the bracket is a label. The mark stays on the part
   through `guardRequest` and **each provider mapper brackets it where its wire shape allows** (`fenceUntrustedMedia`): OpenAI
   and Gemini move a tool result's media out of the text-only `tool` / `functionResponse` into a trailing user message / extra
   parts, and the fence open, media and fence close travel there together. An untrusted file's `name` is dropped (it would
   reach a title / filename outside any fence), and **an untrusted media part may not name a stored ref** (refused): an
   untrusted party must not choose which blob enters the prompt. A `tool_use` is checked deeply: a tainted value at any depth
   of its `input`, or in its `id` or `name`, is refused (iterative walk; a 100 000-node input fails closed). Because the guard
   would then refuse EVERY later request carrying that assistant message, the agent loops screen a model's tool calls at
   **dispatch**: an over-cap call is replaced, in the transcript, the approval digest and the tool-call log, by a small placeholder
   (`{ __oversizedInput: true }`), never run, and answered with a static `isError` result; the run continues.
8. **The response shape is unchanged** (`content`, `toolCalls`, `stopReason`, `usage`): `toolCalls` already are the
   `tool_use` parts, and a derived `parts` field could only disagree with them. `assistantMessageOf(response)` builds the
   assistant turn (text, then one `tool_use` per call). **Streaming** gains `LlmStreamChunk.toolDelta` (the call's `id` and
   `name`, then input JSON fragments) for Anthropic and OpenAI, surfaced by `collectStream({ onToolDelta })` and
   `createLlmEffect({ onToolDelta })`. It is transient like text deltas and is NOT routed through ADR 0119's governed
   `ctx.onDelta` channel: the delta validators inspect text, so a tool-input fragment on that channel would be ungoverned
   in a way the doc could not honestly describe. The assembled call still arrives whole on the terminal chunk, which is
   all that is journaled. `createLlmEffect({ onToolReset })` mirrors ADR 0119's `onReset`: the runtime's reset chunk for a
   retried attempt reaches it, so a consumer discards the failed attempt's fragments instead of concatenating two attempts'
   JSON. It stays outside the governed channel: no middleware delta guard or output validator sees tool-input fragments and
   `streamTokenBudget` meters text only. Gemini's `generateContent` has no stream here and is unchanged in that respect.
9. **Agent threading.** `agentLoop$` and `AgentRunner` push `assistantMessageOf(response)` and ONE `user` message of
   `tool_result` parts per turn (the placeholder is gone). `isError` is set for a menu/schema refusal, a declined or
   undigestible approval, and (runner) a thrown tool. A result is still the `{ tool, result }` JSON envelope in text, with
   the ADR 0085 taint re-applied outside the serialization. A tool returns media with `mediaResult(parts)`, and that is
   honoured **only for a tool whose definition declares `returnsMedia: true` and only when the output is not tainted**. The
   marker is a shape any JSON can have: honoured unconditionally, a web page / MCP server / peer agent could return it naming
   a ref of its choosing and have the loop fetch that blob into the prompt (and, with no resolver, fail the run on every
   recovery). Otherwise the value is data and takes the ordinary text path (fenced if tainted). `returnsMedia` is the one new
   `ToolDefinition` field (an optional declaration; not a kernel type's shape, no event carries it). The `agentLoop$` approval gate parks before the results
   message is pushed, so a park mid-turn leaves the transcript as it was. **Compaction** never starts the kept suffix on a
   `tool_result` message: the cut is moved back to include the assistant turn that made the calls, so a fold cannot orphan a
   result (the kept tail may therefore exceed `keepRecent` by one message). The compaction effect now receives messages
   whose `content` may be parts. **The compaction trigger is measured over a virtual transcript with the PRE-R5 shape and
   sizes** (one entry per message the old loop would have held, each the size it measured; a physical message knows how many
   it stands for), so `afterMessages`, `afterBytes` and the byte-trigger's kept-suffix size decide exactly as before and the
   `#turn:<t>:compact` frames land on the same turns. This is what makes decision 10 true under compaction; a test records a
   run with a copy of the old loop body, crashes it, and resumes it under the new body with `divergence: "fail"`.
10. **Replay and durability.** The model-call frame's input is `{ messages, tools, system }` as before; it now holds parts,
    with media as addresses. Recorded responses are unchanged and are served as-is, so an old recording (string content,
    `"(tool calls)"` turns) still folds and replays. The replay-divergence detector (ADR 0113) compares step ids, not
    inputs, so an in-flight `agentLoop$` execution recorded before this change resumes: its completed turns are served from
    the log and its next turn is built in the new shape from the recorded responses. Nothing about the log shape changed.
    The one thing in the transcript that moves step IDS is compaction, handled by decision 9's virtual measure.
    **Content GC (ADR 0055):** the mark phase of `sweepUnpinnedContent` now also reads the media source shape
    `{ kind: "ref", ref: { address } }`, because that shape is deliberately not the `{ __loomContent }` marker the sweep
    knew; a blob cited as a media ref anywhere in a scanned log is pinned (retained while cited, like a bare ref). Without
    this an orphan sweep after the TTL reclaimed media the transcript still cited. A test puts a blob, cites it as an R5
    ref in a `STEP_COMPLETED`, advances 10 days and sweeps with `reclaimOrphans`. As with a bare ref today, the sweep sees a
    media ref inside an ENCRYPTED payload only when it scans through a decrypting store.
11. **Not decided here (follow-ups).** Audio/file `tool_result` mapping for providers whose tool message is text-only is a
    workaround (OpenAI: media rides in a trailing `user` message; Gemini: extra `inlineData` parts beside the
    `functionResponse`). Provider-hosted file ids (OpenAI Files, Anthropic Files API, Gemini fileData URIs) and URL sources are
    out of scope: they are a different trust and lifetime model from content addressing. Model output other than text and
    tool calls (generated images/audio) is not represented. Gemini's `parametersJsonSchema` and `functionCall.id` follow the
    current API reference and were not exercised against the live service (the tests stub `fetch`).

### Authorizing under dedupe

The ContentStore is content-addressed, so identical bytes are ONE blob however many tenants stored them. A `ContentResolver`'s notion of "owner" must therefore be a SET of tenants (a blob each of them put), not a single owner: a single-owner map records the first tenant and wrongly denies the second tenant who stored the same bytes. Record every `put`'s tenant against the address, authorize if the asking principal's tenant is in the set, and drop a tenant from the set (erase the blob when it empties) on that tenant's delete.

## Consequences

- **Breaking for `@loom/llm` consumers**: see the CHANGELOG. A provider written against the old text-only `LlmMessage`
  that reads `m.content` as a string must use `textOf`; a media-capable provider declares `capabilities`.
- The transcript an agent re-journals each turn is now bounded in bytes for media (addresses, not bytes) and still grows
  with turns; compaction remains the answer, now pair-aware.
- A model cannot be asked about media on a provider that has not declared it; that is a refusal, never a degradation.
- The kernel is untouched.

## Fix round 1 (review of PR #514)

Eleven findings, each with a failing-first test: **P1** a tainted / undeclared tool output shaped like a media result chose
which blob was fetched (decisions 4, 7, 9); **P2** the upgrade claim failed under compaction (decision 9/10), media refs were
invisible to content GC (decision 10), untrusted media lost its fence on OpenAI and Gemini (decision 7), the 32 MiB cap was
checked after all fetches (decision 5); **P3** `keepRecent: 0` crashed, a tainted value deep in `tool_use.input` passed, an
untrusted file name reached a title, no per-request inline total, the reasoning path resolved before the capability check
and keyed its cache on bytes, `onToolDelta` duplicated on retry, the conformance kit did not cover `stream` or a declared-but-
dropped image. Q1/Q2 were decided by the controller: model-aware default declarations, and the 256 KiB inline total.

### Fix round 2

Seven P3s from the re-review (approved, no P1/P2): a per-call media header on OpenAI; test gaps (three calls per turn under
compaction, the principal reaching the resolver, the 100k-node cap, a shrinking `maxBytes` hint, the taint invariant on a
`returnsMedia` tool); capability defaults became an allowlist (decision 6); the resolve context is required; `ref.size` is
validated; an over-cap tool call no longer bricks the run (decision 7).

### Guard against raw reads

`content: string | LlmContentPart[]` type-checks under `.join`, template strings and untyped `JSON.stringify`, so a parts
message silently became `"[object Object]"` (found by hand in loom-demo and several loom-examples providers). Guards:
a type-aware fitness test (`packages/spec/src/rawMessageContent.test.ts`) over loom's own `.ts`/`.tsx`/`.mts` source that flags `x.content`, `x?.content`, `x["content"]`, a destructured `{ content }` and later reads of a variable initialised from one, unless the value goes to `textOf`/`toParts`/`hasStructuredParts`/`Array.isArray`, a `typeof` or `===`/`!==`, or a union-preserving position (it does not track the value through arbitrary calls or `any`), a
`runLlmProviderConformance` case that sends a text-parts message and fails a provider that string-coerces it, and a
user-guide warning plus provider-author checklist. A type-level brand was rejected (it breaks `textOf`'s own `string`
branch and every legitimate narrowing), and biome has no type-aware rules.

## Questions for the user

None open.
