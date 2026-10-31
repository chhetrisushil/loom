# ADR 0087 — The agent loop is a runner body, not a step handler

- Status: **Accepted — shipped** (`agentLoop$`, `createAgentModelEffect` in `@loom/agent`;
  `agentStep$` retained)
- Date: 2026-08-18
- Builds on: [ADR 0061](0061-step-identity-interpreter-guardrails.md) (step identity + the
  interpreter pattern), [ADR 0057](0057-multi-gate-suspend-passthrough.md) (multi-gate suspend),
  [ADR 0077](0077-typed-resume-payloads.md) (typed resume gates),
  [ADR 0085](0085-untrusted-content-integrity-axis.md) (prompt-boundary integrity),
  [ADR 0054](0054-claim-check-middleware.md) (claim check).
- Part of: the agent-runtime placement series (R1 in
  [the evaluation](../requirements/2026-08-18-agent-runtime-placement-evaluation.md)). **No kernel
  change: KERNEL_ABI stays 1.1.0, EVENT_SCHEMA stays 1.18.0, no new syscall and no new event kind.**

## Context

`@loom/agent` implemented the ReAct loop on the wrong side of two boundaries at once.

`agentStep$` wraps the entire loop in `step$({ handler: handler$(...) })`, and a handler receives
`StepHandlerContext` — `executionId`, `stepId`, `workflowId`, `attempt`, and `emit`. That is the
whole affordance. No `execute`, no `suspend`, no `decide`, no `stream`. Four consequences, each
independently expensive:

- **No per-turn durability.** Forty model calls and N tool calls are ONE frame. A crash at turn 39
  re-runs all 39, and `maxIterations` is the only bound that exists.
- **No mid-loop HITL.** The agent cannot suspend before a destructive tool call, so approval must be
  hoisted out of the agent entirely — precisely the design the feature exists to avoid.
- **No `ctx.decide` per turn.** `DECISION_RECORDED` was hand-emitted through `emit`: a fact in the
  log, but not served on replay and carrying no propensity, so an agent's routing choices were
  logged in a shape `@loom/learning` cannot evaluate.
- **No streaming.** `ctx.stream` exists and the handler cannot reach it.

The kernel's entire agent-relevant surface was present and unreachable from the agent. Nothing was
missing from the kernel; the loop was simply on the wrong side of it.

## Decision

### D1 — `agentLoop$(ctx, config, input)` is an ordinary function over `ExecutionContext`

Called FROM a runner body, issuing `ctx.execute` per turn. Not a step, not a builder, not a new
seam — the same construct the blueprint walker and the runbook walkers already are.

`agentStep$` **stays**, and is not deprecated. It is the cheap opaque form: one frame instead of 2N,
for an agent that wants none of the above. Adopters choose the cost.

### D2 — Identity: `#turn:<i>` and `#turn:<i>:tool:<j>`

[ADR 0061](0061-step-identity-interpreter-guardrails.md) D1 requires the sequence of ids an
execution produces to be a pure function of logged inputs. Both indices satisfy it: the turn index
from the number of completed turns, the tool index from the model response — which is itself a
recorded task output. So a recovery re-run re-derives exactly the same id sequence, and every
completed task is served from the log instead of re-invoked.

The proof is the same crash matrix ADR 0061 licensed: `agentLoopCrash.test.ts` builds the durable
prefix of a run that died mid-loop, recovers onto fresh effect instances, and asserts the recovered
process makes only the REMAINING model and tool calls.

### D3 — The model call resolves through the `EffectRuntime`, by `modelToolId`

This is what puts the most expensive and least reliable call an agent makes inside the protection
ring: K2 authorization, metering and quotas, retry, `idempotencyKey`, K9 in-doubt — and
`guardRequest`, which `createLlmEffect` runs unconditionally.

It also closes the half of R2 the direct-guard fix could not reach. `AgentRunner` now guards its
prompt boundary but still calls the provider directly; a loop that resolves the model through an
effect id gets the whole ring, not just the integrity check.

