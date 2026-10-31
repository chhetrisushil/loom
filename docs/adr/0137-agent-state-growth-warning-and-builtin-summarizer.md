# ADR 0137 — Agent state growth: an opt-in warning and a built-in compaction summarizer

- Status: **Proposed** (2026-10-31) — implemented in the PR that carries it; accepted on merge
- Date: 2026-10-31
- Found by: GitHub issue #721 (measurement and plan). Owner ruling: `agentLoop$` compaction stays
  OPT-IN; there is NO default behaviour change.
- Builds on: [ADR 0087](0087-durable-agent-loop.md) D5 (compaction as a recorded task),
  [ADR 0122](0122-conversation-layer-streaming-transport-and-token-budgeting.md) (the conversation layer's rolling summary),
  [ADR 0083](0083-second-consumer-rule.md) (the second-consumer rule).
- Placement: **1P, `@loom/agent` only.** Kernel, KERNEL_ABI, EVENT_SCHEMA and every SPI unchanged. No new
  event, no new log field.

## Context

An `agentLoop$` without `compaction` journals each turn's whole model input (the transcript is re-sent every
turn), so its folded state grows O(turns^2) and resume reads it all. The #721 offline harness (re-measured with a
cloning store; the first table was ~2x high, see issue #722) measured 3.5 MB of folded state at 50 turns,
54.9 MB at 200, 279 MB at 450, and a `RangeError: Invalid string length` serializing it by 650
(table and caveats in `docs/scaling.md`, "Agent state growth"). `compaction: { toolId, afterBytes }` already
bounds it, but nothing says you need it, and opting in means writing a summarizer effect.

## Decisions

**D1 - warn, never act.** With no `compaction`, when the loop's running transcript byte count (the counter
`afterBytes` already reads; not re-serialized) exceeds `warnTranscriptBytes`, the loop emits ONE warning per
run through the existing seam (`AgentLoopConfig.onWarn`, else the app's `observability.onWarn` via
`configureAgentLoopDefaults`, else a process warning `LOOM_AGENT_STATE_GROWTH`; a throwing sink never fails
the run). It names the fix and `docs/scaling.md`. Default threshold `DEFAULT_STATE_GROWTH_WARN_BYTES` =
256 KiB (~64k tokens): in the harness that is turn ~107 and ~16 MB of folded state, early enough to act on
(compacting there is cheap, and a 128 KiB default would warn at turn ~52 and 3-4 MB, noisier for ordinary
agents); the issue's 1 MB example is turn ~450 and ~280 MB, past a Postgres JSONB value's 255 MB cap. `warnTranscriptBytes: false` turns it off. The trigger
is a pure function of journaled content; nothing is written to the log; a resume in a fresh process replays
the crossing turn from the log and warns again (once). The log and the model's requests are byte-identical
with and without the warning (tested).

**D2 - a built-in summarizer, model supplied by the caller.** `createSummarizerEffect(provider, { instruction?,
maxTokens? })` returns an ordinary `createLlmEffect`: `{ messages } -> { summary }`, the contract of both
`compaction.toolId` and `@loom/conversation`'s `budget.summarizerToolId`. The user registers it under a name
of their choosing (`effects.register("summarize", createSummarizerEffect(provider))`, or passes a route's
provider), so it runs inside the capability ring (grant, metering, quotas, `guardRequest`) like the agent's own
model call, and `ctx.execute` records it once and serves it from the log on replay with no model call. It is
opt-in by being named in `compaction.toolId`; nothing registers it implicitly. The transcript is flattened
with `summarizerText` and re-wrapped `tainted(..., "agent:summarizer-input")` in a USER message, never the
system prompt. `maxTokens` defaults to 1024 (~4 KiB): a summary larger than `afterBytes` is re-summarized on
the next turn (the skip rule only covers a single oversize newest message), one summarizer call per turn until
it fits, so keep it well under `afterBytes / 2`. An empty or whitespace summary throws `SummarizerEmptyError`
(the summary replaces the folded transcript and is journaled permanently, so the step fails visibly instead).

**D3 - reuse.** The conversation layer had no built-in summarizer (its `summarizerToolId` is also
user-written), but it owned `summarizerText`, the bounded taint-unwrapping walker both contracts need. It moved
to `@loom/agent` (`@loom/conversation` depends on `@loom/agent`, not the reverse) and `@loom/conversation`
re-exports it unchanged. The summarizer is not conversation-specific.

**D4 - second consumer (ADR 0083).** Two unrelated consumers of the same `{ messages } -> { summary }`
effect: `agentLoop$` `compaction.toolId` and the conversation layer's `budget.summarizerToolId` (one
registered effect serves both, as `summarizerText`'s documentation already said).

## Rejected / not here

- Compaction as the `agentLoop$` default (owner ruling: opt-in).
- Dropping completed turns' inputs from folded `frames` (issue #721 item 4): a kernel change needing its own
  root-cause read, ADR and EVENT_SCHEMA check; not in this change.

## Consequences

Additive public API on `@loom/agent`: `AgentLoopConfig.warnTranscriptBytes`, `DEFAULT_STATE_GROWTH_WARN_BYTES`,
`createSummarizerEffect`, `DEFAULT_SUMMARIZER_INSTRUCTION`, `SUMMARIZER_INPUT_ORIGIN`, and (moved)
`summarizerText` / `SUMMARIZER_TEXT_TRUNCATED`. An existing uncompacted loop that crosses 256 KiB now logs
one warning; set `warnTranscriptBytes: false` to silence it.

## Amendment (2026-10-31) — the warning also names claim-check

[ADR 0140](0140-agent-claim-check-opt-in.md) adds the opt-in `execution.claimCheck`, and the warning text now
names it beside `compaction` (tool outputs are about 80% of the state). Still report-only, still one warning
per run, still fires with claim-check on (compaction is what bounds the transcript).

Review round (2026-10-31): the warning text also says the opt-in WITHHOLDS an offloaded tool's result from the
model except its digest/preview, so only tools whose output the model does not need in full should be listed.
