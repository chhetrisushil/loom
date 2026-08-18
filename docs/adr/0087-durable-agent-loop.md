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

`requireApproval(toolCall, turn)` returning `false` suspends on a gate (default
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

Neither is invented here. The second is **not yet wired into the loop** — see D6.

### D6 — What this deliberately does NOT do

- **Skill selection.** `SkillRegistry` selection is a per-turn *choice*; doing it correctly means
  `ctx.decide`, so replay serves the same set. Half-wiring it (selecting live, unrecorded) would
  reintroduce exactly the unevaluable-log problem this ADR exists to fix. Left out until it can be
  done through the decision seam.
- **The per-turn summarize pass.** D5's second half belongs in the loop body, but it is a separate
  behaviour with its own failure modes (a lossy, nondeterministic summary must be journaled through
  `ctx.execute` to be replay-safe). Deferred rather than approximated.
- **Reasoning-runtime routing.** `AgentRunner`'s `reasoning` path stays where it is. Routing through
  `ctx.decide` from the loop is the right shape and is a follow-up.

Each of these is a place where a partial implementation would read as coverage. They are named here
so the absence is a recorded decision rather than an oversight.

## Consequences

- An agent's turns are individually durable, individually retryable, individually visible in the
  log, and individually authorized. A crash costs one turn.
- Approval, streaming and per-turn decisions become reachable for the first time — R1 was the
  precondition for all three, which is why it is the largest item and the last of the small ones.
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
