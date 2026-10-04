# B - Genericity audit of Loom (main 3d2056e), 2026-10-05

Method: read each package's index + main source, built the dependency graph from package.json, grep-swept for domain
nouns / vendors / English / UI / storage assumptions and READ the context of each hit. Doc/ADR/memory claims were ignored
unless confirmed in code. Paths below are relative to the repo root. "ex=N" = number of files in
loom-examples/loom-plugins/loom-demo importing the package (consumer evidence, not authority).

Headline: the kernel is genuinely domain-free (no DB/dashboard/incident/ticket nouns anywhere in core, event-runtime,
replay-vm, effect-runtime, workflow-runtime, no hardcoded tool ids as semantics, no vendor SDKs; vendors appear only as
fetch-based adapters inside @loom/llm with replaceable model/baseUrl). The genericity debt is NOT domain nouns. It is
(1) an LLM-text-chat worldview baked into several "generic" seams, (2) one UI syscall + one UI package wired into the
kernel, (3) example-extraction leftovers living in 1P packages, (4) English-only heuristics with no locale seam, and
(5) 5 packages with zero code consumers.

## (a) Package table (72 = 43 packages + 18 plugins + 11 tools)

Verdicts: GENERIC / MOSTLY (minor leaks) / DOMAIN-SPECIFIC / INERT.

### packages/*
| pkg | purpose (from code) | verdict | key evidence |
|---|---|---|---|
| core | defs builders (flow$/step$/tool$/agent$/skill$/memory$...), error types, hashes, version pins | MOSTLY | `AgentDefinition` carries A2A card fields (packages/core/src/types/definitions.ts:313-360); closed `EffectKind` incl. "a2a" (definitions.ts:4); `TaskKind` incl. "ui" (definitions.ts:165) |
| event-runtime | EventStore SPI, in-mem/async/sharded/tenant stores, leases, timers, fencing | GENERIC | no domain/vendor refs |
| snapshot-runtime | snapshot store SPI + in-mem | GENERIC | |
| replay-vm | pure fold of the log to ExecutionState | MOSTLY | RESOURCE_METERED fold hardcodes 6 dimensions (packages/replay-vm/src/eventHandlers.ts:780-825) |
| effect-runtime | effect registry, authz, policy, Llm/Human/A2A/Tool effects | MOSTLY | built-in `LlmEffect`/`A2AEffect` classes (src/effects/LlmEffect.ts:12, A2AEffect.ts:4); `ResourceSnapshot` = tokens/costUsd/ms (src/types.ts:36-46) |
| workflow-runtime | the kernel: interpreter, ctx syscalls, timers, lifecycle, recovery | MOSTLY | `ctx.ui` is a KERNEL_ABI syscall + hard dep on @loom/agent-surface (see L1) |
| scheduler | cooperative priority scheduler | GENERIC | |
| wire-abi | portable fold vectors / ABI | GENERIC | |
| dispatcher | ExecutionDispatcher SPI + Local/Placement | GENERIC | "cloudrun" only in doc comments (src/types.ts:29) |
| worker-runtime / worker-runtime-local | WorkerRuntime SPI + local impl | GENERIC | |
| graph-executor | fan-out executor over dispatcher | GENERIC | ex=1 |
| classify | taint / sensitivity marks / redaction primitives | GENERIC | `ssn` only in comments |
| compliance | export/erase-subject | GENERIC | jurisdiction-neutral; GDPR only in comments |
| telemetry | adapter SPI + console adapter | GENERIC | |
| verify | static flow rules | GENERIC | |
| conformance | store/provider conformance kits | GENERIC | |
| memory | MemoryStore SPI, tiered memory, unicode tokenizer | GENERIC | `content: unknown`, `tokenize` uses \p{L}\p{N} (src/searchText.ts:19) |
| knowledge | document->passage corpus, grounded request, citations | GENERIC | only `packParagraphs` default chunker is prose-shaped, replaceable (`Chunker`) |
| reasoning | model routing ladder + confidence elevation + bandit routers | GENERIC | LLM-only by definition; routers/confidence are seams |
| llm | LlmProvider SPI + Anthropic/OpenAI/Gemini fetch adapters + taint guard | MOSTLY | text-only message model (L3); stale hard-coded default models (C3) |
| agent | ReAct loop (agentLoop$, agentStep$, AgentRunner), skills | MOSTLY | text-only AgentInput/Output, tool results as user-role JSON, `String(entry.content)` (L3) |
| capability | flow+intent metadata catalog with keyword `find` | MOSTLY | `\W+` ASCII tokenizer (L5) |
| intent | NL -> capability router | MOSTLY | fixed English prompt, no override (L6) |
| planner | goal -> ordered capability list | MOSTLY | fixed English prompt; plan = flat id list with no inputs/edges (L6) |
| analytics | log analytics, cost/model ranking, advisory | MOSTLY | USD + "model" worldview, English advice strings (packages/analytics/src/advisory.ts:21,175,187) |
| learning | Policy SPI, trajectories, SNIPS off-policy eval, promotion gate | MOSTLY | contextual-bandit shape: single-step discrete `select(context, actions)` (src/types.ts:27-45) |
| middleware | retry, metering/quota, redaction, claim-check, safety, nestedBudget | MOSTLY | metering/Budget closed to 5 dims (src/metering.ts:21-48) |
| orchestration | cross-execution awaitChildren/All | GENERIC | |
| live-query | live read over state | GENERIC | ex=1 |
| projection-runtime | Projection/ProjectionRuntime SPI | GENERIC | |
| agent-surface | durable UI-patch protocol (`SURFACE_PATCH`, emitter, projection) | GENERIC | itself domain-free; placement is the problem (L1) |
| blueprint-runtime | widget IR (Blueprint), builders, pins, normalization | MOSTLY | closed dashboard-flavoured `WidgetKind` (MetricCard/Timeline/ApprovalCard/StatusBadge/ProgressBar/DataTable, src/widgets.ts) but `customWidget$` seam exists (src/customWidget.ts:20) |
| app | defineConfig composition root + A2A bus + progressHub | MOSTLY | example leftovers (L4) |
| sdk | umbrella re-export | MOSTLY | hard deps on native store plugins + terminal renderer + both protocol plugins (packages/sdk/package.json:40-60); zero consumers |
| registry | AgentRegistry + A2A-shaped card | MOSTLY | 44 lines, `RegisteredAgentCard` = A2A card (src/index.ts); only sdk re-exports it |
| spec | capability manifest/ layering guard / docs emit | GENERIC | |
| plugin-kit | storage preset helper | GENERIC | |
| orchestrator | `decideApproval`, `autoApprovalAllowed`, `dispatchPlan` | DOMAIN-SPECIFIC | extracted from example conductors; English regex policy (L2) |
| fair-scheduler | tenant-fair scheduler | INERT | ex=0, no src consumer (only a spec/capabilities.ts mention) |
| isolate | child-process isolated tool runner, brokeredFetch | INERT | ex=0, no consumer; plugin-sandbox only mentions it in comments (plugins/sandbox/src/types.ts:5) |
| replay-inspector | state-at-N/diff/pinning inspection lib | INERT | ex=0; `loom inspect` reimplements in tools/cli/src/inspector.ts (does not import it) |
| saga | 107-line compensation helper | INERT | ex=0, no consumer |

