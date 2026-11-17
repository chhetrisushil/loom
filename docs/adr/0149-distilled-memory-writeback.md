# ADR 0149 — Distilled memory write-back: facts, consolidated against what the scope already holds

- Status: **Proposed** (2026-11-18)
- Date: 2026-11-18
- Builds on: [ADR 0121](0121-one-canonical-agent-loop.md) (R10 `writeBack`), [ADR 0137](0137-agent-state-growth-warning-and-builtin-summarizer.md)
  (a built-in model effect the caller supplies the model for), [ADR 0122](0122-conversation-layer-streaming-transport-and-token-budgeting.md)
  (the conversation layer passes `agent.writeBack` through per turn; the degrade-on-failure amendment),
  [ADR 0085](0085-untrusted-content-integrity-axis.md) (taint), [ADR 0083](0083-second-consumer-rule.md) (second consumer).
- Placement: **1P, `@loomwork/agent` only.** Kernel, KERNEL_ABI, EVENT_SCHEMA and every SPI (MemoryStore
  included) unchanged. No new event. Opt-in: an app that does not set `writeBack.distill` sees no change.

## Context

`agentLoop$`'s `writeBack` (R10) stores each finished run's prompt and final answer, verbatim, as a `user` and
an `assistant` entry in the recall tier and scope. The next run recalls them. That is a transcript, not a
memory: recall grows by two raw entries per run, the same fact restated across runs is stored every time, and a
fact that changed ("the tenant moved to the Pro plan") is kept beside the one it replaced. `recallLimit` bounds
the prompt by dropping the OLDEST entries, which drops the old facts that are still true along with the stale
ones.

Hosted memory services (Vertex AI Memory Bank is the one that prompted this) do two things instead: they
**extract** short facts from a session with a model, and they **consolidate** them against what is already
stored (a new fact that restates or contradicts an old one replaces it). Both are model calls over the run's
content, i.e. ordinary effects. Nothing about them needs a particular vendor or a new store capability, so loom
can offer them over every `MemoryStore` backend.

## Decisions

**D1 — opt-in shape.** `writeBack.distill: { toolId: string; maxExisting?: number; maxFacts?: number;
maxFactChars?: number }`. Everything else about `writeBack` is unchanged: the write still goes through
`writeBack.toolId` (or `unless` / `allowDirect`), the `unless` verdict is still recorded, and an interrupted or
failed run still writes nothing. With `distill` set, the run writes **facts only**: the raw prompt / answer
entries are not written (the full transcript is in the execution log for audit). `requireEffectRing` applies to
the distiller exactly as to the write: `distill.toolId` is always an effect id.

**D2 — the distiller contract.** One effect, `{ prompt, answer, existing } -> { add, supersede }`:
- `prompt`, `answer`: the run's prompt and final answer, with the provenance they had in the run (a prompt with
  `promptOrigin` arrives tainted, an answer from a run that saw taint arrives tainted).
- `existing: { id, content }[]`: the facts already in the target tier and scope, at most `maxExisting`
  (default 200), newest kept. Read through a recorded `ctx.decide` (`<loop>#writeback:existing`), for the same
  reason recall is: a store that changed between the run and a replay must not change what the distiller saw.
- `add: string[]`: new facts, each one short self-contained statement.
- `supersede: string[]`: ids from `existing` that the new facts restate or contradict.

The call is a journaled `ctx.execute` (`<loop>#writeback:distill`): it runs inside the capability ring (grant,
metering, quotas, kill switch, `guardRequest`) and a replay serves the recorded output with no model call.

**D3 — the model's output is validated before it touches memory.** The distiller is a model; its output is
data, not authority.
- A `supersede` id not in the `existing` set handed to it is dropped. A distiller cannot delete an entry it was
  not shown (an injected "forget everything" can at most supersede the facts in `existing`, and only by naming
  them).
- `add` entries that are not non-empty strings are dropped; each is cut to `maxFactChars` (default 1000); at most
  `maxFacts` (default 16) are kept. Anything dropped or cut is reported once through `onWarn`.
- A fact's id is `fact:<fnv1a64(text)>` within the scope, so the same fact distilled twice (by two runs, or by a
  resume) is one entry: the write `forget`s the superseded ids and the new ids, then `remember`s the new facts.
  The write is idempotent under re-run, as R10's is.
