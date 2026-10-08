# ADR 0121 — One canonical agent loop

- Status: **Accepted** (on merge)
- Date: 2026-10-08
- Closes: R10 (agentic-readiness audit, findings H3, H4, H8 and recommendation 4)
- Builds on: [ADR 0087](0087-durable-agent-loop.md) (the loop as a runner body), [ADR 0112](0112-structured-concurrency.md)
  (`ctx.parallel` scopes), [ADR 0113](0113-body-aware-code-fingerprint-and-dynamic-id-migration.md) (replay-divergence
  detection), [ADR 0120](0120-llm-content-parts-and-tool-threading.md) (tool_use / tool_result threading, the compaction
  virtual measure), R4 (tool menus; an authority denial is terminal), R9 (`reasoningToolId`, `requireEffectRing`), R13
  ([ADR 0117](0117-approvals-bound-to-what-the-approver-saw.md), bound approvals).
- Placement: **1P, `@loom/agent` only.** Not a kernel change: no syscall, no event kind, no payload field.
  `KERNEL_ABI`, `EVENT_SCHEMA` and every SPI are unchanged. Every new behaviour is built from `ctx.execute`, `ctx.decide`,
  `ctx.parallel` and `ctx.suspend` as they exist.

## Context

`@loom/agent` shipped three ways to run the same ReAct loop:

1. `AgentRunner` — a class; the whole loop in ONE step handler (or an effect via `asEffect()`), `emit` and nothing else.
2. `agentStep$` — a wrapper around (1) as a `step$`.
3. `agentLoop$` — a runner-body function; one durable frame per turn, the real `ctx.decide` / `ctx.suspend`, compaction,
   approval.

ADR 0087 declared (3) the better design; the audit measured that it was also the weaker agent. Each finding re-measured
against `main` at `d3fe58b3`:

| Finding | State before this change | Here |
| --- | --- | --- |
| **H8a** a failing tool fails the run (`ctx.execute` not in a `try`); `AgentRunner` feeds `{ error }` back | **still true** | fixed (D1) |
| **H8b** tool calls strictly sequential; `AgentRunner` has `parallelTools` | **still true** | fixed (D2) |
| **H8c** `agentLoop$` never writes memory (`recall` only) | **still true** | fixed (D4) |
| abort / partial capture: `agentLoop$` has no `signal` handling; `AgentRunner` has `AGENT_INTERRUPTED` | **still true** | fixed (D3) |
| **H4** `reasoning` model call not journaled, so a resume re-calls the model | **partly fixed by R9**: `reasoningToolId` journals each call as a frame, but it is opt-in; the default (`reasoning` alone) still called the provider directly, un-journaled, and had no crash test | fixed for the default path (D5); crash/resume tests for both paths |
| **H3** no example consumer of `agentLoop$` | **still true** (every `loom-examples` agent uses `AgentRunner`) | in-repo end-to-end test here; the `loom-examples` example is a companion change (D8) |
| the "two routing paths inside (3)" footgun | R9 added the ring for `reasoning`; `modelToolId` vs `reasoning` remains a choice | documented; both paths now journal the response |

## Decision

