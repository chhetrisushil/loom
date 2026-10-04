# A-kernel: Loom kernel audit (main 3d2056e)

Method: code only. Every claim cites `path:line` (paths under `packages/`). Where a number is MEASURED, the throwaway scripts are in [`2026-10-05-agentic-readiness-experiments/`](2026-10-05-agentic-readiness-experiments/) (run from the repo root with `node docs/requirements/2026-10-05-agentic-readiness-experiments/expN.cjs` after `pnpm build`) (run against built `dist`, nothing in the repo touched).

## 0. What the kernel actually is

- **Syscall table** `KERNEL_SYSCALLS`, `workflow-runtime/src/abi.ts:33`, ABI 1.2.0 (`abi.ts:18`): `execute, run, decide, parallel, suspend, sleep, sleepUntil, emit, stream, ui` (10 entries). `ExecutionContext` interface: `workflow-runtime/src/types.ts:113-202`. It also has `negotiateBudget` (`types.ts:145`), which is NOT in the syscall table (table/interface drift, minor).
- **Event schema** 1.22.0, fold handlers in `replay-vm/src/eventHandlers.ts` (`EVENT_SCHEMA_VERSION` at :968). Fold = `foldEvents` (`replay-vm/src/foldEvents.ts`), 94 lines.
- **Execution model**: the flow body is a plain async function RE-RUN FROM THE TOP on every resume/recovery; each syscall is served from the fold (`WorkflowContext.ts:243` `execute` short-circuits on `vm.hasCompleted`; `suspend` consumes ordered passthroughs `:690-:735`). This is replay-by-re-execution, not a VM with an instruction pointer. Everything below follows from that.
- **Real kernel**: core (types only, 1.5k lines), replay-vm, snapshot-runtime, event-runtime (EventStore/BranchRegistry/LeaseStore/TimerStore SPIs), effect-runtime (registry, authz, middleware seam), workflow-runtime (the interpreter + a lot of lifecycle), scheduler (ephemeral concurrency), wire-abi (fold test vectors), dispatcher/worker-runtime(-local) (compute SPI).
- **Not kernel-owned**: `MemoryStore` is `packages/memory/src/types.ts:124`; `ContentStore` is `plugins/content/src/ContentStore.ts`; claim-check is `packages/middleware/src/claimCheck.ts` (default inline cap 16 KiB at :137). Child orchestration/saga/live-query are 1P packages.
- Size smell: `workflow-runtime` = 7,832 lines; `WorkflowRuntime.ts` alone 2,446; a large share is legacy-repair machinery (`blankStream.ts` 631, `strayPassthroughs.ts` 232, `orphanCensus.ts` 157, `recoverAbandoned.ts` 391, `LogLifecycle.ts` 712) plus ADR 0104/0105/0107 compatibility branches inside `resume`/`resumeAs` (`WorkflowRuntime.ts:1435`, `:800-:880`).

## 1. Genericity

Verdict: the kernel is **mostly generic and notably vendor-free** (no SQL/dashboard/incident/release/LLM-vendor strings in core, workflow-runtime, effect-runtime, replay-vm, snapshot-runtime, event-runtime, dispatcher, worker-runtime, scheduler; grep over those `src` trees for database/dashboard/sql/incident/release/genui/blueprint/openai/anthropic/gemini/claude/gpt returned only unrelated `release()` lease methods and one `SURFACE_PATCH` test vector). The leaks are conceptual, not name-level:

| # | Leak | Evidence | Severity |
|---|------|----------|----------|
| G1 | **UI is a syscall.** `ctx.ui` is a kernel ABI accessor and `workflow-runtime` depends on `@loom/agent-surface` (which pulls `classify` + `projection-runtime`). | `workflow-runtime/src/abi.ts:81-86`; `WorkflowContext.ts:1-2,169`; `types.ts:1,201`; `workflow-runtime/package.json` dependencies list `@loom/agent-surface`; `agent-surface/package.json` deps `classify, projection-runtime`. `ui` is just `emit` of surface patches (`WorkflowContext.ts:169`), so it needs no kernel slot. | High (violates own minimality; couples kernel build graph to a UI package) |
| G2 | **LLM/agent vocabulary in kernel types.** `EffectKind = "tool"\|"llm"\|"human"\|"a2a"`; `TaskKind` adds `agent, ui, memory, plan`. `kind` is "advisory" yet `kindOf(...) === "human"` changes replay semantics. `a2a` is a named external protocol. | `core/src/types/definitions.ts:4,165`; semantic use `WorkflowContext.ts:~246` (`isHuman`), `effect-runtime/src/EffectRuntime.ts:kindOf` | Medium (closed enum blocks e.g. `"sensor"`, `"robot"`, `"payment"` kinds without a core edit) |
| G3 | **LLM economics baked into the fold.** `RESOURCE_METERED` folds `tokens`, `costUsd`, `ms`, `memBytes`, `wallMs`, `netBytes` into a fixed `_resources` shape with a fixed ceilings table; `DecideOptions` has `estimatedCostUsd`. `ResourceDimension` is a closed union. | `replay-vm/src/eventHandlers.ts:780-828`; `workflow-runtime/src/userspaceEmit.ts` `METER_CEILINGS`; `types.ts:75` (`estimatedCostUsd`), `types.ts:209` (`ResourceDimension`) | Medium (a non-LLM resource, e.g. GPU-seconds or API credits, cannot be metered by the kernel's own mechanism) |
| G4 | **Policy-shaped audit events are kernel event types**: `SAFETY_BLOCKED`, `EGRESS_DENIED`, `EFFECT_DENIED`, `EXECUTION_DENIED`, `QUOTA_EXCEEDED`, `OUTCOME_RECORDED`, `APPROVAL_GRANTED`, `PAYLOAD_SHREDDED`, `ERASURE_PENDING`. They are "pure audit" lists in `variables` (`_safety`, `_outcomes`, ...). Userspace is allowed to append several of them (`USERSPACE_KERNEL_EVENTS`). | `eventHandlers.ts:441,462,543,565,592,688,711,732,829`; `userspaceEmit.ts:~25-34` | Low-Medium (every one is a permanent ABI member forever; most could be plain app events that a lens reads) |
| G5 | **Built-in cron** `ScheduleDefinition` with UTC 5-field cron and the `schedule$` builder live in `@loom/core`. | `core/src/types/definitions.ts:~196-214`; `core/src/index.ts` exports `schedule$` | Low |
| G6 | **Agent/skill/memory/projection definitions in core.** `AgentDefinition`, `SkillDefinition`, `MemoryDefinition`, `AgentSkillDef` (A2A card metadata), `ProjectionDefinition` are all in `@loom/core` types though the runtime never reads them. | `core/src/types/definitions.ts:~48-60,~244-360`; exported `core/src/index.ts:36-70` | Low-Medium (core "stays dependency-light" but is semantically the vocabulary of one application style) |
| G7 | **English strings as semantics**: `EXECUTION_RECOVERED`, `EffectInDoubtResolved`, `TIMER_FIRED`, reserved prefixes `__loom_`, `effect:` are string-typed protocol names. Gate matching is by exact string `on`. Not English-sentence parsing, so fine. No finding of natural-language-as-control-flow in the kernel. | `types.ts` constants; `WorkflowRuntime.ts:787` | Info |

Opinionated in a way that BLOCKS a use (not just taxing it):
- **O1: one live park per execution, resume refused while running.** `assertResumable` rejects any resume unless `status === "suspended"` and the event name equals the single recorded gate (`WorkflowRuntime.ts:770-795`). Measured: `resume` during a busy step throws `ResumeRefusedError not-suspended` (`exp2.cjs` test 1). So an external message arriving while the agent is thinking is lost/rejected unless the caller retries. Blocks inbox/mailbox/actor-style agents without an out-of-kernel durable inbox.
- **O2: flow code hash ignores the flow body.** `flowContentHash` hashes only id, version, deadline, and the declared step list (FNV-1a 32-bit, `core/src/flowHash.ts:44-71`); the file's own comment says a body-only edit "folds an existing log identically" (`flowHash.ts:16-19`). That is false for any edit that changes control flow (the log's recorded step ids are served positionally by id, but a changed branch can take a different path). Replay-by-re-execution + no body fingerprint = silent divergence risk for exactly the long-lived agents that survive deploys.
- **O3: flow runners are in-process closures keyed by structural hash**, so serving an old in-flight execution requires the old runner code to still be registered in the same binary (`WorkflowRuntime.ts:573-612`, `:954-985`). There is no code-by-reference. See 2a.

## 2. Primitive sufficiency

Legend: OK supported, FRICTION supported-with-friction, NO not supported.

### 2a. Long-lived / perpetual agents