### D4 — Approval is a gate before the effect, and a refusal is data

`needsApproval(toolCall, turn)` returning `true` (originally `requireApproval` returning `false`; see the ADR 0121 amendment) suspends on a gate (default
`AgentToolApproval`) BEFORE the effect runs — the point of asking. A resume carrying
`{ approved: false }` feeds a refusal back to the model as a tool result rather than throwing: a
human declining is information the agent can settle on, not an error. Pair the gate with
`flow$({ resumeSchemas })` ([ADR 0077](0077-typed-resume-payloads.md)) to parse the payload.

### D5 — The log-growth trade-off is real, and the answers already exist

Per-turn durability journals each turn's message array, so the log grows with conversation length.
That is a genuine cost and it is not free. It has two halves and both already ship:

- **bytes per turn** — claim-check middleware ([ADR 0054](0054-claim-check-middleware.md)) plus the
  `ContentStore` seam: lossless, by reference;
- **turns per conversation** — `TieredMemory`'s `summarizeAfter` and its injectable `Summarizer`:
  lossy, by summarization.

Neither is invented here. The second is wired into the loop as a RECORDED task — see D6.

### D6 — What the first cut deliberately did NOT do (all since landed)

The three items below were held back from the initial implementation because a partial version of
each would have read as coverage. All three shipped in the follow-on (2026-08-18), and the reason
each was deferred turned out to shape its design — recorded here because that is the useful part:

- **Skill selection** now runs through `ctx.decide`, so replay serves the set that ran. This closes
  a hole `llmSkillSelector` documented against itself ("the LLM decision is not recorded"): an
  unrecorded selection means a replayed run can rebuild a *different prompt* than the one whose
  answer is in the log.
- **Memory recall** likewise, via `TieredMemory.recall({ decide })` and bounded by `recallLimit` —
  the fix for the "unbounded recall" cost, where conversation length was a hard wall rather than a
  cost curve.
- **The per-turn summarize pass** runs through `ctx.execute` against a `compaction.toolId`, which is
  precisely why it was deferred: a summary is lossy and nondeterministic, so computing it in the
  loop body would make the reconstructed transcript depend on *when* you replayed. As a recorded
  task it is journaled once and served from the log. A test asserts the `:compact` frame exists;
  replacing the recorded task with an inline computation fails it.

- **Reasoning-runtime routing** now passes the real `ctx.decide` into `reason()`, so the route and
  every elevation are decisions replay serves. `AgentRunner` fakes the seam — it hand-emits
  `DECISION_RECORDED` through `emit`, which records the route as a fact but cannot have it served,
  so a re-run re-routes. A test proves the difference: swap the real seam for the hand-emitted one
  and a replay takes `strong` where the log says `cheap`.

  The trade-off is stated rather than hidden: on the routed path the model call is made by the
  Reasoning Runtime's own routes, so `guardRequest` still runs but K2, metering and K9 in-doubt do
  not apply to it. `modelToolId` gets the full ring and no routing. They are alternatives, and one
  of the two is required — an absent model access is refused up front rather than running zero
  turns and returning an empty answer.

### D7 — Streaming granularity is the author's choice, and now an easy one

`chunkDeltas(emit, { minChars })` batches provider deltas to a semantic boundary before handing
them on. The advice in `docs/usage.md` — chunk at a sentence, not a token — was advice until
something made it easy to follow, and it matters because a sink is not always transient:
`ctx.stream` appends a durable event per call, so a token-granular stream through it is the same
fold economics ST-R rejected, arriving through the sanctioned door. Wrapping the sink turns the
delta count from a property of the provider's tokenizer into a decision.

Transient sinks (`@loom/live-query`, `progressHub`) do not need it — there, per-token is free.

## Consequences

- An agent's turns are individually durable, individually retryable, individually visible in the
  log, and individually authorized. A crash costs one turn.
