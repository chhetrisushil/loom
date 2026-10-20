# ADR 0133 — Model reasoning as audit evidence: captured at the provider seam, kept out of the fold

- Status: **Proposed** (2026-10-20). The three open questions of the first draft are resolved by owner ruling of
  2026-10-20 (see "Resolved questions"): continuation is designed in, capture is configurable with a boot warning,
  and the live view ships in this ADR.
- Date: 2026-10-20
- Builds on: [ADR 0037](0037-tamper-evident-audit-chain.md) (hash chain over the log),
  [ADR 0046](0046-content-store-seam-thin-authoritative-log.md) (content store seam),
  [ADR 0054](0054-claim-check-middleware.md) (the reference is the recorded value; erasure invisible to replay),
  [ADR 0085](0085-untrusted-content-integrity-axis.md) (taint),
  [ADR 0119](0119-decide-scope-streaming-deltas.md) (streamed deltas and output guards),
  [ADR 0120](0120-llm-content-parts-and-tool-threading.md) (content parts, tool threading, `resolveContent`),
  [ADR 0121](0121-one-canonical-agent-loop.md) (`agentLoop$`),
  [ADR 0122](0122-conversation-layer-streaming-transport-and-token-budgeting.md) (conversations, shared mode),
  [ADR 0083](0083-second-consumer-rule.md).
- Placement: **1P (`@loom/llm`, `@loom/agent`, `@loom/conversation`, `@loom/plugin-conversation-sse`, `@loom/app`)**.
  **Kernel unchanged: KERNEL_ABI and EVENT_SCHEMA unchanged.** The audit fact is a userspace event emitted through
  `EffectContext.emit`, and the fold ignores it.

## Context

Models with extended thinking return reasoning next to their answer. When an agent does something it should not
have (the post-incident case: it read injected content and then called a tool), the reasoning is the closest thing
to a record of *why* it acted. A framework for agentic applications should be able to keep that record.

Today loom discards it. `LlmResponse` (`packages/llm/src/types.ts`) is
`{ content, toolCalls?, stopReason, usage? }`, the terminal `LlmStreamChunk` carries the same outcome fields, and
none of the shipped providers maps a reasoning part. An application that wants reasoning for audit has to call the
vendor SDK directly, which also bypasses `guardRequest`, content resolution, the capability ring, metering, output
guards and the conformance kit. When doing something correctly means bypassing the framework, the framework is
missing a seam.

### What the providers actually return (checked 2026-10-20)

- **Anthropic Messages.** `thinking` blocks (`thinking` text + `signature`) and `redacted_thinking` blocks (opaque
  `data`). Streaming adds `thinking_delta` and `signature_delta` events. On current models the display defaults to
  *omitted*: the `thinking` text is empty and the `signature` carries the reasoning; `display: "summarized"` returns
  a readable summary. The raw chain of thought is never returned. Blocks **must be sent back unchanged** on later
  requests, and they are **bound to the model and the conversation**: a block's signature covers the system prompt,
  the tool list and every message before it. Editing earlier history invalidates every block after the edit (a 400,
  or a silent drop under `prefix_mismatch_behavior: "drop_block"`). The documented remedy is to remove the
  affected block and every thinking block after it.
- **Gemini `generateContent`.** Thought summaries arrive as parts with `thought: true` when `includeThoughts` is set.
  A `thoughtSignature` is metadata on a part, notably on a `functionCall` part. On Gemini 3 a current-turn
  `functionCall` sent back without its signature is a 400.
- **OpenAI Chat Completions** (what `OpenAiProvider` calls) returns no reasoning for OpenAI models. Encrypted
  reasoning items exist only in the Responses API, which loom does not call. Some OpenAI-compatible servers return a
  `reasoning_content` string; that is mapped when present and is not promised.

