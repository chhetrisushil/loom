# ADR 0133 — Model reasoning as audit evidence: captured at the provider seam, kept out of the fold

- Status: **Proposed** (2026-10-20)
- Date: 2026-10-20
- Builds on: [ADR 0037](0037-tamper-evident-audit-chain.md) (hash chain over the log),
  [ADR 0046](0046-content-store-seam-thin-authoritative-log.md) (content store seam),
  [ADR 0054](0054-claim-check-middleware.md) (the reference is the recorded value; erasure invisible to replay),
  [ADR 0085](0085-untrusted-content-integrity-axis.md) (taint),
  [ADR 0119](0119-decide-scope-streaming-deltas.md) (streamed deltas and output guards),
  [ADR 0120](0120-llm-content-parts-and-tool-threading.md) (content parts, tool threading),
  [ADR 0121](0121-one-canonical-agent-loop.md) (`agentLoop$`), [ADR 0083](0083-second-consumer-rule.md).
- Placement: **1P (`@loom/llm` + `@loom/plugin-content`)**. **Kernel unchanged: KERNEL_ABI and EVENT_SCHEMA
  unchanged.** The audit fact is a userspace event emitted through `EffectContext.emit`, and the fold ignores it.

## Context

Models with extended thinking return reasoning next to their answer: Anthropic thinking blocks, Gemini thought
summaries, OpenAI reasoning items. When an agent does something it should not have (the post-incident case: it read
injected content and then called a tool), the reasoning is the closest thing to a record of *why* it acted. A
framework for agentic applications should be able to keep that record.

Today loom discards it. `LlmResponse` (`packages/llm/src/types.ts`) is
`{ content, toolCalls?, stopReason, usage? }`, the terminal `LlmStreamChunk` carries the same outcome fields, and
none of the shipped providers maps a reasoning part. An application that wants reasoning for audit has to call the
vendor SDK directly, which also bypasses `guardRequest`, content resolution, the capability ring, metering, output
guards and the conformance kit. When doing something correctly means bypassing the framework, the framework is
missing a seam.

Two questions follow: **who captures reasoning** (kernel, framework or application), and **where it is stored**
relative to the deterministic log.

### What replay actually needs

Replay serves recorded step values and makes no model call. Reasoning is never needed to reproduce an execution.

Storing reasoning in the log would **not** break determinism, though. Anything that is recorded is replay-safe, and
flow code that branched on recorded reasoning would branch the same way on replay. "Not needed for replay" means the
kernel has no reason to *know about* reasoning. It is not, by itself, a reason to keep reasoning out of the log. The
reasons to keep the bytes out are these:

1. **Erasure.** Reasoning restates its inputs, including personal data and secrets the model saw. It needs a
   retention and erasure schedule that can differ from the log's. Anything in the log can only be erased through
   K10 redaction or shredding of the whole log ([ADR 0022](0022-k10-log-lifecycle-retention-redaction-encryption.md)).
   A sidecar blob can be deleted on its own schedule.
2. **Size.** Reasoning can run to thousands of tokens per turn, often more than the answer. Every fold, checkpoint
   and replay would carry it for nothing.
3. **Taint.** Reasoning is derived from tainted input and can repeat an injected instruction verbatim. If it is part
   of the step value, flow code and prompts can pick it up and feed it back to a model. Keeping it out of the value
   makes that impossible rather than discouraged.
4. **Value stability.** `createLlmEffect`'s `parse(response)` decides what is recorded. If reasoning is added to the
   step value, every recorded shape changes whenever capture is switched on, and an app's `parse` has to know about it.

### What reasoning is, and what it is not

- **Often not the raw chain of thought.** Several providers return a *summary*, a *redacted* block, or an
  *encrypted* item that only the provider can read. The audit record must say which one it holds and must not
  present a summary as a transcript.
- **Not a faithful explanation.** Stated reasoning does not reliably describe what caused the output. It
  *corroborates* the primary evidence, which loom already records durably and in a tamper-evident way: the inputs
  with their taint, the tool calls, authorizations and denials (`EFFECT_DENIED`, `EGRESS_DENIED`, approvals), and
  the step values. An audit that relies only on the reasoning is a weak audit.