- Approval, streaming and per-turn decisions become reachable for the first time — R1 was the
  precondition for all three, which is why it is the largest item and the last of the small ones.
  All three are now USED, not merely reachable: skills and recall through `ctx.decide`, compaction
  through `ctx.execute`, granularity through `chunkDeltas`.
- The log grows with conversation length for adopters who opt in. Documented, with the two existing
  mitigations named; `agentStep$` remains for those who want neither.
- `@loom/agent` gains a dependency on `@loom/workflow-runtime` for `ExecutionContext` — the same
  edge `@loom/orchestration` already has, and for the same reason: a runner-body construct needs the
  runner's context type.

## Verification

- `agentLoopCrash.test.ts` — the loop runs to an answer; each turn is its own journaled task with
  identity-rule ids; recovery after a mid-loop crash re-runs ONLY the unfinished turn.
- `agentLoopApproval.test.ts` — the gate parks before the effect (nothing destructive has run while
  a human decides), an approval runs it, a refusal reaches the model and the run settles.
- `agentLoopChoices.test.ts` — a DRIFTING selector (different answer on the second call) proves the
  point: without the seam a replay rebuilds a prompt without the skill; with it, the recorded set is
  served. Plus recall bounded by `recallLimit`, and a G2 control where neither is configured.
- `agentLoopCompaction.test.ts` — the transcript folds once the threshold is crossed and stops
  tracking conversation length; the summary is its own `:compact` frame; an un-configured loop still
  grows (the behaviour being bounded). Plus a byte-based trigger (below), the constructor guard, and
  `chunkDeltas` boundary, `minChars` and flush behaviour.

## Amendment (2026-09-27) — D5 corrected: claim-check does not bound the growing quantity; a byte-based compaction trigger

A 2026-09-27 backlog audit (Part L item 7) found D5's "bytes per turn" half wrong for the quantity
that actually grows, and a second, undocumented surprise for adopters who *do* use claim-check on an
agent's tools.

**How the log actually grows.** Every turn is `ctx.execute(..., { messages, tools, system })`, and
the kernel journals the whole call as its `STEP_STARTED` `input` (`WorkflowContext.ts:163`,
`emit("STEP_STARTED", { stepId, input })`). Turn *k* therefore records the whole *k*-message
transcript, so **uncompacted log bytes are O(n²) in turn count** (Σk·|messages|). `afterMessages`
compaction bounds this to O(n) by capping each turn's input at `keepRecent + 1` messages — that part
was always correct.

**What D5 got wrong: claim-check bounds a different quantity.** `claimCheckMiddleware` offloads a
tool's RESULT — the value an effect returns — not the transcript an agent re-sends on every
subsequent turn (`packages/middleware/src/claimCheck.ts:139`, `(ctx, _input, next)`: input is
ignored). D5 named it as the "bytes per turn" answer; it is not. One oversized tool result still
rides along, uncompacted, in every later turn's journaled `STEP_STARTED` input until it ages past
`keepRecent` on message COUNT alone — `afterMessages` never looked at bytes.

**The claim-check contract toward the model: documented, not a resolve hook.** The envelope IS the
recorded and returned value (ADR 0054); `toolResultContent` (`packages/agent/src/toolResultContent.ts`)
JSON-stringifies it as-is, so a claim-checked tool's result reaches the model as
`{"tool":…,"result":{"__loomClaimCheck":true,"ref":…,"digest":…}}` plus whatever the middleware's
`digests[toolId]` projected — a reference and a digest, not the resolved body. This is correct for
replay (resolving the envelope's bytes into the transcript would put them into the NEXT turn's
journaled `STEP_STARTED` input, undoing the very offload claim-check exists for) and is now the
supported, documented shape: **declare a `digests[toolId]` projection for every tool a claim-checking
agent calls**, so the model sees something legible instead of a bare hash. An `AgentLoopConfig`
`resolveToolResult` hook was considered and rejected — it would resolve the envelope back into the
model-facing message, which is exactly the growth this amendment bounds, and it duplicates what a
digest already does at the point the envelope is produced.

