# Reducing token cost

An `agentLoop$` run, or a conversation built on one, spends tokens in four places: the transcript it re-sends
to the model every turn, the tool results inside that transcript, the history a conversation carries between
runs, and the memory recalled into each prompt. Loom has one opt-in for each. None is on by default, and none
is free: each trades some fidelity for fewer tokens. This page says what each one bounds, when to reach for it,
and what it costs.

## What to measure first

A loop re-sends its whole transcript on every model call, so the tokens it sends grow with the square of its
turn count: turn N pays for turns 1 to N-1 again. That is the baseline the options below are measured against,
and it is why the same option saves little on a five-turn run and a great deal on a two-hundred-turn one.

Measure before and after, with the option on and off, on a run shaped like yours:

- Tokens sent per model call (the provider's usage numbers), not the size of the log. The log is bytes you store; the prompt is tokens you pay for. They move
  together only for some options.
- Cost per turn at turn 5, 50 and 200, not one average. The curves differ: compaction flattens the late turns,
  a claim-check helps from the first large tool result.
- Cache behaviour. Provider prompt caching rewards a stable prefix. A rolling summary REWRITES the front of the
  prompt each time it is refreshed, so the cached prefix is lost at that turn. A run that compacts every few turns can
  pay more for cache misses than it saves in tokens. If you rely on caching, measure the cache hit rate with
  compaction on and off, and set `afterBytes` high enough that it fires rarely.

[Scaling, section 5](scaling.md) has the measured state-growth tables for the log side of these options.

## Bound the transcript inside a run: compaction

- **Bounds:** the transcript `agentLoop$` re-sends each turn. Older messages are folded into one summary, the
  newest `keepRecent` stay verbatim ([ADR 0137](adr/0137-agent-state-growth-warning-and-builtin-summarizer.md),
  [ADR 0138](adr/0138-compaction-archives-what-it-removes.md)).
- **Use it when:** a run goes past a few dozen turns, or one tool result is large enough to ride in every later
  turn. A loop with no `compaction` warns once (`LOOM_AGENT_STATE_GROWTH`, through `onWarn` or
  `observability.onWarn`) when its transcript passes `warnTranscriptBytes` (default 256 KiB). Treat that warning
  as the cue to turn this on.
- **Config:**

```ts
effects.register("summarize", createSummarizerEffect(provider));

agentLoop$(ctx, {
  definition,
  modelToolId: "model",
  compaction: { toolId: "summarize", afterBytes: 256 * 1024, keepRecent: 4 },
}, input);
```

- **Trade-off:** the summary is model-written and lossy. A fact the summarizer drops is gone from the prompt (the
  log and the archive still hold it). It costs one extra model call each time it fires, and it can defeat prompt
  caching, as above. Keep the summarizer's `maxTokens` well below `afterBytes / 2`, or compaction re-fires on the
  next turn.

## Bound a conversation's history: the token budget

- **Bounds:** which past turns of a conversation enter a run. `fitToWindow` keeps the newest whole turns that fit
  the model's context window beside the system prompt, the rolling summary and the new message; older turns
  leave the prompt but stay in `history` ([ADR 0122](adr/0122-conversation-layer-streaming-transport-and-token-budgeting.md), D5).
- **Use it when:** you run `@loomwork/conversation` and a conversation can outlive the context window.
- **Config:** `conversation$({ budget: { contextWindow, summarizerToolId?, maxSummaryTokens? }, rotateEveryTurns? })`.
  With `summarizerToolId` the evicted turns fold into a rolling summary through the same `{ messages } -> { summary }`
  contract as compaction, so one `createSummarizerEffect` serves both. `rotateEveryTurns` (default 100) continues
  the conversation as a new execution, carrying the summary and the window, so one execution's log stays bounded.
- **Trade-off:** it decides per turn what the model forgets. Without `summarizerToolId` the evicted turns are
  simply gone from the prompt. The budget and `agent.compaction` answer different questions (which turns enter a
  run, and how a run's own transcript grows) and compose. The rolling summary has the same prompt-caching cost as
  compaction.

## Keep big tool results out of the transcript: claim-check and lean log

- **Bounds:** the bytes of each tool result. `execution.claimCheck` offloads a named tool's result over
  `inlineCapBytes` (default 1 KiB of JSON) to a content store and journals an envelope with a short digest
  instead ([ADR 0140](adr/0140-agent-claim-check-opt-in.md)). `toolCallLog: "lean"` stops the loop's returned
  `toolCallLog` from repeating every result a second time in the finished state
  ([ADR 0142](adr/0142-agent-lean-tool-call-log.md)).
- **Use it when:** tools return bulk output (exports, query dumps, file contents) the model does not need in full.
  Lean log suits any long run; it changes the shape of the output only.
- **Config:**

```ts
const config = defineConfig({
  execution: { claimCheck: { store: contentStore, toolIds: ["export_report"] } },
});

agentLoop$(ctx, { definition, modelToolId: "model", toolCallLog: "lean" }, input);
```

- **Trade-off:** the model sees the envelope and digest, never the offloaded bytes, so list only tools whose
  output it does not need to read. Claim-check bounds one result's bytes, not the transcript re-sent each turn;
  that is compaction. Lean log shrinks the stored state and the returned value, not the prompt: a reader that
  wants a tool's output resolves its `stepId`. Both are about log and state size more than prompt tokens; claim-check
  reduces prompt tokens only because the offloaded result is no longer in the transcript.

## Bound what memory puts in the prompt

- **Bounds:** the entries recalled into each run's prompt. `agentLoop$` recalls from `memory` (tier
  `memoryTier`, scope `memoryScope`) and by default puts ALL of them in the prompt, so a long-lived scope turns
  conversation length into a hard wall.
- **`recallLimit`:** `recallLimit: 20` keeps only the newest 20 entries. It is the cheapest lever and a blunt
  one: it drops the OLDEST entries, including old facts that are still true.
- **`recallRelevant`:** `TieredMemory.recallRelevant(tier, scope, query, { decide, limit })` returns the entries
  most relevant to a query rather than the newest, recorded as a decision so a replay sees the same set. It needs
  a searchable tier (a semantic `MemoryStore`; see [ADR 0090](adr/0090-knowledge-is-retrieval-over-memory.md)). Use it from your own
  code when the prompt should carry only what matches the question; `agentLoop$`'s own recall is newest-first.
- **Distilled write-back ([ADR 0149](adr/0149-distilled-memory-writeback.md); the `distill` field lands in a
  sibling PR to this page, so it is not yet in the published packages):** by default write-back stores the raw
  prompt and answer, so recall grows by two entries per run and a changed fact sits beside the one it replaced.
  With `writeBack.distill` the loop instead asks a model for short facts and the ids of existing facts they
  replace, and stores only those, so recall stays about the size of what is known.

```text
effects.register("distill", createDistillerEffect(provider));

agentLoop$(ctx, {
  definition,
  modelToolId: "model",
  memory,
  recallLimit: 50,
  writeBack: { toolId: "memory-write", distill: { toolId: "distill" } },
}, input);
```

  This block is not a `ts` block because `writeBack.distill` is not in the built types until that PR lands.
  `createDistillerEffect(provider, { instruction?, maxTokens? })` is the built-in distiller; it needs a model call
  per run.
- **Trade-off:** distilling pays one model call per run to save tokens on every later recall, so it wins for a
  scope that is recalled many times. The model decides what is worth remembering and may omit something you
  wanted; the full transcript stays in the execution log for audit. Distilled facts derived from tainted
  input are stored tainted and recalled fenced, like any tainted entry.

## Choosing

| Symptom | Reach for |
|---|---|
| One run gets slow and costly past a few dozen turns | `compaction` |
| A conversation outgrows the context window | `budget` with `summarizerToolId` |
| A tool returns bulk output the model barely reads | `execution.claimCheck` |
| The finished state is large, the prompt is fine | `toolCallLog: "lean"` |
| The prompt carries a long, repetitive memory | `recallLimit`, then `writeBack.distill` |

Turn on one at a time and measure each against the baseline. Stacking them without measuring hides which one is
paying and which one is only costing a model call.