### plugins/*
| plugin | purpose | verdict | key evidence |
|---|---|---|---|
| a2a | A2A protocol client/server | GENERIC | protocol adapter |
| a2ui | project surfaces onto Google A2UI wire | GENERIC | catalog is Text/Row/Column/List/Button (src/catalog.ts:56) |
| audit-chain | hash-chained EventStore | GENERIC | |
| content | content-addressed side store / claim-check | GENERIC | |
| crypto | field encryption + crypto-shred | GENERIC | |
| durable-state | typed versioned carry-state | MOSTLY | `sentinelState` hardcodes `sentinel:<id>` key (src/sentinel.ts:53), name encodes one worldview |
| mcp | MCP client+server | GENERIC | |
| mcp-app | MCP Apps (SEP-1865) surface egress | GENERIC | depends on plugin-a2ui + plugin-mcp (plugin->plugin) |
| postgres | PG stores | GENERIC | imports SPI types from feature plugins (L-layering) |
| sqlite | SQLite stores | GENERIC | same |
| read-model | checkpointed cross-execution read models | MOSTLY | package.json description and src/types.ts:3 are branded "db-copilot infra" (metadata only) |
| renderer-react | React blueprint renderer | MOSTLY | hardcoded English "No pending approval", "no rows" (C1) |
| renderer-terminal | string renderer | MOSTLY | hardcoded "Approve"/"Reject" defaults (src/defaultRegistry.ts:88) |
| sandbox | QuickJS sandbox for LLM-authored reshaping code | GENERIC | |
| sentinel | `sentinelPreset` = schedule + durable-state + claim-check bundle | INERT | ex=0; only consumer is tools/scaffold/src/templates.ts:49 (a generator); db-sentinel example composes the parts directly; default pin `FINDING_RECORDED` (src/sentinelPreset.ts) |
| cloudrun | Cloud Run WorkerRuntime | MOSTLY | vendor-platform adapter in 1P (ex=1); fine as plugin, candidate for 3P |
| worker-remote / worker-server | HTTP worker runtime/endpoint | GENERIC | |