| Aspect | Status | Evidence |
|---|---|---|
| Snapshot + compaction exist | OK | `LogLifecycle.compact` (`LogLifecycle.ts:601-701`), `truncatePrefix(Keeping)` (`event-runtime/src/types.ts` SPI 1.5.0); periodic snapshot `snapshotEvery` (`WorkflowRuntime.ts:2150`) |
| Bounded history for ONE ever-running execution | **NO** | No `continue-as-new`/rotate in code (grep over packages/plugins/tools: zero hits; only ADR text defers it, `docs/adr/0052`). Compaction only truncates the LOG; the folded STATE is never pruned: `frames` (one per stepId, `eventHandlers.ts:210-248`, holds both `input` and `output`), `_decisions`, `_resumePayloads`, `_outcomes`, `_resources` all grow monotonically and ride every snapshot. |
| Cost per turn of a message-loop agent | **NO (measured quadratic)** | `exp.cjs`: flow = `while(true){ msg = await ctx.suspend; await ctx.execute(step#i) }`. Per-resume latency (in-memory stores) 0.14 ms at turn 250 -> 0.9 ms at 1500 -> 4.2 ms at 6000; runner re-ran from top 6001 times; folded state 1.2 MB at 6000 turns with trivial payloads. Cause: re-execution from the top (`WorkflowRuntime.ts:1445-1460`, `execute` runs `runner(ctx,input)` at :2290) plus `resume` reading the ENTIRE log every time (`:1347`, `:1500`, `:1734`: `eventStore.read(executionId)`, used for legacy stray-passthrough inspection `:858`), plus a full-state snapshot written on EVERY suspend (`:2369`, not gated by `snapshotEvery`). |
| Live commit cost within one execution | **NO (measured quadratic)** | `exp5.cjs`: `ReplayVM.applyEvent(STEP_COMPLETED)` x5,000 = 2.4 s, x20,000 = 41.7 s (killed at 40k). `applyEvent` is `foldEvents([event], state)` (`ReplayVM.ts`), which calls `resetFoldOwnership()` per event (`foldEvents.ts`), so `setFrame` copies the whole `frames` record each time (`eventHandlers.ts:28-37`). The "O(1) amortized" ownership optimisation only applies within a multi-event fold, not the live path. |
| `DECISION_RECORDED` fold | **NO (measured quadratic)** | `exp4.cjs`: replaying 5k/10k/20k decisions = 2.3 s / 9.9 s / 41.9 s, whereas 20k STEP_COMPLETED fold in 5 ms. Handler spreads `_decisions` per event (`eventHandlers.ts:410-418`). A learning-heavy agent (1 decision per step) hits this first. |
| Timers / sleep at long horizons | OK | `sleep/sleepUntil` record absolute `wakeAt` once (`WorkflowContext.ts:743-750`); `TimerService` polls a `TimerStore` (`TimerService.ts:203`); `armDeadline` chunks past 2^31-1 ms (`deadlineTimer.ts:1-40`). Caveat: with no `timerStore` wired the `wakeAt` is silently not scheduled (warns once, `WorkflowRuntime.ts:2318-2335`). |
| Versioning a RUNNING agent | **FRICTION, with a correctness hole** | Pin by flow hash to a still-registered older runner (`WorkflowRuntime.ts:954-985`); `resumeAs` + `transformState` for explicit migration (`:1478-1560`). Holes: (i) hash excludes the body (O2); (ii) `replay-check` refuses any execution that used dynamic step ids because it demands every recorded frame id exist in `definition.steps` (`WorkflowRuntime.ts:1531-1538`) while the step-identity rule tells agents to mint `id#n` dynamically (`flowHash.ts:22-31`), so replay-check is unusable for exactly the dynamic agents; (iii) a pinned old version requires the old closure to be shipped in the binary forever (no code-by-hash store). |
| Schema evolution of persisted events | OK | Additive-only rule + pinned `knownEventTypes()` (`eventHandlers.ts:~895-968`, 22 minor versions); snapshots re-read through `normalizeSnapshotState` (`foldEvents.ts`). Payload shapes are not versioned per event (consumer must tolerate absence); no upcaster registry. |

Placement: continue-as-new/state pruning => **KERNEL** (needs fold-semantics change: a "carry-forward" checkpoint that drops frames, or an incremental/keyed state). The quadratic fold costs and full-log reads are plain **KERNEL bug-fixes** (no ABI change). Code-by-hash registry + body fingerprint => **KERNEL** (hash) + **1P** (registry).

### 2b. Dynamic, runtime-composed control flow

Status: **OK-with-friction; determinism holds when the step-id rule is obeyed.**
- Plans invented at runtime work because the flow is arbitrary JS and every durable unit is `ctx.execute(TaskDefinition)` keyed by caller-minted `task.id` (`WorkflowContext.ts:243-290`); loops of unknown bound, recursion, and data-dependent branching are just JS. Replay holds if the SEQUENCE of ids is a pure function of logged facts (documented at `WorkflowContext.ts:236-242`, `flowHash.ts:22-31`). Nothing in the kernel ENFORCES it: a flow that branches on `Date.now()`/`Math.random()` silently diverges (there is no `ctx.now()`/`ctx.random()` syscall; the only way to capture time/randomness is `ctx.decide`). `@loom/verify` is outside this audit's scope.
- Friction: a task's `toolId` must already be registered in the process-local `EffectRuntime` registry (`EffectRuntime.ts:19,38`; `execute` throws `No effect registered` at :69-71). So an agent can invent a plan over a FIXED tool menu, not invent a new tool. Any worker that resumes must have identical registrations (not recorded or checked in the log).
- Friction: `ctx.parallel` only accepts `[StepDefinition, input][]` tuples (`types.ts:151`, `WorkflowContext.ts:666-684`); arbitrary concurrent sub-flows must be hand-rolled with `Promise.all(ctx.execute(...))`, which works but gets none of the limit/ordering help.
- Spawning children dynamically: no syscall. `ctx` has no `spawn/child/startExecution`; it must be done as an effect that calls `runtime.start` (see 1P `@loom/orchestration`). Replay-safe only because the effect result is journaled.

