# C — Capability readiness audit (loom main 3d2056e)

Method: code only (non-test src), docs/ADRs/READMEs/memory ignored. `../loom-examples` read only to check for end-to-end references.
Legend: ✅ supported, ⚠️ partial, ❌ missing. Maturity: PG = production-grade, PT = prototype, ST = stub.
Placement: K kernel, 1P-pkg, 1P-plug, 3P.

## 0. Cross-cutting headline findings (each verified in code)

| # | Finding | Evidence |
|---|---|---|
| H1 | The model is never told a tool's parameters. Both agent loops send `inputSchema: {}` for every tool, although `ToolDefinition.inputSchema` is a Zod schema. No zod->JSON-schema conversion exists anywhere in packages/plugins/tools. A real model can call only tools whose arguments it can guess from name+description. | `packages/agent/src/agentLoop$.ts:178-184`, `packages/agent/src/AgentRunner.ts` (toolSpecs map, `inputSchema: {}`), `packages/core/src/types/definitions.ts:86`; grep for zodToJson/toJSONSchema = 0 hits |
| H2 | LLM SPI is text-only: `LlmMessage.content: string`; no parts, no tool_use/tool_result roles. Tool results are fed back as `role:"user"` JSON text and the assistant's tool_use blocks are replaced with the literal `"(tool calls)"`. Multi-modal in/out and native tool-result threading are impossible at the SPI. | `packages/llm/src/types.ts:3-6`, `packages/agent/src/agentLoop$.ts:454,480,385`, `packages/llm/src/providers/AnthropicProvider.ts:54-56` |
| H3 | Canonical agent loop `agentLoop$` has NO example consumer in loom-examples (0 hits for `agentLoop`); every example uses the older `AgentRunner`, and all LLMs in examples are scripted/demo providers. | grep over `../loom-examples/examples` (the sibling repo) |
| H4 | `agentLoop$` with `reasoning` journals only route/elevation choices, not the model response. The model call is `config.reasoning.reason(...)` (a direct `provider.complete`), not `ctx.execute`, so on any resume/recovery re-run every completed turn calls the model again; a different answer yields different `#turn:i:tool:j` ids than the log holds. The docstring discloses the ring bypass but not this. No crash test for the routed path. | `packages/agent/src/agentLoop$.ts:444-457`, `packages/reasoning/src/ReasoningRuntime.ts` (decide wraps only route id), `packages/agent/src/agentLoopReasoning.test.ts` (no crash/recover case) |
| H5 | `orchestration.superviseChildren` keeps spawn specs, group aggregation and `started` in process memory, populated only from live `onEvent`. After a process restart nothing rebuilds them: a recovered child's completion hits `if (!started.has(execId)) return`, so the parent is never resumed; a group with 2 of 3 members settled loses its results. | `packages/orchestration/src/orchestration.ts:365-380, 530-600`; no rehydrate path (grep restart/recover in the file: only comments) |
| H6 | The A2A plugin is a Loom-flavoured subset, not the A2A protocol: custom `POST /tasks/send` + `GET /tasks/:id` (no JSON-RPC `message/send`, no SSE, no task cancel, no push), text-only parts, statuses `submitted/working/completed/failed` only (suspended maps to `working`, so no `input-required`), and the HTTP server exposes no route for `provideInput` even though the executor has it. Client discovers via `/.well-known/agent.json` and polls. | `plugins/a2a/src/A2AServer.ts` (routes), `plugins/a2a/src/AgentExecutor.ts` (`executionStatusToA2A`), `plugins/a2a/src/types.ts` (`A2AMessagePart.type:"text"`, `A2ATaskStatus`), `plugins/a2a/src/A2AClientEffect.ts` (poll loop) |
| H7 | Rewards can only be recorded from inside the running execution (`recordOutcome(sink=ctx)` -> `ctx.emit`). Outcomes are joined to decisions by `${event.executionId}\0${decisionId}`, so a reward written from another execution never links. `WorkflowRuntime` has no append-external-fact API (public methods: start/resume/resumeAs/cancel/fork/loadState). Delayed human feedback (thumbs-up days later) therefore needs the original execution to stay suspended. | `packages/analytics/src/outcomes.ts:37-43`, `packages/analytics/src/decisions.ts:62-73`, `packages/learning/src/trajectories.ts:105-114`, `packages/workflow-runtime/src/WorkflowRuntime.ts` method list |
| H8 | `agentLoop$` does not catch a failing tool: `ctx.execute` at :368 is not in a try/catch, so one tool error fails the whole agent execution. `AgentRunner` instead returns `{error}` to the model (`AgentRunner.ts` runToolCall) so it can self-correct. The canonical loop is therefore weaker at self-correction than the legacy one. Also: tool calls run strictly sequentially in `agentLoop$` (`runToolCalls` for-loop) while `AgentRunner` has `parallelTools`; and `agentLoop$` never writes memory (only `recall`; no `remember`/`append`). | `packages/agent/src/agentLoop$.ts:346-387`, `packages/agent/src/AgentRunner.ts` (runToolCall, parallelTools, memory.append) |