### tools/*
| tool | purpose | verdict | key evidence |
|---|---|---|---|
| cli | operator commands | GENERIC | stores.ts deliberately backend-neutral via `--config`; `--db` sqlite shorthand only |
| compiler | handler$ extraction, resumability, runner analysis | GENERIC | no @loom deps |
| create-loom-app | scaffold entry | GENERIC | |
| scaffold | file templates + codegen | MOSTLY | `loom new` kinds include "sentinel" (tools/scaffold/src/templates.ts:203) |
| appgen | NL/spec -> app files | MOSTLY | English-only grammar, `{prompt:string}` baked into every generated flow (L7) |
| appgen-model | local-model planner | MOSTLY | package is Gemma/node-llama-cpp specific (src/GemmaProvider.ts, gemmaModels.ts) though planChangesModel takes any route |
| testing | createTestApp, VCR, crash harness | GENERIC | |
| eval | golden-log replay/diff | MOSTLY | named "eval" but is regression diffing; does not evaluate agent quality |
| deploy-sim | log-vs-new-flow compat check | GENERIC | |
| dst | deterministic simulation | GENERIC | |
| bench-throughput | internal benchmark | GENERIC | not user-facing |

Tally: 72 total = 41 GENERIC, 25 MOSTLY, 1 DOMAIN-SPECIFIC, 5 INERT.

## (b) Leaks by severity

### BLOCKS GENERIC USE (a class of app cannot be built, or is silently wrong)

L1. UI is a kernel syscall. `ctx.ui` is one of the ABI syscalls (packages/workflow-runtime/src/abi.ts:80-86, kind "accessor"),
constructed in every WorkflowContext (WorkflowContext.ts:1-2,168 `createSurfaceEmitter`), typed in the public
`ExecutionContext` (workflow-runtime/src/types.ts:1,201), and @loom/workflow-runtime has a hard `dependencies` edge on
@loom/agent-surface (the only non-kernel edge of any kernel package; computed from package.json). A headless/batch/voice/robotics
agent pays for and is versioned against a UI protocol. The layering guard (packages/spec/src/layering.ts:18-27) only forbids
kernel -> `plugins/*`, so this edge is invisible to it. `ctx.ui` is nothing but `ctx.emit("SURFACE_PATCH", ...)` (agent-surface/src/emitter.ts), and the
event is explicitly a userspace event the fold skips, so nothing in the kernel needs it.
Fix: move `ui` out of the syscall table into a userspace helper (`surfaceOf(ctx)` exported by @loom/agent-surface), drop the
dependency, bump KERNEL_ABI major or deprecate. Stay in 1P (agent-surface), leave the kernel.

L2. `@loom/orchestrator` is app policy shipped as a framework package. `autoApprovalAllowed(goal)` = `/low risk|automatically|auto[- ]?fix|auto/i.test(goal)`
(packages/orchestrator/src/approval.ts:12-13) - an English-only keyword regex over the user's goal decides whether a human is skipped; the bare `auto` alternative
matches "author", "automotive", "audit the auto-scaling..." so it also OVER-approves. `riskLevel === "low"` (approval.ts:42) is a string vocabulary
the framework does not define anywhere else. Comment admits "identical across every example orchestrator" (approval.ts:5-8): it is extracted example code.
`dispatchPlan` (src/dispatchPlan.ts) is a 15-line for-loop over `{steps}` with `DispatchResult{status:string; artifact}`.
Fix: delete from 1P; move to loom-examples (consumers: ex=3 in agent-swarm/db-command-center). If an approval seam is wanted, expose a
predicate-injected `decideApproval(policy: (req)=>boolean)` - not a regex. Placement: examples.