### 2c. Nondeterminism capture and streaming

- LLM output / external reads: OK via `ctx.execute` (STEP_COMPLETED output replayed) and `ctx.decide` (`WorkflowContext.ts:539-618`, records `choice` + optional `alternatives/context/policy`; replay never re-calls the decider).
- Randomness / time: **NO syscall**. Only `decide`. `wakeAt` is the one sanctioned wall-clock entry (`WorkflowContext.ts:743-750`). Friction, kernel-level: a `ctx.now()`/`ctx.random()` pair is 2 trivially-orthogonal `decide` wrappers; could be **1P helper** (built on `decide`), but without it nothing stops the nondeterministic default.
- Streaming: **FRICTION / partial.** `ctx.stream` = `ctx.emit({delta,done})` (`WorkflowContext.ts:686-688`); inside a step `EffectContext.emit` appends events immediately (`effect-runtime/src/types.ts:72`, `WorkflowContext.ts:~348`), serialised through a FIFO write queue (`ExecutionJournal.ts:enqueue`). Partial deltas that were enqueued before a crash may be persisted, but: (a) a step is the unit of durability, so after a crash the whole step re-runs (the LLM call restarts, tokens regenerate and are emitted AGAIN, un-stamped, with no attempt tag in the payload); (b) flow-level `ctx.stream` stamps every distinct digest and the fold keeps one `_flowEmits` leaf entry per distinct stamped emit (`eventHandlers.ts:80-110`), so per-token streaming from flow code grows fold state without bound; (c) no resume-from-partial primitive. Placement: **1P** (stream-chunk step protocol with attempt id + checkpoint) is feasible; the `_flowEmits` growth for token streams needs a **kernel** guard or a documented rule to stream only from inside effects.

### 2d. Concurrency

- `ctx.parallel` with `limit`, input-order results (`WorkflowContext.ts:666-684` over `scheduler/src/structured.ts:27`). OK.
- **Structured concurrency is incomplete (measured).** `parallel` deliberately does NOT forward the per-task abort signal (`WorkflowContext.ts:670-673`), so failFast cannot cancel siblings. `exp3.cjs`: a branch that calls `ctx.suspend` while a sibling step is running parks the execution (`EXECUTION_SUSPENDED` appended, handle resolves) and the sibling's `STEP_COMPLETED` is appended AFTER the suspend (log: `...EXECUTION_SUSPENDED, STEP_COMPLETED`). The kernel has an entire reserved fold flag for this (`_failedWhileParked`, ADR 0105, `eventHandlers.ts:~150-170`). Orphan work + writes after park.
- Concurrent waits: **NO.** `suspendedOn` is a single condition (`core/src/types/execution.ts` `ExecutionState.suspendedOn`); `Promise.all([ctx.suspend(A), ctx.suspend(B)])` throws on the first and records only gate A (`exp2.cjs` test 2). Passthrough payloads are positional (`WorkflowContext.ts:731-736`) not keyed by gate name, so two logically independent waits cannot be consumed out of order. No `select`/race across signals.
- Fan-out at scale: a single execution's frames record makes thousands of parallel steps O(N^2) (measured above: 5k = 2.4 s, 20k = 42 s). Fan-out to thousands is viable only as child EXECUTIONS (1P orchestration), not as in-execution steps.
- Cancellation: OK. `cancel()` is durable, fences first if not live (`WorkflowRuntime.ts:1022-1060`), AbortSignal threaded to effects (`WorkflowContext.ts effectCtx`). Deadlines: flow-level `deadlineMs` anchored to logged start (`WorkflowRuntime.ts:2218-2236`), step `timeoutMs` anchored to first logged attempt (`WorkflowContext.ts:~362-395`). Good.

### 2e. Communication into a running execution