## 1. MULTI-TURN

Where a dialogue lives: nothing in code names a "conversation"/"session". Two shapes are possible with existing parts:
(a) one long execution that `ctx.suspend`s once per user turn and is `runtime.resume`d with the user message; (b) one execution per turn with history in `TieredMemory` keyed by `memoryScope` (`AgentInput.memoryScope`, `packages/agent/src/types.ts:6`; `agentLoop$` `memoryScope` default = executionId, `agentLoop$.ts:119,318`). No package, helper or example composes either into a chat loop.

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Per-turn durable agent loop (turn N journaled, crash costs one turn) | ✅ | PG for `modelToolId` path | `agentLoop$.ts:241-485`, ids `#turn:i`/`#turn:i:tool:j` :32-38; crash test file `agentLoopCrash.test.ts` | `reasoning` path not replay-safe (H4): 1P-pkg fix (wrap `reason` in `ctx.execute`/record response) |
| Session/conversation abstraction (create, append user turn, history, close) | ❌ | - | none; grep conversation = types/memory comments only | 1P-pkg (`@loom/conversation`: turn-as-resume protocol over a suspended execution + transcript projection). Not kernel |
| User turn as signal into running agent | ⚠️ | PT | `ctx.suspend`/`resume` (`workflow-runtime/src/types.ts:177`, `WorkflowRuntime.ts:1336`); `resume` only addresses a SUSPENDED execution (ingress refuses `not-suspended`, see `orchestration.ts:~435`). No inbox/mailbox/queue, no race of "wait for user OR timeout OR tool" | A message arriving mid-turn has nowhere to go. Needs mailbox semantics: kernel question (new wait primitive) vs 1P (buffer in durable-state, poll at turn boundary). Recommend 1P first |
| Interruption / barge-in | ⚠️ | PT | `runtime.cancel` -> `cancelled` is TERMINAL, resume refused (`WorkflowRuntime.ts` ~:1380 "K8.2 cancelled is TERMINAL"); `AgentRunner` has `AGENT_INTERRUPTED` typed failure w/ partial text (`AgentRunner.ts:70,172-180`); `agentLoop$` has zero `signal` handling (grep) | Barge-in = kill the conversation. Need turn-scoped abort that keeps the dialogue alive. 1P-pkg over AbortSignal + a typed-failure turn result; port R6 partial-capture to `agentLoop$` |
| Streaming responses to the user | ⚠️ | PT | Providers stream SSE (`AnthropicProvider.ts:115-229`, OpenAI too; Gemini has NO stream/tools, `GeminiProvider.ts` 93 lines); `createAgentModelEffect({stream,onDelta})`; `chunkDeltas` for durable `ctx.stream` | Only an in-process callback. No transport to an end-user (no SSE/WebSocket server anywhere: grep `text/event-stream` only in MCP client). `live-query` re-folds durable events, cannot carry token deltas (`chunkDeltas.ts` header). Streamed-turn crash restarts the stream from zero. 1P-plug (HTTP/SSE gateway) |
| Context-window management: summarisation | ⚠️ | PT | `agentLoop$` `compaction` (afterMessages/afterBytes, summary journaled via ctx.execute) `agentLoop$.ts:154-172,395-434`; `TieredMemory.summarize` `TieredMemory.ts:204-224` | No shipped summariser effect: `compaction.toolId` must return `{summary}`; `TieredMemory` default summarizer just concatenates (`:76`). Summary is injected as a `user` message. `summarize` is clear+re-append, non-atomic (crash between loses the scope) `:220-222` |
| Token budgeting / truncation of prompt | ❌ | - | triggers are messages and UTF-8 bytes, never tokens (`agentLoop$.ts:194-200`); no tokenizer or model context-limit table in repo | 1P-pkg: token estimator + `fitToWindow`. `streamTokenBudget` (`middleware`) meters output only |
| Short-term conversation memory | ✅ | PG (store) / PT (use) | `TieredMemory` tiers `working/episodic` w/ TTL/maxEntries `TieredMemory.ts:69-74`; `recall` recorded via `ctx.decide` `:146-157` | `agentLoop$` never writes back (H8) so builder must call `remember` themselves, un-journaled (replay duplicates writes) |
| Long-term memory / retrieval | ⚠️ | PG store; PT retrieval | `MemoryStore` SPI 2.1.0 (`memory/src/types.ts:81,124-207`), Sqlite/Postgres stores, FTS `search`, `recallRelevant` always via decide `TieredMemory.ts:166-179` | Lexical only (no embeddings in 1P; grep embed: none in 1P). Retrieval is not an automatic part of the agent loop |
| Resume after crash mid-turn | ✅ | PG | per-turn frames; `recoverAbandoned.ts`; K9 in-doubt (`definitions.ts:88-97`) | Mid-stream partial text lost (not durable). Resume replays full log each time unless snapshot cadence set (`WorkflowRuntime.resume` reads all events :1350) |
| Reference example | ❌ | - | no chat/conversation example; agentLoop$ unused (H3) | Add `chat-agent` example (suspend-per-turn + compaction + streaming) |