## Decision

### D1 — Placement: framework support out of the box, kernel unchanged, application sets policy only

| Layer | Owns | Why |
|---|---|---|
| Kernel | nothing new | The fold never reads reasoning (P10). A userspace event through `ctx.emit` already exists for durable facts the fold ignores, the same channel `AGENT_TOOL_CALL` and middleware metering use. |
| `@loom/llm` | the reasoning shape on `LlmResponse` / the terminal chunk, provider mapping, the conformance rule, capture in `createLlmEffect` | Only the provider seam sees the reasoning, and only this layer keeps capture inside the guarded call path. |
| `@loom/plugin-content` | the store that holds reasoning blobs | Reuses the content store seam, with erasure that replay does not notice (ADR 0054 semantics, not ADR 0046). |
| Application | whether to capture, the retention schedule, who may read | Policy, not mechanism. |

Leaving capture to the application was rejected. It is not possible today without bypassing the provider seam.
Evidence that the application writes about itself, in its own table, is outside the audit chain, tenant scoping and
erasure. And every application would have to get taint, erasure and the at-least-once rerun right on its own.

### D2 — The provider contract: an optional `reasoning` field

```ts
export interface LlmReasoningPart {
  /** What the provider actually returned. Never upgrade a `summary` to `text`. */
  kind: "text" | "summary" | "redacted" | "encrypted";
  /** Readable text; absent for `redacted` / `encrypted`. */
  text?: string;
  /** Provider-opaque bytes (signature, encrypted item), base64. Never read by loom. */
  opaque?: string;
}

export interface LlmResponse {
  // …existing fields…
  /** ADR 0133 — reasoning the provider returned. Absent: none returned, or the provider does not map it. */
  reasoning?: LlmReasoningPart[];
}
```

`LlmStreamChunk` gets the same field on the terminal chunk only. Reasoning deltas are **not** streamed to sinks in
this ADR: a live view of thinking is a separate decision with its own taint and output-guard questions (ADR 0119).

Conformance (`runLlmProviderConformance`): optional, but honest, like `toolCalls`. A provider that reports
`reasoning` must report equal parts from `stream` and `complete` for the same request, and must never report `kind:
"text"` for content the vendor labels a summary. Every shipped provider (Anthropic, OpenAI, Gemini) maps what its API
returns, and its test pins the `kind` mapping.

### D3 — Capture: blob in a sidecar store, a reference in a userspace event, nothing in the step value

`createLlmEffect` gains `reasoning?: { store: ContentStore; capture?: (ctx) => boolean }`. After the provider
returns, and before `parse`:

1. If `response.reasoning` is present and capture is on, the parts are serialized canonically and `put` into
   `reasoning.store`. The store is content-addressed, so a crash-recovery rerun that produced the same bytes stores
   nothing new.
2. The effect emits **`LLM_REASONING_CAPTURED`** through `ctx.emit`, carrying
   `{ stepId, attempt, ref, digest, size, kinds, provider, model? }`. These are the reference and the digest, never
   the text.
3. `reasoning` is **removed** from the response handed to `parse`. The recorded step value is exactly what it is
   today, whether capture is on or off.

If capture is off or no store is configured, reasoning is dropped, which is today's behaviour. G2 holds: an
application that does nothing sees no change.

Properties:

- **Replay** makes no model call and does not run the effect, so it emits nothing and reads no blob. The event that
  is already in the log is ignored by the fold. Replay is byte-identical with capture on or off.
- **Tamper evidence.** The event is in the log, so with `@loom/audit-chain` the digest is hash-chained. Altering
  the blob is detectable (its digest stops matching), and dropping the event breaks the chain.
- **Erasure.** Deleting the blob leaves the reference and digest in place, and the audit reader reports
  `erased`. Replay never notices, because it never reads the blob. The record of *that* the model reasoned, and how
  much, stays. The content goes.