Status: **NOT supported as a primitive; only point-to-point gate answers.**
- Inbound path is `runtime.resume(id, {eventType, payload})` (`WorkflowRuntime.ts:1336`), valid only while parked on that exact event name (:770-795), single-slot. No mailbox/queue/inbox in the kernel; no way for flow code to `receive` multiple pending messages, or to `select` on messages vs timer (a timed suspend has exactly two wakes: the gate or TIMER_FIRED, :784-790).
- Typed HITL: **OK.** `flow$({resumeSchemas})` parses and persists the parsed payload before append (`core/src/types/definitions.ts:~158-180`, `WorkflowRuntime.ts:1431`), `ctx.suspend<T>` typed (`types.ts:177`), optional `ResumeAuthenticator` for signed approvals (`WorkflowRuntime.ts:1415`).
- Inter-execution request/response and pub/sub: nothing in `ExecutionContext`; 1P `@loom/orchestration` and `plugin-a2a` do it over `resume`. ADR 0052 itself says the "stable address" problem (route by logical name, not executionId) is unsolved.
- Perf consequence for an inbox agent: each message is `_resumePayloads` forever (2a).
- Placement: a **durable per-execution inbox** (append a MESSAGE event when not parked; `ctx.receive()` consumes in order; `ctx.select`) needs the **KERNEL**: it changes `assertResumable` and the passthrough model. A 1P inbox keyed by chain id is possible but cannot make "append while running" atomic with the fold.

### 2f. Large and binary payloads

Status: **FRICTION; kernel has no policy.**
- No size limit or content-address concept in any kernel path: `STEP_STARTED` stores `input` inline in the frame (`eventHandlers.ts:210-228`), `STEP_COMPLETED` stores `output` (:230-248), resume payloads go straight into `_resumePayloads` (:363-388), emit payloads unrestricted. The only cap is on typed-failure payloads, 16 KiB (`WorkflowContext.ts:33,498`).
- Claim-check is middleware on effect outputs (`packages/middleware/src/claimCheck.ts:137`, 16 KiB default); resume payloads (a user turn carrying an image) and step inputs are not covered by the kernel, and everything lands in snapshots (`ExecutionState.frames[*].input/output`).
- No byte-streaming primitive anywhere (SPI is `append(envelope)` JSON). Binary has to be by-reference through `plugins/content`. That is the right architecture; the gap is no kernel-enforced "inline cap" guard and no ref type the fold understands (so GC/retention of blobs depends on app sweeps). Placement: **1P** for ContentStore + refs; **KERNEL** only for a configurable inline-size refusal at `commit`.

### 2g. Identity, tenancy, security

- Principal propagation: OK. `RunOptions.principal` (`WorkflowRuntime.ts` types `RunOptions` :269) -> `EffectContext.principal` -> `CapabilityAuthorizer` before registry lookup (`EffectRuntime.ts:56-70`); denial is a journaled `EFFECT_DENIED`. Delegation with signed attenuable tokens (`effect-runtime/src/authz.ts:161-330`, HMAC secret). `ctx.decide`'s scope inherits the principal (`WorkflowContext.ts:~556-580`).
- **Fail-open lifecycle authz**: `authzDenial` returns "allowed" whenever `principal === undefined` (`WorkflowRuntime.ts:464`), i.e. an unauthenticated `resume`/`cancel`/`loadState` call passes the `ExecutionAuthorizer`. Stated design ("trust-boundary model"), but it means authorization depends on every ingress remembering to attach a principal.
- `ResumeAuthenticator` is optional (`WorkflowRuntime.ts:633 hasResumeAuthenticator`); default resume is unauthenticated.
- Tenancy: decorators `TenantScopedEventStore` / `TenantScopedSnapshotStore` (232 + 65 lines) scope ids; kernel itself has no tenant concept beyond opaque `PrincipalChain.tenant`. OK as a design.
- Fencing/leases: `acquireFence` monotonic token stamped into `metadata.fence`, store rejects older (`event-runtime/src/types.ts` K9.4; `ExecutionJournal.ts:build`); `LeaseStore` with store-clock expiry (`event-runtime/src/leases.ts:1-80`), `recoverAbandoned`. OK, thoughtfully done. Caveat from 2d: post-suspend sibling writes depend on fence rejection to be safe.
- Userspace-emit guard prevents forging kernel events (`userspaceEmit.ts`, `WorkflowRuntime.ts:759`). Good.

### 2h. Introspection for self-aware agents