Verdict: PARTIAL. Durable single-run agent turn is solid; "a conversation" is unassembled and the real-LLM tool path is blocked by H1/H2.

## 2. MULTI-AGENT

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Agent definitions | ✅ | PG | `AgentDefinition` `core/src/types/definitions.ts:348-360`; `agent$()`; local `AgentRegistry` (in-memory Map) `packages/registry/src/index.ts:19-44` | Registry is process-local: no distributed discovery, no capability/skill query. 1P-pkg/plug |
| Agent-to-agent over network | ⚠️ | PT | A2A plugin (H6): `createA2AServer` serves ONE flow per server `A2AServer.ts` ; `A2APeerClient.discover/map/registerInto` `A2APeerClient.ts:138-208`; `createA2AClientEffect` polls 500 ms/60 s `A2AClientEffect.ts:15` | Not wire-compatible with real A2A; no streaming, no input-required, no cancel, unauthenticated by default (`A2AServer.ts` authorize comment). 1P-plug hardening to spec |
| In-process agent bus | ❌ | - | no bus type in packages; examples use hand-rolled `bus.dispatch` (`orchestrator/src/dispatchPlan.ts:12` takes a callback) | `dispatchPlan` is a 40-line sequential skeleton, not a bus. 1P-pkg if wanted; child executions already cover in-process delegation |
| Child executions (spawn+await) | ⚠️ | PT | `awaitChild/awaitChildren/awaitAll` + `superviseChildren` `orchestration.ts:168-604`; deterministic ids `childIdFor` :57; `maxDepth` :162-187; failure as typed `childFailed` :52 | Supervisor state is in-memory only -> hangs after restart (H5). Single `_resumePayload` slot per await. Fix in 1P-pkg (rehydrate from event store at boot, `waitParentDurable` polls ≤1 s :395) |
| Delegation with scoped authority | ✅ | PG | `grants` subset -> signed holder-bound `DelegatedGrant` minted at start, never logged `orchestration.ts:88-95,310-337,340-352`; `DelegationAuthorizer` in effect-runtime | Only via child spawn; not via A2A (remote agent sees no delegated authority). Governance audited elsewhere |
| Fan-out of independent subtasks | ✅ | PG | `executeGraph` (`graph-executor/src/executeGraph.ts:63-106`, bounded `parallelLimit`, lineage in BranchRegistry); `fanout$` `orchestration/src/fanout.ts:27-41` | `executeGraph` is a flat barrier: nodes have no dependencies/edges despite the name (`GraphNode` :7-15). DAG/pipeline with data edges: 1P-pkg |
| Supervisor/worker | ⚠️ | PT | achievable with awaitChildren; example `child-orchestration` (fan-out, all-or-nothing, single) | No restart policies/one-for-one supervision despite the name: `superviseChildren` only starts/resumes. 1P-pkg |
| Swarm (dynamic wiring from intent) | ⚠️ | PT | `agent-swarm` example: intent -> plan -> `executeGraph`, `PLAN_COMPOSED` emitted by app flow (`agent-swarm/src/capabilities/flows.ts:50-53`) | Pattern lives in example code; not a package |
| Hierarchical | ⚠️ | PT | nested child ids `::`, depthOf `orchestration.ts:79` | needs H5 fix |
| Debate / consensus / market-auction / voting | ❌ | - | grep debate/consensus/auction/blackboard/critic: 0 non-test hits | Compose over `awaitChildren` + `ctx.decide`; 3P or 1P-pkg recipe. Not kernel |
| Shared memory / blackboard | ⚠️ | PT | `MemoryStore` keyed scopes shared by key; `durable-state` plugin (`durableState.ts:95`) | No typed blackboard w/ subscription/CAS across agents; writes un-journaled unless via effects. 1P-plug |
| Dynamic agent spawning | ✅ | PG | child spawn by runtime flowId (`SpawnChoice` `orchestration.ts:97-105`) | Flows must be pre-registered in `deps.flows` (:312): no spawning of a novel agent definition at runtime |
| Failure isolation | ✅ | PG | one writer per execution; child failure becomes data (`ChildResult` :46-50); K9 in-doubt | Isolation breaks at supervisor restart (H5) |
| Coordination at scale | ⚠️ | PT | dispatcher/worker-runtime SPI, cloudrun, fair-scheduler, placement | Measured ceiling ~5.7K durable exec/s is a memory-file claim not verified here; no distributed supervisor (single process `Map`s) |