**D1 — `agentLoop$` is THE canonical loop.** A failing tool is *feedback*: the failure becomes an `isError`
`tool_result` (`{ error }`, the shape `AgentRunner` always produced) and the run continues, so the model can retry,
reformulate or explain. `toolErrors: "fail"` restores the old behaviour (also in a parallel turn, where it is a fail-fast
scope). What is NOT a tool failure and is never fed back, in either mode: a park (`SuspendError`), an authority error
(`CapabilityDeniedError`, `EffectModeViolationError`, R4), a safety or budget stop (`SafetyViolationError` incl. the kill
switch, `QuotaExceededError`: not something the model can fix, and feeding it back lets it spin to `maxIterations`), a
cancellation (`ExecutionCancelledError`, a scope's abort, a closed decide scope), a replay divergence, and a
continuation. `isTerminalToolError` is that classification; the kernel's unexported control-flow errors are matched by
`name`, and `@loom/middleware`'s two classes the same way (it stays a dev-only dependency).

*Replay caveat, stated plainly.* An untyped failure is recorded as `STEP_FAILED` and the kernel re-runs a failed step
live on replay (at-least-once for a failed step). A resume that re-runs the body (for example after an approval) therefore
calls the failed tool again. A tool that must fail EXACTLY ONCE throws a `TypedFailure` on a channel declared in its
`errors`: that outcome is served from the log (ADR 0060). Journaling every failure through an extra `ctx.decide` was
rejected: it adds a decision per tool call to every log to avoid a duplicate call on a failure path, and it cannot be
consulted before the re-execution it is meant to prevent.

**D2 — Parallel tool calls: `parallelTools?: boolean | number`, default `false`.** One model turn's calls run through
`ctx.parallel` (`kernel.features.scopes` on: one cancellation scope; off: the pre-R6 bounded `Promise.all`; everything
else holds). Step ids are unchanged, `<loop>#turn:<i>:tool:<j>` with `j` the index in the recorded response, so the
identity rule holds and a log recorded serially resumes in parallel mode (and the reverse) with no divergence. Results are
fed back in the model's order whichever call finishes first. A branch that fails is that call's `isError` result, not the
scope's failure (D1). Approvals are gathered first, sequentially and in call order, before any call of the turn starts: a
turn parked on an approval has run none of its calls, and a resume re-asks the gates in the same order. A turn with one
runnable call runs it directly (no scope).

**D3 — Abort and deadlines.** `signal?: AbortSignal` stops THIS run without cancelling the execution (a barge-in, a host
shutting a turn down): checked before every model call and every tool call; once aborted nothing further is issued and the
run fails on `AGENT_INTERRUPTED` carrying `InterruptedAgentRun` (`content` of the interrupted generation when the provider
surfaces one, `iterations`, the completed `toolCallLog`), the same channel and payload `AgentRunner` uses (moved to
`interrupted.ts`, still exported from `AgentRunner`). A signal is not journaled: the interruption is live-only. A kernel
cancel needs no signal: `ctx.execute` stops at the next frame and aborts the effect in flight (K8); the two compose.
`turnTimeoutMs` / `toolTimeoutMs` set the frame's kernel `timeoutMs` (anchored to the first logged start, so a recovery
re-run resumes the countdown); on the direct `reasoning` path `turnTimeoutMs` aborts the provider request. A model call
that times out fails the run (nothing to continue with); a tool that times out is an `isError` result.

**D4 — Memory write-back: `writeBack?: boolean | { tier?, scope? }`, optional, requires `memory`.** On a normal finish the
loop remembers the prompt and the final answer as `user` / `assistant` entries in the tier and scope the next run recalls
from. The write is a side effect in a body that re-runs on resume, so it is idempotent: entry ids are deterministic
(execution, loop, a hash of the prompt / of prompt + answer) and an entry the scope already holds is skipped. A run that
is interrupted or fails writes nothing. The residual: a tier that summarizes may fold an entry's id away, costing one
repeated entry, never a lost one. Per-turn summaries were not added: `compaction` already owns summaries.

**D5 — The `reasoning` response is journaled on the default path (H4).** With `reasoning` and no `reasoningToolId`, each
routed call's RESPONSE is recorded as a decision, `<loop>#turn:<i>:response:<n>`, through the `invoke` seam
`ReasoningRuntime` already offers: the decider re-checks the route's declared modalities, resolves content, and calls the
route's provider. A replay serves the recorded answer: **zero provider calls for a completed turn**, and the
`#turn:<i>:tool:<j>` ids cannot move under the log because the answer that fixed them is the recorded one. The route and
elevation decisions stay where they were, so `@loom/learning` still evaluates them. This is still OUTSIDE the ring (no K2
authorization, metering, kill switch, in-doubt): `reasoningToolId` / `requireEffectRing` remain the way to get those, and the
one-time `LOOM_AGENT_RING` warning stays (its text now says the response is journaled). Making `reasoningToolId` mandatory
was rejected: it would fail every existing `reasoning` caller at start for a property (the ring) that is a separate axis
from replay safety.

**D6 — Consolidation: deprecate and document, do not delete.**

| API | Status | Use instead |
| --- | --- | --- |
| `agentLoop$` | **canonical** | n/a |
| `AgentRunner` | `@deprecated` (kept; no behaviour change) | `agentLoop$` in a runner body; an `AgentRunner` outside a flow (an effect with no `ExecutionContext`) has no replacement yet |
| `agentStep$` | `@deprecated` (kept) | `agentLoop$` |

Both keep working for as long as an in-flight execution or an example depends on them; removal needs a major and a
release note. Capability parity, so the table can be read as a migration checklist:

| Capability | `AgentRunner` / `agentStep$` | `agentLoop$` (after R10) |
| --- | --- | --- |
| Unit of recovery | the whole run (one frame) | one turn / one tool call |
| Tool failure | `{ error }` fed back | `{ error }` fed back (`toolErrors`) |
| Authority denial | terminal | terminal (plus safety / quota stops) |
| Parallel tools | `parallelTools` | `parallelTools` (`ctx.parallel`) |
| Abort + partial capture | `AGENT_INTERRUPTED` | `signal` + `AGENT_INTERRUPTED`; kernel cancel |
| Memory | `MemoryRuntime` read + append | `TieredMemory` recall (recorded) + `writeBack` |
| Mid-loop approval, compaction, recorded skills / routing | not possible | yes |
| Model call journaled | n/a (the whole run is one frame) | yes, both `modelToolId` and `reasoning` |
| Streaming deltas (`stream`, `onDelta`) | yes | via the model effect (`createAgentModelEffect({ stream })`) |
| Events `AGENT_TOOL_CALL`, `AGENT_COMPLETED`, `SKILLS_SELECTED` | emitted | not emitted: the frames and decisions are the record |