Two things follow. First, reasoning is **load-bearing for the live path**: a tool-use loop must send the previous
turn's blocks or signatures back, so a resumed `agentLoop$` needs them on its next live call. Replay still makes no
model call and never needs them. Second, loom's current behaviour (drop everything) already loses reasoning on every
tool-loop turn and will fail outright on a model that enforces signatures.

### What replay actually needs

Replay serves recorded step values and makes no model call. Reasoning is never needed to reproduce an execution.

Storing reasoning in the log would **not** break determinism either: anything recorded is replay-safe. "Not needed
for replay" means the kernel has no reason to know about reasoning; it is not by itself a reason to keep the bytes
out of the log. The reasons to keep readable reasoning out are:

1. **Erasure.** Reasoning restates its inputs, including personal data and secrets the model saw. It needs a
   retention and erasure schedule that can differ from the log's. A sidecar blob can be deleted on its own; anything
   in the log only through K10 redaction or shredding the whole log
   ([ADR 0022](0022-k10-log-lifecycle-retention-redaction-encryption.md)).
2. **Size.** Reasoning can be longer than the answer. Every fold, checkpoint and replay would carry it.
3. **Taint.** Reasoning is derived from tainted input and can repeat an injected instruction verbatim. Out of the
   step value, flow code and prompts cannot pick it up by accident.

Signatures are different: they are opaque (no readable content), needed for continuation, and small next to the
text. They are recorded inline.

### What reasoning is, and what it is not

- **Often not the raw chain of thought:** a summary, an empty block with a signature, a redacted block. The record
  says which.
- **Not a faithful explanation.** Stated reasoning does not reliably describe what caused the output. It
  *corroborates* the primary evidence loom already records durably: the inputs with their taint, the tool calls,
  authorizations and denials, the step values. An audit that relies only on the reasoning is a weak audit.

## Decision

### D1 — Placement: framework support out of the box, kernel unchanged, application sets policy only

| Layer | Owns |
|---|---|
| Kernel | nothing new (userspace `ctx.emit` already carries durable facts the fold ignores) |
| `@loom/llm` | the reasoning shapes, provider mapping both ways, the conformance rule, capture in `createLlmEffect`, `readReasoning` |
| `@loom/agent` / `@loom/conversation` | carrying reasoning parts through the transcript, and dropping them on any history edit (D5) |
| `@loom/plugin-conversation-sse` | the live reasoning stream (D6) |
| `@loom/app` | the config and the boot warning (D7) |
| Application | whether to capture, the retention schedule, who may read, whether to show it live |

Application-owned capture was rejected: it is impossible today without bypassing the provider seam, evidence the
application writes about itself in its own table is outside the audit chain, tenant scoping and erasure, and every
application would have to get continuation, taint and erasure right on its own.

### D2 — The shapes

```ts
/** What the provider returned. Never upgrade a `summary` to `text`. */
export type LlmReasoningKind = "text" | "summary" | "redacted";

/** Reasoning on a response, as the provider returned it. Lives only on `LlmResponse`, never in a step value. */
export interface LlmReasoning {
  kind: LlmReasoningKind;
  /** Readable text; "" for an omitted-display block; absent for `redacted`. */
  text?: string;
  /** Provider-opaque continuation bytes (signature, redacted data). Never read by loom. */
  signature?: string;
  /** The provider that produced it (`"anthropic"`, `"gemini"`, …): parts are only sent back to it. */
  provider: string;
}

/** The recorded form: what a step value and a transcript carry. No readable text, ever. */
export interface LlmReasoningPart {
  type: "reasoning";
  kind: LlmReasoningKind;
  provider: string;
  signature?: string;
  /** Where the text lives (sidecar store), when it was captured and is non-empty. */
  textRef?: LlmContentRef;
  /** SHA-256 of the text, so a resolved text can be checked. */
  digest?: string;
  /** Readable text existed and was NOT kept (no store, or capture off): the part cannot be reproduced for continuation, so D5 drops it. */
  omitted?: true;
  /** REQUEST-TIME ONLY: the text `resolveRequestContent` fetched from `textRef`, for the provider to map back. Never on a recorded value; `guardRequest` strips it from callers. */
  text?: string;
}
```