Verdict: PARTIAL. Strong substrate (identity, authority, isolation), but orchestration is happy-path only and the network protocol is not the standard.

## 3. MULTI-MODAL

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Image/audio/video/file in an LLM message | ❌ | - | `LlmMessage.content: string` `llm/src/types.ts:3-6`; providers copy `{role,content}` (`AnthropicProvider.ts:54-56`, `OpenAiProvider.ts:65`); Gemini provider has no tools/stream | Core SPI change: parts model (`LlmContent` already exists for taint; extend to `Part[]`) -> 1P-pkg `@loom/llm` MAJOR bump; providers map to native blocks. Not kernel |
| Native tool_use / tool_result threading | ❌ | - | H2 | same change; also needed for parallel tool calls and correct provider caching |
| Binary tool I/O | ⚠️ | PT | claim-check with `streamResult` + `codec:"bytes"` `middleware/src/claimCheck.ts:42-75,178`; `resolveClaimCheckBytes`; `ContentStore.put(Uint8Array)/putStream` `content/src/ContentStore.ts:64-87`; sqlite/postgres content stores | Storage exists; nothing carries a ref into a prompt part or reads it back to the model. MCP image/audio blocks are typed (`mcp/src/types.ts:54-63`) but only text is projected for the model |
| Streaming media | ❌ | - | no audio/video stream abstraction; `putStream` is for storage only | 3P/1P-plug (realtime voice is a different transport; do not push into kernel) |
| Renderers / generative UI out | ✅ | PG/PT | blueprint-runtime, `renderer-react` (hooks, widgets), `renderer-terminal`, `a2ui` (bridge + conformance), `mcp-app` (SEP-1865), `agent-surface` patch protocol | UI out is strong; there is no audio/image *widget* in the default registries (not checked beyond `renderer-terminal/defaultRegistry.ts`) |
| Embeddings / vector search | ❌ in 1P | - | no embedder interface in 1P; `MemoryStore.search` contract explicitly allows similarity backends (`memory/src/types.ts:154-163`) and the 3P `loom-plugin-vector` is the stated example | SPI is ready; need `Embedder` SPI + 1P reference backend or leave 3P. Non-text embeddings: 3P |
| Image in -> audio out end to end | ❌ | - | requires parts model + a tool that returns bytes + TTS tool; none of the pieces compose | blocked by first row |

Verdict: NOT READY for model-facing multi-modal; UI-out and blob storage are ready.