Migration: (1) register `createAgentModelEffect(provider)` under an id and pass it as `modelToolId` (or pass `reasoning`
+ `reasoningToolId`); (2) call `agentLoop$(ctx, { definition, … }, input)` from the flow's runner body; (3) replace
`memory: MemoryRuntime` + `definition.memoryId` with `memory: TieredMemory` and `writeBack: true`; (4) a consumer of
`AGENT_TOOL_CALL` reads `toolCallLog` from the output or the `#turn:<i>:tool:<j>` frames; (5) grant the flow the model and
tool effect ids in the authorizer (a loop in a runner body is authorized per frame).

*Why not make `AgentRunner` a thin wrapper now.* The honest wrapper is an `ExecutionContext` adapter over an
`EffectContext` (`execute` → `effectRuntime.execute`, `decide` → the hand-emitted decision, `parallel` → `parallelLimit`,
`suspend` → refused). It is buildable, but it would also have to keep `AGENT_TOOL_CALL` / `AGENT_COMPLETED` / `SKILLS_SELECTED`,
the streaming sink wiring (ADR 0119) and the one-frame semantics that the existing `AgentRunner` tests and every `loom-examples` agent pin,
and it changes nothing for a user who is moving to `agentLoop$` anyway. Deprecating first, with the parity table above,
costs no behaviour and lets the examples migrate; the wrapper is a follow-up if a consumer cannot move.

**D7 — In-flight compatibility: nothing about an existing log's shape changes.** Every new behaviour is shape-neutral or
opt-in:

- the default (`parallelTools` unset) is the original gate, run, gate, run order with the same frames;
- a tool that fails is the only new outcome in the default path, and no old log holds a caught failure (the old body
  failed the run on it);
- the response decision (D5) is appended only where the body asks for it; a log recorded before has none, so that turn
  re-asks the model once, exactly as it did before (not a new divergence), and every later turn is journaled;
- ids, the compaction virtual measure (ADR 0120) and the approval gate keys are untouched.

A loop-version marker in the first frame was considered and rejected: it would itself be a new decision in every old log,
and an old log cannot be told apart from a new run at that point without peeking at the log (no such API), so it would
choose "new" for exactly the runs that need "old". `compactionUpgrade.test.ts` still pins the R5 half; `agentLoopR10.test.ts`
embeds a FROZEN COPY of the pre-R10 loop (`agentLoopR9.fixture.ts`), records logs with it, and resumes them under the new
body with `divergence: "fail"`: mid-run crash with multi-call turns; the same log resumed with `parallelTools: true`; a run
parked on an approval gate by the old body and answered under the new one; a `reasoning` run recorded without response
decisions.

**D8 — The example (H3).** `agentLoopR10.test.ts` ends with a runnable end-to-end run (a routed model through the effect
ring, parallel lookups with a flaky tool, a destructive call parked on a human across a process restart, memory
write-back, one model call after the restart). The `loom-examples` repo is the right home for the user-facing version and
is listed as a companion change in the PR (name, what it shows); this repo does not edit it.

## Rejected

- **Deleting `AgentRunner` / `agentStep$`.** Unreleased-or-internal is the bar for removal and they are neither (every
  example uses them).
- **A loop-version marker.** See D7.
- **Journaling tool failures through `ctx.decide`.** See D1.
- **Mandatory `reasoningToolId`.** See D5.
- **A hard `signal` cut of an in-flight `ctx.execute`.** Racing the await would leave a step that completes after the body
  threw. The kernel cancel already aborts an in-flight effect; `signal` is checked at the boundaries.

## Tests

`packages/agent/src/agentLoopR10.test.ts`, each with its negative case: a failing tool is `isError` and the run goes on;
`toolErrors: "fail"` and an authority denial (serial and parallel) still fail the run with no second model call; the
parallel barrier no serial loop can pass, a `parallelTools` bound, a failing branch isolated, approvals before any call;
a fired signal issues no further model or tool call and carries out the work done, a kernel cancel stops at the next frame;
`turnTimeoutMs` / `toolTimeoutMs`; write-back (recalled by the next run, idempotent across a crash before completion, none
when interrupted, refused without `memory`); the `reasoning` crash / resume for the direct and ring paths asserting zero
provider calls for completed turns and identical step ids; and the old-body resumes of D7. Each guard was mutated (guard
removed, test red, restored) while writing them.