- From INSIDE a flow: **NO.** `ExecutionContext` exposes no read of its own history/state/frames, no `ctx.fork`, no `ctx.query(otherExecution)` (`types.ts:113-202`). A flow can only observe via effects.
- From OUTSIDE (runtime API): OK. `loadState` (`WorkflowRuntime.ts:1644`), `fork(parent, atSequence)` (:1768, prefix copy, re-registers the forked gate's timer, metadata `forkedFrom/forkSequence`), `BranchRegistry` lineage (`event-runtime/src/BranchRegistry.ts`), `replay-inspector`, `analytics`. Counterfactual simulation is therefore possible but orchestrated by a supervising process, not the agent. Placement: an in-flow `ctx.history()`/`ctx.fork()` would be an **effect over the runtime** (1P), replay-safe because its result is journaled; no kernel change required, but the kernel needs to hand effects a runtime handle (today `EffectContext` has none).
- Observability hook: `onEvent` synchronous callback (`ExecutionJournal.ts commit`), `onStorageError`, `telemetry` package. OK.

### 2i. Learning hooks

Status: **OK for online decisions; NO for delayed credit.**
- `DECISION_RECORDED` carries `choice, rationale, source, alternatives, estimatedCostUsd, estimatedLatencyMs, confidence, context, policy{id,version,propensity}` (`eventHandlers.ts:390-440`, `WorkflowContext.ts:~600-618`); effect-side decisions are namespaced to step+attempt (`userspaceEmit.ts effectDecisionId`). `OUTCOME_RECORDED{key,success,score,decisionId}` links reward to decision (`eventHandlers.ts:565-590`).
- Gaps: (1) `propensity`, `context` are unvalidated free-form (no range check that propensity is in (0,1], no schema); they are "descriptive only", so a mis-logged decision silently poisons off-policy estimates. (2) **No kernel API to attach an outcome to a decision after the execution is finished**: `OUTCOME_RECORDED` can only be appended through `ctx.emit`/`EffectContext.emit` of a LIVE run (`analytics/src/outcomes.ts:36-45` takes an `OutcomeSink = {emit}`), `resume` refuses non-suspended executions (`WorkflowRuntime.ts:770-777`), and terminal executions are re-openable only via `resumeAs` (a code-migration verb). Rewards that arrive days later (user feedback, business KPI) have no first-class home; they must live in a side store keyed by `(executionId, decisionId)`. (3) `_decisions` quadratic fold (2a). Placement: late outcome append = **KERNEL** (an `annotate(executionId, fact)` that appends a non-state-changing audit event to a terminal log and is legal under fencing) or **1P** side-table; `propensity` validation = **KERNEL** (tiny).

### 2j. Distribution, scale, delivery semantics

- Multi-worker: dispatcher SPI (`dispatcher/src/types.ts`), `PlacementDispatcher`, `SupervisingDispatcher`, `WorkerRuntime{allocate,execute,release,cancel?}` (`worker-runtime/src/types.ts`), fencing on re-dispatch. The `ExecutionResult.state` returns the full folded `ExecutionState` over the wire (`worker-runtime/src/types.ts`), so result size grows with history (2a).
- Backpressure: none in dispatcher/worker SPIs (grep for concurrency/queue/limit in `dispatcher/src` finds only an LRU comment); `LocalWorkerRuntime` explicitly leaves concurrency to the caller (`worker-runtime-local/src/LocalWorkerRuntime.ts:33`). Effect-level bounded concurrency exists via `Scheduler` (`EffectRuntime.ts:130-140`). Each execution's writes go through a single FIFO promise chain (`ExecutionJournal.ts enqueue`), so the unit of write throughput is one execution.
- Delivery semantics: effects are at-least-once by default; `idempotent: false` parks at `EFFECT_INDOUBT` for operator verdict; deterministic `idempotencyKey = executionId:stepId[:rN]` (`WorkflowContext.ts idempotencyKeyFor`, `effect-runtime/src/types.ts:~131`). This is a sound, honest model. Undeclared tools are silently at-least-once (opt-in safety).
- `liveHandles` map is bounded by live runs and cleaned on settle (`WorkflowRuntime.ts:2438-2442`). No unbounded in-memory maps found in the kernel hot path (`warnedStrayPassthroughs` is explicitly FIFO-bounded, :404-435).

## 3. Kernel surface size

Syscalls (10): `execute, run, decide, parallel, suspend, sleep, sleepUntil, emit, stream, ui` (+ unlisted `negotiateBudget`).

Judgement:
- **Orthogonal core (keep)**: `execute` (durable effect), `decide` (captured nondeterminism), `suspend` (external wait), `emit` (durable fact).
- **Derivable, should be library (not kernel)**: `run` (alias of `execute`, `WorkflowContext.ts:~292`), `stream` (= emit, :686), `ui` (= emit via a 1P emitter, :169), `sleep`/`sleepUntil` (= suspend with `wakeAt`, :743-750; only the TimerStore service needs the kernel), `negotiateBudget` (= decide, :621-640), `parallel` (needs only `Promise.all` + the limit helper; its single kernel-relevant job is fixing the cancel semantics). Net: the irreducible ABI is ~4 calls. The ABI is not "minimal" by its own P10 standard, but the excess is cheap and mostly cosmetic EXCEPT `ui` (dependency, G1).
- **Missing and kernel-only** (cannot be built in userland with the same guarantees):
  1. A way to prune/rotate fold state for an unbounded execution (continue-as-new or keyed/expiring state) (2a).
  2. A durable inbox/mailbox with `receive`/`select`, or at least "append message while running" (2e, O1).
  3. Cancellation scope for concurrent branches that propagates abort to siblings and prevents post-park writes (2d).
  4. A body-sensitive code fingerprint, or logged "code version" per decision point (O2).
  5. A per-commit inline-size refusal (2f).
- **Should leave the kernel**: legacy-repair surface (`blankStream`, `strayPassthroughs`, `orphanCensus`, ADR 0104/0105/0107 compatibility checks in `resume`) -> a migration tool package; `ui` -> 1P; `ScheduleDefinition`/cron -> the timer service package; the `llm|a2a` kinds and USD/token fold -> app vocabulary.

## 4. Correctness / scalability risks found in passing

| # | Risk | Evidence | Measured |
|---|------|----------|----------|
| R1 | Live commit cost is O(frames) per event => O(N^2) per execution | `eventHandlers.ts:28-37` `setFrame` copies frames when not fold-owned; `ReplayVM.ts applyEvent` -> `foldEvents([event],...)` resets ownership every event (`foldEvents.ts` `resetFoldOwnership()`) | 5k steps 2.4 s, 20k 41.7 s |
| R2 | `DECISION_RECORDED` fold is O(D^2) even in bulk replay | `eventHandlers.ts:410-418` spreads `_decisions` per event (no `appendAudit`-style ownership) | 20k decisions fold = 41.9 s vs 5 ms for 20k steps |
| R3 | Every resume reads the whole log, ignoring the snapshot | `WorkflowRuntime.ts:1347,1500,1734` (`eventStore.read`), used by `checkStrayPassthroughs(allEvents)` `:858`; the snapshot only trims the fold, not the I/O | per-resume linear (exp.cjs) |
| R4 | A full-state snapshot is saved on EVERY suspend, regardless of `snapshotEvery` | `WorkflowRuntime.ts:2357-2369` | 1.2 MB state at 6k turns written per turn |
| R5 | `compact()` loads the whole log into memory | `LogLifecycle.ts:619` `store.read(executionId)`, then slices | O(N) memory per compaction |
| R6 | Writes after park (zombie sibling) | `WorkflowContext.ts:670-673` no signal forwarded; `exp3.cjs` log shows STEP_COMPLETED after EXECUTION_SUSPENDED | confirmed |
| R7 | Flow code hash is 32-bit FNV over structure only | `core/src/flowHash.ts:44-71` | collision + body-blind (O2) |
| R8 | Dead/ghost event types in the ABI | `PARALLEL_STARTED`, `PARALLEL_COMPLETED`, `STEP_RETRYING` have fold handlers (`eventHandlers.ts:310,326,345`) and consumers (`analytics`, `telemetry`) but NO writer in kernel or plugins/tools (grep of packages/plugins/tools, non-test, found only the handlers and readers). Permanent ABI surface with no emitter; analytics' "parallel window" feature therefore never sees data from the stock runtime. | grep |
| R9 | `emit` digest cost and `_flowEmits` growth per distinct stamped emit | `WorkflowContext.ts:61-100,202-224`; `eventHandlers.ts:80-110` | by inspection |
| R10 | Both `input` and `output` retained in every frame forever | `eventHandlers.ts:210-248` | by inspection |
| R11 | Fail-open lifecycle authz without a principal | `WorkflowRuntime.ts:464` | by inspection |
| R12 | Table/interface drift: `negotiateBudget` is on `ExecutionContext` but not in `KERNEL_SYSCALLS` | `types.ts:145` vs `abi.ts:33-92` | by inspection |
| R13 | Task registry is process-local and unchecked on resume: resume on a worker lacking a tool throws `No effect registered` mid-run (`EffectRuntime.ts:69-71`) after the step was already logged STEP_STARTED | by inspection |

## 5. Summary table

| Capability | Status | Kernel change needed? | Evidence |
|---|---|---|---|
| Durable effects, replay-by-log | OK | no | `WorkflowContext.ts:243` |
| Nondeterminism capture (LLM/decisions) | OK | no | `WorkflowContext.ts:539` |
| Randomness / time capture | FRICTION | no (1P helper over decide) | no syscall in `types.ts:113-202` |
| Dynamic plans, loops, recursion | OK/FRICTION | no | `WorkflowContext.ts:243-290`; fixed tool registry `EffectRuntime.ts:69` |
| Dynamic child spawn | FRICTION | no (1P effect) | absent from `types.ts:113-202` |
| Long timers | OK | no | `deadlineTimer.ts:1-40`, `TimerService.ts:203` |
| Bounded history for perpetual execution | NO | YES (continue-as-new / prunable state) | measured `exp.cjs`; no code hit for continue-as-new |
| Fold/commit scalability (steps, decisions) | NO | YES (bug-fix, no ABI) | `eventHandlers.ts:28-37,410-418`; `exp4/exp5` |
| Versioning running agent | FRICTION | YES (body-aware fingerprint) | `core/src/flowHash.ts:16-19`; `WorkflowRuntime.ts:1531` |
| Schema evolution of events | OK | no | `eventHandlers.ts:~895-968` |
| Streaming partial output | FRICTION | partial (guard on `_flowEmits`) | `WorkflowContext.ts:686`; `eventHandlers.ts:80-110` |
| Parallel fan-out (<=hundreds) | OK | no | `WorkflowContext.ts:666` |
| Structured concurrency / sibling cancel | NO | YES | `WorkflowContext.ts:670-673`; `exp3.cjs` |
| Concurrent independent waits / select | NO | YES | `exp2.cjs` test 2; `WorkflowContext.ts:731` |
| Signals into a running execution / mailbox | NO | YES | `WorkflowRuntime.ts:770-777`; `exp2.cjs` test 1 |
| Typed HITL suspend/resume | OK | no | `types.ts:177`; `definitions.ts` resumeSchemas |
| Inter-execution request/response, pub/sub | FRICTION | no (1P) | not in ctx; ADR 0052 |
| Large / binary payloads | FRICTION | optional (inline-size guard) | `eventHandlers.ts:210-248`; claim-check is middleware `claimCheck.ts:137` |
| Principal/delegation/authz | OK (fail-open w/o principal) | no | `EffectRuntime.ts:56`, `WorkflowRuntime.ts:464` |
| Fencing, leases, multi-worker safety | OK | no | `event-runtime/src/leases.ts`, `acquireFence` |
| Tenant isolation | OK (decorator) | no | `TenantScopedEventStore.ts` |
| In-flow introspection / self-fork | NO | no (1P effect + runtime handle) | `types.ts:113-202` |
| External introspection / fork / branch | OK | no | `WorkflowRuntime.ts:1768`, `BranchRegistry.ts` |
| Decision logging (context, propensity) | OK (unvalidated) | small (validate) | `eventHandlers.ts:390-440` |
| Delayed reward attach | NO | YES or 1P side-table | `analytics/src/outcomes.ts:36`; `WorkflowRuntime.ts:770` |
| Backpressure / admission | NO | no (dispatcher 1P) | dispatcher grep |
| Exactly-once effects | by idempotency key + in-doubt park (at-least-once core) | no | `WorkflowContext.ts idempotencyKeyFor` |

## 6. Top gaps ranked by blocking impact for futuristic agentic apps

1. **Unbounded fold state / no continue-as-new, and quadratic per-turn cost** (2a, R1-R4). Any agent that lives for months with a turn loop pays O(history) per turn (measured). Placement: **KERNEL** (state pruning/rotation is a fold-semantics change) + KERNEL bug-fixes for R1/R2/R3/R4 that need no ABI change.
2. **No inbound message primitive; resume only while parked on one named gate** (2e, O1). Actor/mailbox/multi-party agents cannot be built with delivery guarantees. Placement: **KERNEL** (durable inbox + `receive`/`select`); everything above (routing by logical name, pub/sub) is 1P.
3. **Concurrency is not structured** (2d, R6): siblings outlive a park, writes after suspend, one gate at a time, positional passthroughs. Placement: **KERNEL** (cancellation scope for `parallel`, keyed gate answers).
4. **Running-agent code evolution is unsafe** (O2, R7, replay-check vs dynamic ids): body-blind 32-bit hash, closures must stay in the binary, replay-check rejects dynamic-step executions. Placement: **KERNEL** (fingerprint) + **1P** (code-by-hash registry, migration tooling).
5. **Late reward/outcome attach and unvalidated learning metadata** (2i). Placement: **KERNEL** (small: append audit fact to terminal execution; validate propensity) or **1P** side table keyed by (executionId, decisionId).

Honourable mentions: streaming partials are step-granular (1P protocol over effect-emit, with a kernel guard on `_flowEmits`); no inline-size guard for multi-modal payloads (KERNEL tiny / 1P content refs); `ui` as syscall + agent-surface dependency and dead `PARALLEL_*`/`STEP_RETRYING` events (KERNEL cleanup, no new capability).

## 7. What is genuinely strong (so the next pass does not re-litigate it)

Fencing + lease design with store-clock semantics; ordered `_resumePayloads` fix; in-doubt parking for non-idempotent effects with deterministic idempotency keys; userspace-emit guard closing the "forge a kernel event" hole; typed failure channels substituted on replay; additive-only event schema with a pinned type list; durable timers that survive the 2^31 ms trap; `fork()` that re-registers the forked gate's recorded `wakeAt`; no vendor names anywhere in the kernel `src` trees.