## 4. AUTONOMOUS DECISION-MAKING

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Planning | ⚠️ | PT | `PlannerRuntime.plan(goal)` returns an ordered list of `{capabilityId, rationale}` `planner/src/PlannerRuntime.ts:7-15,40-48`; LLM or keyword fallback `:50-76` | No arguments/bindings between steps, no dependencies, no preconditions; plan is not journaled (plain async call; the `planner-decide-scope` example wraps it manually and relies on `@loom-ui/planner`); silently falls back to keyword heuristic when the LLM output is unparseable `:44-47,128` |
| Intent routing | ✅ | PT | `IntentRuntime.route/run` `intent/src/IntentRuntime.ts:36-57`; single capability, keyword confidence = score share | LLM route returns confidence 1 constant :85; not journaled |
| Plan execution | ⚠️ | PT | `dispatchPlan` sequential (`orchestrator/src/dispatchPlan.ts:28-42`); `executeGraph` flat | no dependency-aware executor (see 2) |
| Replanning on failure / reflection / self-critique loops | ❌ | - | grep replan/reflect/critic: 0 hits | A recipe over `ctx.decide` + loops; 1P-pkg or documented example. Not kernel |
| Goal management (long-horizon, subgoals) | ❌ | - | `Plan.goal` is a string; no goal store/state | The primitives exist (durable-state, child executions); 1P-plug `goals` or example |
| Tool discovery & selection | ⚠️ | PT | `CapabilityCatalog.find` keyword substring scoring, capped terms `capability/src/CapabilityCatalog.ts:89-112`; `SkillSelector` deterministic or LLM, recorded via decide `agentLoop$.ts:273`; MCP: `McpClient` list/call, `mcpInvoke$` dynamic dispatch with schema-hash pinning `mcp/src/mcpInvoke$.ts:1-40` | No semantic ranking (needs embeddings); tool args schema never shown to model (H1). MCP tools are mapped statically per effect or dynamically per step: good provenance, but the LLM never sees MCP `inputSchema` through the agent loop |
| Perpetual / scheduled agents | ✅ | PT-PG | `schedule$` cron 5-field UTC, static input `core/src/types/definitions.ts:235-244`; `sentinelPreset` = schedule + `sentinelState` + claim-check + pinning `sentinel/src/sentinelPreset.ts:1-109`; durable-state | Cron only: no event/webhook/condition triggers, no missed-run policy (grep catchUp/misfire: none), `input` fixed. Reactive triggers = app code. 1P-plug |
| Acting under uncertainty | ⚠️ | PT | `ReasoningRuntime` confidence-based elevation across tiers `reasoning/src/ReasoningRuntime.ts:80-110`; default confidence = stop-reason only (`confidence.ts`, 37 lines) | No calibrated uncertainty, abstain/ask-human policy helper. HITL exists as `requireApproval` `agentLoop$.ts:96,352-365` |
| Decision provenance | ✅ | PG | `ctx.decide` -> DECISION_RECORDED with rationale/alternatives/confidence/policy/propensity (`workflow-runtime/src/types.ts:133-143`, `decideWithPolicy.ts:60-100`); analytics `decisionRecords` | Strong; the weak spot is un-recorded model calls in the routed path (H4) |
| Safety hooks (stop a runaway agent) | ✅ (hooks only) | PG | `maxIterations` (default 10) `agentLoop$.ts:259`; `deadlineMs` `workflow-runtime/src/types.ts:252`; `metering/nestedBudget/streamTokenBudget` middleware; `maxDepth` orchestration; `negotiateBudget` ctx syscall; `safety.ts` validators; `requireApproval` | Governance audited separately |

Verdict: PARTIAL. Strong on journaled choice and scheduling; planning is a menu-picker and no loop above the single ReAct turn.

## 5. LEARNING

Supported kinds: contextual-bandit style policy selection with logged propensity and off-policy evaluation; recency/relevance memory; outcome-ranked routing. Not supported: any gradient learning, fine-tune export, preference data, sequential RL value estimation, online update.