L3. The agent/LLM message model is text-only, so non-chat/multimodal agents hit a wall and tool calling is not round-tripped natively.
- `LlmMessage{role:"system"|"user"|"assistant"; content:string}` (packages/llm/src/types.ts:3-6) and `LlmResponse.content: string` (types.ts ~57): no image/audio/file parts,
  no `tool` role, no tool_use/tool_result blocks, no reasoning blocks.
- `agentLoop$` feeds tool results back as a *user* message of JSON text (packages/agent/src/agentLoop$.ts:385, toolResultContent.ts:19-23) and records the assistant's tool-call turn as
  the literal placeholder `"(tool calls)"` (agentLoop$.ts:454,480). The tool_use id the provider issued is dropped, so provider-native tool pairing is never used; the model sees prose, not its protocol.
- `AgentInput{prompt:string}` / `AgentOutput{content:string}` (packages/agent/src/types.ts:1-20): an agent cannot take a structured/multimodal task or return a typed result.
- Memory recall is coerced with `String(entry.content)` (agentLoop$.ts:329, AgentRunner.ts:151) although `MemoryEntry.content` is `unknown` (memory/src/types.ts:49): any non-string memory
  (the store promises round-trip of objects) becomes "[object Object]" in the prompt. Also `agentLoop$` only READS memory; nothing in it appends (grep: only recall at :319), whereas AgentRunner appends (AgentRunner.ts:287-288).
- Hardcoded routing strategy `"agent"` (agentLoop$.ts:441) and `"planning"` (planner/src/PlannerRuntime.ts:87) with no config override.
Fix: widen `LlmMessage.content` to `string | LlmPart[]`, add `tool_use`/`tool_result` parts (providers already map them), `AgentInput<T>`; fix the String() coercion (JSON.stringify non-strings). Stay 1P.

### AWKWARD (workable but a user must fork or work around)

A1. Closed resource-metering dimensions inside the kernel fold. `tokens,costUsd,ms,count,memBytes,wallMs,netBytes` are destructured by name in
packages/replay-vm/src/eventHandlers.ts:780-825, ceilinged by name in packages/workflow-runtime/src/userspaceEmit.ts:48-55, typed in `ResourceDimension`
(workflow-runtime/src/types.ts:209) and `ResourceSnapshot` (effect-runtime/src/types.ts:36-46), and `Budget` (middleware/src/metering.ts:41-48). An app that bills in
GPU-seconds, API calls, or credits cannot meter/quota it without a kernel + fold + ABI change (it took ADR 0032 to add three). The comment at metering.ts:3 states the
worldview ("scarce resource for intelligent software is tokens / $ / latency"). `costUsd` also hardcodes the currency.
Fix: a generic `custom: Record<string, number>` dimension map in the fold (additive, byte-identical for logs without it) with name-keyed budgets/ceilings. Kernel change, small.

A2. Closed `EffectKind = "tool"|"llm"|"human"|"a2a"` and `TaskKind` incl. "ui" (packages/core/src/types/definitions.ts:4,165) and `AgentDefinition` embedding A2A card metadata
(`AgentSkillDef`, `capabilities.streaming`, definitions.ts:313-360). Core therefore names one LLM-agent protocol. Kind is advisory so impact is naming/placement
(verify/rules.ts:219 checks `supported.includes(effect.kind)`, so an MCP/db effect has to lie). Fix: `EffectKind = string` with the four as well-known constants;
move card metadata into an A2A-owned `metadata?: Record<string,unknown>` extension. Stay 1P.

A3. Keyword fallbacks are ASCII-only and not replaceable. `CapabilityCatalog.find` (packages/capability/src/CapabilityCatalog.ts:97) and `SkillRegistry.find`
(packages/agent/src/SkillRegistry.ts:55) tokenize with `split(/\W+/)` + `length > 2`. In JS `\W` is ASCII-only: "café"-style accents fragment and CJK/Arabic/Cyrillic
queries yield zero terms, so offline intent/plan/skill selection silently returns nothing for non-English users. The sibling @loom/memory tokenizer already does it right
(`/[^\p{L}\p{N}]+/u`, memory/src/searchText.ts:19) - the duplication is the defect. No scorer seam on either class. Fix: share memory's `tokenize` (or accept `scorer`). 1P.

