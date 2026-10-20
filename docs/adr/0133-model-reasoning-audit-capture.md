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
}
```

- `LlmResponse.reasoning?: LlmReasoning[]`, and the same on the terminal `LlmStreamChunk`.
- `LlmToolCall.signature?: string` and `LlmToolUsePart.signature?: string` for a signature that belongs to a call
  (Gemini). It travels with the call and is never dropped with the reasoning parts.
- `LlmReasoningPart` joins the assistant-message content parts (ADR 0120). `guardRequest` refuses a reasoning part
  in any message but `assistant`.
- `LlmStreamChunk.reasoningDelta?: string` streams readable reasoning (D6).
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

- **Replay** serves the recorded step value (parts with refs and signatures), runs no effect, emits nothing and reads
  no blob. The event already in the log is ignored by the fold.
- **Tamper evidence.** With `@loom/audit-chain`, the event and the step value are hash-chained, digests included. An
  altered blob fails its digest; a dropped event breaks the chain.
- **Erasure.** Deleting a blob leaves the ref and digest. The audit reader reports `erased`; replay never notices;
  continuation drops the part (D5).
- **At-least-once.** A rerun after a crash between the emit and `STEP_COMPLETED` emits again with a new `attempt`.
  The audit reader groups by `stepId` and marks which attempt's value was recorded; superseded attempts are kept.
- **Tenant scope.** The emit goes through the same store wrappers as every other event; the blob store is
  tenant-scoped like the ADR 0054 claim-check store.
- **Value shape.** A step value gains `reasoning` parts only when the provider returned reasoning. A provider that
  returns none, or an application whose `parse` ignores the field, sees no change.

### D4 — Reading it back: an audit reader, not a flow API

`readReasoning(log, store, { executionId, stepId? })` in `@loom/llm` joins `LLM_REASONING_CAPTURED` events to their
blobs, checks each digest and returns `{ parts, status: "ok" | "erased" | "digest-mismatch" }` per part. Readable
text is returned **wrapped as untrusted content** (ADR 0085, origin `llm-reasoning:<stepId>`), so putting it into a
prompt is refused in every instruction position. `ctx` gets no reasoning accessor. A flow that calls `readReasoning`
inside a step gets tainted text recorded as that step's value, which is replay-safe.

### D5 — Continuation: send it back unchanged, drop it on any edit

At request time, `resolveRequestContent` (the ADR 0120 seam that already resolves media refs) resolves each
assistant `reasoning` part's `textRef` from the sidecar and checks the digest. The provider maps the part back to
its vendor block unchanged (Anthropic `thinking` / `redacted_thinking` with the signature; Gemini thought parts).
Parts are sent only to the provider named in `provider`; a request to another provider omits them.

**The drop rule.** A reasoning part is valid only while everything before it is exactly what it was when the part
was produced. So, for parts sent back to a provider:

- When a transcript is **edited** (`agentLoop$` compaction, conversation rotation or rolling summary, a model or
  provider switch), every reasoning part **after the edit point** is dropped from the request. Compaction replaces
  the prefix, so it drops them all.
- When a part **cannot be resolved** (blob erased, digest mismatch, no store configured and the text was non-empty),
  that part **and every reasoning part after it** are dropped.
- A call's own `signature` (on `tool_use`) is never dropped by this rule. Gemini validates it on the current turn,
  and it holds no readable content.

Dropping is the vendor's documented remedy, so continuation degrades (less carried-over reasoning) instead of
failing. The decision is a pure function of the journaled transcript plus the resolver's answer, and it runs on the
live path only, so replay is unaffected. The `agentLoop$` compaction measure counts reasoning parts as **zero
bytes**, so a run recorded before this change and resumed after it compacts on the same turns.

### D6 — The live view

When `live` is on and the call is streamed, `reasoningDelta`s are delivered through the ADR 0119 per-call sink as
`{ reasoning: tainted(delta, "llm-reasoning:<stepId>") }`, a separate channel from text deltas, so no consumer that
renders text deltas sees reasoning by accident.

- **Guards.** A middleware `deltaGuard` is applied to reasoning deltas as well as text deltas. A middleware with
  `inspectsOutput: true` refuses streaming for the whole call (unchanged ADR 0119 rule), which covers reasoning.
- **Not journaled.** Like text deltas, reasoning deltas are transient. The durable record is D3.
- **Off by default**, for each call (`live`) and for each transport.
- **Transport.** `@loom/plugin-conversation-sse` gains an opt-in `reasoning` SSE event type. In **shared mode**
  (ADR 0122 D10) reasoning deltas go **only to the turn's asker**, never to other participants. The reasoning
  carries what the asker's turn saw, and the per-viewer filter is not designed to classify free text.
- **`Last-Event-ID` resume** does not replay reasoning deltas missed while disconnected: they were never journaled.
  The client sees a gap marker, not a fabricated stream.

### D7 — Configuration and the boot warning

`defineConfig({ observability: { reasoning: { store, capture, live } } })` sets the default for every LLM effect
the app builds; an effect's own `reasoning` option overrides it. **Capture defaults to on when a store is
configured, off when not.** At boot, when a registered LLM effect's provider declares `capabilities.reasoning` and no
reasoning store is configured, `observability.onWarn` gets one warning per effect naming it: *"`<effect>` can return
model reasoning, but no reasoning store is configured: reasoning is not kept for audit (only signatures, for
continuation)"*. `reasoning: false` is the explicit, silent opt-out.

### D8 — Second-consumer check (ADR 0083)

Unrelated consumers: `agentLoop$` (any tool-using agent on a reasoning model, where continuation is a correctness
need, not only an audit one), the conversation layer when a turn is disputed, a loom-ui planner explaining a layout
decision, and any compliance deployment on a reasoning model.

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
  `@loom/agent`, `@loom/conversation`, `@loom/plugin-conversation-sse`, `@loom/app` minor bumps. No breaking change.
- Kernel, KERNEL_ABI and EVENT_SCHEMA unchanged.
- `docs/data-classification.md` gains a row: reasoning blobs are classified at least as high as the request that
  produced them.
- Audit claims stay honest: each record says whether it holds text, a summary or a redacted block, and the docs
  present reasoning as corroborating evidence, not as an explanation.
- OpenAI reasoning stays unavailable until a Responses API provider exists (a separate decision).