| Capability | Status | Maturity | Evidence | Gap & placement |
|---|---|---|---|---|
| Policy seam (select among discrete actions, stamped id+version) | ✅ | PG | `Policy.select(context, actions)->{action,propensity}` sync `learning/src/types.ts:44-48`; `decideWithPolicy` `decideWithPolicy.ts` | No `update`/learn hook; policy is a frozen function. Training is outside by design (3P). `select` is synchronous (no async policy server call) - small SPI gap, 1P-pkg MINOR |
| Propensity + context logging | ✅ | PG | `DecideWithPolicy` writes context, alternatives, policy stamp into DECISION_RECORDED | Propensity cannot be reconstructed later: policies must report it (types.ts:29-36) |
| Trajectories (credit assignment) | ✅ | PG | `trajectories.ts` direct/terminal/none reward sources, discount, unitOf :60-133 | single-level; no multi-agent/shared-credit |
| Reward / feedback capture | ⚠️ | PT | `recordOutcome` `analytics/src/outcomes.ts:37-43` | only from inside the same execution (H7). No explicit-feedback API (thumbs, edit-distance, corrections). Needs kernel-adjacent decision: appending a user-land fact to a closed execution is a log-semantics question -> propose 1P `feedback` execution + join key that carries target executionId (analytics change), not kernel |
| Off-policy evaluation | ✅ | PG | `evaluatePolicy` SNIPS, weight clip 100, ESS, unit-pooled, warnings `learning/src/evaluate.ts:22-177` | One estimator (SNIPS) + agreement-only; no doubly-robust, no confidence interval/bootstrap (grep: none); promotion relies on lift and ESS thresholds |
| Promotion gate | ✅ | PG | `promotionGate` pure verdict `learning/src/promote.ts:19-60` | Gate returns a verdict only: no registry of promoted policy versions, no rollout/canary/shadow mode (grep canary/shadow: none), rollback = redeploy. 1P-pkg `policy-registry` |
| Online vs offline learning | ⚠️ | PT | offline loop shown by `learning-router` (online select -> mine log -> evaluate -> gate) | Online update during run not modelled (frozen policy); learning-router synthesises rewards in-flow (`learning-router/src/flow.ts:84`) |
| Memory-based in-context learning | ✅ | PT | `TieredMemory` + `recallRelevant` + `@loom/knowledge` (`KnowledgeBase.putDoc/sync/retrieve` `knowledge/src/KnowledgeBase.ts:252-391`, grounded request, citations) | Lexical retrieval; `agentLoop$` never auto-writes lessons; no reflection to semantic tier; no "skill acquisition" |
| Knowledge/corpus lifecycle | ✅ | PT | `sync/planSync/removeDoc/listDocs`; default `packParagraphs` chunker `knowledge/src/chunk.ts` | Text only |
| Analytics over the log | ✅ | PT | `analytics` (profile, advisory, outcomes, replay; 1875 LOC) | read-only lens |
| Model / prompt / policy versioning & rollout | ⚠️ | PT | policy `version` in stamp; flow version pin/migration (K11) | No prompt versioning (prompt text not stamped on calls; grep promptVersion: none), no model-route rollout/A-B. 1P-pkg |
| Fine-tuning / preference data export | ❌ | - | grep jsonl/fine-tune/preference/dpo: none | Trajectory + decision data is the right raw material; add exporter (1P-pkg `learning/export`). 3P for trainers |
| Evaluation harness | ⚠️ | PT | `tools/eval/src/eval.ts` = `replayAsFixture`, `diffRuns` golden-run diff (step/output equality) | A regression-diff tool, not an LLM eval harness: no datasets, graders/LLM-judge, metrics (pass@k), or comparison across models. 1P-pkg/tool |
| Deterministic simulation testing | ✅ | PG | `tools/dst`, `tools/testing` | LLM nondeterminism is handled by recorded decisions, not simulated models |

Verdict: PARTIAL, and honestly scoped: an excellent bandit/off-policy substrate; "an agent improves from experience" beyond routing needs feedback ingestion, memory write-back, rollout and an eval harness.

## 6. CROSS-CUTTING: reference paths and overlap

| Capability | 1P API | Example in loom-examples | Reference path? |
|---|---|---|---|
| Single agent (ReAct) | `AgentRunner` (legacy) / `agentStep$` / `agentLoop$` | `a2a-mesh`, `agent-network`, `db-command-center*`, `incident-war-room` use `AgentRunner` with scripted LLM | agentLoop$: none (H3) |
| Multi-turn chat | memory + suspend | none | ❌ |
| Child orchestration | `orchestration` | `child-orchestration` | ✅ (but H5) |
| Swarm/fan-out | `executeGraph` | `agent-swarm`, `compute-cloudrun` | ✅ |
| A2A | `plugin-a2a` | `a2a-mesh`, `a2ui-*` | ✅ (non-standard) |
| MCP | `plugin-mcp` | `mcp-app-release-approval`, `db-observability` | ✅ |
| Memory/knowledge | memory, knowledge | `runbook-recall`, `db-sentinel` | ✅ |
| Learning | learning | `learning-router` (needs 3P `loom-plugin-linucb`) | ✅ (synthetic rewards) |
| Perpetual agents | sentinel | `db-sentinel` | ✅ |
| Multi-modal | - | none | ❌ |
| Planning + intent | planner/intent | `agent-network`, `planner-decide-scope` (with `@loom-ui/planner`) | ✅ (thin) |