A4. Planner/Intent prompts are hardcoded English and the plan shape is one kind. System prompts at planner/src/PlannerRuntime.ts:68-70 and intent/src/IntentRuntime.ts:77-79,
no `systemPrompt`/`format` option; `Plan = {goal, steps:[{capabilityId, rationale?}]}` (PlannerRuntime.ts:7-15): a linear list, no per-step input binding, no dependencies/parallel
edges, no typed arguments, so a plan cannot be executed without an app-written glue (this is why dispatchPlan/orchestrator exists). Intent `confidence` is hardcoded 1
for model routes (IntentRuntime.ts:~85). `llmSkillSelector` prompt likewise (agent/src/SkillSelector.ts:38). Fix: `prompt`/`parse` overrides + `PlanStep.input?`/`dependsOn?`. 1P.

A5. Cron is UTC-only with no timezone seam (packages/core/src/builders/schedule.ts:5; workflow-runtime/src/cron.ts:1-11). "09:00 local, DST-aware" cannot be expressed; the
determinism rationale is sound but a `tz` IANA field resolved at schedule-registration (recorded in TIMER_FIRED) would keep determinism. 1P/kernel-light.

A6. `learning` is shaped for one-step discrete choice: `Policy.select(context, actions[])` returns one action + propensity (packages/learning/src/types.ts:27-45) and the
evaluator is SNIPS over such records. Continuous actions, sequential credit (beyond a terminal-reward assignment), or ranking/slate decisions need a different record. The substrate
is honestly labelled "not RL", so MOSTLY; note that "learning" over-promises. Keep, but document the bandit scope in the package name/description.