- `LlmResponse.reasoning?: LlmReasoning[]`, and the same on the terminal `LlmStreamChunk`.
- `LlmToolCall.signature?: string` and `LlmToolUsePart.signature?: string` for a signature that belongs to a call
  (Gemini). It travels with the call and is never dropped with the reasoning parts.
- `LlmReasoningPart` joins the assistant-message content parts (ADR 0120). `guardRequest` refuses a reasoning part
  in any message but `assistant`.
- `LlmStreamChunk.reasoningDelta?: string` streams readable reasoning (D6).
- **`LlmResponse.layout?: LlmLayoutEntry[]`** (and the terminal chunk): the vendor's block ORDER, as positions
  only (`"reasoning"` = the next reasoning part, `{ call: id }`, `{ text: n }` = the next `n` characters of
  `content`). A provider flattens a response into `content` + `reasoning[]` + `toolCalls`, which loses where each
  block sat, and a signature binds the blocks before it: `thinking, text, tool_use, thinking, tool_use` must not
  come back as `thinking, thinking, text, tool_use, tool_use`. A provider sets `layout` (via `layoutOf`) ONLY when
  the response has reasoning AND the order is not the canonical one (reasoning parts, one text, the calls), so a
  response without reasoning, and a canonical one, keep today's exact shape and byte-identical step value (G2).
  `assistantMessageOf` replays it (text blocks the vendor returned separately stay separate); a layout that does
  not fit the response (malformed, text lengths that do not sum to `content`, a reasoning count that differs) drops
  EVERY reasoning part rather than reorder them (stripping is always valid, moving a block never is), and a named
  call the loop screened out drops the reasoning parts after it (a suffix drop); the Anthropic mapping no longer regroups blocks and Gemini already emitted in
  message order. The recorded form adds positions, no new content.
- **Asking for it (provider config).** Nothing requests readable reasoning by default.
  `AnthropicProvider({ thinking: { type: "adaptive", display?: "summarized" | "omitted" } })` is passed through as
  the request's `thinking`; `GeminiProvider({ includeThoughts: true })` becomes
  `generationConfig.thinkingConfig.includeThoughts`. Unset, neither key is sent (G2).
- `LlmCapabilities.reasoning?: boolean`: the provider can return reasoning. It drives the boot warning (D7).

Conformance (`runLlmProviderConformance`): optional, but honest. A provider that reports `reasoning` reports equal
reasoning from `stream` and `complete` for the same request, the concatenated `reasoningDelta`s equal the terminal
chunk's readable text, and `kind` follows the vendor's own label. Each shipped provider's tests pin its mapping in
both directions: response → `LlmReasoning`, and assistant `reasoning` part → the vendor's request block, unchanged.

### D3 — Capture: text in a sidecar store, signature inline, a userspace event for the audit

`createLlmEffect` gains `reasoning?: { store?: ContentStore; capture?: boolean | ((ctx) => boolean); live?: boolean }`.
After the provider returns, and before `parse`:

1. For each `LlmReasoning` with non-empty text, when capture is on and a store is configured, the text is `put`
   into the store (content-addressed, so a crash-recovery rerun with the same bytes stores nothing new).
2. The response handed to `parse` has `reasoning` **replaced** by `LlmReasoningPart[]`: kind, provider, signature,
   and `textRef` + `digest` when the text was stored. Readable text never reaches `parse`, so it is never in a step
   value. With no store, the text is dropped and the part keeps only its signature.
3. When at least one part was captured, the effect emits **`LLM_REASONING_CAPTURED`** through `ctx.emit` with
   `{ stepId, attempt, provider, model?, parts: [{ kind, ref?, digest?, size? }] }`: references and digests, never
   text, never signatures.

Properties:

- **Fail-closed store.** A failing `store.put` throws out of the effect, which fails the step and lets the retry
  policy re-run it: audit evidence that cannot be kept is never silently recorded as less than was configured.
  With capture off or no store, readable text is dropped and the part is flagged `omitted: true`.
- **The event's `ref`** is the store's content address as a string (`parts[].ref`), with `digest` (SHA-256 hex of
  the UTF-8 text) and `size`; the model id is recorded when the effect is told it (`reasoning.model`;
  `registerReasoningRoutes` passes the route id).
- **Replay** serves the recorded step value (parts with refs and signatures), runs no effect, emits nothing and reads
  no blob. The event already in the log is ignored by the fold.
- **Tamper evidence.** With `@loom/audit-chain`, the event and the step value are hash-chained, digests included. An
  altered blob fails its digest; a dropped event breaks the chain.
- **Erasure.** Deleting a blob leaves the ref and digest. The audit reader reports `erased`; replay never notices;
  continuation drops the part (D5).
- **At-least-once.** A rerun after a crash between the emit and `STEP_COMPLETED` emits again with a new `attempt`.
  The audit reader groups by `stepId` and marks which attempt's value was recorded; superseded attempts are kept.
- **Tenant scope and who may resolve a ref.** The emit goes through the same store wrappers as every other event;
  the blob store is tenant-scoped like the ADR 0054 claim-check store. A content store has no tenancy of its own
  (whoever can name an address reads it), and a reasoning part's `textRef` rides in a transcript a caller can
  assemble, where the part's `digest` is the address and so proves nothing. So the stored bytes are **sealed to
  the capturing execution** (a small envelope naming its `executionId`; the part's and the event's `digest`/`size`
  stay those of the readable text), and the default resolver serves a blob only to the execution it is sealed to.
  A ref forged from, or copied out of, another execution resolves to "not yours" (`null`), which D5 treats as a
  hole: the part and every reasoning part after it are dropped and nothing is sent. This costs cross-execution
  dedupe (the same text captured by two executions is two blobs, which is what makes erasing one execution's
  reasoning independent of the other's) and means a FORK, which has a new execution id, continues without its
  parent's reasoning (the safe degradation). The authorizing seam is the ADR 0120 one: `reasoning.resolve` is a
  `ContentResolver` called with `{ executionId, stepId, principal, origin: "reasoning" }` that returns the text
  bytes or `null`; unset, `reasoningStoreResolver(store)` is used. (The media `resolveContent` is not reused: it
  is built over another store and would answer `null` for every reasoning address, silently dropping all
  continuation.)
- **Value shape.** A step value gains `reasoning` parts only when the provider returned reasoning. A provider that
  returns none, or an application whose `parse` ignores the field, sees no change.

### D4 — Reading it back: an audit reader, not a flow API

`readReasoning(log, store, { executionId, stepId? })` in `@loom/llm` joins `LLM_REASONING_CAPTURED` events to their
blobs, checks each digest and returns `{ parts, status: "ok" | "erased" | "digest-mismatch" }` per part. Readable
text is returned **wrapped as untrusted content** (ADR 0085, origin `llm-reasoning:<stepId>`), so putting it into a
prompt is refused in every instruction position. `ctx` gets no reasoning accessor. A flow that calls `readReasoning`
inside a step gets tainted text recorded as that step's value, which is replay-safe. A blob not sealed to the
queried execution reads as `digest-mismatch`. For an endpoint, `readReasoningBounded(log, store, query, limits)`
selects by `stepId` / `stepPrefix` BEFORE any `store.get` and caps `maxParts` / `maxBytes` (the event's declared
size gates the fetch, so nothing past the cap is read), returning the first parts in log order and
`truncated: true`.

### D5 — Continuation: send it back unchanged, drop it on any edit

At request time, `resolveRequestContent` (the ADR 0120 seam that already resolves media refs) resolves each
assistant `reasoning` part's `textRef` from the sidecar and checks the digest. The provider maps the part back to
its vendor block unchanged (Anthropic `thinking` / `redacted_thinking` with the signature; Gemini thought parts).
Parts are sent only to the provider named in `provider`; a request to another provider omits them.

**The drop rule.** A reasoning part is valid only while everything before it is exactly what it was when the part
was produced. So, for parts sent back to a provider:

- When a transcript is **edited** (`agentLoop$` compaction, conversation rotation or rolling summary, a model or
  provider switch), every reasoning part **after the edit point** is dropped from the request. Compaction replaces
  the prefix, so it drops them all, and when reasoning is carried it takes the SIMPLE shape below.
- When the **tool set or the system prompt changes**, a signature (which covers `tools` and `system`) no longer
  verifies for any block produced before the change, so EVERY reasoning part on the transcript is dropped from
  then on (tool-call signatures stay). `agentLoop$` fixes `system` for the run, so the only change it makes
  mid-loop is the tool menu growing (a `search_tools` hit, a skill activation); the parts are dropped when the
  menu grows, for good, and turns after it carry fresh blocks produced under the new menu. Stripping EVERY
  thinking block is always valid, and removing a block together with all blocks after it is valid; removing one
  from the middle is not, which is why the rule is "from here on, all" and never "this one".
- When a part **cannot be resolved** (blob erased, the resolver answered `null` because it is not this execution's,
  digest mismatch, no store configured and the text was non-empty), that part **and every reasoning part after
  it** are dropped. Only a definitive "not found" counts: a resolver that **throws** (a store outage, a timeout)
  fails the call, and the step retries per normal effect semantics, rather than silently continuing with less.
- A call's own `signature` (on `tool_use`) is never dropped by this rule. Gemini validates it on the current turn,
  and it holds no readable content.

**How `agentLoop$` applies it (implemented).** The assistant turn carries the response's reasoning parts in the vendor's order
(`layout`, falling back to reasoning-first) and each tool call's `signature` (`assistantMessageOf`). The model effect resolves the parts at request time from the
same store it captured into (`createAgentModelEffect(provider, { reasoning: { store } })`). On compaction every
reasoning part still on the transcript is after the edit point, so all are dropped from the summarizer's input
and from what the next request replays; the shape depends on whether reasoning is carried (next paragraph). On a `reasoning` runtime a route's model id is known from the
recorded route decision, so before each effect-backed call the parts a DIFFERENT route produced are dropped (a
same-provider model switch included: Anthropic binds a block to its model; a provider never sees another
provider's parts anyway). The rule is per part (produced by this route or not), so after A, B, B the second B call
still carries B's own part. The direct routed path (no `reasoningToolId`) is not an effect: it has no sidecar and
journals its response as a decision, so it records NO reasoning (the decision value never carries readable
text), continues no reasoning blocks and keeps tool signatures. The `conversation` layer builds history from
plain text, so reasoning never crosses a turn there: rotation and the rolling summary have nothing to drop, and
a test pins that no request after the first carries a reasoning part. The routed path's `ReasoningResult` (and its response cache) carry reasoning only as text-free recorded parts
(`textFreeReasoning`: signature, kind, provider, `omitted: true` when text existed), so readable text never leaves
the provider/effect layer except through the sidecar and `readReasoning`. The drop happens on the live request
only: a replay serves the recorded frames.

**Compaction shape (implemented).** The vendor rules, from the Anthropic documentation (not verified live): a
thinking block's signature binds the top-level system, the set of tools and every earlier message, so an edit
before a block invalidates it and every later block; with `prefix_mismatch_behavior: "drop_block"` the API drops
the first mismatched block and every later one "including blocks in an assistant turn whose tool_use is still
waiting on its tool_result". Stripping every `thinking` and `redacted_thinking` block (each turn's text and
`tool_use` stay) is a valid request, but is documented as a one-time recovery, "not a steady-state pattern": an
integration that does it every request loses that reasoning and the prompt-cache benefit. For client-side
compaction the documented recommendation is "simple compaction": summarize the conversation into a single
message, start the next request with that summary plus the new user turn, "replay nothing else - no earlier turns,
no earlier thinking blocks"; keep-tail compaction must strip thinking from retained turns, and "don't compact in
the middle of a tool round (an assistant turn whose tool_use is still waiting on its tool_result should go back
with its thinking intact)". A kept tail with an in-flight round therefore cannot keep that round's thinking valid.
So, when compaction fires (same trigger, same turn, same frame id `#turn:<t>:compact`) AND any message on the
transcript carries a `reasoning` part, `agentLoop$` uses **simple compaction**: the summarizer is given the WHOLE
transcript (reasoning stripped, the in-flight round's tool calls and results included) and the next request is a
single user message holding the summary followed by the in-flight round's results as text parts (a label per
result, `isError` marked, media parts passed through), with no assistant turn, no `tool_use`, no `tool_result`
and no thinking block replayed. Taint is unchanged: a result's content keeps its own tainted text part, and the
summary is tainted when anything it covers was (ADR 0085 positional rule: only in a user message, fenced). Turns
after it append normally, so their new reasoning is bound to the new, stable prefix. When NO message carries a
reasoning part, compaction is exactly the previous keep-tail (identical requests, frame ids and decisions; a
test pins it, and a recorded run replays with zero model calls). The choice is a pure function of the journaled
transcript. A run recorded by the earlier, unreleased build of this ADR that held reasoning parts at a compaction
would ask the summarizer a different input on resume.

**The direct routed path.** `agentLoop$` with `reasoning` and no `reasoningToolId` is valid (the API accepts the
request) but, by the vendor rule above, strips thinking on every request. It is not refused by default, because that
would break every existing direct-path app on a current Anthropic model; see D7 for the warning and the opt-in refusal.

Dropping is the vendor's documented remedy, so continuation degrades (less carried-over reasoning) instead of
failing. The decision is a pure function of the journaled transcript plus the resolver's answer, and it runs on the
live path only, so replay is unaffected. The `agentLoop$` compaction measure counts reasoning parts as **zero
bytes**, so a run recorded before this change and resumed after it compacts on the same turns. **Known
trade-off:** with large preserved thinking the zero-byte measure under-counts the real request, and
`afterBytes` under-reports what the next request carries; the alternative (counting them) would change when a
recorded run compacts on resume, which replay stability forbids.

### D6 — The live view

When `live` is on and the call is streamed, `reasoningDelta`s are delivered through the ADR 0119 per-call sink as
`{ reasoning: tainted(delta, "llm-reasoning:<stepId>") }`, a separate channel from text deltas, so no consumer that
renders text deltas sees reasoning by accident.

- **Guards.** A middleware `deltaGuard` is applied to reasoning deltas as well as text deltas. A middleware with
  `inspectsOutput: true` refuses streaming for the whole call (unchanged ADR 0119 rule), which covers reasoning.
- **Not journaled.** Like text deltas, reasoning deltas are transient. The durable record is D3.
- **Off by default**, for each call (`live`) and for each transport.
- **Configured sink.** `createLlmEffect({ reasoning: { live: true, onDelta } })` takes the live sink the way
  `onDelta` takes the text sink: the runtime reaches it (`Effect.reasoningSink`) only through the delta guards,
  with the increment still wrapped as untrusted content. `ConversationHub.reasoningSink()` is that sink and
  unwraps at its own edge, into a bounded in-progress buffer (the same cap as the reply, head dropped) that is
  superseded together with the reply (one `reset` on a re-run; `endTurn` when the durable message lands).
- **Transport.** `@loom/plugin-conversation-sse` gains an opt-in `reasoning` option (`true`, or `{ live, store }`)
  with `reasoning` and `reasoning-partial` SSE event types and, with a `store`,
  `GET /conversations/:id/reasoning?cursor=<the reply's history cursor>`. The endpoint reads only the reply's
  turn (`stepPrefix`, applied before any blob is fetched) and is bounded: at most 256 parts and 1 MiB of readable
  text per response (`REASONING_RESPONSE_MAX_PARTS` / `_MAX_BYTES`); past either it returns the first parts with
  `truncated: true`. In **shared mode**
  (ADR 0122 D10) reasoning deltas go **only to the turn's asker and the conversation's owner** (owner ruling
  2026-10-20), never to other participants. The reasoning carries what the asker's turn saw, and the per-viewer
  filter is not designed to classify free text; the owner, who administers the conversation, is the one added reader. This holds
  for the live events, the catch-up partial and the durable endpoint alike (`Conversations.reasoningTarget`
  decides: in shared mode only the reply's asker or the owner, by the ADR 0111/0122 identity rule (tenant, actor and
  `onBehalfOf` all equal); any other participant, a non-participant, another tenant, an
  unknown cursor and a non-reply record get the same 404 as a missing conversation). An event with no asker is
  served to the owner alone in shared mode.