Overlap / canonicality of "agent loop" (three APIs):
1. `AgentRunner` (class; whole loop in ONE step handler; hand-emits events; fake `decide` for reasoning) - used by every example.
2. `agentStep$` = wrapper around (1).
3. `agentLoop$` (runner-body function; per-turn durable frames; real `ctx.decide`/`suspend`; compaction; approval) - declared the better design in its own header and the only one with approval + compaction.
Canonical should be (3), but (3) lacks (1)'s tool-error feedback, parallel tools, abort/partial capture, memory write-back, and has no example. The overlap does block builders: choosing (1) loses mid-loop HITL/compaction/crash granularity; choosing (3) loses features and has no worked example. Also two routing paths inside (3): `modelToolId` (protected, not routed) vs `reasoning` (routed, unprotected, non-replay-safe response): "pick per agent" is a footgun.
Planner/Intent/Capability overlap with `agent-surface`/`appgen` is low; `orchestrator.dispatchPlan` vs `executeGraph` vs `awaitChildren` are three ways to run a plan (sequential callback, flat parallel, parent/child durable) with no guidance on which is durable: only `awaitChildren` is crash-recoverable (and see H5).

## 7. Scorecard

| Dimension | Verdict | One line |
|---|---|---|
| Multi-turn | PARTIAL | Durable per-turn loop and memory tiers are good; no conversation abstraction, mailbox, barge-in, token budgeting, or user-facing stream transport |
| Multi-agent | PARTIAL | Child orchestration, scoped delegation, isolation are real; supervisor dies on restart, A2A non-standard, no DAG/patterns/blackboard |
| Multi-modal | NOT READY | LLM SPI is string-only, no parts or tool_result threading; UI renderers and blob stores exist but are not wired to the model |
| Autonomous decision-making | PARTIAL | Journaled decisions, schedules and sentinel are strong; planner is a capability-id menu with no args/deps/replan/goals |
| Learning | PARTIAL | Off-policy bandit substrate is rigorous; reward ingestion is same-execution only, no rollout, export or LLM eval harness |

## 8. Top gaps ranked (by blocking effect)

1. Tool schemas never reach the model (H1). 1P-pkg (`@loom/agent` + `@loom/llm`): derive JSON schema from Zod `ToolDefinition.inputSchema` / MCP schema.
2. LLM SPI string-only; no parts, no native tool_use/tool_result (H2) - blocks multi-modal and correct tool threading. 1P-pkg `@loom/llm` MAJOR.
3. `superviseChildren` not restart-safe (H5): parents hang forever. 1P-pkg `@loom/orchestration` (rehydrate from log / recovery hook).
4. `agentLoop$` reasoning path not replay-safe (H4) and agent loops diverge (H8, H3): consolidate to one canonical loop with tool-error feedback, parallel tools, abort, memory write-back, plus an example. 1P-pkg.
5. No conversation/session layer or mailbox (user turn while running, barge-in without killing the execution). 1P-pkg first; kernel only if a durable inbox primitive is proven necessary.
6. A2A not protocol-compliant (JSON-RPC, streaming, input-required, cancel, provideInput route, multi-part). 1P-plug.
7. Delayed/external feedback cannot link to a past decision (H7). 1P-pkg change in analytics/learning (join on a carried target executionId) + a feedback ingestion helper; kernel untouched.
8. No end-user streaming transport (SSE/WebSocket gateway) and no token-aware context budgeting. 1P-plug / 1P-pkg.
9. Planner: argument/dependency-aware plans, journaled planning, replanning-on-failure loop, goal store; executor with edges (`executeGraph` is flat). 1P-pkg.
10. Learning lifecycle: policy registry with canary/shadow rollout, prompt/model versioning, trajectory/preference export, and an LLM-evaluation harness (tools/eval is golden-diff only). Embedding SPI + reference vector backend (3P exists). 1P-pkg/tool; trainers 3P.

Placement summary: nothing above requires a kernel change; items 5 (durable inbox) is the only candidate to revisit after a 1P prototype.