- **At-least-once.** A crash between the emit and `STEP_COMPLETED` reruns the step. If the rerun produces different
  reasoning, there are two events with distinct `attempt` values. The audit reader groups them by `stepId` and
  identifies the attempt whose step value was recorded. A superseded attempt is still evidence, and it is kept.
- **Tenant scope.** The emit goes through the same store wrappers as every other event. The blob store is
  tenant-scoped the same way the content store already is for ADR 0054 claim checks.

### D4 — Reading it back: an audit reader, not a flow API

`readReasoning(log, store, { executionId, stepId? })` lives in `@loom/llm`. It joins `LLM_REASONING_CAPTURED` events
to their blobs, checks each digest, and returns `{ parts, kinds, status: "ok" | "erased" | "digest-mismatch" }`.
Readable text is returned **wrapped as untrusted content** (ADR 0085, source `llm-reasoning:<stepId>`), so a tool
that later puts it into a prompt is refused in every instruction position by `guardRequest`.

No flow API is added: `ctx` has no way to read reasoning. A flow could still build a step that calls
`readReasoning`, and that is supported. What it gets back is tainted, and it is recorded as the value of that
step, so it is replay-safe.

### D5 — Second-consumer check (ADR 0083)

Consumers that have nothing to do with each other: `agentLoop$` (any tool-using agent run on a reasoning model), the
conversation layer (ADR 0122) when a turn is disputed, a loom-ui planner explaining a layout decision, and any
compliance deployment on a reasoning model. The requirement is not specific to one workload.

## Open questions (to settle before Accepted)

1. **Provider continuation.** Some providers require earlier turns' reasoning to be sent back on the next call of
   a tool-use loop. Anthropic thinking blocks with signatures and Gemini thought signatures are believed to work this
   way, but this must be **verified against each provider's current documentation** before Accepted. If confirmed, a
   resumed `agentLoop$` needs that data for its next *live* call, though never for replay. The proposed split: the
   provider-opaque continuation token (`opaque`, not readable reasoning) is carried in the recorded assistant turn as
   ADR 0120 already threads `tool_use`, and is subject to the log's lifecycle. The readable audit copy stays in the
   sidecar and can be erased. This keeps erasure of the audit copy from breaking a parked loop. It does put a small
   opaque blob into the step value, which D3 otherwise avoids. Is that acceptable, and how is "opaque" policed?
2. **Default.** Capture is opt-in (no store, no capture). Should `defineConfig` (`observability` or `security`
   group) warn at startup when the provider declares reasoning and no reasoning store is configured?
3. **Live view.** Streaming thinking to a viewer is deferred (D2). Record it as a follow-up or as an explicit
   non-goal?

## Rejected alternatives

- **A kernel event type (`REASONING_RECORDED` in EVENT_SCHEMA).** This bumps the schema for data the fold must
  ignore, and invites kernel consumers. The userspace emit channel already exists.
- **Inline in the step value.** Replay-safe, but loses D3's erasure, size and taint properties, and changes every
  recorded shape when capture is switched on.
- **ADR 0046 externalization.** Makes the blob load-bearing for the fold, so erasing it fails replay loudly. That
  is the opposite of what an erasable audit copy needs.
- **`metadata` on `STEP_COMPLETED`, as audit-chain uses.** Middleware and effects have no channel to stamp step
  metadata, so this would need one (a kernel touch). A separate userspace event gives the same fold invisibility
  with no kernel change.
- **Application-owned capture.** Rejected in D1.

## Consequences

- `@loom/llm` minor bump: an optional field on `LlmResponse` / the terminal chunk, an optional `reasoning` option on
  `createLlmEffect`, `readReasoning`, and a conformance rule. Providers map reasoning parts. No breaking change.
- Kernel, KERNEL_ABI and EVENT_SCHEMA are unchanged.
- `docs/data-classification.md` gains a row: reasoning blobs are classified at least as high as the request that
  produced them.
- Audit claims stay honest: the record says whether it holds text, a summary, a redacted marker or an encrypted
  item, and the docs present reasoning as corroborating evidence, not as an explanation.