- **Catch-up, the same as text (ADR 0122 D7).** The hub keeps the in-progress reasoning per turn, bounded like the
  in-progress reply, so a client that attaches or reconnects mid-call gets a `reasoning-partial` and then the live
  deltas. Once the call has completed, the durable record is the captured reasoning (D3): the transport serves it,
  through `readReasoning` and to the same audience (the asker and the owner in shared mode), to a client that reconnects later. A
  re-run of the turn by another process emits `reset`, as text does. The remaining gaps are the ones text already
  has (a process restart mid-call, a call on another node) plus one by configuration: with no reasoning store, a
  completed call's reasoning was never kept, so a late client gets none, and the boot warning (D7) names that.

### D7 — Configuration and the boot warning

`defineConfig({ observability: { reasoning: { store, capture, live } } })` sets the default for every LLM effect
the app builds; an effect's own `reasoning` option overrides it. **Capture defaults to on when a store is
configured, off when not.** At boot, when a registered LLM effect's provider declares `capabilities.reasoning` and no
reasoning store is configured, `observability.onWarn` gets one warning per effect naming it: *"`<effect>` can return
model reasoning, but no reasoning store is configured: reasoning is not kept for audit (only signatures, for
continuation)"*. `reasoning: false` is the explicit, silent opt-out for effects with no reasoning policy of their own: an effect
that configured its own `store` or `capture` keeps it entirely (the app-wide `false` is a default, never an
override).