**The fix: `compaction.afterBytes`, alongside the original `afterMessages`.** `agentLoop$` maintains
a running UTF-8 byte count of the transcript, updated at every message push (O(1) amortized per
message, never a re-serialization of the array — see `messageBytes` in `agentLoop$.ts`), and folds
once either threshold is crossed. The byte trigger has its own kept-suffix rule, distinct from
`afterMessages`'s fixed `keepRecent` count: the longest run of the newest messages whose bytes total
at most `afterBytes / 2`, floored at 1 (the newest message always reaches the model) and capped at
`keepRecent`. If that suffix already covers the whole transcript — one message alone is over the
threshold — compaction is skipped for that turn rather than paying a summary call that folds
nothing. At least one of `afterMessages` / `afterBytes` is required; the constructor throws if
neither is set.

The trigger is a pure function of already-journaled message content (never wall-clock, never
anything outside the recorded turn history), so it recomputes identically on replay: a recovered
execution decides to compact, and folds the same messages, at the same point a live run would have.

**The lossless option, for adopters who need it, is not built here.** `ContentResolvingEventStore`
(ADR 0046) already externalizes by reference — `externalize: { STEP_STARTED: ["input.messages"] }`
keeps the journaled input a pointer instead of inline bytes. That is the lossless answer to O(n²)
growth; compaction is the lossy one. It is safe under the content sweep only *after* L5a (the sweep
must not reclaim a still-referenced external input as TTL-eligible). Journaling `STEP_STARTED` input
by reference or delta as a KERNEL default was considered and rejected: it is a kernel change to serve
one consumer (bias against the kernel, ADR 0083).

Verified by `agentLoopCompaction.test.ts`: an oversized tool result crosses `afterBytes` with
`afterMessages` unmet; neither threshold crossed compacts nothing (negative); a single message alone
over `afterBytes` skips rather than summarizing every turn; replaying a crashed-and-recovered run
recomputes the identical `:compact` step payload; the constructor guard fires on a compaction block
with neither threshold set and does not reject `afterBytes` alone.

## Amendment (2026-10-31) — the quadratic is measured; compaction stays opt-in, now with a warning and a built-in summarizer

Issue #721 measured the D5 growth on a scaled offline harness: an uncompacted loop's folded state is
O(turns^2) (3.5 MB of folded state at 50 turns, 54.9 MB at 200, `RangeError: Invalid string length`
serializing it by 650 turns; re-measured with a cloning store, the first figures were ~2x high), 97-99.9% of it the journaled per-turn model input. The owner ruled compaction stays OPT-IN. What
changed is discoverability and cost of opting in ([ADR 0137](0137-agent-state-growth-warning-and-builtin-summarizer.md)):
`agentLoop$` warns once per run when an uncompacted transcript crosses `warnTranscriptBytes` (default 256 KiB;
`false` disables), and `createSummarizerEffect(provider)` is a ready-made `compaction.toolId`. See
`docs/scaling.md`, "Agent state growth".

## Amendment (2026-10-31) — claim-check for agent tools is now a one-line opt-in, with a default digest

The 2026-09-27 amendment's "declare a `digests[toolId]` projection for every tool a claim-checking agent calls"
stands, and is now easier to follow: [ADR 0140](0140-agent-claim-check-opt-in.md) adds
`defineConfig({ execution: { claimCheck: { store, toolIds } } })`. A tool WITHOUT a declared digest gets a
default `{ preview }` digest (the first 256 characters of its result's JSON, never for tainted content;
`preview: false` for a bare ref), so the model sees something legible by default. The contract toward the model
is unchanged: the recorded envelope, never the resolved bytes. Off unless set.

Review round (2026-10-31): opting in changes what the model can read. An offloaded tool's result is WITHHELD from
the model except its digest/preview (`{ preview, truncated: true }`), so list only tools whose output the model
does not need in full; a tainted result is fenced as a tainted envelope; and a model or compaction result that
comes back as an envelope is an error naming `execution.claimCheck.toolIds`.
