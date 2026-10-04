# Loom — genericity & agentic-readiness evaluation (2026-10-05, main 3d2056e)

Fresh audit from CODE only (no prior evaluations, docs or ADRs used as evidence). Four independent audits —
[A kernel](2026-10-05-agentic-readiness-kernel.md), [B genericity](2026-10-05-agentic-readiness-genericity.md), [C capabilities](2026-10-05-agentic-readiness-capabilities.md),
[D governance & extensibility](2026-10-05-agentic-readiness-governance-extensibility.md) — each citing `path:line`. Headline claims were
re-verified by the controller: `ctx.ui` in the kernel ABI + workflow-runtime → agent-surface dependency; string-only
`LlmMessage`; English-regex auto-approval in `@loom/orchestrator`; `inputSchema: {}` sent for every tool; no tool-menu
check before `ctx.execute(toolCall.name)`; principal-less execution authz skipped; and the quadratic decision fold
(re-measured: 5k/10k/20k `DECISION_RECORDED` → 2.3 s / 10.0 s / 42.5 s vs 5 ms for the same number of steps).

**Reproducing the measurements:** after `pnpm build`, run e.g.
`node docs/requirements/2026-10-05-agentic-readiness-experiments/exp4.cjs` from the repo root (decision vs step fold
cost); `exp.cjs` (message-loop resume cost), `exp2.cjs` (signal while busy, two parallel gates), `exp3.cjs` (sibling
completes after suspend), `exp5.cjs` (live commit cost). They are throwaway probes, not tests.

The second-consumer rule was deliberately relaxed for this evaluation: gaps are judged against what futuristic agentic
systems (multi-turn, multi-agent, multi-modal, autonomous, learning) will need, not against today's consumers.

## Verdict

**Generic: yes, with a handful of fixable leaks. Ready for futuristic agentic systems: not yet.** The kernel's
durability core is genuinely strong and domain-free; the gaps are (1) a few kernel primitives that long-lived,
conversational, concurrent agents need, (2) an LLM/agent layer built around text chat, and (3) governance that exists
but is opt-in and loses identity at boundaries.

| Dimension | Verdict | One line |
|---|---|---|
| Genericity | ✅ mostly | Kernel free of domain/vendor nouns; leaks: `ctx.ui` syscall, closed `EffectKind`/`TaskKind`, fixed metering dimensions, ASCII/English heuristics, example code in 1P (`orchestrator`, `@loom/app` leftovers); 5 inert packages |
| Multi-turn | ⚠️ partial | Durable per-turn loop exists; no inbox/signal into a running execution, no session layer, no turn-scoped interrupt, no token budgeting; per-turn cost grows with history |
| Multi-agent | ⚠️ partial | Child executions + scoped delegation are real; supervisor not restart-safe; A2A plugin isn't the A2A protocol; no DAG/debate/blackboard; principal lost across agent boundaries |
| Multi-modal | ❌ not ready | LLM SPI is `content: string`; no parts, no tool role; content store + renderers exist but are not wired to the model |
| Autonomy | ⚠️ partial | `ctx.decide` provenance, schedules, sentinel are strong; planner returns id lists only (no args/deps/replan/goal store); no autonomy envelope by default |
| Learning | ⚠️ partial | Rigorous bandit/off-policy substrate; no late reward → past decision, no rollout/canary, no prompt/model versioning, no training export, no embedding SPI |
| Governance | ⚠️ opt-in | Good primitives (deny-wins authz, delegation, hash chain, taint refusal, QuickJS sandbox) but permissive defaults, principal not durable, fail-open execution authz, no system kill switch |
| Extensibility | ⚠️ | 7 versioned SPIs with conformance kits; but not publishable (all `workspace:*`, 0.0.1, no `files`), scaffold only installs inside the monorepo, plugin-kit is storage-only |

## Strengths (confirmed in code — keep, don't re-litigate)
Deterministic replay with journaled effects; `ctx.decide` decision provenance with propensity; fencing + store-clock
leases; in-doubt effect parking with deterministic idempotency keys; userspace-emit forgery guard; typed failures
served on replay; additive-only event schema; scoped, attenuated delegation; Ed25519 audit chain; unconditional taint
refusal at prompt positions; 7 conformance kits; zero vendor names in kernel source.

## The gaps, prioritised

### P0 — blocks futuristic workloads or is a safety hole
| # | Gap | Evidence | Placement |
|---|---|---|---|
| 1 | **Unbounded fold state & super-linear cost** — `_decisions` spread per event (20k decisions = 42 s to fold); full-log read per resume; full snapshot per suspend; compaction never prunes frames/decisions/resume payloads; no continue-as-new. A perpetual or conversational agent degrades to unusable. | replay-vm `eventHandlers.ts:410`, workflow-runtime `WorkflowRuntime.ts:1347,2369`; A-kernel exp4/exp5 | **Kernel** (perf fixes: no ABI change; bounded history/continue-as-new: fold semantics) |
| 2 | **No inbound message primitive** — resume while a step runs → `ResumeRefusedError`; two parallel `ctx.suspend` record only the first gate. No mailbox/select. | `WorkflowRuntime.ts:770-795`; exp2 | **Kernel** (durable inbox + receive/select); routing/pub-sub 1P |
| 3 | **Principal not durable or propagated** — dropped across dispatcher, A2A, crash recovery, timers, child spawn; execution authz skipped when principal is absent; attenuated child can regain base authority after recovery. | `WorkflowRuntime.ts:462-466`, A2A `AgentExecutor.ts:75` | **Kernel** + dispatcher/wire-abi SPI; 1P reference ExecutionAuthorizer |
| 4 | **Agent loop executes any effect id the model names; tool schemas never sent** — no menu-membership check, no input validation, `inputSchema: {}`. | `agent/src/agentLoop$.ts:178-184,367-377` | 1P `@loom/agent` |
| 5 | **LLM SPI is text-only** — no content parts (image/audio/file), no `tool` role/tool_use/tool_result threading; tool results go back as user JSON, tool turns recorded as "(tool calls)". | `llm/src/types.ts:3-6`, `agentLoop$.ts:385,454,480` | 1P `@loom/llm` (MAJOR) + providers |