**Implemented as.** `@loom/app` cannot see providers on its own, but every LLM effect built by `createLlmEffect`
exposes a small hook (`Effect.reasoning`: `capable`, `posture()`, `adopt()`), and `defineConfig` walks
`EffectRuntime.entries()` right after `execution.registerEffects`: the nearest point at which it sees both the
registered effects and their providers' declared capabilities. It hands the config to each effect (the effect's own
options win field by field), then warns once per capable effect left with no store (an effect that set
`capture: false` itself, or an app with `reasoning: false`, is silent). Effects registered after boot are not
checked. The warning text names the effect id and the config key.

**The direct-path check (implemented).** `agentLoop$` is a runner body and cannot see the app config, so the
check lives where the routes and their providers are first known: the top of each `agentLoop$` call, before any
model call. When `reasoning` is configured without `reasoningToolId` and a route's provider declares
`capabilities.reasoning`, it emits ONE warning per `ReasoningRuntime` naming the capable route(s): *"route "<id>"
can return model reasoning, but the direct routed path (no `reasoningToolId`) discards it every turn ... Set
`reasoningToolId` (see registerReasoningRoutes) to carry it."* The sink is the loop's own `onWarn`, else the
app-wide default `defineConfig` hands over through `configureAgentLoopDefaults` (`observability.onWarn`), else
a process warning (`LOOM_AGENT_REASONING_DISCARDED`). Opt-in refusal: `observability.reasoning.requireContinuation:
true` (or `requireReasoningContinuation: true` on `agentLoop$`) throws `AgentLoopConfigError` instead, on every
call. `observability.reasoning: false` silences the warning. Default stays a warning. Nothing fires with
`reasoningToolId`, with a provider that does not declare the capability, or when nothing is configured. The
app-wide default is process-wide state, replaced by each `defineConfig`.