- Facts are stored with `role: "fact"`. Recall places a plain fact in a `user` message prefixed
  `Remembered fact: `; a tainted one in a fenced `user` message, as any tainted entry.

`WriteBackRequest` gains an optional `forget: string[]`; `memoryWriteBackEffect` forgets those ids first. An
existing registration of `memoryWriteBackEffect` handles both shapes; a request without `forget` behaves as
before.

**D4 — provenance.** A fact is stored `tainted(text, origin)` when ANY input the distiller was shown was
tainted: the prompt (`promptOrigin`), the run (`sawTaintFrom`, which already includes tainted recalled entries),
or an `existing` fact. The origin is the first one seen, as for R10's answer. Otherwise it is stored plain, as
R10's answer is. Through the conversation layer the prompt is the end user's words (`promptOrigin` set), so
every fact a conversation distills is tainted and recalled fenced; that is the intended result, and the same
treatment its rolling summary gets.

**D5 — a failing distiller degrades.** The answer has already been produced; memory is a by-product. A distill
step that fails with anything but control flow (park, authority / safety stop, cancel, divergence) writes
NOTHING, warns once through `onWarn`, and the run completes with its answer. The outcome is a recorded decision
(`<loop>#writeback:distill:outcome`), so a resume reaches the same verdict, the pattern of ADR 0122's
2026-11-03 amendment. An authorization DENIAL of the distill effect also degrades (it is classified `denied`, not
terminal, the same rule the conversation summarizer applies): memory fails closed, nothing is written, and the
warning names the denial. Quota and rate-limit
exhaustion degrade the same way (`classifyModelCallFailure`'s `quota` / `rate-limited`). Only control flow that
the classifier calls `terminal` (cancel, park, safety stop, divergence) ends the run. It never falls back to writing the raw entries: that would mix transcript entries into a
facts-only tier.

**D6 — a built-in distiller.** `createDistillerEffect(provider, { instruction?, maxTokens? })`, beside
`createSummarizerEffect`: an ordinary `createLlmEffect` that puts the prompt, the answer and the existing facts
(with their ids) in a tainted USER message, never the system prompt, asks for JSON `{ add, supersede }`, and
throws `DistillerOutputError` on output that does not parse to that shape (which D5 turns into a skipped write).
The caller supplies the model and registers it under a name of their choosing.

**D7 — second consumer.** `conversation$` already passes `agent.writeBack` to every turn's `agentLoop$`, with
the scope set per asker in shared mode (`shared.memoryScope(asker)`). So the conversation layer distills per
turn with no change of its own, into the asker's scope. That and the stand-alone `agentLoop$` are two unrelated
consumers of one contract.

## Rejected / not here

- **Distillation as the default write-back.** Opt-in, like compaction (ADR 0137).
- **Keeping the raw entries beside the facts** (in the same tier or a separate `rawTier`). The log already holds
  the transcript; a second copy in memory is what this change removes.
- **Append-only facts** (no `existing`, no `supersede`): stale and contradicting facts accumulate, and recall
  grows without bound, which is the problem being solved.
- **Relevance-ranked `existing`** (`recallRelevant` with the prompt as query) instead of newest-first: worth it
  for a scope with thousands of facts, but needs a searchable tier. Left for a later amendment; `maxExisting`
  bounds the cost meanwhile.
- **A Vertex AI Memory Bank backend.** A vendor adapter is a 3P plugin implementing `MemoryStore`, built when a
  consumer runs on Vertex. Memory Bank also extracts server-side and asynchronously, which `MemoryStore`'s
  read-after-append contract does not describe; that needs its own evaluation.

## Consequences

Additive public API on `@loomwork/agent`: `AgentLoopWriteBackFields.distill`, `AgentLoopDistill`,
`createDistillerEffect`, `DEFAULT_DISTILLER_INSTRUCTION`, `DistillerOutputError`, `DISTILLER_INPUT_ORIGIN`.
The distill-on cost is one extra model call per finished run, plus one recorded read of the scope. What it buys
is a recall that stays roughly the size of the facts the scope actually holds, instead of growing by two raw
entries every run. The implementing change must show this with a deterministic test that counts recalled
entries and bytes over many runs, with distillation on and off. The "80% fewer tokens" claim from the video is
not adopted: the saving depends on the baseline and the workload.