A7. @loom/app carries example-conductor leftovers (packages/app/src/): `BroadcastingProjectionRuntime` (constructor `missionId`, SSE comment, filters `SURFACE_PATCH` for one mission,
BroadcastingProjectionRuntime.ts:11-21,58), `InProcessA2ABus` ("This app runs entirely in the browser", InProcessA2ABus.ts:9-14; `onApproval` HITL baked in) and `progressHub`
(process-wide singleton; `onReport` is ONE subscriber per execution, `subscribers.set` overwrites, progressHub.ts:18; second subscriber silently steals the first's feed). All
three are consumed only by loom-examples (ex>=1 each), not by `defineConfig` itself except the bus. Fix: move Broadcasting/progressHub to examples or a `@loom/plugin-*`; make hub
multi-subscriber. `defineConfig` also hard-links `@loom/plugin-a2a` and `@loom/agent-surface` (defineConfig.ts:2,46,1124-1125) for two boolean flags - protocol choice in the composition root.

A8. @loom/sdk "umbrella" forces everything: `export *` of llm, reasoning, agent, both protocol plugins, agent-surface, blueprint-runtime, terminal renderer (packages/sdk/src/index.ts:1-31) and hard
`dependencies` on plugin-postgres/-sqlite/-sandbox (package.json:40-60) so `pnpm add @loom/sdk` installs pg/better-sqlite3/WASM even for a UI-less, DB-less app, despite the lean-import comment (index.ts:11-14).
Zero examples import it. Fix: delete, or make store/sandbox plugins optional peer deps.

A9. Opinionated wording in UI renderers: "No pending approval" (plugins/renderer-react/src/renderers/ApprovalCardRenderer.tsx:46), "no rows" (DataTableRenderer.tsx:26), defaults "Approve"/"Reject"
(ApprovalCardRenderer.tsx:39-42; renderer-terminal/src/defaultRegistry.ts:88-89), `WidgetAction.type` "APPROVE"/"REJECT". Labels are overridable for the buttons only; empty-state text has no prop/i18n hook.
Also the built-in widget vocabulary is dashboard-shaped; fine given `customWidget$`.

A10. appgen is English- and shape-bound: grammar "create a <name>" / "use <model> first" / "elevate to" / "pause for approval" (tools/appgen/src/parseIntent.ts:15-33,
regexes at ~40-60); `slug` strips non-[a-z0-9] so a non-Latin name collapses to "app" (parseIntent.ts:3-9); every generated flow is `FlowRunner<{prompt:string},{result:string}>`
with `z.object({prompt: z.string()})` (tools/appgen/src/generate.ts:60,69; stepTemplate.ts:24) - generated apps are LLM-chat-shaped by construction (also seen in the stub body
`async (input:{prompt:string})`, stub.ts:13). Documented as an offline deterministic default, replaceable by the model path, so MOSTLY.

### COSMETIC

C1. Hard-coded vendor model defaults that go stale: "claude-opus-4-8" (packages/llm/src/providers/AnthropicProvider.ts:46), "gpt-4o" (OpenAiProvider.ts:60), "gemini-2.0-flash"
(GeminiProvider.ts:36). Vendor adapters live inside the SPI package @loom/llm (index.ts:20-25); acceptable (fetch-only, baseUrl/model configurable), but a required `model` would be more honest and the adapters could be separate plugins.
C2. `UNTRUSTED_CONTENT_SYSTEM_NOTE` is an English constant (packages/llm/src/untrusted.ts:61) appended by `groundedRequest` (knowledge/src/prompt.ts); no locale option.
C3. @loom/analytics advice strings are English and USD-formatted ("Prefer model ... for future routing", "Set a cost budget near $...", advisory.ts:175,187); the `RecommendationKind` set is
"model-ranking"|"budget"|"hot-failure" (advisory.ts:21) - LLM-ops vocabulary in a log-analytics package.
C4. Domain-branded metadata: "db-copilot infra" in plugins/read-model/package.json:4, plugins/read-model/src/types.ts:3, plugins/sentinel/package.json, packages/conformance/src/index.ts:2010,
packages/event-runtime/src/types.ts:12, plugins/sqlite/src/SqliteContentStore.ts:13; example names referenced from packages/spec/src/capabilities.ts:223,547. No code impact; scrub.
C5. `ExecutionPolicy` names `gpu`, `"cloudrun:svc"`, `memoryScope` (packages/core/src/types/execution.ts:139-150) - opaque advisory fields, harmless.
C6. `loom new sentinel` is a first-class scaffold kind (tools/scaffold/src/templates.ts:203) - one preset elevated to a peer of flow/agent/tool.
C7. appgen-model: GemmaProvider/`GEMMA_TIERS` (tools/appgen-model/src/gemmaModels.ts:19-37) make a generic "plan with a local model" tool Gemma-named; the provider is the only Gemma-specific piece.
C8. tools/eval is named "eval" but only does golden-log diffing (tools/eval/src/eval.ts); an agent-quality eval harness (datasets/scorers) does not exist, so the name over-promises.
C9. Duplicate private `stableId` hash in blueprint-runtime/src/widgets.ts:5 and customWidget.ts:3.

### Checked and CLEAN (do not re-sweep)
- Domain nouns (database/sql/dashboard/incident/ticket/release/genui/gx-) in core, event-runtime, replay-vm, effect-runtime, workflow-runtime, scheduler: none in code (hits were "genuinely", comments, bench fixtures).
- Hardcoded tool/effect-id semantics: none (`toolId ===` grep empty).
- Approval/"human" semantics in kernel: none; APPROVAL_GRANTED is a generic audit fold (replay-vm eventHandlers.ts:688).
- Single-tenant/single-user: TenantScopedEventStore, principal chains, fair-scheduler exist.
- Storage engine assumptions in non-storage packages: none; cli/stores.ts:10-20 is deliberately backend-neutral.
- Memory (`content: unknown`, unicode tokenizer, id round-trip) and knowledge are text-agnostic enough.
- Taint/classify, compliance, verify, dst, testing, compiler: no leaks found.

## (c) Dependency / layering findings
Graph computed from package.json `dependencies` (workspace edges) across packages/plugins/tools.
1. workflow-runtime -> agent-surface: the single kernel edge to a non-kernel package (L1). Guard blind spot: packages/spec/src/layering.ts forbids only kernel/SPI -> `plugins/*`
   (layering.ts:18-27, findLayeringViolations); extend it to forbid kernel -> any non-KERNEL_PACKAGES package.
2. Kernel/SPI packages are otherwise clean: core/event-runtime/snapshot-runtime/replay-vm/effect-runtime/scheduler/wire-abi depend only on kernel packages.
3. Feature-SPI types live in feature plugins, so storage engines depend on features: plugin-postgres and plugin-sqlite import `DurableStateStore`/`RevisionConflictError`
   (plugin-durable-state), `ReadModelStore` helpers `assertPurgeFilter/clampQueryLimit/parseQueryCursor` (plugin-read-model) and sqlite imports plugin-content (sqlite/src/SqliteDurableStateStore.ts,
   SqliteReadModelStore.ts, SqliteContentStore.ts; postgres/src/PostgresDurableStateStore.ts, PostgresReadModelStore.ts). Result: a Postgres-only app that never uses read models still installs
   plugin-read-model/durable-state, and a 3P store for those seams must depend on a feature plugin. Fix: SPI + pure helpers into a neutral package (or @loom/plugin-kit).
4. plugin -> plugin edges: mcp-app -> a2ui + mcp; cloudrun -> worker-remote; sentinel -> content, durable-state, middleware; sqlite/postgres -> kit/durable-state/read-model/content.
   mcp-app->a2ui is legitimate (it reuses the catalog validator); sentinel is a pure bundler.
5. UI stack is triplicated without a shared core: agent-surface (SURFACE_PATCH state tree), blueprint-runtime (widget IR), plugin-a2ui and plugin-mcp-app (wire projections of agent-surface),
   plus renderer-react/terminal over blueprint. renderer-react depends on workflow-runtime + projection-runtime + agent-surface + blueprint-runtime; plugin-a2ui depends on both agent-surface and blueprint-runtime.
   Two vocabularies (surface paths vs widgets) for "agent drives a UI" is real duplication a newcomer must choose between.
6. @loom/app depends on 19 workspace packages incl. plugin-a2a and agent-surface, and tools/cli on 22 incl. app/appgen/learning/knowledge: acceptable for top-level composition, but `app` is the
   only way in for config, so its protocol/UI defaults are effectively framework defaults (A7).
7. @loom/spec depends on compiler, plugin-content, wire-abi and dispatcher: a docs/manifest package reaching into a tool and a plugin; benign but inverts tiers.
8. No cycles found among package.json edges.

## (d) INERT or redundant
Evidence = no importer in packages/*/src, plugins/*/src, tools/*/src (test files excluded) AND no import in loom-examples / loom-plugins / loom-demo.
- @loom/replay-inspector (1,102 loc): ex=0, zero src importers; the CLI's `inspect` is a separate implementation (tools/cli/src/inspector.ts imports only core/event-runtime/./core/./trace). Delete or make the CLI use it.
- @loom/isolate (1,231 loc): ex=0, zero importers; plugin-sandbox cites it only in comments (plugins/sandbox/src/types.ts:5, SandboxWorkerPool.ts:147). Overlaps plugin-sandbox (both are "run untrusted
  tool code with limits"). Keep one; move the other to loom-plugins.
- @loom/saga (107 loc) and @loom/fair-scheduler (322 loc): ex=0, zero importers (only spec/capabilities.ts names them). Move to examples/3P or delete.
- @loom/plugin-sentinel (111 loc): ex=0; only the scaffold template emits it. The db-sentinel example uses `sentinelState` directly. Fold into scaffold output or delete; drop `loom new sentinel`.
- @loom/orchestrator (102 loc) - not inert (ex=3) but wrong tier: move to examples (L2).
- @loom/sdk: zero importers anywhere; pure re-export (A8). @loom/registry: 44 lines, only sdk + a comment in plugin-a2a; ex=4 but trivial.
- Redundancy: `agentStep$` vs `agentLoop$` vs `AgentRunner` (three agent loops; agentLoop$ doc admits AgentRunner "fakes" the decide seam, agentLoop$.ts:70-80) - pick one canonical;
  `IntentRuntime` + `PlannerRuntime` + `capability` duplicate the same prompt/complete/scheduler plumbing (`complete()` copied in both: IntentRuntime.ts:~100-125, PlannerRuntime.ts:~76-100).

## Top fixes by value
1. Take `ctx.ui` + the agent-surface dependency out of the kernel (L1) and harden the layering guard.
2. Widen the LLM message/agent I/O model beyond text; fix `String(entry.content)` (L3).
3. Open the metering dimensions (A1).
4. Delete @loom/orchestrator from 1P (L2).
5. Replace `\W+` tokenizer with memory's unicode tokenizer, add a scorer seam (A3).
6. Prompt/plan-shape seams for planner/intent (A4).
7. Move Broadcasting/progressHub/InProcessA2ABus out of @loom/app; multi-subscriber hub (A7).
8. Prune 5 inert packages + sdk (section d).
9. Move feature-SPI types out of feature plugins (c.3).
10. Timezone seam for schedules (A5).