### P1 — needed for credible multi-agent / autonomous systems
| # | Gap | Placement |
|---|---|---|
| 6 | Structured concurrency: `parallel` doesn't forward cancellation; siblings commit after park; gate answers keyed by position (A) | Kernel |
| 7 | Running-agent evolution: `flowContentHash` is 32-bit FNV over the step list only (body edits invisible); replay-check rejects dynamic step ids (A) | Kernel (fingerprint) + 1P (code-by-hash registry, migration tooling) |
| 8 | Restart-safe supervision: `superviseChildren` keeps state in memory; parent hangs after restart (C) | 1P `@loom/orchestration` |
| 9 | Autonomy envelope & kill switch: no default deadline, spawn depth/breadth cap, rate limit, per-agent budget; no tenant/system stop; cancel doesn't cascade to children; reasoning path + `llmSkillSelector` bypass authz/metering/kill (D) | 1P middleware + app strict mode; kernel cancel-cascade |
| 10 | Canonical agent loop: three overlapping loops; `agentLoop$` (canonical) unused by examples, serial tools, one failing tool fails the run, re-calls the model on resume with `reasoning` set (C) | 1P `@loom/agent` |
| 11 | Late reward attach: outcomes only from the live execution; no append to a finished log (A, C) | Small kernel append or 1P side table keyed (executionId, decisionId) |
| 12 | A2A/MCP servers unauthenticated by default; A2A is a Loom-specific subset (no input-required, streaming, cancel); MCP authz is one effect id for all tools (C, D) | 1P plugins |
| 13 | Approval not bound to what the approver saw; no first-party ResumeAuthenticator; `InProcessA2ABus` auto-approves (D) | 1P / kernel hook |

### P2 — maturity and generality
| # | Gap | Placement |
|---|---|---|
| 14 | Move `ctx.ui` out of the kernel (it is `emit`), drop workflow-runtime → agent-surface; extend the layering guard to forbid kernel → non-kernel packages | Kernel (ABI minor) |
| 15 | Open the closed vocabularies: `EffectKind` (names `a2a`), `TaskKind` (`ui`), fixed metering dimensions (tokens/costUsd…) → custom dimension map | Kernel/core |
| 16 | Planning depth: plans with args + dependencies, journaled, replan-on-failure, goal store; `executeGraph` with edges | 1P |
| 17 | Conversation layer + streaming transport (SSE/WebSocket) + token-aware context budgeting | 1P package + plugin |
| 18 | Learning lifecycle: policy registry with canary/shadow, prompt/model versioning, trajectory/preference export, embedding SPI, a real eval harness | 1P / tools; trainers & vector backends 3P |
| 19 | Unicode/locale: `/\W+/` tokenizers in CapabilityCatalog/SkillRegistry; English fixed prompts in Planner/Intent without override; UTC-only cron | 1P |
| 20 | Publishability: `files`/license/`publishConfig`/semver, scaffold without `workspace:*`, plugin-kit beyond storage, Effect/bridge/telemetry conformance kits | Tooling / 1P |
| 21 | Prune: `orchestrator` (example code), inert `replay-inspector`, `saga`, `fair-scheduler`, `plugin-sentinel`; pick one of `isolate`/`sandbox` (isolate leaves fs/child_process open); `@loom/sdk` hard-deps; `@loom/app` leftovers (`BroadcastingProjectionRuntime`, single-subscriber `progressHub`); ~half of workflow-runtime is legacy-repair code | 1P / examples |

## Where the audits disagreed (and the ruling)
- **Multi-turn needs the kernel?** C said every capability gap is 1P. A measured `ResumeRefusedError` for a message
  arriving mid-step and found no inbox primitive. Ruling: a conversation/swarm layer on top needs a **kernel** durable
  inbox (or append-while-running); everything above it (sessions, routing, pub/sub) is 1P.

## Suggested sequencing
1. **Kernel scalability fixes** (#1 perf half) — pure bug fixes, no ABI change, highest leverage, measurable.
2. **Safety P0s in 1P** (#4 tool-menu check + schemas, #3's 1P half, #9 strict-mode defaults) — small, high value.
3. **Kernel primitive design** (#1 bounded history, #2 inbox/select, #6 structured concurrency, #3 durable principal,
   #7 body-aware fingerprint) — one coordinated KERNEL_ABI/EVENT_SCHEMA design with an ADR each; Opus first review.
4. **LLM/agent layer v2** (#5 content parts + tool threading, #10 one canonical loop, #17 conversation layer).
5. **Multi-agent & learning maturity** (#8, #11, #12, #16, #18) and P2 cleanup.