### D8 — Second-consumer check (ADR 0083)

Unrelated consumers: `agentLoop$` (any tool-using agent on a reasoning model, where continuation is a correctness
need, not only an audit one), the conversation layer when a turn is disputed, a loom-ui planner explaining a layout
decision, and any compliance deployment on a reasoning model.

## Live verification (2026-10-20)

- **Gemini: verified live** on `gemini-3.8-flash` and `gemini-3-flash-preview`, through loom's `GeminiProvider` with
  `includeThoughts`. Turn 1 returned a thought summary and a `functionCall` with its `thoughtSignature`; turn 2,
  built with `assistantMessageOf` from the recorded (text-free) parts, was accepted and answered. The same turn 2
  with the call signatures removed was refused with the documented 400 ("Function call is missing a
  thought_signature in functionCall parts"). This confirms D5's rule that a call's `signature` is never dropped.
- **Anthropic: not verified live.** The available key had no API credit; by owner decision the live check is
  dropped for now, and the Anthropic mapping is verified against recorded wire shapes only (as the other provider
  tests are). The two Anthropic-specific items are no longer deferred: they are **built from the Anthropic
  documentation** (the rules quoted in D5, "from the Anthropic documentation (not verified live)"):
  1. The direct routed path (no `reasoningToolId`) with a reasoning provider is valid per the documentation but
     discards reasoning every request (the documented non-steady-state pattern), so it gets a warning, and an
     opt-in refusal (D7).
  2. Compaction with reasoning carried uses the documented "simple compaction" shape instead of a kept tail
     (D5), because an in-flight tool round's thinking cannot stay valid across a replaced prefix.
  If a live check later contradicts either rule, only these two behaviours change.

## Resolved questions (owner ruling 2026-10-20)

1. **Provider continuation:** verified against the providers (Context). Designed in as D5: signatures inline,
   readable text by reference, the drop rule.
2. **Default:** configurable, with a boot warning (D7).
3. **Live view:** in scope (D6).

## Rejected alternatives

- **A kernel event type** (`REASONING_RECORDED` in EVENT_SCHEMA): a schema bump for data the fold must ignore. The
  userspace emit channel already exists.
- **Readable text inline in the step value:** loses erasure, size and taint properties.
- **ADR 0046 externalization:** makes the blob load-bearing for the fold, so erasure fails replay loudly.
- **`metadata` on `STEP_COMPLETED`:** effects have no channel to stamp step metadata (a kernel touch); a userspace
  event gives the same fold invisibility.
- **Dropping reasoning entirely between turns** (today's behaviour): loses continuation and fails on providers that
  enforce signatures.
- **Application-owned capture:** rejected in D1.

## Consequences

- `@loom/llm` minor bump: optional fields and parts, provider mapping both ways, `readReasoning`, conformance rules.
  `@loom/agent`, `@loom/conversation`, `@loom/plugin-conversation-sse`, `@loom/app`, `@loom/effect-runtime` (the guarded reasoning channel, `Effect.reasoningSink`, the `Effect.reasoning` hook, `EffectRuntime.entries()`) and `@loom/conformance` (the parity rule) minor bumps. No breaking change.
- Kernel, KERNEL_ABI and EVENT_SCHEMA unchanged.
- `docs/data-classification.md` gains a row: reasoning blobs are classified at least as high as the request that
  produced them.
- Audit claims stay honest: each record says whether it holds text, a summary or a redacted block, and the docs
  present reasoning as corroborating evidence, not as an explanation.
- OpenAI reasoning stays unavailable until a Responses API provider exists (a separate decision).
