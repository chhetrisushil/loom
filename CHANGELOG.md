# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Streaming deltas through `DecideScope.invokeTransient` ([ADR 0119](docs/adr/0119-decide-scope-streaming-deltas.md)).** `invokeTransient(toolId, input, { signal?, onDelta? })` delivers a streaming effect's deltas to that call's sink via the new `EffectContext.onDelta` (also `TransientInvokeOptions.onDelta`). Governance is identical to a non-streaming call (authz, middleware, kill switch, taint, budget admission, cancellation); deltas are live-only (never journaled, silent on replay), a throwing sink is swallowed and warned (`EffectRuntimeOptions.onWarn`), and the sink is silent once the call settles or aborts. Each `EffectDelta.delta` is a **tainted** value (ADR 0085; `unwrapTainted` to display); a `{ reset: true, attempt }` chunk precedes a retried attempt; the terminal `{ done: true, usage? }` chunk is sent only after the call succeeded. **Delta validators:** `SafetyValidator` gains a `"delta"` phase and `checkDelta`; `piiValidator()`/`denyPatterns()` have delta forms that check the running text and sever the stream before the offending delta is delivered; an output validator with no delta form (`EffectMiddleware.inspectsOutput`) makes the runtime refuse the sink (fail-closed). `collectStream` runs its guard before delivery (a breaching delta is no longer delivered) and checks the signal per chunk. `createLlmEffect` (`stream: true`) calls the per-call sink before its configured `onDelta`. `@loom/effect-runtime` now depends on `@loom/classify`. Additive: EVENT_SCHEMA and KERNEL_ABI unchanged.

### Documentation

- **Wave 2 coordinated kernel design (agentic-readiness, Part R; design only, no runtime change).** One design document ([`docs/requirements/2026-10-05-wave2-kernel-design.md`](docs/requirements/2026-10-05-wave2-kernel-design.md)) and nine **Proposed** ADRs, planned together so the contract bumps happen once (KERNEL_ABI 1.2.0 → 1.3.0, EVENT_SCHEMA 1.22.0 → 1.23.0, EventStore SPI 2.0.0 → 2.1.0; nothing is bumped by this change). Each ADR is accepted at its own implementation PR.
  - [ADR 0109](docs/adr/0109-bounded-history-and-continue-as-new.md) bounded history: `ctx.continueAsNew`, a deterministic successor started first and then `EXECUTION_CONTINUED` (new `continued` status; existing recovery repairs a crash; promotes ADR 0052's frozen draft).
  - [ADR 0110](docs/adr/0110-durable-inbox-and-receive-select.md) a durable inbox (1P stream) with kernel `ctx.receive` / `ctx.select`, `MESSAGE_CONSUMED`, concurrent waits, an authorized `runtime.send`, and a no-lost-wakeup protocol.
  - [ADR 0111](docs/adr/0111-durable-principal.md) the execution's principal recorded on `EXECUTION_STARTED` and rehydrated on every path (recovery, timers, supervisor, children); the effect principal becomes the owner, not the resumer.
  - [ADR 0112](docs/adr/0112-structured-concurrency.md) cancellation scopes, a park barrier, and the cancel cascade (1P, in `@loom/orchestration`).
  - [ADR 0113](docs/adr/0113-body-aware-code-fingerprint-and-dynamic-id-migration.md) SHA-256 structural hash, an opt-in body fingerprint, replay-divergence detection, dynamic-id `replay-check`.
  - [ADR 0114](docs/adr/0114-ctx-ui-leaves-the-kernel.md) `ctx.ui` leaves the kernel (drops the `workflow-runtime` → `agent-surface` dependency; layering guard extended).
  - [ADR 0115](docs/adr/0115-open-vocabularies.md) open `EffectKind` / `TaskKind` and custom metering dimensions.
  - [ADR 0116](docs/adr/0116-late-outcome-attach.md) `runtime.recordOutcome` for a late reward on a finished execution (authorized, terminal-only, sequence-CAS, idempotent; no fence).
  - [ADR 0118](docs/adr/0118-acquire-if-parked-fence.md) a conditional `acquireFenceIf` on the fence token and an unanswered park (EventStore SPI, optional), a retryable `ResumeContendedError` with a timer-backed re-driver, closing the R8 supervisor's residual TOCTOU, and a retention pin for children a parent is parked on.

### Known issues

- _None open._ The principal known issue (effects run under the resumer's principal, not the owner's) is **resolved by R3k** for every execution started on 1.23.0 — see Security below. Executions started before 1.23.0 recorded no principal and keep the old behaviour exactly (see "Legacy logs" in the R3k entry).

### Security

- **The execution's principal is durable: effects run as the OWNER on every path, not as whoever drove the last `execute()` (R3k, [ADR 0111](docs/adr/0111-durable-principal.md), now Accepted; EVENT_SCHEMA 1.23.0 payload fields, no ABI or DISPATCHER_SPI change). Resolves the "Known issue" this changelog carried.** `EXECUTION_STARTED` now records `principal` (a `PrincipalRecord { v: 1, ref?, identity?, delegation? }`, `{ v: 1 }` at least — an anonymous start included) and `parent`; the fold keeps them at `_principal` / `_parent`. Every `execute()` rehydrates the effect principal ONCE from sequence 0 of the execution's own LOG (never from a caller-supplied state) through the default resolver, a `principalResolver`, or a `principalCodec`'s `fromRef`.
  - **Acting principal != lifecycle caller.** `options.principal` keeps ONE job: the caller of the lifecycle op (`ExecutionAuthorizer`, `ResumeAuthenticator.verify`). The effects of an execution run as its recorded owner on `start`, `resume`, `resumeAs`, `restoreFromState` (a doctored or stripped `_principal` in the supplied state is ignored), timer wakes, `recoverAbandoned`, the dispatcher / remote worker re-drive and supervisor child starts. After an approval the effects run as the OWNER (the approver is recorded in `APPROVAL_GRANTED`); after a timer wake or recovery they run as the owner (tenant `policy$` DENY rules, `stopTenant` and `perTenant` now fire); a delegated child keeps its attenuation across a crash.
  - **BREAKING (new executions only).** An execution started on 1.23.0 whose flow relied on the approver's or resumer's principal reaching its effects now runs as its owner: pass the approver explicitly as data. Only `{ tenant, actor, onBehalfOf }` (each <= 256 characters) is recorded and rebuilt, so **extra `PrincipalChain` fields (`roles`, custom claims) no longer reach the effects of a restarted run — nor, for uniformity, of the first run**; carry them with a `principalCodec`/`principalResolver`. A principal that carries a `delegation` and has nothing able to restore it is REFUSED at `start` with `PrincipalUnrestorableError` (log empty); `superviseChildren({ delegation })` composes the restoring codec itself (`orchestrationPrincipalCodec`), a hand-built runtime supplies `principalCodec` or `principalResolver`.
  - **Legacy logs.** An execution with NO record (started before 1.23.0) keeps today's behaviour exactly — `options.principal` reaches the effects — and replays byte-identically; "absent" means legacy only because every 1.23.0 start writes a record. A record that is present but malformed or of an unknown version denies (never falls back).
  - **The delegation token is never written** (a bearer credential in a permanent log): only a SHA-256 digest of its signature and its expiry. The kernel denies an unrestorable delegation itself — `EFFECT_DENIED` BEFORE any authorizer, so a `PolicyAuthorizer` or a 3P authorizer that allows everything cannot authorize it (`PrincipalChain.delegationUnresolved`, `principalShredded`, `principalUnresolved`; `DelegationAuthorizer` keeps its own deny). A crypto-shredded record denies every effect and never runs as the resumer.
  - **Identity is never written verbatim under an erasure obligation.** `defineConfig` resolves how the identity subset is recorded: outside `security.strict` / a composed `security.compliance` the verbatim subset is the zero-config default (its non-redactability is a documented non-goal); with `security.crypto: { events, snapshots }` (your `EncryptingEventStore` / `EncryptingSnapshotStore`, which gain `registerSensitive`) `principal.identity.*` is registered sensitive, encrypted at rest and shredded with the subject; otherwise strict/compliance REQUIRE `security.principalCodec` (the log carries `{ v: 1, ref }` only) and `defineConfig` throws `PrincipalRecordingRefusedError` naming the three ways out. **BREAKING for strict apps:** `security.strict: true` without crypto or a `principalCodec` no longer composes (the scaffold generates a codec).
  - **A fork acts as the FORKER.** `fork` stamps `forkedBy` (the forker's record) into the metadata of every copied envelope; the resolver prefers it and a fork's owner for authorization is the forker. Acting as the owner needs `fork(…, { actAs: "owner" })`, authorized as the new `ExecutionOp` `"actAsOwner"` on the parent (**default deny** in `executionAccessPolicy`); the log records `forkActAs: "owner"`. Under crypto-without-codec a fork refuses (`PrincipalUnrestorableError`) because envelope metadata is not encrypted.
  - **`ExecutionAuthzRequest.owner`** is filled by the kernel from sequence 0 for `resume`/`cancel`/`query`/`actAsOwner` on an existing execution, so **`executionAccessPolicy` drops its in-process owner table**: **BREAKING** — `ownerOf`, `adopt`, `tracked` and `maxTracked` are removed and a restart no longer loses ownership. `resolveOwner` is consulted only for a legacy log; `committed` stays on the SPI. A supervisor child started with no principal has no owner of its own and effects stay anonymous; its lifecycle follows its parent's owner (`parentOwner`, round 2).
  - `PrincipalCodec`, `PrincipalResolver`, `PrincipalRecord`, `PrincipalIdentityMode`, `PrincipalUnrestorableError` (`@loom/workflow-runtime`); `delegationDigest`, `principalBlocked` (`@loom/effect-runtime`); `orchestrationPrincipalCodec` (`@loom/orchestration`); `WorkflowRuntime.composePrincipalCodec`. The authorizer conformance kit gains `"actAsOwner"` and an `owner` case.
  - **Review round 1.** (P1) A `ref` record is restored by the composed `principalCodec` FIRST, then the resolver; a resolver answering `undefined` for any non-empty record now DENIES instead of dropping the principal (a resolver written for identity records no longer widens a `superviseChildren({ delegation })` child to the base authorizer). (P2) The start's record is held for the life of its live execution, so an immediate `cancel`/`query` by the owner is not denied while sequence 0 is still being journalled; `parent` is recorded only at a trusted start, so a starter cannot pin another execution's retention (round 2: the lineage grant, in every mode). (P3) The orchestration `ref` is MACed (`loom:orch:v2:`, key derived from the supervisor secret; unsigned refs refused), `storedPrincipalOf` refuses any envelope that is not sequence 0 / `EXECUTION_STARTED`, and `fork(…, { actAs: "owner" })` without an `executionAuthorizer` is documented as unrestricted like every op. **Follow-up:** forks of an identified forker are refused under crypto without a codec; either the scaffold always generates a codec or the crypto plugin encrypts the `forkedBy` metadata path.
  - **Review round 2.** (Decided, user) A principal-less supervised child's LIFECYCLE follows its parent's owner again, durably: `ExecutionAuthzRequest.parentOwner` (additive) is the nearest recorded owner up the child's recorded `parent` chain (max 8 hops, cycle-safe, unknown beyond), (round 3 widens it to delegated children, below); `executionAccessPolicy` uses it for every op except `actAsOwner`. The child's effects stay anonymous. `parent` is now recorded ONLY at a trusted start in every mode (a caller's `parentExecutionId` is omitted, including with no authorizer); trust is a new narrow `LineageGrant` (`WorkflowRuntime.lineageOptions()`, `RunOptions.lineage`) the child supervisor presents in every mode, not the system grant. (Decided, user) Threat model: write access to the event store is INSIDE the principal trust boundary (it can forge any event); integrity comes from the store's access control plus audit-chain/crypto where composed; the orchestration ref stays MACed as defence in depth. See ADR 0111.
  - **Review round 3.** (Decided, user) Resume stays in the parent's reach: the parent's owner may query, cancel AND resume a supervised child (`inherited` covers every op except `actAsOwner`). CONSEQUENCE: under the default "tenant" rule scope a same-tenant principal can approve a gate inside a supervised child; tighten `rules.resume` to `"owner"` to narrow it. (Decided, user) A DELEGATED child (own owner = its child id) is now ALSO reachable through its trusted recorded parent: the kernel fills `ExecutionAuthzRequest.parentOwner` for any execution whose recorded `parent` is trusted (anonymous or delegated; a shredded/unrestorable record gets none), and `executionAccessPolicy` allows an owner match on the child's own owner OR on `parentOwner` for query/cancel/resume, never `actAsOwner`. The child's EFFECTS still run under its attenuated delegation. The kernel reads sequence 0 once per authorization (`recordedPrincipal` returns `parent` with the principal, so the lineage walk's first hop costs no re-read). `parentExecutionId` is recorded only when trusted (lineage or system grant), in every mode: a non-supervisor caller passing `parentExecutionId` no longer gets a parent recorded, even with no authorizer. A start whose runtime call throws synchronously removes only its own live start record. See ADR 0111.

- **Approvals are bound to what the approver saw, there is a first-party `ResumeAuthenticator`, and the A2A bus no longer auto-approves (R13, [ADR 0117](docs/adr/0117-approvals-bound-to-what-the-approver-saw.md); behavioural tightening, no ABI change).** `KERNEL_ABI` and `EVENT_SCHEMA` are unchanged.
  - **View binding.** `ctx.suspend({ on, viewDigest })` records a digest of the proposal in the suspend condition (durable, fold-visible; `viewDigest()` / `approvalViewDigest()`). A resume answering that gate must echo it as `payload.viewDigest`; a stale or missing echo is refused before the append (`ResumeRefusedError`, reason `view-digest-mismatch`, nothing recorded). `answerApproval(state, decision)` builds the resume. A gate that declares no digest is unaffected; a timer wake is exempt.
  - **BREAKING (`agentLoop$`).** `requireApproval` gates now declare a digest of position + tool + input, so a bare `{ approved: true }` resume is refused. Resume with `answerApproval(state, { approved })`, or pass `bindApproval: false`. A `resumeSchemas` entry for that gate must let `viewDigest` through.
  - **`signedResumeAuthenticator({ gates, keys, authorize?, requireActor?, now? })` + `signResume`** (`@loom/workflow-runtime`): HMAC-SHA256 over the whole event (payload incl. the echoed digest, `discardLegacyAnswers`, actor, REQUIRED expiry) and the park it answers (`executionId` + the parking `EXECUTION_SUSPENDED` sequence, via the new additive optional `ResumeAuthenticator.verify(event, context?)`), so a signature is single-use: refused at another execution, a fork, or a later park of the same gate. The proof's actor must equal the calling principal's. Secrets under 16 bytes are refused; `keys` may return several secrets (rotation). Records `APPROVAL_GRANTED { actor, verifiedBy: "hmac-sha256" }`. Passes `runResumeAuthenticatorConformance` (which gains a context case). `runtime.parkedAtSequence(id)` gives the approver the value to sign.
  - **`viewDigest` is SHA-256 (`v2:`)**, not 64-bit FNV; an execution parked with a `v1:` digest still resumes by echoing it. A UI renders the proposal from the tool call in the log and recomputes `approvalViewDigest(correlationKey, tool, input)`; the proposal is not copied into the condition. `agentLoop$` gate keys now include the loop id, and a tool input too deep to digest is refused to the model rather than failing the run.
  - **`TIMER_FIRED` is the kernel's wake.** A caller-supplied `TIMER_FIRED { approved: true }` used to answer a timed approval gate past the digest and the authenticator. On a fail-closed runtime a `TIMER_FIRED` resume without the system grant is refused (`timer-wake-not-system`); everywhere the recorded payload is exactly `{ wakeAt }`.
  - **Bus.** `unsafeAutoApprove` warns once; `ApprovalDecision.proof` + `approvalPayload(request, decision)` let a strict app approve through the bus with a signed proof; `resolveApproval` on an unknown/evicted task names `runtime.resume` + `answerApproval`. The scaffold's approver keys fail closed (unset/empty/odd-named actor verifies nothing).
  - **BREAKING (`signResume`).** It requires `exp`, `executionId` and `parkedAtSequence`; the authenticator rejects an event it is given no park context for.
  - **BREAKING (strict).** `security.strict` now REQUIRES `security.resumeAuthenticator` (config error otherwise); `strict: { requireResumeAuthenticator: false }` acknowledges an app with no approval gates. The scaffold generates one.
  - **BREAKING (`InProcessA2ABus`).** With no `onApproval` the gate stays suspended: `dispatch` returns `{ status: "working", suspended }`, answered later with `bus.resolveApproval(taskId, decision)`. Demos opt in with `onApproval: unsafeAutoApprove`. `onApproval` now receives `{ executionId, gate, viewDigest }` and the bus echoes the digest; the resume uses the gate's own name (it hard-coded `"ApprovalGranted"`).
  - **R13 review round 2.**
    - **The park is located exactly, for any number of events after it.** `runtime.parkedAtSequence(id)`, `resume`, `resumeAs`, `restoreFromState` and the bus all use one lookup: the newest `EXECUTION_SUSPENDED` in the events in hand, else a walk back in 64-event indexed range reads from the snapshot (no whole-log read; cost = events between the park and the snapshot). Round 1 probed only 16 events back and then bound the TIP, so a signed approval was rejected ("signature does not verify") once 16+ events (denials by varying principals, parallel siblings) trailed the park on a resume's fast path. `restoreFromState` bound the preloaded state's tip and the bus the result's tip; both now bind the park. No fold, `EVENT_SCHEMA` or `KERNEL_ABI` change.
    - **A park that is no longer in the log is refused, never guessed.** If the `EXECUTION_SUSPENDED` was compacted away (or the log does not hold it) a signed approval is refused with `ApprovalRejectedError` reason `park-not-located: ...`, and `parkedAtSequence` returns `undefined`. The tip is never substituted.
    - **Remote approvers** must obtain `parkedAtSequence` from `runtime.parkedAtSequence(id)` or the bus `ApprovalRequest` to sign; `state.sequence` is NOT the park once anything trails it.
    - **`agentLoop$` deep input.** The deep-input refusal can change replay of a main-era execution whose approved tool call had input nested more than 1024 levels deep (negligible: such an input was already unbounded recursion on the digest path).

- **A2A and MCP servers are authenticated by default, loopback-bound, and A2A tasks are owned by their creator (R12; behavioural tightening, no ABI change).** `KERNEL_ABI` and `EVENT_SCHEMA` are unchanged.
  - **BREAKING (defaults).** `createA2AServer` and `createMcpServer` now THROW at creation unless the caller supplies `authenticate` (new: returns the caller's `PrincipalChain`, or `undefined` for a 401) or `authorize`, or passes `insecure: true` (logs a loud warning). They previously ran unauthenticated when neither was set. They also bind `127.0.0.1` instead of every interface; pass `host: "0.0.0.0"` (or an interface address) to widen. `server.url` now carries the bound host, not `localhost`. Migration for a demo or test: add `insecure: true`. `loom-examples` that need it: `a2a-mesh`, `agent-network`, `mcp-app-release-approval` (all `port: 0`, same-process clients).
  - **Strict.** The app does not construct these servers, so they cannot be refused from `defineConfig`; pass `strict: app.strict`. Under strict `insecure: true` is a config error, and the A2A server additionally requires `authenticate` or `resolvePrincipal` (every task must carry a principal).
  - **A2A task ownership.** The HTTP server namespaces every task id by the caller's principal (tenant + actor + onBehalfOf): the execution the runtime sees is `a2a.<namespace>.<client id>`, and the client only ever sees the id it chose. A caller cannot read, resume, or collide with another caller's task by guessing or choosing an id; the lookup lands in its own namespace and finds nothing (404). Previously `task.id` became the `executionId` verbatim, so any caller could read any execution's folded state, and a colliding id re-drove the victim's execution. Callers that pass only a boolean `authorize` (no principal) share ONE namespace; use `authenticate` for per-caller ownership. `LoomAgentExecutor` takes `{ namespaceByPrincipal }` (off for direct in-process use; the server turns it on). The server has no cancel route, so there is nothing to cancel across callers; R3's `executionAccessPolicy` still governs cancel on the runtime.
  - **MCP per-tool authorization.** `mcp.invoke` is one registered effect, so a `GrantTable` could allow all of a server's tools or none. `Effect.resourceOf` / `ToolEffectOptions.resourceOf` (new, optional) lets an effect name the sub-resource a call targets; the runtime passes it as `CapabilityRequest.resource`, and `GrantTable`, `PolicyAuthorizer` (allow/deny/`match.effect`) and `DelegationAuthorizer` accept the qualified id `<effectId>:<resource>` (`capabilityIds`). `mcp.invoke` presents `<server>/<tool>`: grant ONE tool with `mcpToolCapability(server, tool)` = `mcp.invoke:<server>/<tool>`. A grant on bare `mcp.invoke` still means "every tool on every server", unchanged. A resolver that throws, or an effect without one, fails closed against a qualified grant. `McpInvokeOptions.server` is the server identity (default: see the review-round note below).
  - **MCP server per-tool exposure.** `createMcpServer({ authorizeTool })` decides per caller whether a tool is listed and callable; a refused tool is reported as unknown (never as forbidden). Tool handlers receive `ctx.principal` from `authenticate`. Default unchanged: every authenticated caller may use every served tool.
  - **R12 review round 1 (all behavioural tightening, no ABI change).**
    - **A2A principals must carry an `actor`.** `principalNamespace` now THROWS unless `principal.actor` is a non-empty string, and `createA2AServer` answers 401 (warning once) when `authenticate`/`resolvePrincipal` yields such a principal. A principal identifying callers by another field (`{ sub }`) used to hash to ONE shared namespace, so callers could read each other's tasks. `executionAccessPolicy` likewise refuses (and never records an owner for) a principal whose actor is empty. When both `authenticate` and `resolvePrincipal` are set, `authenticate` wins and `resolvePrincipal` is ignored.
    - **A2A execution id shape.** The runtime sees `a2a.<ns>.<client id>`, where `<ns>` is a 24-hex-char hash of tenant + actor + onBehalfOf. Anyone reading A2A executions by their raw client id (`loadState("my-task")`) must use the new id.
    - **`PolicyAuthorizer` matching.** DENY globs (`deny` list, `match.deny`) match both the bare effect id and the qualified `<effect>:<resource>` id. ALLOW entries (`allow` list, allow `match.effect`) match the qualified id only when the pattern itself contains `:` and the text before the first `:` equals the request's effect id exactly; `allow: ["*.search"]` no longer allows `mcp.invoke` on a resource named `srv/wipe.search`. Bare `allow: ["mcp.invoke"]` still allows every resource.
    - **Denial reasons name the resource** (`PolicyAuthorizer`, `GrantTable`, `DelegationAuthorizer`), so an audit can tell which tool was refused (`EFFECT_DENIED` has no `resource` field and gaining one would change `EVENT_SCHEMA`).
    - **`McpInvokeOptions.server` now defaults to the client URL's hostname (plus `_<port>` when non-default)** (was the literal `"server"`). Grants written as `mcp.invoke:server/<tool>` must name the host, or set `server` explicitly. A `server` containing `/` or `:` is rejected.
    - **Strict defaults from the runtime.** `createA2AServer` defaults `strict` from `workflowRuntime.requiresPrincipal` (new read-only accessor); `createMcpServer` takes `runtime: { requiresPrincipal }` for the same. Explicit `strict` still overrides. Under strict an A2A caller that resolves to no principal (authorize-only) is refused 401 instead of joining the shared namespace.
    - **MCP resources follow `authorizeTool`.** `resources/list`/`resources/read` hide a `ui://` template tied to a tool the caller may not use. `authorizeAppJournaledCall(tool, req, principal)` now receives the principal. `resourceOf` is evaluated on the pre-middleware input: a middleware that rewrites the tool name must not be relied on for authorization.
  - **R12 review round 2.**
    - **`startWorkerServer` (the container entrypoint) binds `0.0.0.0`** by default (`options.host` / `$HOST` override); round 1's loopback default made the Cloud Run image unreachable. `createWorkerServer` keeps the loopback default. Set `authorize` on a reachable worker.
    - **`McpClient.serverHost` keeps a non-default port** (`localhost:3001` -> `localhost_3001`; default ports omitted) so two servers on one host no longer share a grant id. Grants written for a ported server's default id must add the `_<port>` suffix.
    - **A whitespace-only A2A `actor` is refused** like no actor (401).
    - **`createMcpServer` without `runtime` or `strict` warns once** that strictness is advisory.
    - Docs: a bare-id allow pattern (`mcp.invoke`, `mcp.*`) allows every resource of the effect; scope with `mcp.invoke:<server>/<tool>`.
    - **`createWorkerServer` binds `127.0.0.1` by default** (was all interfaces); pass `host` to widen. `server.url` carries the bound host.
    - **A2A `publicUrl`** sets the URL the agent card advertises (a `0.0.0.0` bind otherwise advertises `localhost`).
    - **REQUIRED alongside this merge:** the companion `loom-examples` PR (`a2a-mesh`, `agent-network`, `mcp-app-release-approval` need `insecure: true` or `authenticate`).

### Fixed

- **`superviseChildren` is restart-safe (R8; no ABI change).** Spawn specs, group aggregation and the started set lived only in process memory, filled by live `onEvent`, so after a restart a recovered child's completion hit `if (!started.has(id)) return` and the parent was never resumed, and a group with 2 of 3 members settled lost its results. The supervisor now rebuilds a parent's state from the log: a child terminal event it did not see spawned triggers a per-parent rehydration (the parent's park, its spawn `DECISION_RECORDED`, each child's terminal event), and the new `supervisor.recover({ source?, pageSize? })` does a boot catch-up (resume parents whose children all settled while down, start children recorded but never started, adopt the rest; returns `{ scanned, parked, resumed, started }`). Double resume is harmless: a lost race is swallowed, a start whose id exists is not an error, and a resume is dropped unless the parent is parked on that exact child/group key (the resume gate checks only the gate NAME, so a late duplicate used to be able to answer the parent's next `awaitChild`). `ChildSupervisor` gains the `recover` method (additive for callers; a hand-written `ChildSupervisor` must add it). `recover()` costs one store scan + one fold per execution; there is no parked-parent index. Restart policies remain out of scope. `KERNEL_ABI` and `EVENT_SCHEMA` unchanged.
- **`superviseChildren` R8 review round 1 (multi-supervisor safety; no ABI change).** (P1-a) The duplicate-resume window is closed with no kernel change: `awaitChild`/`awaitChildren` park with `viewDigest: <key>` (R13) and the supervisor's resume echoes it, so a slow supervisor's stale resume is refused pre-append (`view-digest-mismatch`) instead of answering the parent's next `awaitChild` with the previous child's output; old parks without a digest are unaffected. (P1-b) Group members that settle on different nodes no longer hang the parent: a settling member re-reads its unsettled siblings from the log (after its own terminal is durable) and `recover()` re-derives even an already-known park. (P1-c) A losing resume's in-memory re-run starts no phantom child: children start only once the parent is durably parked on that exact key, and from the durable spawn decision. (P2-a) `resume()` failures are observed: `resumed` counts only a durable resume, a failed append reaches `onError`, `StaleFenceError` is no longer treated as a lost race (the supervisor takes its own fence; see round 2 for the bound and the residual). (P2-b) A member whose execution retention deleted (`EXECUTION_DELETED` in the lifecycle stream) settles as a typed failure instead of being started again. (P3) per-park supervisor state is dropped when the park is answered; `recover()` crosses tenants unless the store is tenant-scoped; a compacted terminal event loses the error text / cancel reason. `ChildSupervisor` gains `size()` (`@internal`, a leak check). Follow-up outside this package: `LogLifecycle` should refuse to delete a child whose parent is still parked on it. `KERNEL_ABI` and `EVENT_SCHEMA` unchanged.

- **`superviseChildren` R8 review round 2 (no ABI change).** (P2-1) The live path no longer gives up silently on a slow store: its ~1s wait for the parent's park distinguishes "parent terminal" (stop) from "bound exhausted" (back off exponentially and `adopt` from the log while the parent is non-terminal; a give-up after 10 minutes is reported through `onError`); a park that stays on a different key is a losing resume's phantom and stops quietly. `recover()` is opt-in and not needed for this. (P2-2) Fence acquisition is bounded to two per resume with the park re-read before each; the supervisor does NOT fence up front (the earlier "as `TimerService` does" was inaccurate: `TimerService` does). Residual that needs a kernel SPI, named for the Wave 2 kernel design: an **acquire-if-parked fence SPI** — `acquireFence` is unconditional, so a rival fencing between the acquire and the append fails the resume, and one landing between the durable resume and the read-back supersedes the holder of the already-running parent body; a resume still stale is reported. A live resume refused `not-suspended` is quiet when the durable log shows the park answered (it used to retry 10x and then `onError`). (P3-1) State held for a park answered elsewhere (adopt-then-answered-on-another-node) is dropped by a periodic sweep, by every adoption and by `recover()`. (P3-2) The retention-deletion facts are a bounded map keyed by id and compared with the spawn decision's time (a reused parent id no longer fails its fresh member), counted in `size()` as `reclaimed`. (minor) An observed resume with no durable evidence within a bound is "unknown": not counted, retried through `adopt`. `SupervisorDeps` gains an `@internal` `tuning`. `KERNEL_ABI` and `EVENT_SCHEMA` unchanged.

- **Fold, live-commit and resume cost were super-linear (R1a; no ABI change).** Folded state is
  byte-identical, `KERNEL_ABI` and `EVENT_SCHEMA` are unchanged.
  - `DECISION_RECORDED` spread the whole `_decisions` map per event: folding 5k / 10k / 20k
    decisions took 2.3 s / 10 s / 42 s (20k steps: 5 ms). The map is now a fold-owned container
    written in place, like `frames` and the audit lists.
  - A live commit was its own fold pass, so fold ownership was reset on every event and every
    commit re-copied the whole frames map (5k commits 2.6 s, 20k 45 s, 40k 192 s). `ReplayVM`
    now keeps its own ownership set across `applyEvent`s and retires it when a state escapes
    through `getState()`, so a state a caller holds is still never written to. New
    `ReplayVM.peekState()` is the borrowed read for the runtime's hot path (`WorkflowContext`,
    `ExecutionJournal`); `getState()` keeps its meaning.
  - `WorkflowRuntime.resume` read the whole log on every call. With a snapshot it now takes the
    execution's identity from sequence 0 and folds snapshot + tail. The one consumer of the full
    log, the ADR 0104 legacy stray-passthrough scan, still runs over the whole log on the first
    resume of an execution in a process and on every resume of a log it flags; `discardLegacyAnswers`
    always forces it. After a CLEAN scan the runtime keeps the scanner itself (not a "clean" flag)
    and feeds it only the events appended since, so a PRE-0104 kernel appending to the same log
    afterwards (a mixed-version fleet during a rolling upgrade, an old node running
    `recoverAbandoned`) is detected by the warm runtime as a fresh one detects it; a flagged
    result, a gap in the tail, a log that no longer reaches the scanned sequence, or a different
    flow definition falls back to the full read, and `feed` is idempotent across concurrent
    resumes. A refused scan never leaves a remembered entry. Residuals (ADR 0104 amendment): a
    `truncatePrefix` after a clean scan (can only drop the advisory "unverifiable" warning), a
    log erased and re-created under the same id to at least the scanned length, and step kinds
    resolved per fed event.
  - The snapshot written at every suspend is kept: with `snapshotEvery` unset it is the only
    thing that bounds a resume's tail. It hands the state to the store by reference (no copy).

- **MCP-mapped tools showed the model `{}` for their arguments (R4b).** R4 sent each tool's Zod
  schema as JSON Schema, but an MCP tool's schema is already JSON Schema and its Zod form is a
  `z.unknown()` placeholder. New optional `ToolDefinition.jsonInputSchema` (and
  `trustJsonSchemaText`); `@loom/plugin-mcp` `mapTool` sets it from the server's `inputSchema`,
  and `toolInputJsonSchema(zod, json?, { trustText })` prefers it. The schema is THIRD-PARTY
  bytes bound for a prompt, so it is sanitised first (`sanitizeJsonSchema`): a keyword
  allowlist (unknown / `x-*` / `default` / `examples` dropped), depth 16, 1000 nodes, 64KB,
  remote `$ref` dropped (nothing is fetched), cyclic or oversized refused
  as a whole and sent as `{ type: "object" }` with a `LOOM_AGENT_TOOL_SCHEMA`
  warning per tool id (the run never fails). **The text that must stay is constrained, not
  merely capped** (a per-item cap still admitted ~64KB of prose per tool): property and
  `$defs`/`definitions` keys must match `^[A-Za-z0-9_.-]{1,64}$` (else the entry is dropped,
  and its `required` mention; `required` only names kept properties); `enum`/`const` strings are
  at most 64 chars with no control / zero-width / bidi characters (else the keyword is dropped);
  `format` only from JSON Schema's standard list; `pattern` at most 128 chars and must compile
  under `new RegExp(p, "u")` (compiled, never run); a `$ref` survives only if it names a kept
  `$defs`/`definitions` entry or `#`; and ALL of that attacker-controlled text together is
  budgeted at 4096 characters per tool, past which the whole schema is refused. A hostile
  server can still say a few words inside the budget; the description is the default-deny
  surface. **Taint:** `description`/`title` inside the schema, and the
  MCP tool's own description, were read as instructions yet never passed `guardRequest`
  (a plain string carries no taint). They are now stripped (the description becomes the fixed
  string "Third-party tool; description withheld") unless the operator opts in with
  `listTools/registerInto({ trustDescriptions: true })` (a trusted description is still capped
  at 1000 chars, with a one-time `LOOM_AGENT_TRUSTED_TOOL_TEXT` warning per tool).
  Strip-by-default rather than taint-and-refuse: `guardRequest` refuses the WHOLE request on a
  tainted description, so every MCP agent would fail to run; ADR 0085's MCP producer is
  likewise opt-in (`taintResults`) and its `unwrapTainted` is the operator's visible
  decision, which `trustDescriptions` mirrors. **Tool names:** the name is the effect id and
  what the model sees, so `listTools` skips (with a `LOOM_MCP_TOOL_NAME` warning) any tool whose
  name is not `^[A-Za-z0-9_-]{1,64}$` (providers 400 on one, and a long name is prompt text);
  `listTools({ anyToolName: true })` opts out for tools never shown to a model (`mcpInvoke$` and an
  app view use it: `loom.surface.since` is a legitimate dotted name).
  **Validation:** an MCP tool now checks its own call's shape INSIDE its effect
  (object input, `required` keys present, declared top-level property types) and returns a
  recorded `{ error: { code: "invalid_tool_input", ... } }` RESULT; nested rules, enums and
  bounds stay the server's job. The check reads the RAW schema, so its refusal echoes only
  identifier names (`^[A-Za-z0-9_.-]{1,64}$`) and JSON Schema type names — any other name is
  reported without it (the refusal is a model-visible tool result). It is in the effect, not in the agent loop before
  `ctx.execute`, so replay is deterministic: the schema comes from a LIVE `tools/list` at
  boot, and a gate outside the journaled step would refuse, after server schema drift, a call
  the log records as executed. Note a direct flow caller of an MCP tool now also receives that
  result, instead of the server's error, for a malformed call. **Hazard (R4b vs R4):** R4's
  zod gate reads a STATIC definition the deployer controls (hence "drain before upgrading");
  R4b's schema is remote and drifts on its own, so it is kept out of the gate. What the model
  is SHOWN still comes from the live listing, so a drifted schema changes the menu on the next
  model call of a resumed run (the recorded model responses still replay). Pre-R4b executions
  are unaffected (MCP tools were `z.unknown()`, nothing was gated). No new dependency.

- **Agent loops executed any effect id the model named, with unvalidated input, and showed the model no argument schemas (R4).**
  `agentLoop$` ran `ctx.execute({ toolId: toolCall.name })` and `AgentRunner` (hence `agentStep$`)
  ran `effectRuntime.execute(toolCall.name, ...)` for WHATEVER name the model returned, so under
  the default permissive config a hallucination or a prompt injection could reach any registered
  effect; and every `LlmToolSpec.inputSchema` was `{}`. Now a call runs only if its name is on
  the loop's tool menu (agent tools + selected skills' tools) and its input passes the tool's Zod
  `inputSchema`; otherwise nothing is executed and the model gets a structured
  `{ error: { code: "tool_not_on_menu" | "invalid_tool_input", ... } }` result (issues bounded)
  so it can recover. The refusal is deterministic from the recorded model output and appends
  nothing. Schema faults (async or throwing refinements, pathologically deep input) are
  refusals too (`invalid_tool_input`, fixed message), never throws; input deeper than 64
  levels or 100k nodes is refused before Zod runs; echoed names/paths are capped at 200
  chars. `requireApproval` now receives `onMenu` as a third argument.
  **Replay caveat:** an in-flight `agentLoop$` execution whose log recorded an off-menu or
  invalid-input call (written before this change) replays a refusal in its place, so its
  `toolCallLog` / later transcript diverge from the recorded run; drain in-flight `agentLoop$`
  executions before upgrading. `agentStep$` / `AgentRunner` (one step) are unaffected. Each tool's Zod schema is sent as JSON Schema
  (`toolInputJsonSchema`, a minimal in-package converter; no new dependency). **Behavioural
  tightening:** code that relied on calling an off-menu effect, or on sending input its tool's
  schema rejects, now gets the refusal result instead of an execution. Tools whose schema is
  `z.unknown()` (MCP-mapped tools) are unaffected for validation but are still described as `{}`.
- **A flow whose only reach is a ctx hand-off lost its runner-body analysis (backlog L36).**
  `@loom/compiler` kept a flow's `runnerReach` in the manifest only when it had steps,
  unresolved targets or suspends, ignoring L32 `escapes`. A flow that only hands `ctx` to a
  library (`planner.compose(input, ctx)`) therefore read as "no runner-body analysis" instead
  of the undeclared-hand-off warn, so declaring the library's reach had no effect on it. Found
  by a genUI review: its `generate-dashboard` flow was silently unanalysed.

### Added

- **R6: structured concurrency — `ctx.parallel` is a cancellation scope, a park drains before it commits, and cancelling a parent cancels its children ([ADR 0112](docs/adr/0112-structured-concurrency.md), now Accepted; EVENT_SCHEMA 1.23.0 shapes as frozen at W2-0, KERNEL_ABI unchanged).** **BREAKING (behaviour; no source change) ONLY WITH `kernel.features.scopes: true` (default off: `ctx.parallel` stays the pre-R6 bounded `Promise.all`; turn it on once every node folds the record):** (1) a failed `parallel` now ABORTS its still-running siblings (their effect `signal` fires, they record `STEP_CANCELLED`) and journals the outcome as a kernel-stamped `PARALLEL_COMPLETED { scopePath, failedBranch, error, cancelled[] }`; a re-run SERVES the scope from that record (nothing that was not already completed starts again; the SAME error value is thrown by the first run and every re-run: a `TypedFailure` stays typed, a class in `execution.errorClasses` or the built-in `Error` family is rebuilt from the recorded message, else a `ParallelScopeFailedError` with `errorName`; the first run no longer throws the original object), so replay no longer depends on timing. Flows that relied on a failed `parallel` leaving siblings running must pass `{ failFast: false }`. (2) A park commits only after every step in flight has settled: a parallel sibling's `STEP_COMPLETED`/`STEP_FAILED` now lands BEFORE `EXECUTION_SUSPENDED`, never after it (and `_failedWhileParked` can no longer be produced by this kernel; the fold keeps it for old logs). New step starts freeze once a park is decided. A step that outlives `parkDrainMs` (default 30 s, `WorkflowRuntimeDeps.parkDrainMs`) is aborted and its append dropped with a warning (it re-runs on resume under the same idempotency key).
  - `ctx.parallel` accepts branch functions `(b: BranchContext) => Promise<T>` beside `[step, input]` pairs, and options `{ limit, failFast (default true), onPark: "drain" | "abort" }`. Each call is a scope with a deterministic path (`<parent>/<k>.<branch>`, exposed as `b.scopePath`), the identity R2 keys waits by. A `SuspendError` in a branch is a barrier, not a failure. Step ids are unchanged; the `PARALLEL_COMPLETED` writer is not flagged (an older node ignores the record and re-runs the scope live, as before).
  - **Review round 1 (PR #499), shape amendment:** `PARALLEL_COMPLETED` gains ADDITIVE optional `launched`, `consumed[]`, `cursor`, `errorName`, `errorChannel`, `errorPayload` (EVENT_SCHEMA stays 1.23.0, unreleased; frozen W2-0 shape amended by user decision 2026-10-06) so a served scope launches exactly the branches the first run launched and consumes exactly the gate answers it consumed. `kernel.features.scopes` (off by default) gates the writer. The journal is sealed the moment `EXECUTION_SUSPENDED` / `EXECUTION_COMPLETED` / `EXECUTION_FAILED` is enqueued: a zombie effect's late emit (ADR 0102's "never lost" note) is now DROPPED with a warning and re-emitted by the re-run. A branch closing over the root `ctx` stays in its scope (AsyncLocalStorage).
  - **Review round 2 (PR #499):** `PARALLEL_COMPLETED.consumed` is run-length encoded (`[branchScopePath, startIdx, count]`, 16 KiB budget instead of 128 entries; the unreleased pair form is gone). The first run of a failed scope throws the rebuilt error with `cause` = the original (first run only; never branch on it). `EXECUTION_CANCELLED` seals the context like park/terminal.
  - **First `recover()` after upgrading** cancels the live children of parents that were cancelled or continued before the upgrade (the orphan sweep is new): expect a one-time `RecoverSummary.cascaded > 0`. A pass reads each gone parent's log once.
  - `@loom/orchestration`: `awaitChild`/`awaitChildren` accept `detached`; `superviseChildren` cancels a cancelled (or continued) parent's non-detached children (live, from the parent's recorded spawn decisions) and `recover()` sweeps orphans by their recorded `_parent` (`RecoverSummary.cascaded`), cancel reason `{"kind":"cascade","parent":…}`. Consumers: `fanout$` (via `ctx.parallel`) is the only in-repo caller and now fails fast; no example in `loom-examples` calls `ctx.parallel` directly.
- **R8k: an acquire-if-parked fence, a contended-resume re-driver and a retention pin for parked children ([ADR 0118](docs/adr/0118-acquire-if-parked-fence.md), now Accepted; EVENT_STORE_SPI 2.1.0 gains its method, KERNEL_ABI and EVENT_SCHEMA unchanged).** Closes the residual the `@loom/orchestration` README named under "Restart safety (R8)": `acquireFence` was unconditional, so a rival supervisor's acquire between a resume's durable `EXECUTION_RESUMED` and its read-back superseded the holder of the already-running parent body.
  - **`EventStore.acquireFenceIf?(id, { fence, parkSeq })`** (optional): bumps and returns the token only if it has not moved AND no *answering* event (`isAnsweringKind`: a resume, a later park, a terminal kind, an unknown kind stamped `metadata.kernel: true`) exists past `parkSeq`; else `{ stale: true, fence }` and nothing changes. Audit appends after a park (`EXECUTION_DENIED`, `OUTCOME_RECORDED`, `STEP_FAILED`, `MESSAGE_CONSUMED`, application events) never make it stale. Memory: one synchronous step. **Postgres:** one round-trip (three statements, one implicit transaction: ensure the fence row, `FOR UPDATE`, conditional `UPDATE … WHERE NOT EXISTS`), and the append guard reads the fence row `FOR SHARE` ONLY for a batch holding an answering kind, on the single-append and the `appendMany` paths; an `EXECUTION_SUSPENDED` append also ensures a token-0 fence row (inert) so the lock has a row to take. **SQLite does not fence and omits it** (the ADR text assumed it did; see "Implementation (as built)"). Every decorator forwards/routes/scopes it (a decorator that does not decide is a compile error); the conformance kit gains the cases, an every-interleaving test of two resumers with crashes (with the unconditional acquire as a negative control) and the Postgres append-vs-acquire races.
  - **`RunOptions.fenceIfParkedAt`** on `resume` / `resumeAs`: a dead acquirer's stale token is retried on the token the store returns (3 tries); an answered park is `ResumeRefusedError` `not-suspended` with nothing appended and no token taken; exhaustion is the new retryable **`ResumeContendedError`** (not a `ResumeRefusedError`). `assertResumable` is re-run under the acquired fence. A store without the method falls back to `acquireFence`.
  - **`superviseChildren`** resumes unfenced first and, on `StaleFenceError`, with `fenceIfParkedAt` (a store without the method keeps the old two-acquisition loop). `superviseChildren({ redrive })` turns a `ResumeContendedError` into a backed-off (200 ms base, 30 s cap, full jitter) `TimerStore` row that `TimerService` fires through a registered re-driver, 8 attempts, then `onError` once and `recover()`. **`TimerRecord.redrive?: { attempt }`** (additive) with an upsert on both SQL stores (a flagged row is never downgraded) and guarded migrations (`pragma table_info` + `ALTER TABLE` on SQLite, `ADD COLUMN IF NOT EXISTS` on Postgres); `TimerService` gains `redrivers`, `registerRedriver`, `maxRedriveAttempts`, `redriveBackoff`. **Behind `defineConfig({ kernel: { features: { redrive: true } } })`, off by default** (an older node's `TimerService` retires a re-drive row as obsolete); it hands out `app.redrive` and warns when `timers` is missing.
  - **`pinParkedChildren(supervisor)`** (`@loom/orchestration`) and `ChildSupervisor.parkedOnChild`: retention leaves a finished child its parent is still parked on exactly where it is, until the parent is answered or terminal; `app.supervise(supervisor)` composes it into `app.lifecycle`.
  - **Review round 1 (PR #498).** `resume` / `resumeAs` with `fenceIfParkedAt` now run on the VM advanced by the tail read under the acquired fence (an ignorable append between the caller's fold and the acquire used to burn the token and append nothing); the acting principal is computed before the acquire. A **fenced `TimerService` wake (in-process path)** is now an acquire-if-parked (an answered park retires the timer as obsolete; the dispatcher path, `recoverAbandoned` and `LocalWorkerRuntime` are unchanged and named in the ADR). `pinParkedChildren` no longer pins a crypto-shredded log forever (`PayloadShreddedError` is not pinned; any other read error rethrows so retention fails visibly). Postgres `migrate` backfills the token-0 fence row of every pre-version park once; the timers `redrive` column no longer takes ACCESS EXCLUSIVE on every boot; `deleteExecution` drops the inert token-0 row. SQLite's timer-column migration is one `BEGIN IMMEDIATE`. `TimerStore.due(now, limit, { redrive: false })` (additive) keeps a node with no re-driver from being starved by re-drive rows, and the next re-drive row can no longer collide with the one it retires. **Rolling upgrade is not safe in both directions**: roll every node first, then enable anything relying on `fenceIfParkedAt`.
  - **Review round 2 (PR #498).** A contended fenced timer wake no longer re-acquires on every poll: it backs off in process (bounded map, the D4 schedule and attempt cap; exhaustion reports `onError` once and retires the row). The Postgres park-fence backfill gains an opt-out (`backfillParkFences: false` on `migratePostgresStores`, `PostgresEventStore`, `postgresStorage`) and an exported batched `backfillParkFences(pool, { batchSize })` for large installs (temporary partial index, built CONCURRENTLY and dropped). 3P `TimerStore` authors: honour `due(now, limit, { redrive: false })` by excluding re-drive rows before the limit. ADR 0118 records the rollout note and the R2 rule (retire a timer only when its wait is no longer pending, not merely when status is not suspended).
  - **Cost** (`pnpm --filter @loom/bench-throughput bench:fence`, recorded in the ADR): fenced and unfenced executions are within run-to-run noise; park/resume is about 4% lower on Postgres; a resume under the conditional fence is about 25% slower than one under `acquireFence` (one more round-trip), taken only on a stale fence.

- **Wave 2, W2-0: the kernel reservation — KERNEL_ABI 1.3.0, EVENT_SCHEMA 1.23.0, EventStore SPI 2.1.0, every new fold handler, with NO writer yet ([ADRs 0109–0116 and 0118](docs/requirements/2026-10-05-wave2-kernel-design.md), all still Proposed; user decision 2026-10-05, "full reservation up front").** Nothing a flow can call changes; this lands the handlers and the frozen shapes the item PRs (R3k, R8k, R6, R14, R2, R15, R11, R1b, R7) write against, each writer behind its own `kernel.features` flag. Existing logs replay byte-identically (proved by tests below).
  - **Versions.** `KERNEL_ABI_VERSION` 1.3.0 (reserved: `continueAsNew`/`receive`/`select` enter `KERNEL_SYSCALLS` with their writers; still 10 syscalls), `EVENT_SCHEMA_VERSION` 1.23.0 (folded kinds 30 → 32), `EVENT_STORE_SPI_VERSION` 2.1.0 (reserved for the optional `acquireFenceIf`, which lands in R8k; a 2.0.0 store still conforms), compatibility matrix regenerated.
  - **Reserved kinds.** `EXECUTION_CONTINUED { successorId, chainId, generation }` (→ new terminal `ExecutionStatus` `"continued"`, `_continuedTo`) and `MESSAGE_CONSUMED { waitId, topic, messageId, inboxSeq, sender, payload }` (→ `_inbox`, `_waitAnswers`); a payload and handler for the existing `PARALLEL_COMPLETED { scopePath, failedBranch, error, cancelled[] }` (→ `_scopes`).
  - **Reserved fields.** `EXECUTION_STARTED.{principal, parent, chainId, generation, continuedFrom, codeHash}` (→ `_principal`, `_parent`, `_chain`, `_codeHash`; a validated carry seeds `_resources`/`_inbox`), `EXECUTION_SUSPENDED.condition.waits[]` (→ `_waits`), a wait-addressed `EXECUTION_RESUMED` `{ waitId, payload }` (→ `_waitAnswers`), `RESOURCE_METERED.custom` (→ `_resources.custom`), `OUTCOME_RECORDED.{recordedBy, late}`.
  - **The marker rule.** The new kinds, the `PARALLEL_COMPLETED` payload, a wait-addressed resume, a park's `condition.waits` and an outcome's `recordedBy`/`late` fold ONLY an envelope with `metadata.kernel: true` (the journal stamps the first three by kind; the R2 and `recordOutcome` writers stamp the rest through the commit's metadata; no ingress accepts caller metadata). The runtime's commit site also strips `waits` (and an unearned `stepId`) from every userspace park, so a flow can write neither: `ctx.suspend`, a raw `throw new SuspendError` and a human step all funnel through it. An application event that already carries one of those names in an existing log folds as the no-op it always was. The fold now reads three more metadata keys — `kernel`, `forkChain`, `forkedBy` — and the stale "reads exactly one metadata key" comment is corrected.
  - **Frozen shapes.** The shapes above are frozen at W2-0; a later change to any of them is an additive schema change (a further optional field and a MINOR bump), not an edit in place. The folded inner shapes and the mechanisms the round-4 design left open are recorded in the design document ("Frozen at W2-0") and amended into ADRs 0109, 0110, 0111, 0112, 0115 and 0116.
  - **Answering / ignorable classification.** `@loom/event-runtime` exports a REQUIRED `EVENT_KIND_CLASS: Record<EventKind, "answering" | "ignorable">` (no default: an unclassified kind is a compile error) and `isAnsweringKind(event)` (the input to R8k's `acquireFenceIf`): a kernel kind by its map entry; an APPLICATION kind is ignorable (a parallel sibling's emit or a stream delta after a park must not stale the acquire forever); an unknown kind stamped `metadata.kernel: true` (a newer node's kernel kind) is answering, fail-closed. Every later kernel kind's writer must stamp `kernel: true`. New `@loom/core` exports `KERNEL_EVENT_KINDS` / `EventKind`. A fitness test (`packages/spec/src/eventKindWriters.test.ts`) pins handlers = classification and lists every handler with no writer in an explicit "reserved, writer in item X" table (`PARALLEL_STARTED` and `STEP_RETRYING` are the pre-existing exceptions).
  - **`guardUserspaceEmit`.** Refuses the new kinds by name, refuses an `OUTCOME_RECORDED` carrying `recordedBy`/`late`, and validates `RESOURCE_METERED.custom` (name pattern, at most 32, no `constructor`/`prototype`, finite values in [0, 1e15]).
  - **`ExecutionStatus` widens by `"continued"` (source-level change for exhaustive switches).** Terminal and NOT completed everywhere: replay-vm, `LogLifecycle` retention, `blankStream`, the stray-passthrough scanner, `eraseSubject`, analytics (`executionNodes`, `analyze`), learning (`Trajectory.outcome` gains `"continued"`, no terminal reward), `InProcessA2ABus` (`working`), `LocalWorkerRuntime` (not a completion), orchestration (a continued parent's park is gone; a continued child is never settled), `cancel` (no-op) and `resumeAs` (refused). Telemetry, audit-chain's head cache, DST's `exactlyOnceOutcome` and the CLI timeline handle the kernel-stamped `EXECUTION_CONTINUED`, and a fitness test fails any literal terminal-kind set that omits it. Following a chain to its head is deferred to R1b; **interim:** `LocalWorkerRuntime` reports a continued execution as a FAILED dispatch outcome until R1b widens `ExecutionOutcome` or follows `_continuedTo`.
  - **Behaviour change.** Application code that emits `EXECUTION_CONTINUED`, `MESSAGE_CONSUMED` or `PARALLEL_COMPLETED` is now refused at runtime (they are kernel kinds). **In-flight executions that already emitted `MESSAGE_CONSUMED` or `EXECUTION_CONTINUED` as application events now throw on replay (the userspace guard runs before the event is served from the log), and a parked gate that is literally named `MESSAGE_CONSUMED` / `EXECUTION_CONTINUED` becomes unresumable; no known consumer.** **Residual (the one live reserved shape):** an existing log whose app-emitted `RESOURCE_METERED` already carries a field named `custom` folds differently from 1.23.0 (a payload field on a kind that was already folded; it is validated at the userspace guard but cannot be stamp-gated, since metering is written by userspace); `OUTCOME_RECORDED.recordedBy`/`late` and a park's `waits` are stamp-gated and no longer residual. **ABI.** KERNEL_ABI 1.3.0 reserves, and does not contain, `continueAsNew`/`receive`/`select`; the wire handshake advertises `kernelAbiVersion` and `syscalls`, so clients feature-detect against the advertised list and must not infer a syscall from `kernelAbiVersion >= 1.3.0`.
  - **Fold hardening (review round 1).** `_inbox.cursors` and the other new fold maps are read as own properties (a topic named `toString` no longer folds to `NaN`, which a snapshot turned into `null`); the carry seeds `_resources.exceeded`/`reason` so a rotation cannot reset a quota; malformed `waits` never throw the fold.
  - **Tests.** Fold handlers, marker no-ops, carry seeding and validation, wait-addressed resumes, dedupe cap, hostile keys (`packages/replay-vm/src/wave2Fold.test.ts`); seven new wire-abi fold vectors incl. marker-blind-fold and forged-`waits` negatives; guard, journal stamp, no-ingress and `continued` runtime tests (`packages/workflow-runtime/src/wave2Reservation.test.ts`); classification and writer-table fitness tests.

- **R3 round 2 (1P half).** A dispatched resume was gated as `cancel` at `acquireFence`: under
  `cancel: "deny"` a legitimate dispatched resume was refused (and audited as a cancel).
  `acquireFence` takes `gateAs: "resume"`, which `LocalWorkerRuntime.allocate` passes; the public
  default is unchanged. `RunOptions.parentExecutionId` now seeds owner inheritance only on a
  system-granted start or a fork. A throwing `committed` hook is reported via `onWarn`. Residuals
  documented in usage.md: an identified caller can tell not-found from denied; a fence on a fresh
  id records no owner; `createWorkerServer`'s `authorize` is a boolean gate and trusts the
  package's principal.
- **Fail-closed execution authorization and a first-party `ExecutionAuthorizer` (R3, 1P half; no
  ABI or event-schema change).** The execution authorizer was consulted only when a call carried a
  `principal`, and loom shipped no implementation, so every app hand-wrote one.
  - `WorkflowRuntimeDeps.executionAuthz: { requirePrincipal: true }` makes a principal-less
    `start`/`resume`/`resumeAs`/`cancel`/`loadState` reach the authorizer with `principal:
    undefined`. `@loom/app` sets it under `security.strict` (`strict: { requirePrincipal: false }`
    opts out). Off, the runtime is byte-identical.
  - Kernel-internal principal-less callers (`TimerService` wakes and schedule starts,
    `recoverAbandoned`, `retireAbandonedBranches`, the `superviseChildren` child start and parent
    resume) present `runtime.systemOptions()`: an identity-compared,
    per-instance `SystemGrant` that skips the execution authorizer only (it is not a principal and
    never reaches an effect). `runtime.systemStateReader()` serves read-only observers.
  - `executionAccessPolicy()` in `@loom/workflow-runtime`: per-op `owner`/`tenant`/`any`/`deny`
    rules, workflow allow-list, `requireTenant`, `allowAnonymous` (default false), `resolveOwner`.
    It passes the `ExecutionAuthorizer` conformance kit. The scaffold's `app/security.ts` now uses
    it (owner-only, same tenant) and its `main.ts`/test attach a principal.
  - Behavioural note: a strict app that starts executions without a principal now gets
    `ExecutionDeniedError`; attach one, or opt out. Interim until R3's kernel half (ADR 0111): the
    principal is not durable, so ownership is remembered in-process by the policy (lost on restart
    unless `resolveOwner` answers) and internal paths act as the system.
  - **Review round 1 (Opus), all fixed:**
    - *`LocalWorkerRuntime` is no longer the system.* It applied the grant to every package, so
      every dispatcher-routed caller (`InProcessA2ABus`, `executeGraph`, `PlacementDispatcher`, a
      worker-server) bypassed the authorizer: an anonymous dispatch read and approved another
      actor's execution. It now takes NO grant by default; `new LocalWorkerRuntime(runtime, {
      system: runtime.systemOptions().system })` is the explicit opt-in for a recovery/timer
      re-drive target, applies to principal-less packages only, and sets `runsAsSystem`.
      `ExecutionPackage.principal` and `WorkerRequest.principal` (optional JSON) carry the caller
      across the seam and every dispatcher forwards them (**Dispatcher SPI 1.1.0 to 1.2.0**,
      minor: optional fields, plus the optional `WorkerRuntime.runsAsSystem`). `InProcessA2ABus`
      takes `options.principal` (bus default) / `DispatchOptions.principal` (per call);
      `executeGraph` takes `options.principal`. `createWorkerServer` throws when built around a
      `runsAsSystem` worker without `authorize`, and honours a package's `principal` only when
      `authorize` is set (it is the authenticated dispatcher's claim); without it the field is
      dropped and the dispatch is anonymous.
    - *Owner hijack.* The reference policy recorded the owner inside `authorize("start")`, before
      the start committed, so a start that then FAILED (duplicate id, invalid input) still took
      the id. `ExecutionAuthorizer.committed?(request)` is called once the bootstrap is durable and
      is where ownership is recorded; `authorize` no longer adopts. A start with no principal of
      its own inherits its parent's owner (`RunOptions.parentExecutionId`, set by the child
      supervisor; a fork's child gets the forker's). A schedule occurrence or timer wake has no
      parent and no principal, so it has no owner (refused for owner/tenant scopes unless
      `resolveOwner` answers).
    - *Every execution op is gated.* `fork` (`query` on the parent + `start` on the child),
      `restoreFromState` (`resume`, and the `resumeAuthenticator` now runs) and `acquireFence`
      (`cancel` on an existing execution, `start` on a new id) took no identity and skipped the
      authorizer; each now takes `{ principal, system }` like `resume`. The full op table is in
      usage.md.
    - *The owner table never evicts.* A flood used to evict a victim's owner (takeover under
      `unknownOwner: "allow"`, DoS under `"deny"`). At `maxTracked` further starts are refused;
      `adopt` returns whether it recorded. `"allow"` is documented unsafe without `resolveOwner`.
    - *Principal on the wire.* `handleRpc` now applies `resolvePrincipal` to
      `execution.resume`/`getState`/`cancel`, not only `start`. `createA2AServer` takes
      `resolvePrincipal(req)` and `LoomAgentExecutor.submit/get/provideInput` a `{ principal }`
      call context. An A2A server or wire carrier WITHOUT a principal resolver is anonymous and a
      strict runtime refuses it; with one it works. The in-process bus works with a principal
      (above).
    - *Smaller:* an `"owner"`-scoped op whose `resolveOwner` answer names no actor is denied (it
      used to fall back to the tenant); `@loom/testing`'s `resumeWith` takes a fourth `options`
      argument (`{ principal }` / `runtime.systemOptions()`); under strict an ANONYMOUS
      cancel/loadState/resume of an unknown id is denied by the policy instead of answering "not
      found" (an identified caller can still tell the two apart: `loadState(id, { principal })`
      returning `null` is how an edge asks "is this id free?").

- **Strict mode and the autonomy envelope (R9, 1P half; no kernel change).** Every default was
  permissive: no authorizer allowed every effect, no deadline let a run go forever, spawn depth
  and breadth were unbounded, nothing metered spend, and the kill switch was a synchronous
  per-process predicate.
  - `defineConfig({ security: { strict } })`: `true` (or `{ defaultDeadlineMs }`) makes
    composition THROW, listing every problem, without `security.authorizer` and
    `security.executionAuthorizer` and if `checks.verify` is `"off"`; it applies a 24 h default
    execution deadline to flows STARTED under strict that declare none (by wrapping `runtime.start`
    only — never `resume`/`resumeAs`/`restoreFromState` — so the flow fingerprint is NOT changed
    and a resume never cancels an execution the default was not meant for), spawn caps (depth 5, fan-out 32),
    a 1M-token per-execution budget, verification on (`"error"`), and an in-memory kill switch.
    Not strict, behaviour is unchanged and ONE advisory naming what is permissive goes through
    `observability.onWarn`; `strict: false` is the silent opt-out. New `execution.envelope`
    (`spawn`, `budget { perExecution, perAgent, perTenant, pricing }`, `rateLimit`) and
    `security.killSwitch`; `app.strict`, `app.envelope`, `app.killSwitch`; `STRICT_DEFAULTS`.
  - `@loom/middleware`: `rateLimitMiddleware` (token bucket per execution / tenant / workflow /
    process, LRU-bounded, injectable clock), `killSwitchMiddleware` + `KillSwitchRegistry` +
    `InMemoryKillSwitch` (system / tenant / workflow stop, fails closed), and typed refusals
    `RateLimitExceededError` and `KillSwitchEngagedError`, both `retryable: false` — which
    `retryMiddleware`'s default classifier now honours.
  - `@loom/orchestration`: `SpawnLimits`, `boundOrchestration` (parent-side refusal before the
    spawn decision is recorded), `SupervisorDeps.limits` (a refused spawn starts no child and
    resumes the parent with a failed child), `SpawnLimitExceededError`.
  - `@loom/agent` / `@loom/reasoning`: `agentLoop$({ reasoning, reasoningToolId })` routes each
    model call through the EffectRuntime as a journaled frame (`registerReasoningRoutes`),
    `llmSkillSelector({ toolId })` does the same for skill selection, and
    `requireEffectRing` refuses the direct-provider spellings. `ReasoningRuntime.reason` takes an
    optional `invoke` (`ModelInvoker`).
  - `create-loom-app` / `loom new` scaffold `strict: true` with an `app/security.ts` stub.
  - New error names for control-plane classifiers (loom-ui `isControlPlaneError`):
    `RateLimitExceededError`, `KillSwitchEngagedError`, `SpawnLimitExceededError`.

  Behavioural notes: (1) `defineConfig` without `security.strict` now logs one `onWarn` advisory
  — an app that asserted its `onWarn` sink stayed empty must set `strict: false`. (2) The
  direct-provider `llmSkillSelector(provider)` now runs `guardRequest`. (3) Residuals, by
  design: the kill switch refuses the NEXT effect and does not cancel running executions or
  their children (kernel cancel cascade, later); a skill selection or routed call made through a
  `ctx.decide` scope would drop its charge, which is why both are journaled frames instead; the
  per-agent/per-tenant budgets are cumulative per process and eventually consistent across nodes;
  an effect-backed `skillSelector` is refused by `AgentRunner`.

  Limits of the 1P half, stated plainly (each closes in a later kernel/R3 wave, not here):
  - **The default deadline is not durable per execution.** The kernel anchors a deadline to the
    logged start but stores neither the default nor an explicit `start({ deadlineMs })`; a resume
    re-arms `options.deadlineMs ?? flow.deadlineMs`. So a strict-started flow with no
    `flow$({ deadlineMs })` is unbounded again after its first resume. Declare the deadline on
    the flow for one that survives resume. A durable per-execution deadline is the kernel half.
  - **Refusals are ordinary `STEP_FAILED`** (untyped). A flow that CATCHES a kill-switch / rate /
    budget / spawn refusal and continues will, on replay, re-run that step live (at-least-once
    for untyped failures). Do not catch-and-continue past a control-plane refusal.
  - **A rate-limit trip is terminal** (`retryable: false`; `retryAfterMs` is informational).
    The strict middleware order is kill switch, redaction, rate limit, budget, then yours, so a
    user `retryMiddleware` sits INSIDE the limiter and cannot retry a trip.
  - **Tenant scope is not durable yet.** `stopTenant` and `perTenant` read `ctx.principal.tenant`,
    which is not carried across timers, recovery, dispatchers or child spawn until R3; only
    `stopAll` / `stopWorkflow` are reliable across those until then.
  - **Spawn caps are best-effort.** Depth is read from the child-id string and fan-out is per
    `awaitChildren`/`awaitAll` group. A `runtime.start` made from inside an effect, an A2A or
    remote dispatcher hop, or a freshly minted id is not counted.
  - **Budget is blind to transient spend:** a call made through `scope.invokeTransient` (or the
    runtime's `invokeTransient`) has a no-op emit, so it is never charged. A `ctx.execute` frame
    inside a decider IS charged, which is how the effect-backed skill selector's model call is
    metered.
  - **`AgentRunner` is not covered by the `LOOM_AGENT_RING` warning:** its `reasoning` path still
    calls providers directly; use `agentLoop$` with `reasoningToolId` (or `requireEffectRing`)
    for ring-guarded reasoning.
  - **`requireEffectRing` cannot be forced by strict** (it does not construct agents). Set it per
    `agentLoop$` call site; without it `agentLoop$` warns once per process (`LOOM_AGENT_RING`)
    when `reasoning` is used without `reasoningToolId`.
  - **Remote / Cloud Run workers**: strict and the envelope apply to the EffectRuntime of THIS
    process only; a worker process needs its own middleware and authorizer.

  Fixed in review: strict no longer wraps `resume`/`resumeAs`/`restoreFromState` (the wrapper
  cancelled in-flight executions on resume and replaced an explicit longer deadline); strict now
  refuses ANY configuration with no effective spend bound (`budget: false` with `rateLimit:
  false`, or `perExecution: false` with no `perAgent`/`perTenant`); `QuotaExceededError` now
  carries `retryable: false` (so the default retry classifier stops retrying a spent budget);
  an effect-backed skill selection is journaled as a decision (replay serves the selected ids
  instead of re-parsing the recorded response against the current registry, and switching an
  in-flight execution from `llmSkillSelector(provider)` to `llmSkillSelector({ toolId })` serves
  the old `#skills` decision with no new model call).

- **`@loom/verify` declared reach for code a flow hands its `ctx` to (backlog L32).** A flow
  that calls `planner.compose(input, ctx)` reached nothing as far as capability-compat,
  effect-class and suspension-safety could tell, and was not reported either. The compiler now
  records each hand-off of `ctx` (or `ctx.decide`) to a callee outside the module
  (`RunnerReach.escapes`); the library declares what it reaches under
  `Symbol.for("loom.verify.reach")` (`{ run?, transient? }`; `declareReach` /
  `readReachDeclaration` / `ReachDeclaration` exported from `@loom/verify`, zero dependency
  needed for a 3P library); the app maps the callee to the real object with
  `checks.verify.reach: { planner }`. Declared tools join `FlowSpec.effects` (and, for
  `transient`, `deciderEffects`, so `replay-safety` errors on a journaled one) with
  `viaDeclared` provenance; an escape with no declaration is an unresolved `warn` naming the key
  to add. `{ decide: ctx.decide }` handed to a library now resolves the same way instead of
  being a bare `decide alias` warn. `ctx` is recognised as the first parameter of every runner
  (`runner:`, `registerFlow`, `FlowRunner`-typed) whatever it is named and is followed into
  same-module helpers; `ctx.run`/`ctx.suspend` handed out as values are escapes
  (`member`); a declared tool that is not registered is a `warn`; `{ run: [], transient: [] }`
  declares "reaches nothing". A runner that is a wrapper call, factory, import, member or
  `get runner()` accessor is followed where it can be and otherwise reported `runner not
  analysable`, never skipped; ctx-rooted callees are unresolved. `recordReach()` /
  `assertReachMatches()` let a library test its declaration against what it actually runs
  (a task's id is its `toolId ?? id`, as the runtime resolves it). ADR 0083 second consumers: loom-ui planner, genUI
  planner flows, loom-examples `planner-decide-scope`, `@loom/knowledge` `kb.retrieve`. Known
  follow-up L34: 1P libraries (`fanout$`, `awaitChild`, `decideWithPolicy`, `recordOutcome`,
  `runAgentLoop`, `kb.retrieve`) declare their reach. ADR 0086 amendment; no kernel, syscall or
  ABI change.
- **Named cancellation errors (backlog L33).** `@loom/workflow-runtime` exports
  `ExecutionCancelledError` and `DecideScopeClosedError`, each with its `name` set
  explicitly. They replace the plain `Error`s that `throwIfCancelled`, the closed-scope
  rejection, the decider-settled abort and `cancel()` used, so a consumer can classify a
  control-plane refusal by `err.name` instead of matching message text (the motivating
  case: loom-ui's planner must propagate, not retry and record, a cancellation). Messages
  are unchanged. A caller-supplied `Error` cancel reason is still the abort reason and the
  thrown error, as-is. `ExecutionCancelledError.kind` is `"cancel"` for an operator/API
  cancel and `"deadline"` for a kernel-driven deadline breach (same name, so classified
  alike). The signal's reason and the completion rejection are one object.
  **Changed (observable):**
  - `cancel()` with no reason used to abort the signal with the runtime's `AbortError`
    `DOMException`; the reason is now an `ExecutionCancelledError`.
  - `cancel(id, "stop")` (a non-Error reason) used to abort with the raw string, so
    `ctx.signal.reason === "stop"`; the reason is now an `ExecutionCancelledError` whose
    `.reason` is `"stop"`.
  - A persisted `EXECUTION_FAILED` `error` string (`String(err)`) for these now reads
    `ExecutionCancelledError: …` rather than `Error: …` (a step in a cancelled execution
    records `STEP_CANCELLED`, not `STEP_FAILED`; only a leaked decide scope called from a
    step can put `DecideScopeClosedError: …` in a `STEP_FAILED`), and a deadline breach's
    `EXECUTION_CANCELLED` `reason` reads `ExecutionCancelledError: execution deadline
    exceeded (…)`. The fold treats these as opaque strings.
  No EVENT_SCHEMA or KERNEL_ABI change.
- **`@loom/verify` reach analysis counts `ctx.decide` scope calls (backlog L31).** A flow
  whose effects all ran through `scope.invokeTransient("tool.id", …)` inside deciders
  reached nothing, so capability-compat, effect-class and suspension-safety passed
  vacuously. `analyzeRunnerReach` now records a literal-toolId scope call as a reached step
  (`viaDecider`), tracking the scope by binding (`(scope) =>`, `async (s) =>`, destructured
  `({ invokeTransient })`, same-region named deciders). A non-literal toolId, a scope that
  escapes the call site, and a decider passed by reference with no visible body are
  reported as unresolved (the existing ADR 0086 `warn`), never dropped. `replay-safety`
  also errors on a scope call to a `journaled` effect, which the transient seam refuses at
  runtime; the mode is read from the real registry via the new read-only
  `WorkflowRuntime.effectModeOf` / `EffectRuntime.modeOf`; a scope-reached effect that is not
  registered gets an `info` finding. An ambiguous named decider (redeclared, `let`, reassigned)
  and an aliased `decide` (`.bind`, destructured, `ctx["decide"]`, spread args) are unresolved.
  Verify-only plus an ADR 0086
  amendment; no kernel change.
- **`ctx.decide` hands its decider a transient invoker stamped with the deciding execution
  (backlog L30; KERNEL_ABI 1.2.0).** `decide(id, (scope) => scope.invokeTransient(...))`: the
  decider's effect calls (an LLM/MCP planner) previously ran under the synthesized
  `workflowId: "transient"` with only the caller's principal, so flow-scoped K2 grants never
  applied, the execution's delegation token and actor were dropped, and middleware could not
  correlate the call to the deciding execution. The scope now carries the execution's
  `workflowId`/`executionId`, its full principal chain, and its cancellation signal (a
  decider-supplied signal is composed with it, never replaces it; a call still in flight when
  the decider settles is aborted). `stepId` stays the toolId, as for a bare call, so every
  stepId-keyed consumer (secret-output redaction, pricing, per-tool middleware config) matches
  on both paths; calls are told apart by the new `EffectContext.callKey`
  (`decide:<decisionId>:<n>`), which the A2A peer client (task id) and redaction (secret-ref id)
  append so two calls in one execution do not collide. Budget ADMISSION applies (the scope
  passes the execution's running totals); the call's CHARGE is dropped by the no-op `emit`.
  A denial inside a decider is not durable (a decider that catches it leaves no trace in the
  log). Still transient (R1-R5: nothing journalled, no-op `emit`, same middleware chain, the
  journaled/ambient mode check: `journaled` effects are refused, undeclared effects allowed);
  replay serves the recorded decision and never runs the decider; the scope throws after the
  decider settles. New public types `DecideScope` (`@loom/workflow-runtime`) and
  `TransientIdentity` / `TransientInvokeOptions.as` / `.resources` (`@loom/effect-runtime`).
  `TransientInvokeOptions.as` is an authorization input: any wrapper that memoises or dedupes
  transient calls must key on it. `KERNEL_ABI_VERSION` 1.1.0 -> **1.2.0** (additive MINOR: a
  flow that uses the scope throws on an older kernel and can now require >= 1.2.0);
  existing `() => T` deciders and `invokeTransient` callers are unchanged. No EVENT_SCHEMA
  change. ADR 0083 (second-consumer rule) for the new exported types: consumers are the loom-ui
  Planner and genUI's planner decisions.

### Changed

- **`@loom/plugin-sandbox`: `SandboxWorkerPool.run` renamed to `runJson`** (backlog L19
  round-1 review). It is public API (exported from the package), and its second parameter
  used to be the raw `input` value, `JSON.stringify`d internally. It now takes that JSON
  TEXT directly instead (see the L19 entry under **Fixed**) — had the method kept its old
  name, an external caller still passing a raw value under the new semantics would get no
  compile error and a silently wrong VM input: `run(script, "42", …)`, meant as the STRING
  `"42"`, is `JSON.parse`d as pre-serialized JSON and seeds the NUMBER `42` instead. The
  rename makes that a compile error for any caller outside this package. `@loom/sdk/sandbox`
  does not re-export this class, so nothing else in this repo was affected.

### Fixed

- **`PostgresLeaseStore` stamps and judges leases on DATABASE time (backlog L29, closes the
  L28 known limitation).** It used each caller NODE's `Date.now()`, so the `acquire` takeover
  clause compared node A's stamp against node B's clock: skew beyond the ~40s slack (60s TTL,
  renewal every ttl/3) let a fast node steal a live lease or made a slow node's healthy lease
  look expired every cycle (fencing rejected the loser's writes, but effects ran twice). When
  `now` is omitted, `acquire`/`renew` now stamp `expires_at` and the takeover condition and
  `expired()` compare against `(extract(epoch from clock_timestamp()) * 1000)::bigint` in the
  same statement, one clock for every node. The reading is a scalar subquery
  (`(SELECT ...)`, one reading per statement, and `acquire` takes it once via a CTE): a bare
  volatile `clock_timestamp()` in `expired()`'s WHERE is re-evaluated per row and turned
  `idx_leases_expiry` into a full-index Filter (143 ms at 200k live leases vs 0.026 ms as an
  InitPlan with a real Index Cond); a test EXPLAINs the real query (`LEASE_EXPIRED_SQL`).
  `clock_timestamp()` rather than `now()`: `now()` is frozen at transaction start, so a lease
  written through a caller-supplied client inside a long transaction would be stamped and
  judged on a stale reading. An explicit `now` is honoured verbatim (tests, simulated clocks);
  mixing explicit and DB time on one lease table is unsupported. A fractional `ttlMs` is now
  rounded up (Postgres rejected it as `bigint`). `SqliteLeaseStore` is unchanged: single host,
  the process clock is its one clock. **LeaseStore SPI 2.1.0 (MINOR, additive):** optional
  `LeaseStore.storeNow?(): Promise<number>` returns the store's own clock; `PostgresLeaseStore`
  implements it (DB time) and `orphanCensus` (hence `loom census`) judges lease expiry on it
  when present instead of the CLI host's `Date.now()` (executions are still aged by wall
  clock; an explicit `now` overrides both). `Lease.expiresAt` is documented as on the store's
  clock. Stores without `now()` behave exactly as before. `runLeaseStoreConformance` gains a
  `storeNow()` case (skipped when absent; `leaseStoreNowProblem` is exported and negative-proved:
  a store whose `storeNow()` is an hour off its stamping clock fails).

- **`recoverAbandoned` judged lease expiry on the wall clock, not the store's** (backlog L28,
  double-execution hazard under an injected clock). It called `leases.store.expired(Date.now())`
  while `acquire`/`renew` stamped `expiresAt` with the store's own `now`. With
  `InMemoryLeaseStore({ now: sim })` at sim ~ 1000, every live lease (expiry ~ 61000) read as
  expired, so recovery re-drove executions healthy holders were still running. Now
  `LeaseStore.expired`'s `now` is OPTIONAL and defaults to the store's own clock, and
  `recoverAbandoned` passes none. **LeaseStore SPI 2.0.0 (MAJOR, BREAKING for implementers,
  following the MemoryStore 2.0.0 precedent):** an implementation MUST default `now` to the
  clock that stamps its leases. A 1.x store declared `expired(now: number)` still type-checks
  against `expired(now?: number)`, but given `undefined` it returns `[]` (`expiresAt <=
  undefined` is false, SQL `<= NULL` is false), so an UNCHANGED third-party store silently
  recovers nothing. Callers passing an explicit `now` are unaffected. `LEASE_STORE_SPI_VERSION`
  is now in `kernelManifest().spis` and the compatibility matrix, and the cheatsheet banner is
  checked against it (the banner test used to exempt LeaseStore). The in-repo SQLite and
  Postgres stores already default to `Date.now()`, which is what they stamp with (Postgres
  now stamps and judges on database time instead: see L29 below). The conformance case for `expired()` with no argument now takes an optional
  `clocked` factory (`LeaseStoreConformanceOptions`) and drives the store's injected clock
  instead of sleeping, so it discriminates the L28 bug (the check is exported as
  `leaseExpiredDefaultProblem` for third-party kits); `checkCompatibility` accepts a
  `leaseStoreSpi` deployment version; backends with no injectable clock keep
  the wall-clock form. `orphanCensus` keeps its own explicit `now` option (it also ages
  executions by it; documented to be given the lease store's clock when that is not the wall).

- **L27: timer wake times use the runtime's clock** (kernel; behavioural for hand-wired setups,
  and for `defineConfig` with a non-default `execution.now` plus `timers`).
  `ctx.sleep` and `suspend({ timeout })` computed `wakeAt` with raw `Date.now()` while
  `TimerService` judged it with its own `now`, so one simulated clock given to both made
  sleeps never fire (clock behind the wall) or fire at once (clock ahead). `wakeAt` is now
  `runtime.now() + ms`, and `TimerService`'s `now` defaults to the runtime's clock (new
  read-only `WorkflowRuntime.clock`, the same way it already reads `runtime.events`), so a
  simulated or offset `WorkflowRuntimeDeps.now` (`defineConfig` `execution.now`) alone drives
  sleeps, suspend timeouts and cron cursors. An explicit `TimerService` `now` still wins; if it
  disagrees with the runtime's clock, timers fire early (it runs ahead) or never (it runs
  behind). Default wall-clock setups are unchanged. **Fixed clock:** under a FIXED clock
  (including `defineConfig` `execution.now` plus `timers`) sleeps, `suspend({ timeout })` and cron
  schedules now never fire, where they used to fire on wall time; advance the clock or drive
  `tick(now)` yourself. **Offset clock:** an offset is safe only if every runtime touching the log
  uses the same one; this covers wake times and cron, and applies across an upgrade (timers parked
  before it carry wall-clock `wakeAt`, so an offset runtime fires them |offset| early or late,
  never under a fixed clock; old and new nodes disagree during a rolling upgrade).
  `sleepUntil(absolute)` targets and cron occurrences are measured on the runtime clock. `tools/dst` is unaffected (its runtimes
  keep the wall clock; drivers still jump to `wakeAt` themselves); to virtualise sleeps pass
  `now: world.clock.now` to the runtime.

- **L26 round 2: invalid `timeoutMs`/`deadlineMs` are rejected** (behavioural tightening).
  `step$`/`flow$` now throw on NaN, 0, negative and Infinity (NaN armed a 1ms timer, 0 and
  negatives breached at once, Infinity never fired; omit the field for no deadline). The same
  check runs again in the runtime (`registerFlow`, `start` of an inline definition, `ctx.run`
  before `STEP_STARTED`) for specs that bypass the builders, so an invalid budget can no longer
  fire at 1ms. A per-call `options.deadlineMs` is validated at the top of `start`, `resume` and
  `resumeAs`, before any read or append, so a rejected call leaves the log untouched (a
  caller-chosen `executionId` is not burned and can be retried). No in-repo or loom-examples caller passed such a value. Also documented: under a
  FIXED `now`, a budget above 2^31-1 ms (~24.8 days) never fires within a single run (each
  chunk re-arms; test added), and the deadline timers are deliberately not `unref`'d.

- **Step `timeoutMs` and execution `deadlineMs` mixed two clocks** (backlog L26, latent, P3 in
  production). The deadline anchor is a journal timestamp written with the runtime's injectable
  `now` (`WorkflowRuntimeDeps.now`), but the remaining budget was computed from raw
  `Date.now()`. With any `now` that is not the wall clock the remaining time was either hugely
  negative (every `timeoutMs` step failed with `StepTimeoutError`, every `deadlineMs` execution
  was cancelled at start) or above 2^31 ms (Node clamps the timer to 1ms). Both are now measured
  with `now`; `EXECUTION_DENIED` and cancel-of-a-suspended-execution envelopes are stamped with
  it too. The `setTimeout` still waits real milliseconds, so `now` must advance in real time for
  a deadline to fire on time; the option's TSDoc said "never fold-relevant" and now says
  deadline-relevant. The default clock is unchanged. Also fixed on the same lines: a
  `timeoutMs`/`deadlineMs` above 2^31-1 ms (~24.8 days) made Node clamp the timer to 1ms, so
  `deadlineMs: 30 days` durably cancelled the execution ~1ms after start. The remaining budget
  is now capped at the declared budget (a clock stepping backwards cannot grant more) and a
  longer wait is armed in chunks of at most 2^31-1 ms, recomputing from `now` at each chunk.
  Caveats: a FIXED `now` silently disables the crash-surviving deadline (elapsed is always 0,
  so every resume re-grants the full budget), and an offset `now` is safe only if every
  runtime touching the log uses the same offset. (`ctx.sleep`/`suspend({timeout})` wake times
  were fixed in L27 and lease expiry in L28, both above.)
- **Six packages value-imported a package they declared only in `devDependencies`** (backlog L22).
  The workspace links every package everywhere, so nothing in the suite noticed; a consumer
  installing the PUBLISHED package would get "Cannot find module" at load. Moved to
  `dependencies` (the repo's convention, no peers): `@loom/plugin-worker-server` -> `@loom/core`;
  `@loom/app` -> `@loom/classify`; `@loom/orchestration` -> `@loom/effect-runtime`; `@loom/cli`
  -> `@loom/effect-runtime`, `@loom/snapshot-runtime`; `@loom/agent` and `@loom/plugin-a2a` ->
  `zod`. New fitness test `packages/spec/src/runtimeDeps.test.ts` scans every workspace
  package's non-test `src/` (AST, so multi-line, `export ... from`, `require` and literal
  `import()` count; `import type` / all-`type` specifiers do not) and fails naming the package
  and import when it is not in dependencies, peerDependencies or optionalDependencies.
  The same test also requires TYPE-only imports in shipped `src/` to be declared (the emitted
  `.d.ts` names the package): `@loom/capability` type-imported `zod` from its public types while
  declaring it only in `devDependencies`, so it moved to `dependencies`; the one other hit,
  `@loom/worker-runtime-local`'s `spiShapeProof.ts` (type-imports the dev-only `@loom/conformance`),
  is an exact, justified exemption because the file is emitted but unreachable (not exported, and
  the `exports` map exposes only the entry). It additionally scans the hand-written subpath shims
  a package ships outside `dist/` (`event-runtime` `memory.js`/`sequence.js`, `snapshot-runtime`
  `memory.js`) and requires the JSX import source (`react`) to be declared for any package
  whose tsconfig uses the automatic JSX runtime. Known limit, documented in the test: non-literal
  `import(spec)`/`require(x)` (tools/cli, packages/isolate runner) are invisible to a static scan.
- **`@loom/isolate`: `timeoutMs` charged child-process startup, and a brokered fetch never timed
  out** (backlog L23 + L24; same class as the L13 sandbox clock). (L23) The run clock started
  at spawn, so under load a 150 ms tool was killed before its module finished loading, and
  since a kill discards the child the next call cold-started and died again, forever. The
  parent now warms the child first (`booted` -> `warm` -> `ready`); `timeoutMs` opens only when
  the child is ready. Startup has its own allowance, new `coldStartMs` (default 10 000, finite
  and > 0, else `RangeError`); a child that exceeds it, or exits or disconnects while warming
  (any exit code), fails with the typed `IsolatedToolStartupError` (exported) instead of
  hanging, and is replaced on the next call. Its `phase` is `"spawn"` (the runner never booted:
  the environment) or `"load"` (the tool module's top-level code hung or exited: a TOOL fault);
  a module that throws at load fails the load phase with a plain tool `Error`, once, instead of
  being re-executed by the run. **`coldStartMs` also bounds untrusted top-level code** (unlike
  the sandbox's trusted compile), so a tool that forces a cold start on every call costs up to
  `coldStartMs + timeoutMs` per call; size it accordingly ([ADR 0019](docs/adr/0019-k7-data-plane-isolation-and-egress-control.md)
  addendum). An abort during warm-up kills the child and rejects with the abort reason.
  (L24) A host that accepted and never answered held a `maxConcurrentFetches` slot forever.
  New `fetchTimeoutMs` (default 30 000, finite and > 0) bounds each fetch end to end, DNS
  lookup included (a stalled `getaddrinfo` is no longer waited on past the deadline): on expiry
  the request is destroyed, the slot released, and the tool's `ctx.fetch` rejects with
  `code: "FETCH_TIMEOUT"` (error `name` `IsolatedFetchTimeoutError`; not an exported class).
  Fetches are also aborted when the run that issued them ends or is killed.
  **Review fix (security):** an untrusted tool could crash the PARENT: a callback-less `send()`
  to a closed IPC channel emits an uncaught `'error'` (`ERR_IPC_CHANNEL_CLOSED`), reachable by
  `process.disconnect()` while a fetch is in flight, and a disconnected-but-alive child was
  reused by the next call. The parent now holds a permanent `error` listener, treats
  `disconnect` as death (SIGKILL, entry discarded, in-flight run fails with the new exported
  `IsolatedToolDisconnectedError`), checks `proc.connected` before reuse, and sends with
  callbacks.
  **Review fix round 2:** (1) the runner child no longer outlives its parent: it exits on
  `disconnect` (exit code 70) registered before any tool code loads, and the parent SIGKILLs live
  children from ONE module-level `process.exit` hook (a `kill -9` of the parent relies on the
  runner handler alone). Hardening only: a hostile tool can remove the runner's handler, and
  OS-level confinement remains out of scope. (2) A DNS abort still answers the tool with
  `FETCH_TIMEOUT` immediately, but the `maxConcurrentFetches` slot is now held until the
  uncancellable `getaddrinfo` actually settles, so pending lookups stay bounded by the cap
  (`brokeredFetch` takes a new optional `hooks` argument, `BrokeredFetchHooks.lookupStarted`,
  through which the effect learns when the lookup settles).
  (3) Every `EGRESS_DENIED` emit in the fetch handler is guarded (a throwing `ctx.emit` fails the
  run instead of an unhandled rejection in the parent). (4) A child crash or `close()` mid-run
  keeps its `crashed mid-run` error (the disconnect waits up to 100 ms for `exit`); a child that
  stays alive after severing its channel, or that exits through the runner's own disconnect
  handler, is `IsolatedToolDisconnectedError`. (5) A non-JSON-serializable input (circular,
  BigInt) now rejects with the new exported `IsolatedToolInputError` before any timer or
  listener is registered, leaving the healthy child alone. `StartupPhase` is now exported.

- **Two retrying dispatchers ping-ponged one execution, re-running its step on every bounce**
  (backlog L20, [ADR 0004 amendment](docs/adr/0004-failure-recovery.md); from the L12 review of
  [ADR 0103](docs/adr/0103-durable-bootstrap-for-caller-chosen-ids.md)). With `maxAttempts > 1`,
  `LocalDispatcher` counted a lost start race (`ExecutionAlreadyExistsError`) or a fenced-out
  attempt (`StorageWriteError` caused by `StaleFenceError`) as a failed attempt and
  redispatched; the redispatch's fence superseded the healthy holder, which did the same. A
  one-step flow's effect ran 5–6 times on a duplicate dispatch (18 under
  `SupervisingDispatcher({ maxRestarts: 2 })`), past ADR 0004's "the interrupted step may run
  twice". New `isSupersededRefusal(err, executionId)` and `ExecutionSupersededError` in
  `@loom/worker-runtime`; `LocalDispatcher` and `SupervisingDispatcher` rethrow such a refusal
  without retrying (and without tripping the circuit). It must name THIS execution, so a
  coalesced batch's stale fence for another execution, and every other storage error, are
  still retried. The HTTP worker answers it `409 { code: "superseded" }` instead of an opaque
  500, and `RemoteWorkerRuntime` / `CloudRunWorkerRuntime` rethrow it as
  `ExecutionSupersededError`. Now 1 effect (race) / 2 (after bootstrap). Defaults
  (`maxAttempts: 1`, `maxRestarts: 0`) were already safe. **Dispatcher SPI 1.0.0 → 1.1.0**
  (MINOR: a new MUST that non-retrying dispatchers already meet; the kit case runs only with
  `runExecutionDispatcherConformance(…, { overWorker })`). `SupervisingDispatcher` still counts
  an earlier genuine failure in the same dispatch; the worker server reports 409s to a new
  `onSuperseded` hook; `RemoteWorkerRuntime` also requires the 409 body to name its execution.
  Two things this required elsewhere: `TenantScopedEventStore` now re-raises
  `StaleFenceError` / `DuplicateSequenceError` / `DuplicateEnvelopeIdError` with the caller's
  (unscoped) ids — it forwarded the scoped `acme:x`, which brought the ping-pong back in full
  under tenancy — and a start refused on the fence twice with sequence 0 still absent is now
  `StorageWriteError` caused by the new, retryable `StartFencedOutError` (from
  `@loom/workflow-runtime`), because settling it as superseded lost the start outright when the
  newer token's holder had died before writing. **What settling means:** a superseded refusal
  transfers ownership to the newer fence holder without checking it is alive — its liveness is
  covered only by its own dispatcher policy and by `recoverAbandoned`, which deployments MUST
  run to cover dead holders — and it can be the caller's own timed-out earlier attempt, so a
  caller that needs the outcome awaits the execution by id rather than treating it as failed.
- **An A2A peer that answered `/tasks/send` with the finished task was polled for it anyway**
  (backlog L18). `createA2AClientEffect` — and so every `A2APeerClient` call — read only `id`
  from the send answer, slept `pollIntervalMs` (default 500 ms) and asked `/tasks/:id` for a
  result it already held: a synchronous peer (for instance a thin shim whose send handler runs
  a graph and returns its artifact) cost every call a fixed half-second and a second request,
  and one that does not keep finished tasks failed with `A2A status error 404`. A `completed`
  or `failed` task in the send answer is now returned as-is; an `{ id }` answer (loom's own
  `createA2AServer`, which submits asynchronously) and a non-terminal one are polled exactly as
  before. Found as a full-suite load flake: `peerTaint.test.ts` spent ~500 ms of each test in
  that sleep. Review follow-ups: a non-object or otherwise malformed send answer (a bare string,
  `null`, or a terminal task with no `id`) now throws a clear `A2A send error: malformed answer`
  instead of a bare `TypeError`; and a peer-supplied task id has its `/`, `?`, `#` and `%`
  characters escaped before it is used to build the poll URL (and `A2AServer`'s `GET /tasks/:id`
  route decodes them again), so an id containing `/` can no longer be collapsed by URL
  normalization into a request for a different route. Deliberately NOT a full
  `encodeURIComponent`: every loom task id contains `:` (`A2APeerClient` sets
  `task.id = `${executionId}:${stepId}``), and escaping it would send `exec%3Astep` on the wire —
  a 404 against an older, non-decoding `A2AServer` (or third-party peer) during a rolling
  upgrade. Minimal escaping keeps that byte-identical while still closing the path-traversal gap.

- **`ShardedEventStore` over Postgres skipped execution ids when paging** (backlog L10,
  [ADR 0108](docs/adr/0108-execution-id-order-and-fail-soft-migrations.md); EventStore SPI
  **1.5.0 → 2.0.0, MAJOR**: `checkCompatibility` refuses a `1.x` store). `listExecutionsPage` promised "lexicographic" order, which names no
  one order: `PostgresEventStore` paged in the database collation (`en_US.UTF-8` puts `a_b`
  before `A1`), while `ShardedEventStore` merged shard pages with JavaScript's sort and resumed
  EVERY shard from the merged page's last id — so each shard skipped the ids that sort after
  that cursor in one order and before it in the other, and re-served others (reproduced on a
  PG 17 `en_US.UTF-8` cluster: 17 ids came back as 12 entries — 9 missing, 3 duplicated). Retention, the
  read-model catch-up and every `iterateExecutionIds` pass over a sharded Postgres log were
  silently partial. The SPI now pins the order to Unicode **code point** order (= UTF-8 byte
  order, SQL `COLLATE "C"`, SQLite BINARY — the SQLite store already conformed), and the cursor,
  which was opaque, is an executionId (any string) with `nextCursor` the page's last id. That is
  MAJOR because a store conforming to 1.x can fail the new kit case (the ADR 0091 rule); no
  method was added or removed. It also exports the reference
  comparator `compareExecutionIds` from `@loom/event-runtime` (JavaScript's default sort
  compares UTF-16 code units, which disagree with code points on astral characters; the
  in-memory store and the sharded merge now use it). `@loom/plugin-postgres` declares
  `events.execution_id` `COLLATE "C"` and converts an existing table in place on the next
  migration (binary-coercible: no table rewrite, but the two `execution_id` indexes are rebuilt
  under an ACCESS EXCLUSIVE lock once — ~4.5 s per 2M events measured; plan a window for a
  large log), then re-`ANALYZE`s the column (the ALTER drops its statistics, and the planner
  then pages with a seq scan + sort), so paging stays index-only and appends get cheaper
  (memcmp instead of `strcoll`). The conversion waits at most `lockTimeoutMs` for its lock
  (default 2000; set it reliably with `migratePostgresStores(pool, { lockTimeoutMs })` before
  constructing stores, or via `PostgresEventStoreOptions.migrationLockTimeoutMs` /
  `postgresStorage({ migrationLockTimeoutMs })`, which apply when that store migrates the pool
  first), so it cannot queue every append behind itself, then restores the caller's
  `lock_timeout`. The rebuild itself is exempt from `statement_timeout` (restored afterwards),
  so a pool-level timeout cannot abort it on every boot, and so is waiting on the migration's
  advisory lock, so a peer booting mid-rebuild queues behind it instead of failing its
  migration (which left its store refusing every call until restart). If the lock wait times out, the
  statement is cancelled, or a user view or rule depends on the column, boot continues with a
  WARNING naming the two statements to run by hand — paging stays correct (the query says
  `COLLATE "C"` itself), only slower. ADR 0108 D3 makes this the policy for future boot
  migrations that take an exclusive lock.
  Also fixed on the same path: `Sharded(TenantScoped(…))`, the composition
  `TenantScopedEventStore` documents, re-served its first page forever, because the tenant view
  handed out its INNER (prefixed) cursor while the sharded merge handed back an outer id; it now
  speaks outer ids and, with the order pinned, seeks to its tenant's contiguous range (past
  tenants whose names extend its own, such as `acme-eu`) and stops at its end instead of walking
  the whole shared store. The in-memory store keeps its sorted id index across pages instead of
  re-sorting every key per page. The conformance kit gains a code point
  order + arbitrary-cursor case, and `@loom/plugin-postgres` runs the EventStore kit through
  `ShardedEventStore` over three real Postgres shards (raw and tenant-scoped).
- **`BranchRegistry.listRefs` ordered refs three different ways across backends** (backlog
  L21, addendum to [ADR 0108](docs/adr/0108-execution-id-order-and-fail-soft-migrations.md);
  BranchRegistry SPI **1.2.0 → 2.0.0, MAJOR**: a store conforming to 1.x can fail the new kit
  case). Postgres paged in the database collation, SQLite in BINARY (already correct), and
  the in-memory store with `String.prototype.localeCompare` — which is normalization-aware,
  so it can return `0` for two DISTINCT names (an NFC "é" and its NFD decomposition are
  canonically equivalent under most locales). `pruneBranchRefs` pages `listRefs` with an
  `after` cursor, so a comparator that disagrees with the store's own order, or ties two
  distinct names, skips or repeats refs at a page boundary — the same failure mode L10 fixed
  for execution ids, on a second SPI. `listRefs` now orders names in the same Unicode code
  point order D1 pinned (`compareExecutionIds`), and `after` may be any string, not only a
  name the store returned. The in-memory store sorts with `compareExecutionIds` and caches
  the sorted name list across calls (invalidated only when a name is added or removed), same
  shape as the in-memory EventStore's `sortedIds`. `@loom/plugin-postgres` declares
  `refs.name` `COLLATE "C"`, states it explicitly in `listRefs`'s query, and converts an
  existing table in place on the next migration (one index rebuilt — `refs`'s own primary
  key — under an ACCESS EXCLUSIVE lock, following D3's bounded-wait / fail-soft-WARNING
  policy exactly; the two migrations now share one `loom.migration_lock_timeout` setting,
  renamed from `loom.l10_lock_timeout`). The conformance kit gains a code point order +
  arbitrary-cursor case for `listRefs` (mixed case, `-`/`_`, digits, NFC vs. NFD "é", an
  astral name), and `@loom/plugin-postgres` runs the L21 migration against a real pre-L21
  `refs` table the same way it does for L10's `events` table. `pruneBranchRefs` needed no
  code change: it was already contract-driven.
- **`@loom/workflow-runtime`: a fenced `TimerService` could pay for a schedule occurrence's
  first effect twice** (backlog L12, closing the "loser's fence" residual of
  [ADR 0103](docs/adr/0103-durable-bootstrap-for-caller-chosen-ids.md)). With `fenced: true`
  the service acquired a fence before every occurrence START. When the losing node acquired
  it after the winner's bootstrap was durable, the loser was correctly refused as a duplicate,
  but its new token had already superseded the winner's: the winner's next write was refused
  as stale after its first effect had run, the execution was left `running`, and a recovery
  pass re-drove the step. Occurrence starts are now never fenced. The durable bootstrap
  already refuses the duplicate at sequence 0, and the first later fence (a fenced wake or a
  recovery pass) still fences the unfenced starter out, because a fencing store refuses a
  missing token once one exists (a new single-`append` conformance case pins that branch).
  So under `fenced: true` a scheduled execution accepts unfenced writes until its first fence
  (a fenced fire, a fenced recovery pass, a cancel). A deterministic test pins exactly one
  effect across the race and a recovery pass. As a consequence, the other ordering no longer
  reaches `onError` either: the loser is always refused as "already started". Fires
  (resumes) are still fenced, which keeps a duplicate fire's writes safe but NOT its effects
  exactly-once: without `leases` (#380) a later node's fire token fences out an earlier
  node's resume mid-body, recorded as an open residual in ADR 0103. The dispatcher path
  (`LocalWorkerRuntime`) fences before it checks existence, so a racing first dispatch never
  supersedes a live winner; a test pins it.

  `start()` with a caller-chosen id now confirms a `StaleFenceError` at sequence 0 the same way
  it confirms a conflict. If sequence 0 reads back, the id belongs to an existing execution
  that has since been fenced, and the start throws `ExecutionAlreadyExistsError` (it used to
  throw `StorageWriteError`). If sequence 0 is absent, the start retries once alone, so a
  fresh start that shared a `CoalescingEventStore` batch with a zombie's stale write still
  runs. Then it throws `StorageWriteError`. The retry is now truly alone: it goes out as a
  one-envelope `appendBatch`, which a `CoalescingEventStore` flushes as its own batch. Before,
  it re-entered the coalescing queue, so two same-id starts that shared a batch shared the
  retry batch too, BOTH failed with `StorageWriteError`, nothing started, and a
  `TimerService` occurrence was dropped. The `acquireFence` JSDoc no longer recommends
  fencing a start, and warns that a fence supersedes a live holder. No SPI, KERNEL_ABI or
  EVENT_SCHEMA change.

- **`@loom/plugin-sandbox`: the worker pool's hard kill charged runtime creation and input
  seeding to the script** (backlog L13). The worker stamped the run's start before
  `evalInFreshRuntime` created the QuickJS runtime and seeded `input`, while the in-VM wall
  clock is armed only after both. So the parent's hard-kill budget (`wallClockMs` +
  `hardKillGraceMs`) was spent before the script ran: a large input — or a loaded host, where
  even an empty runtime is slow to create — made worker mode return `limitExceeded
  { wallClock }` for a script in-process mode completed, routing a resource kill to
  drift-repair for a script that never ran long (reproduced deterministically: a trivial
  script over a 16 MiB input). `evalInFreshRuntime` now takes an `onScriptStart` hook fired
  at the instant it arms its own wall clock, and the worker publishes that instant, so both
  clocks share one origin. The end of the charged window is unchanged: output marshalling
  still counts, because `dump` can run script code (`toJSON`) that only the hard kill can
  stop. One of the two causes of the full-suite "survives a hard kill" flake; the other was
  the test asserting a 100 ms wall budget for its follow-up run, and is fixed in the test.

- **`@loom/plugin-sandbox`: a worker that never starts a run now fails with a named
  `SandboxWorkerStartupError`** (L13 review). The phases excluded from the script's budget
  (worker scheduling, input parse, runtime creation, seeding) were already bounded by the
  pool's startup-liveness window, but the failure was a plain `Error`, indistinguishable
  from any other. It is now `SandboxWorkerStartupError` (`waitedMs`, `limitMs`), exported,
  and deliberately not a `TypedFailure`: it is the environment failing, not the script, so
  it must not reach `limitExceeded`/drift-repair, and `retryMiddleware`'s default retries it.
  Two allowances, both reported through that error (its `phase` says which): a READY worker
  that has not started the script within `wallClockMs + hardKillGraceMs + startupLivenessMs`
  of the eval being posted (`phase: "start"`), and a cold worker's spawn + WASM compile,
  which has its OWN allowance `coldStartMs` measured from the start of the warm-up and
  independent of any run's limits (`phase: "compile"`) — a compile that never acknowledged
  used to strand its run forever, and judging it against a run's tight wall clock would
  bring back the cold-worker failure loop ADR 0089 D4 prevents. Both are configurable on
  `SandboxWorkerPoolOptions` and `SandboxSpec.workers` (default 10 000 ms each).
  `hardKillGraceMs`/`startupLivenessMs` must be finite and `>= 0`; `coldStartMs` must be
  finite and strictly `> 0`, since it is the only clock a cold compile is ever judged
  against — 0 there does not mean "always warmed before use" (a run's own window never
  judges the compile), it means every cold start fails, forever, and (chained through a hard
  kill) loops. All three refuse anything else at construction, since `NaN` silently disabled
  the bound. `warm()` now settles when its worker exits (it hung on a worker terminated
  mid-warm-up, including by `close()`), and does so with `SandboxWorkerStartupError` rather
  than a plain `Error` for an unexpected exit, matching the wedged-compile case; `close()`
  settles a run still waiting on a cold compile; and an abort during warm-up rejects the run
  and frees the slot at once rather than after the compile. A worker the cold-start allowance
  terminates is now replaced synchronously rather than waiting for its `exit` event to reach
  the pool's death handler — that handler ignored a `terminate()`d worker's exit when its code
  was 0 (which it can be, this soon after spawn, on Node 24), so the dead slot could sit
  un-replaced until some later run's own rejection happened to reclaim it, or a `warm()`-only
  waiter's allowance fired and nothing ever did. The death handler now treats ANY exit as
  death unless the pool itself requested the shutdown. Also: a worker whose run threw before
  starting now stamps the run id with `RUN_FINISHED`, so the parent recognises the finish as
  its own.

- **`@loom/plugin-sandbox`: the script's INPUT was unbounded** (backlog L19, closing
  [ADR 0089](docs/adr/0089-sandbox-worker-pool.md) D4's "a separate question" residual).
  `maxOutputBytes` capped what a script may EMIT; `input` stayed `z.unknown()`, JSON-stringified
  by the caller, posted to a worker and parsed back (or seeded straight into the VM in-process)
  — none of that work runs inside the guarded window, since every limit is charged to the
  script's own execution, which had not started. So an oversized input was bounded only by the
  worker pool's startup-liveness window (L13): a 200 MB input could hold a worker busy for
  ~10 s and then fail with the untyped `SandboxWorkerStartupError`, which default retry
  middleware then retries — repeatedly, on a call that could never succeed. `SandboxLimits`
  gains `maxInputBytes`, checked once in `SandboxEvalEffect` — the shared caller of both
  engines — BEFORE either is touched (and before the script is fetched): an oversized input
  fails typed and non-retryable on a **new**, dedicated channel, `inputTooLarge { bytes,
  limit }` — deliberately NOT `limitExceeded`, which is recorded as the SCRIPT's own outcome
  and routes to drift-repair (re-author the script), a fix that cannot shrink a caller's
  input. **Default is 32 MiB, matching `memoryBytes`'s own default (derived from the same
  constant), not `maxOutputBytes`'s** — round-1 review measured real reshaping inputs at
  1.47–30.9 MB, all succeeding today under the default heap, so the initially-shipped 1 MiB
  default (mirroring `maxOutputBytes`) would have refused every one of them; there is no
  general "headroom under the heap" relationship to size a tighter default against, since how
  far a JSON text expands once parsed depends on its shape. This default therefore refuses
  nothing that succeeds today, and is validated the same way `SandboxWorkerPoolOptions`'
  durations are (refuses `NaN`/negative/non-numeric at construction — now also applied
  retroactively to `maxOutputBytes`, closing the same pre-existing gap there; `0` is accepted
  for either — "refuse every input/output" is a caller's deliberate choice, and a call that
  omits `input` entirely, or whose script returns `undefined`, still costs 0 bytes).

  Two more caller-input failure modes, found in the same review, get the same typed,
  non-retryable treatment, reported before either engine runs: `input` that cannot become
  JSON at all — a BigInt or a circular reference (`JSON.stringify` throws) or a bare
  function/Symbol/`toJSON` returning `undefined` (`JSON.stringify` returns the JS value
  `undefined`, not a string, which used to reach `Buffer.byteLength` and throw an unrelated,
  confusing `TypeError`) — now fails typed as `inputNotSerializable { reason }`, a second new
  channel; and an input UNDER `maxInputBytes` that still overflows the VM heap while being
  PARSED (parsing can expand a JSON text well past its own byte length) now fails typed as
  `inputTooLarge { bytes, limit: memoryBytes }` in BOTH engines, rather than the untyped
  "input marshalling failed: out of memory" it used to throw — `evalInFreshRuntime` reports
  this as an ordinary outcome (`duringSeed: true`) instead of throwing, so `SandboxEvalEffect`
  keeps deciding channel semantics in one place (ADR 0089 D3) regardless of which engine ran.

  Measured once, not twice: `evalInFreshRuntime` and `SandboxWorkerPool.runJson` (see
  **Changed**, below) now take the already-`JSON.stringify`d input text directly rather than
  the raw value, so the effect's one measurement is reused to seed the VM or post to a
  worker — and worker mode no longer parses that JSON back out only to re-stringify it for
  the VM, one JSON round trip removed rather than added. No SPI, KERNEL_ABI or EVENT_SCHEMA
  change.

- **`@loom/plugin-postgres`: `appendBatch` refused a `null` payload** (backlog L16). The bulk
  insert decoded its batch with `jsonb_to_recordset`, which maps a JSON `null` field to SQL
  NULL, so `payload JSONB NOT NULL` rejected the kernel's status-only `EXECUTION_RESUMED`
  (payload `null`, [ADR 0104](docs/adr/0104-recovery-never-answers-a-gate.md)) on every
  `appendBatch` caller — the `CoalescingEventStore` flush, and `LogLifecycle` retention's archive
  copy (so an execution that had ever resumed could not be archived to a Postgres store, and was
  never reclaimed) — while `append` stored it fine. `payload` is now read as
  `e->'payload'` over `jsonb_array_elements`, which keeps JSON `null` as jsonb `null` and
  still yields SQL NULL only for an absent (`undefined`) payload, failing exactly as
  `append` does. The conformance kit gains a direct `appendBatch` null-payload case, so an
  undecorated store catches this without the coalescer. Every other Postgres write path
  (`append`, `copyPrefix`, snapshot / read-model / durable-state / memory stores) binds
  `JSON.stringify(...)::jsonb` or copies jsonb server-side and was already correct; the
  SQLite batch path stringifies per row and was unaffected.

- **`@loom/workflow-runtime`: fork points in compacted history, and the blank-stream repair**
  ([ADR 0107](docs/adr/0107-compacted-fork-points-and-the-blank-stream.md), closing ADR 0106's
  residuals).

  - **`fork()` of a compacted parent returned a wrong state.** A fork point inside the
    compacted prefix folded the nearest snapshot across the hole and copied a prefix missing the
    history it claimed. `fork()` now serves a fork point exactly (every event between the
    nearest snapshot and it survives, or a snapshot sits exactly at it) or throws
    `CompactedForkPointError` (`reason`, `forkableFrom`, `forkableThrough`) with nothing
    written. For a branch of a compacted parent, `forkableFrom` is its fork seed. A snapshot-seeded
    child whose copied prefix would carry pinned events below its seed is refused
    (`checkpoint-above-prefix`): that shape reads as never compacted. The range is now the
    folded tip, so the checkpoint of a log compacted through its tip (`[0]`) is forkable. Before,
    it was refused as outside `0..0`.
  - **Events the pre-0106 bug wrote to execution `""` can be repaired.** `LogLifecycle.
    blankStreamCensus()` / `rehomeBlankStream({ apply, assign })` and
    `loom repair blank-stream <store> [--assign <id>:<from>-<through>,…] [--apply]` (dry run by
    default). A segment is proven when the snapshot its run saved under the real id, at a drain
    barrier, is exactly the fold of the stray events onto that execution's previous snapshot.
    Proven segments are re-homed at their own sequences (`metadata.rehomedFrom`) and journaled
    as **`EVENTS_REHOMED`** on the lifecycle stream (**EVENT_SCHEMA 1.22.0**, pure audit into
    `_lifecycle`). Unprovable runs (a completion with no checkpoint) are listed with their
    candidate executions, never attributed. An operator who knows the owner asserts it with
    `--assign`. The assignment is still checked: the execution must hold a pre-0106 snapshot at
    `from − 1`, parked at the gate the range opens by answering (the awaited event, or
    `TIMER_FIRED` at its wake time, after any approval/`resumeAs` fact), with nothing above it.
    An assigned range once re-homed is reported `rehomed`, not unattributed again. Shredded
    placeholders (key of `""` gone) are refused. A
    healthy execution can never be assigned a stray run. `occupied`, `superseded` and
    `conflict` segments are refused. Each execution's slots land in one batch. A fenced
    execution is written under a new fence, and a never-fenced one stays unfenced. An execution
    that changed since the census is reported in `failed` without stopping the others. A
    missing `EVENTS_REHOMED` fact is written on the next run, and lifecycle facts retry a write
    conflict. A raw store that reads the stray events as ciphertext refuses to apply (use
    `--config`). Re-runs are idempotent, and the `""` stream is left as evidence. After a repair,
    rebuild read models, and in an encrypted deployment destroy subject `""`'s key
    (`shredSubject(keys, raw, "", { executionIds: [] })`), which `shredSubject` now allows while
    refusing reserved ids among the `executionIds` it tombstones.
  - **`""` is reserved.** `isReservedStream("")` is `true`, so enumerators skip it. `start`,
    `resume`, `resumeAs`, `cancel`, `fork` and `restoreFromState` refuse it, `loadState("")`
    returns `null` and `compact("")` throws. `cancel("")` used to append `EXECUTION_CANCELLED`
    into the stray stream.

- **`@loom/workflow-runtime`: compaction integrity**
  ([ADR 0106](docs/adr/0106-compaction-integrity.md), backlog L11). Defects in
  `LogLifecycle.compact` and the code that reads what it leaves:

  - **A resume after compaction lost its events.** The checkpoint was folded with no identity,
    so its `executionId`/`workflowId`/`workflowVersion` were `""`, and the journal stamped
    every envelope from the folded state: the resume's events were appended to execution `""`.
    The checkpoint now takes its identity from the log. Its version comes from the base
    snapshot, or from the latest snapshot when the base is a blank pre-0106 checkpoint. The
    journal writes under the id it was started for and refuses a blank one, so a legacy
    `restoreFromState` state appends nothing. Every snapshot-seeded fold (`resume`, `resumeAs`,
    `loadState`, `cancel`, `fork`) fills a blank identity. A NON-blank one naming another
    execution is refused (`SnapshotIdentityMismatchError`) rather than overwritten.
  - **A second compaction dropped the first one's prefix.** It folded the surviving events
    from scratch. It now folds on the latest snapshot at or below its checkpoint, and throws
    `CompactionCheckpointMissingError` (nothing saved or truncated) when a compacted log has
    none at or above its gap.
  - **A denied resume wrote into the checkpoint's slot.** `EXECUTION_DENIED` was recorded
    after the log's last event. On a log compacted through its tip (`[0]`), that slot sits at
    or below the checkpoint, so the log looked never-compacted and the next compaction lost the
    suspension. It is now recorded after the folded tip.
  - **Compaction deleted pinned events (ADR 0055 D1).** `LogLifecycle` takes
    `pinnedEventTypes` (`defineConfig({ durability: { retention: { pinnedEventTypes } } })`,
    validated at boot) and keeps those events in place. Non-strings and every kernel-written
    kind are refused, including `EXECUTION_RECOVERED` and `EffectInDoubtResolved`. `compact`
    consults the `pinned` predicate only when no kinds are declared. With kinds declared, a
    pinned execution (the documented sentinel setup pins by the same kinds) compacts around
    them. A new `compactionExempt` predicate (also `retention.compactionExempt`) is consulted
    always, and keeps a whole log uncompacted (a legal hold by tag). Reserved control streams
    are refused.
  - **The shred tombstone landed in the checkpoint's slot.** `shredSubject` placed
    `PAYLOAD_SHREDDED` at `read().length`, at or below a compacted log's checkpoint. The next
    compaction then deleted the A3 evidence, or the log read as never compacted. It now follows
    the folded tip. **Breaking:** on a store that can `truncatePrefix`, pass the raw
    `snapshotStore` (or `tombstoneSequenceOf`). Otherwise it refuses, before the key is
    destroyed. Sequences for every execution are resolved BEFORE the key is destroyed, so the
    app's encrypting snapshot store works. A partial append failure throws
    `ShredIncompleteError` after attempting every execution. A re-run with the key already gone
    writes only the missing tombstones. An execution already counts as done when compaction
    folded its tombstone into the checkpoint. The documented shredder no longer guards on key
    existence, which would never have retried. **SnapshotStore SPI 1.1.0:** optional
    `loadLatestSealed`, the latest snapshot at rest, never decrypted. `EncryptingSnapshotStore`
    implements it and `TenantScopedSnapshotStore` forwards it, so a retry works through a
    tenant-scoped encrypting store. `EraseCoordinator` also refuses a snapshot whose
    non-blank identity names another execution (`SnapshotIdentityMismatchError` and
    `assertSnapshotIdentity`, exported from `@loom/snapshot-runtime`).
  - **Erasure waited forever on a compacted terminal execution.** `EraseCoordinator` folded
    the log alone. It now takes `snapshotStore` (`defineConfig` wires it).
  - **The tip rule.** When compaction keeps events, it never removes the log's tip. A
    checkpoint is therefore always the log's highest missing sequence, a gap-free log was never
    compacted, and no reader needs a "checkpoint above the tip" special case (except the
    bootstrap-only `[0]` a keep-nothing compaction leaves).

  **EventStore SPI 1.5.0:** optional `truncatePrefixKeeping(executionId, through,
  keepEventTypes)`, one atomic delete. In-memory, SQLite and Postgres implement it, and every
  decorator forwards it; the hash-chained store refuses it, as it refuses `truncatePrefix`.
  **A store without it can never compact past a log's first pinned event**, so a long-lived
  execution that records a finding early keeps an unbounded replay tail there. `compact` warns
  (`onWarn`) once per execution. The conformance kit now checks `truncatePrefix` and
  `truncatePrefixKeeping`.

  Readers updated:
  - The content sweep finds a gapped log's checkpoint as the lowest snapshot in `[gap, tip]`.
    A kept finding at sequence 1 used to hide a compaction and let the orphan pass erase
    checkpoint-only refs, and a child forked from a compacted parent was refused.
  - `liveQuery` checks a delta's whole span.
  - The replay inspector refuses a position inside compacted history (`CompactedHistoryError`)
    instead of folding across the gap. It probes past the segment with one `head` read.
  - The content sweep reads a forked child's seed directly (`metadata.forkSequence`,
    `loadAt`).

### Changed

- **`@loom/replay-vm`: a step failure the flow catches no longer fails the execution**
  ([ADR 0105](docs/adr/0105-a-caught-step-failure-is-not-the-executions.md)). `STEP_FAILED`
  folded the EXECUTION status to `failed` as well as the step's frame, so a flow that caught the
  failure (try/catch around `ctx.run`, a saga compensation, a typed-failure fallback) ran on
  under a terminal status. A crash after the catch left an execution `recoverAbandoned` and the
  dispatcher would never re-drive, `cancel` refused, retention could prune as finished, and A2A
  peers polling it were told `failed` (`"unknown error"`). A parallel sibling failing AFTER the
  flow parked did the same to a suspended execution: its gate could not be resumed, and
  `TimerService` retired a timed park's row as obsolete. `STEP_FAILED` now folds the frame only, like `STEP_CANCELLED`;
  `EXECUTION_FAILED`, which the kernel commits when a failure escapes the runner, stays the
  execution's terminal failure.

  - **EVENT_SCHEMA 1.21.0** (no new kind or payload field; KERNEL_ABI unchanged): the status
    fold changed, and a new reserved fold key `_failedWhileParked` (`FAILED_WHILE_PARKED`) marks a
    parked execution a `STEP_FAILED` landed on. A `null` `EXECUTION_RESUMED` in that position stays
    status-only, as 1.20.0 folded it (a 1.20.0 `resumeAs` wrote exactly that entry), so every gate
    passthrough folds as under 1.20.0 and the result no longer depends on which snapshot seeds the
    fold. The key is removed by whatever ends the park (a park, a resume, or a terminal event).
    **Cost (fail-closed), refused at ingress:** a caller's `null` answer to such a gate cannot be
    its answer, so `resume` / `resumeAs` refuse it with `ResumeRefusedError`
    (`null-answer-after-parked-failure`, new reason) and append nothing; resume with a non-null
    answer.
  - Snapshots saved by an older fold are repaired on read: `normalizeSnapshotState`
    (`@loom/replay-vm`, new export) reads `failed` with no `_error` and a failed frame as
    `running` (`suspended` when parked) — on every stored-fold read, including `restoreFromState`.
    Two shapes it cannot tell from a genuine failure, so an old snapshot keeps `failed`: an
    `EXECUTION_FAILED` without `error` (never kernel-written), and an execution that genuinely
    failed, was re-opened by `resumeAs` (stale `_error`) and then caught a step failure. Delete
    that execution's snapshots (`snapshotStore.deleteExecution`) to make the log authoritative.
  - New `reconcileTimers(runtime, { source, timers })` (`@loom/workflow-runtime`) re-arms the
    timer row of every execution suspended on a `wakeAt` (idempotent). Needed once after
    upgrading: a timed park whose sibling failed under the old fold had its row retired by
    `TimerService`, and now reads `suspended` with nothing to wake it.
  - **Behaviour change:** when the `EXECUTION_FAILED` write itself fails, the run now rejects with
    `StorageWriteError` (`cause` = the store's error) instead of the step's error — the log folds
    `running`, so the caller must not be told "failed". `handle.getState()` and `onEvent` remain
    the in-memory view (they saw the commit) and read `failed`.
  - `recoverAbandoned` takes an optional `maxRecoveries` (≥ 1; default unbounded): the number of
    CONSECUTIVE re-drives without progress (`EXECUTION_RECOVERED` at the log's tail since the
    last `STEP_COMPLETED` / `EXECUTION_SUSPENDED` / `EXECUTION_RESUMED`), checked only for claimed
    candidates. Executions at the bound are skipped, counted in `summary.exhausted` (new field)
    and reported through `onExhausted`. `loom recover --max-recoveries N` lists them.
  - `loom eval` goldens that pinned `status: "failed"` for a log ending after a caught failure
    now fail and must be re-recorded.
  - **Upgrade note.** On the first deploy every stored execution whose log ends after a caught
    step failure changes from `failed` to `running`. A staleness-predicate `recoverAbandoned`
    pass then selects all of them, however old, and re-drives each (re-executing an untyped
    failing effect; a changed flow hash throws on every pass), and `LogLifecycle` stops pruning
    them; timed parks whose row the old `TimerService` retired never wake. Before enabling
    recovery: run `orphanCensus` or `recoverAbandoned({ dryRun: true })`, bound `isAbandoned` by
    age, cancel what should not resume, set `maxRecoveries`, and run `reconcileTimers` once.

- **`@loom/workflow-runtime`: a gate is answered only by a resume addressed to it**
  ([ADR 0104](docs/adr/0104-recovery-never-answers-a-gate.md)). **Security fix.**
  `ctx.suspend` serves the recorded resume payloads to gates in order (ADR 0057), so every
  `EXECUTION_RESUMED` payload is some gate's answer. Four writers recorded one that answered no
  gate, and the flow's NEXT gate consumed it: no resume named the gate, no authenticator saw an
  approval, and the gate's declared `resumeSchemas` entry (ADR 0077) was never consulted.

  - Crash recovery (`recoverAbandoned`, `LocalWorkerRuntime`) wrote `EXECUTION_RESUMED {}`. A
    flow that crashed before `ctx.suspend({ on: "go1" })` passed go1 with `{}`. Recovery now
    records `EXECUTION_RECOVERED` alone.
  - An in-doubt verdict (K9.3) became the next gate's approval. It is now a kernel
    `DECISION_RECORDED` keyed by step and attempt, so a verdict also goes stale correctly: a
    "retry-fresh" attempt that itself crashes re-parks in doubt rather than calling the
    non-idempotent tool again. A resume at an in-doubt park that is not a verdict for the parked
    step is now refused (`ResumePayloadValidationError`, nothing appended); it used to be
    appended and re-park.
  - A HumanEffect step's answer went to the next gate while the step re-parked forever. A
    `kind: "human"` step now consumes its answer in order with `ctx.suspend` and completes with
    it.
  - `resumeAs` onto a crashed execution answered its next gate. Onto a terminal one it now
    records `EXECUTION_RESUMED(null)`, which re-opens the execution (a crash during the migrated
    run is recoverable) without answering a gate.
  - `resumeAs` onto an execution parked at a gate answered it under ANY event name, with no
    schema, authenticator or authorizer check. It now enforces all of `resume`'s gate rules
    there.
  - Flow and effect code could forge kernel state: `ctx.emit("EXECUTION_RESUMED", …)` answered
    the flow's own gate, and `STEP_STARTED` + `EFFECT_INDOUBT` + `EXECUTION_RESUMED(verdict)` got
    a non-idempotent step adopted with no tool call. **Behaviour tightening:** `ctx.emit` /
    `stream` / `ui` and `EffectContext.emit` now refuse every kernel event type except
    `RESOURCE_METERED`, `QUOTA_EXCEEDED`, `SAFETY_BLOCKED`, `EGRESS_DENIED`, `EFFECT_DENIED`,
    `OUTCOME_RECORDED` and `DECISION_RECORDED`, and validate those.
    - Meter values must be finite, non-negative and plausible.
    - An EFFECT's `DECISION_RECORDED` is recorded as `effect:<stepId>#<attempt>:<id>`, so it can
      never pre-empt the flow's `ctx.decide`. `AgentRunner`'s routing facts move to that id.
    - No userspace emit may change a recorded choice.
    - An isolated tool's relay forwards application events only; a kernel type fails the run.
    - Decision ids beginning `__loom_` are reserved (`ctx.decide` and emits refuse them; a getter
      cannot dodge the check).
    - A verdict counts only beside the kernel's own `EFFECT_INDOUBT` fact for that step and
      attempt.
  - A human step's park now records `condition.stepId` (kernel-only). A pre-0104 log whose open
    human step's answer cannot be told apart from another entry is refused
    (`ResumeRefusedError`, new reason `ambiguous-legacy-answers`) unless the operator resumes
    with an event carrying `discardLegacyAnswers: { stepId, count }` that the configured
    `ResumeAuthenticator` VERIFIES (never on recovery or a timer). It is recorded durably with
    the verified actor. The old kernel never completed a human step, so nothing that ran is lost.

  **EVENT_SCHEMA 1.20.0:** the fold treats a `null` `EXECUTION_RESUMED` into an unparked or
  in-doubt execution as status-only. The EventStore conformance kit now asserts that a `null`
  payload round-trips. Logs written by the old kernel replay as written, because withdrawing an
  entry that already passed a gate would re-park the flow behind recorded steps or shift later
  payloads one gate early. `resume()` classifies them via `onWarn`, once per execution: "passed"
  (audit which gate) or "at-risk" (the next gate WILL pass with it — act now). **Rolling deploys:**
  hold in-doubt verdicts and `resumeAs` onto terminal executions until every node runs this
  version; an old node folds the new `null` resume as a gate answer. Downgrade is unsafe for the
  same reason. A recovery no longer counts as a
  resume in `@loom/analytics` or fires telemetry's `onFlowResume`. KERNEL_ABI unchanged (1.1.0).

- **`@loom/agent`: `agentLoop$` compaction also triggers on bytes** ([ADR 0087](docs/adr/0087-durable-agent-loop.md)
  D5, amended). D5 named claim-check as the "bytes per turn" answer to the log-growth trade-off;
  it isn't — claim-check offloads a tool RESULT's bytes, not the transcript an agent journals as
  every turn's `STEP_STARTED` input, so one oversized tool result rode along uncompacted until it
  aged past `keepRecent` on message count alone. `compaction` gains `afterBytes` (a running UTF-8
  byte count maintained per message push, O(1) amortized, never a re-serialization — so it stays
  replay-deterministic) alongside the original `afterMessages`; at least one is now required,
  enforced by a constructor guard. The byte trigger keeps the longest run of the newest messages
  whose bytes total at most `afterBytes / 2` (floored at 1, capped at `keepRecent`), and skips
  compacting a turn where the newest message alone is already over budget rather than paying a
  summary call that folds nothing. Also documents, rather than adds a hook for, the claim-check
  contract toward the model: a claim-checked tool's result reaches the model as the recorded
  envelope (ref + digest), never resolved back to its bytes — resolving it would put those bytes
  into the NEXT turn's journaled input, undoing the offload — so declare a `digests[toolId]`
  projection for model-facing claim-checked tools. A `resolveToolResult` hook was considered and
  rejected for the same reason. No kernel change; EVENT_SCHEMA and KERNEL_ABI unchanged; existing
  `afterMessages`-only configurations are unaffected.

- **`@loom/plugin-a2ui`, `@loom/plugin-mcp-app`: A2UI structural validation — dangling ids,
  cycles, unreachable components, malformed catalogues** ([ADR 0088](docs/adr/0088-blueprint-conformance.md)
  D5, amended). `validateComponents` gains four finding codes checkable without JSON Schema —
  `dangling-child`/`dangling-template` (error; a `children` reference no component in scope
  defines), `child-cycle` (error; a component reachable from itself via `children`), and
  `unreachable-component` (warn; no path from `root` reaches it, reported only when
  `requireRoot` and a root exists) — via one iterative white/grey/black DFS, O(V+E), no
  recursion. `column("root", ["ghost"])` and `column("root", ["root"])` previously passed with
  `ok: true`; both now fail. New `validateCatalog(catalog)` checks that every `components`/
  `functions` entry's key agrees with its own `component.const`/`name`
  (`catalog-entry-key-mismatch`/`catalog-function-key-mismatch`), run in the
  `A2UISurfaceBridge` constructor. `ValidateComponentsOptions` gains
  `knownComponents?: ReadonlyMap<string, ComponentInstance>` so a batch's `children` may resolve
  against ids outside itself. `@loom/plugin-mcp-app`'s `surfacePayload` never validated at all
  (an unknown component silently rendered as nothing); `SurfacePayloadOptions` gains
  `catalog?: A2UICatalog` (default `defaultCatalog`) and `surfacePayload` now validates with
  `requireRoot: true` and throws like the A2UI bridge — **one breaking change, loud:** a
  previously-unexamined bad tree now throws.

  **The correction that made recompose checkable:** `A2UISurfaceBridge.recompose` replaces its
  stored tree with each batch, while an A2UI client MERGES `updateComponents` by id — so
  validating a batch against only itself (or the bridge's previous batch) would reject a
  batch's correct reference to an already-delivered sibling. The bridge now keeps
  `clientView: Map<id, ComponentInstance>`, seeded in full when the session opens and merged
  incrementally per batch (O(batch)), and `recompose` validates and walks cycle detection
  against the batch overlaid on that view — so a batch may reference any earlier batch's
  component, and a batch that closes a cycle back through an already-sent component is still
  caught. Deferred: prop-VALUE JSON-Schema checking and `callFunction` argument validation
  (need a JSON-Schema engine plus A2UI `common_types.json` `$ref` resolution — a consumer with
  a typed catalogue, likely loom-ui, is the trigger). No kernel change; EVENT_SCHEMA and
  KERNEL_ABI unchanged.

- **`@loom/conformance`: `runLlmProviderConformance` no longer passes a stream that
  silently drops a tool call.** The kit's own request carries no `tools`, so the general
  parity test could never observe a dropped `toolCalls` — a vacuous input twice over
  (the 2026-09-27 backlog audit, item 4). `runLlmProviderConformance` gains a third,
  optional argument, `opts?: { toolRequest?: LlmRequest | null }`:
  - given a `toolRequest` (a request the provider is known to answer WITH a tool call),
    and when the provider has `stream`, `complete(toolRequest)` MUST itself return ≥1
    tool call (a fixture that makes none is a refusal, not a pass), the stream's
    assembled `toolCalls` MUST `toEqual` it, and when `completed.stopReason` is
    `"tool_use"` the streamed `stopReason` MUST equal it;
  - omitting `toolRequest` on a provider that has `stream` is now a FAILING case —
    "stream parity for tool calls is unproven — pass `toolRequest`" — an absent input is
    a refusal, per the vacuous-check pattern;
  - a text-only provider that genuinely cannot call tools opts out explicitly with
    `{ toolRequest: null }`, visible in its own test file rather than inherited from an
    unset default.

  This is a behavioural tightening of the conformance contract, not an SPI shape change:
  there is no `LLM_SPI_VERSION` constant to bump (`@loom/llm` has none, and the LLM SPI
  is absent from `docs/spec/compatibility-matrix.md`), so the tightening is recorded here
  and on `LlmStreamChunk`'s docstring (`packages/llm/src/types.ts`) instead. The rule
  itself lives in a new internal module, `packages/conformance/src/toolCallParity.ts`
  (not re-exported from the package's single public entry point — no second consumer has
  named a standalone need for it, ADR 0083), so its negative cases (a stream that drops a
  tool call, a vacuous fixture, a missing `toolRequest`) can be unit-tested directly —
  vitest has no supported way to prove a nested `describe`/`it` fails from inside a
  running test. `loom-plugins` and `loom-examples` call the kit zero times today
  (re-grepped at execution time), so the blast radius is the scaffold template only
  (`tools/scaffold/src/plugin.ts`), which now shows `toolRequest` in its generated example
  call. `docs/requirements/2026-08-18-agent-runtime-placement-evaluation.md` gets three
  status notes: K8.4 shipped via ADR 0020 A8's `streamTokenBudget`, not the dropped
  `EffectContext` usage-reporter field the doc still described as pending; and
  `@loom/live-query` is not the "transient delta sink" a since-corrected paragraph named
  it as (it has no delta-push API — see the 2026-09-27 backlog audit's item 2 and
  [ADR 0040](docs/adr/0040-live-query-and-orchestration.md)).

- **`@loom/live-query`: `subscribe` folds incrementally — O(N), not O(N²)**
  ([ADR 0040](docs/adr/0040-live-query-and-orchestration.md) Amendment). The 2026-09-27 audit
  confirmed `subscribe` re-folded from genesis (`reader.loadState`) on every wake-up — exactly
  the O(N) rows/event, O(N²)/lifetime cost `WorkflowRuntime.foldState`'s own docstring names
  (measured: N²/2 rows folded, 10.6s at N=4,000 on SQLite). `subscribe` now calls
  `reader.loadState` exactly once per subscription and folds every later delta
  (`eventStore.readFrom(id, tip + 1)`) onto the kept state with `@loom/replay-vm`'s
  `foldEvents` — no new fold, no new version (`fold(snapshot, suffix) === fold(events)`, already
  load-bearing for snapshots/compaction). Also fixes a doc bug the same audit found:
  `createLlmEffect.ts` and `chunkDeltas.ts` named live-query a "natural"/"purely transient" sink
  for streamed deltas, but live-query has no delta-push API (`snapshot` + `subscribe` over
  DURABLE events) — both now name `progressHub` (or the app's own `onDelta` handler). New
  dependency: `@loom/replay-vm`. No kernel change; EVENT_SCHEMA and KERNEL_ABI unchanged.

- **`@loom/plugin-sandbox`: a script's own exception is a typed `scriptError` channel**
  ([ADR 0064](docs/adr/0064-sandbox-eval-plugin.md) D3, amended). `SANDBOX_ERRORS` gains
  `scriptError { name?: string; message: string }` — whatever the script threw on this input,
  including a non-Error value (`throw 42` → `{ message: "42" }`), a SyntaxError in its source,
  and a ReferenceError for `fetch`/`require`/`process` (previously deliberately untyped: the VM
  cannot tell a missing capability from a typo). `name` is kept only when it is a string
  (≤ 128 chars), `message` is bounded at 2048, and no stack is ever carried. Callers can now tell
  "the script threw" from an infrastructure failure without parsing error text: a closed or
  failed worker pool, a script whose bytes do not match their content address, input
  marshalling and cancellation all stay untyped, and a guard kill stays `limitExceeded` even
  when the script catches it and rethrows. Being declared, it is recorded as
  `STEP_FAILED { channel, payload }`, substituted on replay and not retried (ADR 0060). The error
  message keeps the old `sandbox script failed: Name: message` text. Additive for replay: an old
  log's untyped STEP_FAILED has no channel, is never substituted as `scriptError`, and keeps
  legacy re-execution. `docs/api-reference.org` had the channel map wrong
  (`limitExceeded`/`badShape`) and stale `sandboxEval$`/`registerSandboxEval` signatures; both
  are fixed. No kernel change; EVENT_SCHEMA and KERNEL_ABI unchanged.

  Also: memory/CPU kills are read from the text of the engine's own `InternalError` only — a
  script's `throw new Error("connection interrupted")` (or "…out of memory…") was previously
  reported as `limitExceeded` and is now `scriptError`. Script-authored text is bounded without
  splitting a surrogate pair, and lone surrogates and NUL become U+FFFD, so the failure event is
  storable in Postgres `jsonb`. The text is untrusted and not taint-wrapped: never put it in a
  prompt's instruction position.

  **Upgrade note:** a run that is paused or suspended past an untyped failed sandbox step (a
  flow that caught the old `Error("sandbox script failed: …")`) re-runs that step when resumed
  on this version — untyped failures were never substituted — and the re-run now throws a
  `TypedFailure` on `scriptError`. A catch that tests `instanceof TypedFailure` or the channel
  takes that branch on the re-run; the recorded events are untouched.

- **Blueprint IR 2.4.0 (ADR 0101).** A minor bump so a container keeps its identity when a
  recompose inserts or reorders containers around it:

  - `GridLayout`, `FlexLayout` and `StackLayout` gain an optional `id` — the same rule as
    `Widget.id` (a non-empty string, no charset, no length cap; `isLayoutId` is the one spelling
    of it). `grid`/`flex`/`stack` accept it
    and omit the key when absent, so an unid'd layout's bytes and content address are 2.3.0's; a
    present id enters the address.
  - Widget ids and layout ids are one namespace: `duplicate-node-id` now also fires for
    widget↔layout and layout↔layout collisions. `validateBlueprint` gains `layout-id-invalid` — a
    `warn` for a present id that is not a non-empty string, which every reader then treats as
    absent. Layout-level findings name the layout by its id when it has a valid one.
  - New `blueprintLayoutIds`; `preservesBlueprintNodes` compares widget ids AND layout ids, so a
    re-identified container is a `dropped-node-id` finding. `blueprintNodeIds` stays widget-only.
  - `@loom/plugin-renderer-react` keys a container by its id, fixing the index keys nested
    containers got: inserting a container mid-list no longer re-creates the widgets of the
    containers after it (typed input and focus survive). Grid cell keys are prefixed (`k:` keyed,
    `i:` by index) so an id like `"1"` cannot collide with an index key. The DOM is unchanged.
    `@loom/plugin-renderer-terminal` ignores the id; its output is byte-identical.
  - `BLUEPRINT_IR_VERSION` moves `2.3.0` → `2.4.0` with a sixth pinned digest; 2.3.0 (like 2.0.0
    to 2.2.0) is read as it is by `validateBlueprint` and `upgradeBlueprint`.

- **Blueprint IR 2.3.0 (ADR 0100).** A minor bump so a bound widget whose upstream answered with
  nothing can say "no data" instead of failing:

  - `BindingState` gains `"empty"` — delivery succeeded and there is no subject to show. It
    travels the existing status channel (`binding.status.path`); `isBindingStatus` admits it
    under the same rules as the other four states. Not an error; it triggers nothing.
  - The canonical matrix gains an `empty` row right after `error` and before the `check` slot
    (there is no value to check). A producer must clear the bound value when it publishes `empty`;
    a reader ignores one if it is there.
    `@loom/plugin-renderer-react` renders `data-binding-state="empty"` with a `role="status"`
    marker `○ <title>: no data` (or the finding's message); `@loom/plugin-renderer-terminal`
    prints the same row. A pre-2.3.0 reader sees `empty` as a malformed status and falls back to
    its loading/ready row, never its error row.
  - `BLUEPRINT_IR_VERSION` moves `2.2.0` → `2.3.0` with a fifth pinned digest; 2.2.0 (like 2.0.0
    and 2.1.0) is read as it is by `validateBlueprint` and `upgradeBlueprint`. No new finding: a
    status is runtime projection data, never part of the artifact.

- **Blueprint IR 2.2.0 (ADR 0099).** A minor bump so a container can ask for a renderer of its
  own, the way a widget does through `kind`:

  - `GridLayout`, `FlexLayout` and `StackLayout` gain an optional `role` — the open,
    app-defined container axis (`"stepped"`, `"tabbed"`, …); `type` stays the geometry.
    `grid`/`flex`/`stack` accept it and omit the key when absent. Never an ARIA role, never
    display text.
  - `isLayoutRole` is the one spelling of a well-formed role (`/^[a-z][a-z0-9-]{0,63}$/`);
    absent, malformed or unknown ⇒ the plain container. A renderer that keys containers keys
    them by ordinal + `type` + `role`, so a role change is a remount.
  - `BLUEPRINT_IR_VERSION` moves `2.1.0` → `2.2.0` with a fourth pinned digest; 2.1.0 (like
    2.0.0) is read as it is by `validateBlueprint` and `upgradeBlueprint`.
  - `validateBlueprint` gains `role-invalid` — a `warn`, once per layout whose `role` is present
    but not `isLayoutRole`. A well-formed role no renderer knows is not a finding.
  - `@loom/plugin-renderer-react` and `@loom/plugin-renderer-terminal` ignore the role: a roled
    artifact renders exactly as the unroled one.

- **Blueprint IR 2.1.0 (ADR 0098).** A minor bump for genUI's migration onto loom-ui, which
  needs free placement and titled views:

  - `GridCell` gains optional `row`, `rowSpan` and `column` (1-based grid lines; `span` is still
    the width). All absent = flow placement, as before. `cell(span, node, { row, column,
    rowSpan })` states a placement.
  - `GridLayout`, `FlexLayout` and `StackLayout` gain an optional `title` (a section heading);
    `grid`/`flex`/`stack` accept it.
  - `BLUEPRINT_IR_VERSION` moves `2.0.0` → `2.1.0` with a third pinned digest. 2.0.0 artifacts
    are read as they are: `validateBlueprint` knows `2.0.0`, and `upgradeBlueprint` is identity
    on it, so no stored artifact is re-addressed.
  - `validateBlueprint` gains `placement-out-of-range` (one finding per cell; never a cascade
    from a bad `span` or `columns`).
  - `@loom/plugin-renderer-react` wraps a placed cell with explicit `grid-column`/`grid-row`
    and renders a titled layout as `<section><h2/>…</section>`; `@loom/plugin-renderer-terminal`
    prints placed cells in reading order and a titled layout under an underlined heading. An
    unplaced, untitled artifact renders exactly as it did under 2.0.0 on both.

- **Blueprint IR 2.0.0 (ADR 0097).** Three leaks loom-ui's adapters had been working around —
  never reaching loom's own renderers, or a third consumer — are now channels the IR itself
  carries:

  - `GridLayout.children` is now `GridCell[]` (`{ span?: number; node: Widget | Layout }`)
    instead of a bare `Array<Widget | Layout>`, so a grid child's column span is a fact of the
    IR rather than a `props.span` side channel one renderer honoured and the other silently
    dropped.
  - `DataBinding.status?: { path }` names where, in the *same* projection state as the bound
    value, that binding's delivery state (`BindingStatus`: `state: BindingState` —
    `"pending" | "ready" | "stale" | "error"` — plus optional `seq` and `finding`) lives. Both
    first-party renderers now show pending/stale/error from a declared channel.
  - `Widget.source?: WidgetSource` (`{ type, version, degradedFrom? }`) names what a widget
    actually stands for and the semantic types it was degraded through to reach its rendered
    `kind` — never smuggled through `props`.
  - `DataBinding.sensitivity?: DataClass` (from `@loom/classify`, type-only) declares a
    binding's confidentiality class on the artifact; this ships the field only, audience
    enforcement is a loom-ui concern.

  This is a **MAJOR** bump: `BLUEPRINT_IR_VERSION` moves `1.0.0` → `2.0.0`, with the `1.0.0`
  digest kept pinned beside the new `2.0.0` one ([ADR 0096](docs/adr/0096-blueprint-stable-rendering-ir.md)'s
  guard). Readers accept 1.0.0 transparently — `asCell` normalises a legacy bare grid child on
  every read path, and `upgradeBlueprint(bp)` re-addresses a whole 1.0.0 artifact to 2.0.0
  explicitly (identity on already-2.0.0 input) for a caller that wants to. Writers always emit
  2.0.0: `blueprint$` stamps `irVersion`, and `grid({ columns, children })` now accepts
  `Array<GridCell | Widget | Layout>` and normalises every element, so every existing
  `grid({ children: [...] })` call in this repo and its examples keeps compiling unchanged; a
  new `cell(span, node)` builder is how a caller states an explicit span.

  `validateBlueprint` gains seven new finding codes: `span-out-of-range`, `columns-invalid`,
  `malformed-node`, `status-path-invalid`, `sensitivity-unknown`, `source-invalid`,
  `ir-version-unknown` — all findings, never throws. `columns-invalid` (a grid's `columns` is
  not a positive integer) suppresses that grid's span check, so one bad `columns` yields one
  finding rather than one per child; `malformed-node` (a layout child that is neither a
  `Widget` nor a `Layout` — a stray `null`, a string, a `GridCell` outside a grid) makes the
  walk total, so a model-composed artifact can never make `validateBlueprint` throw.

  `@loom/plugin-renderer-react` gains `WidgetFrame` (applies the canonical binding-status
  matrix and `source` data attributes around a widget's rendered body — adds **no** wrapper
  element for a widget with neither a declared status channel nor a `source`, so a 1.0.0
  artifact's DOM is unchanged) and `useWidgetSlice` (a fiber selector over `{ value, status }`
  together). A grid child gains a wrapper element **only** when its span exceeds 1; span-1
  children, and therefore every 1.0.0 grid, are DOM-identical to 1.0.0 and still reconcile by
  widget id. `@loom/plugin-renderer-terminal`'s `TerminalWidgetRenderer` gains an optional
  third `status?: BindingStatus` parameter, and the terminal output gains status glyphs
  (`⋯` pending **and the loading row** — a declared channel with no value yet renders
  `⋯ <title>` rather than `<title>: —` — `~` stale, `✗` error) and a degraded-from suffix when
  a channel or `source` is declared — output for a widget with neither is byte-identical to
  before.

  Both renderers take an optional `check(widget, value)` (`TerminalRenderOptions.check`; the
  `check` prop on `BlueprintRenderer` and `WidgetFrame`): the value-contract slot the matrix
  leaves between `error` and `stale`. loom validates nothing about a bound value itself — a
  framework's own kind contract plugs in there, and a returned `{ code, message }` renders as
  the error row. It runs only for a widget that declares a status channel and only when
  delivery has not already failed.

  A widget with no declared status channel — the overwhelming majority of existing artifacts —
  renders exactly as it did under IR 1.0.0, on both renderers.

### Fixed

- **`docs/scaling.md` and ADR 0074 D4 corrected: bucketed NOTIFY fixes client-side delivery,
  not the writer-side cost; `tools/bench-throughput` section C is un-vacuated**
  ([ADR 0074](docs/adr/0074-storage-scale-out-decorators.md) Amendment). D4 claimed bucketed
  `LISTEN loom_events_<bucket>` "fixes an O(events × nodes) broadcast whose cost lands on the
  writer." It fixes client-side filtering and the follow-up per-notification `SELECT`; it does
  not fix the writer cost, which is per LISTENing backend and channel-independent — a listener
  that receives **zero** notifications (LISTENing on a channel nobody publishes to) costs the
  writer almost as much as one receiving every notification (measured 1.18×–1.73× vs.
  1.22×–1.90×, 4 runs, own local PG 17). The bug this corrects was caught because the bench
  that produced D4's original numbers had gone vacuous: `attachListeners` still LISTENed on the
  pre-bucketing legacy channel after `PostgresEventStore` moved to bucketed channels, so section
  C's listeners received nothing every run and printed "0 delivered … = 0 per event" beside a
  writer-throughput number that still dropped 2.28× in the same run — and `scaling.md` §3.1 read
  "**[open]** … nothing implements it yet" under a heading of SHIPPED. `attachListeners` now
  takes the real channel list off the writer's own store instance
  (`PostgresEventStore#notifyChannels()`, an instance method, not a free function taking
  `notifyBuckets` by hand — review round 1: a bench-side literal has no way to notice the
  instance's configured value change) and the bench fails outright (`VacuousDeliveryError` via
  `assertDelivered`) if any expected channel delivers nothing — a PER-CHANNEL check, not
  merely a nonzero total, so a partial coverage gap (half the expected buckets silently idle)
  cannot hide behind an aggregate that still reads nonzero. A negative case proves the guard
  does NOT fire on a legitimately-empty unrelated-channel row, and another proves it fires on
  partial coverage even when the aggregate total is nonzero.
  Scenario H gains a disjoint-interest variant (`partitionDisjoint`, confirming delivered
  notifications per node drop to exactly `1/nodeCount` while writer throughput does not track a
  clean prediction — plausibly single-host contention, not a fan-out win) and a
  `CoalescingEventStore` variant (measured 1.21×–1.54× recovery). **Recommend
  `CoalescingEventStore` for multi-node deployments with live subscribers**, and record a
  transport change (separate notifier connection, watermark polling, or a Redis/NATS bus as a
  3P plugin) as considered and rejected for now — `CoalescingEventStore`'s measured headroom is
  enough without it. No SPI change, no kernel change; `EVENT_STORE_SPI_VERSION` stays 1.4.0.

- **Kernel: a duplicate `start()` with a caller-chosen execution id is refused before any effect
  runs** ([ADR 0103](docs/adr/0103-durable-bootstrap-for-caller-chosen-ids.md); KERNEL_ABI and
  EVENT_SCHEMA unchanged). `start()` checked nothing: the bootstrap `EXECUTION_STARTED` was folded,
  delivered to `onEvent` and only enqueued, and the body ran at once, so a second start of the same
  deterministic id invoked its effects (a paid model call in the probe) before the store refused
  sequence 0. Now, when the caller supplies `executionId`, `start()` awaits the durable write of
  sequence 0 first — the same envelope, byte for byte, through a builder shared with the journal —
  and a sequence/id conflict — confirmed by reading this execution's sequence 0 back, because a
  coalesced batch hands every caller the same conflict error (an unconfirmed one is retried once)
  — throws the new `ExecutionAlreadyExistsError` with nothing folded, nothing delivered and
  nothing run. Any other failure of that write rejects `start()` with
  `StorageWriteError`. `TimerService` treats the typed error as "already started", which closes
  the cross-node race its `loadState` pre-check left open. There is no `startOnce` helper: catch
  the error. A minted ULID cannot collide, so `start()` without an `executionId` pays no extra
  write and behaves byte-identically. `onEvent` remains pre-durability for every later event, now
  documented; a consumer that must act only on durable facts uses a catch-up read.

  **Upgrade note:** code that started the same caller-chosen id twice and awaited the second
  handle now gets `ExecutionAlreadyExistsError` from `start()` itself. A test that relied on the
  duplicate "succeeding" was testing the defect.

- **The content sweep is race-safe, reclaims orphans, and takes external root sets; ContentStore
  SPI 1.3.0** ([ADR 0055](docs/adr/0055-k10-6-pin-seam-content-gc.md) D5–D7, amended).
  - **D5, the re-cite race.** A `put` of bytes the store already held was a no-op (`INSERT OR
    IGNORE`). A sweep that ran between a re-citing `put` and that execution's event append
    therefore erased the blob by its *old* citation time, and the new event cited a blob that
    was gone. SPI 1.3.0 adds an optional atomic `deleteIfUntouchedSince(ref, cutoffMs)` and
    `touchClock()`. A store implementing them MUST bump a blob's touch time, monotonically, on
    every `put`/`putStream`. The guard cutoff is on the STORE's clock: `touchedBefore`, which
    defaults to `touchClock() − olderThanMs` read at the sweep's start. The caller's `now` is
    log time and only measures the TTL, so a simulated or skewed log clock cannot disarm the
    guard. The sweep erases only through the conditional delete when the store has one.
    Otherwise it falls back to `delete` and reports `raceSafe: false`; `loom sweep content`
    prints `race-safe:`.
  - **D6, orphans.** Blobs nothing cited any more were never reclaimed: a run deleted with no
    archive, a crash between `put` and the append, a truncated prefix. SPI 1.3.0 adds an
    optional `listPage({ cursor, limit, touchedBefore })`, keyset on address, and a bad `limit`
    is a `RangeError`. With `reclaimOrphans: true` (CLI `--orphans`), the sweep erases
    conditionally every stored address untouched since the cutoff that no scanned event, no
    compaction snapshot and no root cites. A touch time of 0 (a pre-1.3.0 writer) is unknown
    and never erased. It refuses a store without the optionals. The report gains
    `orphansReclaimed`. `snapshotStores` lets the sweep read compaction checkpoints: refs in a
    compacted execution's compaction checkpoint (`loadLatestBefore(events[1].sequence − 1)`) and
    latest snapshot are pinned, so `fork()` from between them still resolves. The orphan pass
    refuses to run without them over a store that can `truncatePrefix`, and whenever an
    execution looks compacted (a gap, or only sequence 0 left) but no checkpoint is found. **The sweep cannot see a citing store you did not pass it**, so scan live first,
    then every archive. The CLI scans the config's `durability.retention.archive`, and refuses
    `--orphans --apply` with no archive unless `--no-archive` (warning before it erases).
    `--orphans` needs `--snap` on the `--db` path, and `--archive-snap` with `--archive-db`.
    Every `loom sweep content` refusal exits non-zero.
  - **D7, roots.** `sweepUnpinnedContent({ roots: () => AsyncIterable<string> })` pins
    addresses held in an app's own tables through both passes.
  - `SqliteContentStore` implements all three optionals. On open it migrates an older file: it adds
    `touched_at` and backfills existing blobs to the migration time once, so nothing ages out
    until a full TTL after the upgrade. The re-put bump is monotonic
    (`max(touched_at, excluded.touched_at)`). `InMemoryContentStore` implements all three with an
    injectable clock (`new InMemoryContentStore({ now })`), and so does `SqliteContentStore`
    (`new SqliteContentStore(path, { now })`). `CachingContentStore` forwards all three. The
    conformance kit checks the optionals when present. The three must come as a set, and the
    re-put bump is checked through the conditional delete alone (an internal kit check that
    fails an `INSERT OR IGNORE` store). Monotonicity is checked with a clocked factory.
    `LogLifecycle` exposes its configured `archive` (read-only). The kernel manifest and the
    compatibility matrix now list ContentStore SPI 1.3.0, and `checkCompatibility` accepts
    `contentStoreSpi`. The `loom plugin new content` template names the new methods.
  - `docs/data-protection-patterns.md` says the archive is REQUIRED once retention archives,
    and scopes "erasable without history rewrite" to the log. Content-store blobs have no
    subject mapping; erase them with an explicit `contentStore.delete(ref)`.
    `docs/api-reference.org` had the wrong signatures for `collectContentRefs` and
    `pinByEventKinds`; both are fixed.

  **Behaviour change:** a test fixture that puts a blob at today's wall clock and then cites it
  at a fabricated past time now sees the blob kept, because it was touched after the cutoff.
  Give such a store a clock that matches the fabricated history. Likewise, a harness that runs
  the log on a simulated clock must give the content store that clock or pass `touchedBefore`.
  Otherwise nothing it "aged" is erased, because the guard is on the store's clock.

- **The content sweep no longer erases a load-bearing externalized ref**
  ([ADR 0055](docs/adr/0055-k10-6-pin-seam-content-gc.md) D4, amended). `sweepUnpinnedContent`
  treated every `__loomContent` ref as TTL-reclaimable unless a pinned event kind cited it. An
  ADR 0046 externalized field is a bare ref that `ContentResolvingEventStore.read` resolves, so
  `loom sweep content --ttl 30d --apply` over a 60-day-old externalized `STEP_COMPLETED.output`
  erased the blob, and the next read of that still-running execution threw
  `ContentMissingError`. Resume, replay, fork and compliance export all failed. Now only a ref
  that is an envelope's own `ref` ages out. A ref cited anywhere else, including inside an
  envelope's `digest`, is kept while any scanned event cites it, and so is a ref cited both
  ways. An envelope is recognised by the same structural test as `isClaimCheck`, so an app
  object that only carries `__loomClaimCheck: true` does not make its refs reclaimable.
  `ContentSweepReport` gains `refsLoadBearing`, and `loom sweep content` prints it.

  **Behaviour change:** an app that emits a bare ref itself (`ctx.emit(KIND, { ref })`) and
  relied on the sweep to reclaim it will find the blob kept. The sweep cannot tell such a ref
  from an externalized one. To make it reclaimable, cite it as a claim-check envelope's `ref`.
  Nothing is erased that was kept before. This also works under a `ContentResolvingEventStore`,
  which now leaves claim-check envelopes alone (the ADR 0055 D4 gap, closed by the decorator
  entry below).

- **Every store decorator now carries the whole optional SPI through, so the ADR 0074
  composition actually batches**
  ([ADR 0074](docs/adr/0074-storage-scale-out-decorators.md) Amendment,
  [ADR 0022](docs/adr/0022-k10-log-lifecycle-retention-redaction-encryption.md) Amendment).
  Seven decorators silently dropped optional methods of the store they wrapped:
  - `TenantScopedEventStore` dropped `appendBatch` and `listExecutionsPage`.
  - `EncryptingEventStore` dropped `appendBatch`, `deleteExecution`, `truncatePrefix` and
    `listExecutionsPage`.
  - `ContentResolvingEventStore` dropped `appendBatch` and `listExecutionsPage`.
  - `hashChainedEventStore` dropped `appendBatch`, `listExecutions` and `listExecutionsPage`.
  - The DST `faultInjectingStore` and the `@loom/testing` `crashingEventStore` dropped up to
    seven methods between them.
  - `EncryptingSnapshotStore` dropped `deleteExecution`.

  The consequences:
  - `Coalescing(TenantScoped(backend))`, the order ADR 0074 documents, issued zero batches (50
    appends reached the backend as 50 appends).
  - Over that fallback's non-atomic loop, a batch holding a stale-fence zombie left earlier
    writers' events durable while telling them the write failed.
  - Encrypted logs could be neither retained nor compacted.
  - The audit chain could not be enumerated by `loom retention` or `loom census`.

  Each decorator now declares a `DecoratorPlan` over the whole optional-method union and
  installs it with the new `installOptional` (`@loom/event-runtime`). Every plan key is
  required, so a plan that omits a method, including a future optional SPI method, fails to
  compile (pinned by a `@ts-expect-error` that `pnpm typecheck` checks). The conformance kit
  catches a decorator that uses no plan at all.
  `OPTIONAL_EVENT_STORE_METHODS` / `OPTIONAL_SNAPSHOT_STORE_METHODS` are compile-time
  exhaustive, `refusalsOf` reads a recorded refusal, and `CoalescingEventStore`,
  `ProfilingEventStore` and `TenantScopedSnapshotStore` moved onto plans too.
  `runEventStoreDecoratorConformance` / `runSnapshotStoreDecoratorConformance`
  (`@loom/conformance`) wrap a full-capability store. They assert that every optional method
  survives (or is refused with a reason) and then run the whole SPI suite THROUGH the
  decorator, over the in-memory store by default or a real backend via `inner`. Every in-repo
  decorator is registered, the two tenant compositions also run over Postgres, and
  `packages/spec/src/decoratorConformance.test.ts` discovers decorators and fails on one that
  is not registered. `EVENT_STORE_SPI_VERSION` stays 1.4.0; the SPI history comment now
  records 1.4.0 (`head`).

  Behaviour changes to know about:
  - **`hashChainedEventStore` no longer offers `truncatePrefix`.** It used to forward it, and a
    compacted chain fails `verifyChain` at the first surviving event (measured). Compaction
    over an audit-chained store now returns `null` instead of silently breaking every later
    audit.
  - **`LogLifecycle` enforces a key rule for encrypted logs.** `compact` throws the new
    `UnsafeCompactionError` when the event store encrypts at rest and the snapshot store does
    not share its `KeyStore`. `applyRetention` / `evaluate` return the new `RetentionOutcome`
    `"unsafe-archive"` when an archive does not share it. Without the rule, compaction and
    archiving would write the decrypted fold or events outside the erasure boundary, where a
    key shred no longer reaches. A test shreds the subject after compacting and archiving an
    encrypting store over SQLite and asserts that both copies are unreadable.
  - **The encryption marker (`keys`) now survives decoration**: `installOptional` carries it up,
    and `ShardedEventStore` exposes one shared KeyStore (or a fail-closed marker if its shards
    disagree). So `loom doctor` and the key rule see `Coalescing(Encrypting(pg))` as encrypting.
  - **A compacted execution is reclaimable.** `LogLifecycle.evaluate` folded only the surviving
    log, so an execution compacted through its tip read as `not-terminal` forever. It now folds
    from the latest snapshot when the log has a gap or only its bootstrap left.
  - **Tightening: `TenantScopedEventStore` and `TenantScopedSnapshotStore` reject a tenant
    name that is empty or contains the `:` separator** (a `TypeError` at construction).
    Tenant `"a"` scoped `"b:x"` to `"a:b:x"`, which is tenant `"a:b"`'s `"x"`, so one tenant
    could address another's executions. No in-repo or sibling-repo caller passes such a name.
  - **`ShardedEventStore` declares a plan too**, and is registered with the kit as
    `new ShardedEventStore([inner])`. The fitness test now also discovers decorators whose
    constructor takes an array of stores. The `listExecutionsPage` contract now says, and the
    kit checks, that a page with a `nextCursor` carries at least one id.
  - **`TenantScopedEventStore.listExecutionsPage` never relies on the store's sort order.** It
    pages the inner store and filters, bounded to one page of memory. Postgres pages in the
    database collation (measured: `"a~"` before `"ab"` on an `en_US.UTF-8` PG 17), so a
    "stop at the first id past the tenant's range" shortcut would miss ids.
  - **`ContentResolvingEventStore` leaves ADR 0054 claim-check envelopes alone.** The
    `collectContentRefs` / `substituteContentRefs` / `hasContentRef` walkers treat an envelope
    as a leaf, so an envelope whose blob the sweep reclaimed reads back as the envelope rather
    than throwing `ContentMissingError`, and a `codec: "bytes"` envelope reads at all. A bare
    ref beside it still resolves. This closes the known gap ADR 0055 D4 records. The stale
    "refcounted blob GC … deferred" docstring (it shipped in ADR 0055) is corrected.
  - `CoalescingEventStore`'s docstring no longer claims a failed flush leaves the log untouched
    over any inner store: that holds only when the inner store implements `appendBatch`. It
    also records the coalesced-zombie blast radius.

- **Kernel: flow-level `ctx.emit` / `ctx.stream` / `ctx.ui` append once per execution**
  ([ADR 0102](docs/adr/0102-flow-emits-append-once.md), EVENT_SCHEMA **1.19.0**, KERNEL_ABI
  unchanged at 1.1.0). A flow re-runs from the top on resume and on recovery. `execute`,
  `decide` and `suspend` were served from the log on that re-run; a flow-level emit was not. It was
  appended again every time, so an `emit` before a gate appeared N times after N resumes, and a
  surface built with `ctx.ui.append` before a gate folded to `["x","x"]`.

  Now an emit is served from the log only when the log PROVES it was already made. That means
  a stamped emit of the same `(type, payload)` in the same gate segment that this run has not
  yet matched, with every step and decision so far in the segment itself served from the log.
  Everything else is appended.
  - Stamps: `metadata.flowEmit = <digest of segment, type, payload>`; the fold counts them per
    digest in `variables._flowEmits`.
  - An emit is stamped only if nothing earlier in the run ended unsettled (an untyped failure, a
    timeout, a cancellation, an in-doubt park, a throwing decider) and none of the run's own
    steps or deciders was still executing.
  - Timing can cost a duplicate, never an emit: a different interleaving can turn a served emit
    into an unstamped append, never into a lost one.
  - Kernel facts (`STEP_*`, `DECISION_RECORDED`, `EFFECT_INDOUBT`) and `EffectContext.emit` are
    unchanged and never stamped.

  **Upgrade note:** an execution written before 1.19.0 re-emits its pre-resume emits **once
  more** on its next resume or recovery. No migration is needed. A test or projection that
  counted the duplicates was counting the bug.

  Duplicates remain possible in these cases; none of them loses an emit:
  - Emits after a step that fails untyped: it re-executes on every re-run, so they are appended
    again each time. Declare its failure channel (ADR 0060) and they converge.
  - An emit made while one of the run's own steps is still un-awaited: one extra copy.
  - A payload with no JSON form: appended on every re-run.
  - A deploy that edits an emit: the new content is appended and the old stays.

  An emit can be served in place of a new one only if a deploy moves identical content within a
  segment whose steps are all served, if flow code breaks ADR 0061 determinism, or on a 64-bit
  hash collision (ADR 0102 D2).

  Also: `fnv1a64` (`@loom/core`) now uses 16-bit limb arithmetic instead of BigInt. The output
  is identical, pinned by a differential test, and the cost per byte is roughly a tenth.

- **`loom plugin new keystore` scaffolded a package that could not compile.** The template
  writes `Buffer` in four signatures and the generated `package.json` declared no
  `@types/node`, so the first thing a plugin author did after scaffolding was watch `tsc`
  fail. The template typecheck added yesterday hid it by handing the compiler node's types —
  which the real package never declares. A scaffolded package's dependencies are now derived
  from the code it emits, and a guard asserts that any template using a node global ships the
  types for it.

  The detector strips comments first, and that is the point of its own unit test: two seams
  describe "the process" in prose, and matching those would have added a dependency their code
  never touches. A sweep that reads comments is measuring prose.

- **An encrypting store with in-memory keys now FAILS `loom doctor`.** K10 crypto-shredding
  makes the key the erasure boundary, so losing a key is indistinguishable from shredding the
  subject: the writes succeed, the log survives, and every encrypted field is unreadable from
  the next boot — with nothing failing at the moment it happens. `KeyStore` had exactly one
  implementation, `InMemoryKeyStore`, and the only protection was a README sentence saying
  "back it with a KMS in production".

  `KeyStore` now declares `durable`, `InMemoryKeyStore` declares `false`, and the new
  `encryption keys` check reads it through whichever store exposes a `keys` property — so a
  third party's own encrypting wrapper is covered for free, and the CLI still depends on no
  crypto package. Three states, kept apart: declared non-durable **fails**, undeclared is an
  **advisory** (*this store does not say*), declared durable passes, and nothing encrypting at
  all is a skip. Snapshots are checked alongside the event log, since they carry the same
  fields.

- **A globally installed `loom` did nothing and exited 0.** The entry guard was
  `process.argv[1]?.endsWith("cli.js")`, but a global install puts a SYMLINK named `loom` on
  PATH — so `argv[1]` is `…/bin/loom`, the guard was false, and the binary returned success
  having run no command. `pnpm link --global` hid it by writing a shim that execs `cli.js` by
  name; `npm i -g` creates a plain symlink, which is what a published package gets. Now
  `require.main === module`. `create-loom-app` had the same guard and the same silence.

- **`create-loom-app --help` scaffolded eleven files into a directory named `--help`**, and
  reported success — the only check on the argument was that it existed. `loom-compile --help`
  crashed with an ENOENT naming a path the user never typed. Both now validate their
  arguments and print usage. These were newly *reachable*: before the guard fix, neither ran
  at all through a global install.

- **`pnpm run unlink:global` failed with `ERR_PNPM_UNEXPECTED_STORE`.** The repo pins
  `pnpm@9.14.4` via `packageManager`, so a machine running pnpm 10 self-downgrades inside the
  repo — and 9.x refuses to touch a global directory 10.x created. The global store's format
  is tied to pnpm's major version, so any script touching it is coupled to whichever pnpm
  created it. Both scripts now use `npm link`, whose global has no such versioning.

### Added

- **The Blueprint is a declared rendering IR (ADR 0096).** `@loom/blueprint-runtime` exports
  `BLUEPRINT_IR_VERSION` (`1.0.0`) beside a shape manifest that `tsc` checks exhaustively against
  the `Widget`/`Layout`/`Blueprint` types and that a test pins by digest per version — so a shape
  change fails the build until the manifest agrees, and the manifest cannot change without the
  version. Needed because a sibling framework ([loom-ui](docs/requirements/2026-09-21-loom-ui-design.md))
  now compiles to the Blueprint, and a compile target in another repository is an interface.

  `@loom/plugin-renderer-terminal` is kind-aware when given a registry: `defaultTerminalRegistry`
  covers the eight built-in kinds (asserted with `catalogCoverage`, ADR 0088's second direction,
  which the terminal surface never had), and a kind the registry lacks is marked `[kind]` instead
  of flattened silently. With no registry the output is byte-identical to before.

- **Two printable reference cards: [`docs/cheatsheet-features.md`](docs/cheatsheet-features.md)
  and [`docs/cheatsheet-dx.md`](docs/cheatsheet-dx.md).** Card I is what the kernel gives you
  — the ten syscalls, the builders, the three authority rings, the subsystems on the log.
  Card II is how you work — the CLI, `<store>`, doctor's four marks, the operator passes,
  testing helpers, plugin seams, and the handful of things that reliably bite. Laid out to be
  read on screen or printed (A4, two columns, every block kept whole).

  Both are derived from the kernel manifest, the CLI usage text and the SPI map rather than
  from memory, and a fitness test keeps them that way: every syscall must appear on Card I,
  every seam and CLI command on Card II, and the version and count headlines must match their
  sources. A cheatsheet is the densest enumeration a repo has and nothing about it fails when
  a name changes — which is exactly how three other seam lists here went stale.

- **Three seams that were never in the SPI map at all: `execution-authorizer`,
  `resume-authenticator`, `timer-dispatcher`.** Each is a `defineConfig` option whose type is
  an interface an application implements — replaceable by construction, which is what the map
  says it enumerates — with no row, no conformance kit and no scaffold. They sat in the blind
  spot the other two guards share: both start from a conformance kit, so a seam nobody wrote a
  kit for was invisible to both. A third guard now starts from the config instead — **every
  `defineConfig` option typed as an interface must appear in the SPI map** — and it found the
  third one (`ResumeAuthenticator`) on its first run, along with three data shapes now
  exempted with stated reasons.

  The two new kits' types are declared structurally in `@loom/conformance`, because importing
  them would close a cycle (workflow-runtime dev-depends on plugin-sqlite, which depends on
  conformance). Duplication drifts, so `@loom/worker-runtime-local` — the one package that
  sees both — carries a two-way compile-time proof that the kits still describe the real SPIs;
  adding a method to either interface fails that build. The proof earned itself immediately:
  the first draft of the resume kit declared the verdict as `{ ok: boolean }`, while the real
  `ResumeVerdict` is a three-way union whose third status (`not-applicable`) means *not mine
  to judge* and lets the resume PROCEED. Shipped as drafted, it would have certified a
  contract loom does not have.

- **The seam enumerations are guarded everywhere they appear.** `docs/usage-cli.md` listed
  eleven seams and showed a stale `loom plugin seams` sample; the existing guard covered only
  `docs/plugins.md`, so one enumeration was checked and the other drifted. Both are checked
  now. ADR 0033's hard-coded six-seam list is replaced by the invariant (it was missing five),
  and the SPI map — the doc an implementer opens first — finally says how to *start*.

  Also: a seam's `wiring` line is now checked to name a real `defineConfig` option.
  `durable-state` shipped with `durableState: { store }`, a key invented by analogy with
  `timers: { store }` that does not exist; the real entry point is
  `durableState({ id, version, schema, store })`. The wiring line is the first thing an author
  copies, so a fabricated one sends them to a compile error with loom's name on it.

- **Four more seams: `content`, `durable-state`, `read-model`, `keystore`.** With `lease`
  that closes every SPI loom publishes a conformance kit for — and a kit is loom saying
  "third parties implement this", so an SPI with one and no scaffold was advertising with no
  door. A fitness test now asserts exactly that: **every kitted SPI is scaffoldable**, which
  generalises past any hand-maintained list. Each template documents the property its backend
  is silently wrong about otherwise — content addressing making `put` idempotent, compare-and-set
  on `expectedRevision`, watermark monotonicity under re-apply, and `destroy` being
  irreversible because the key IS the erasure boundary.

- **`loom plugin new lease <name>` — a `LeaseStore` seam.** The interface, the conformance
  kit (`runLeaseStoreConformance`), the SPI-map row and the composition wiring
  (`timers.leases`) all existed; the scaffold did not, so loom advertised a seam a third
  party could not start from. The template documents the three return values that carry the
  whole contract — `acquire` returning `null` for another owner (re-acquiring your own is a
  renewal, not a conflict), `renew` returning `false` meaning ownership is LOST and never
  resurrected, and `expired` as the evidence of an orphan.

- **The seam/doc fitness function now runs both ways.** It checked scaffold → docs only, so
  an SPI could ship an interface, a conformance kit and a map row with no `loom plugin new`
  template and nothing would notice — which is exactly how `LeaseStore` sat. Published SPIs
  must now be scaffoldable or carry a stated reason, and a reason that goes stale (the SPI
  became scaffoldable) fails too. A one-directional fitness function is the failure it exists
  to prevent, pointed the other way.

- **Seam templates are typechecked against the real SPIs, and one was already broken.** The
  scaffold is a generator: when an SPI gains a method, every existing plugin fails loudly
  while the template keeps emitting the old shape silently. The new check found
  `loom plugin new projection` emitting a class missing `subscribeSelector`, added to
  `ProjectionRuntime` by ADR 0068 — so that seam had been scaffolding code that does not
  compile ever since. Fixed, and now guarded for all twelve seams.

- **Verification reports its own coverage (V1–V5).** `suspension-safety`, `capability-compat`
  and `effect-class` see past a flow's declared steps only with the compiler's runner-body
  analysis (ADR 0086) — and without it they reported exactly as they do with it. `loom verify`
  printed the same `0 error(s), 0 warning(s)` whether the rules read the runner bodies or
  never saw them. `reachAnalyzed` existed to tell those apart and no rule read it.

  Each of the three now emits one `info` coverage note per rule (not per flow — the same fact
  twenty times is noise), the headline counts them (`8 rule(s) passed — 0 error(s), 0
  warning(s), 1 coverage note(s)`), the CLI says when no analysis was injected, and
  `loom doctor` surfaces it as an advisory instead of flattening the report to "0 errors".

  `info` deliberately: the compiler is opt-in, so `warn` would scold every correct project
  that does not use it, and a verifier people switch off checks nothing at all.

  A fitness test now runs the same app with and without reach data and requires that **any**
  rule whose real findings change also reports that it could not look — so the next rule added
  cannot silently reintroduce the gap. It guards itself against passing vacuously.

- **`loom doctor` gains two timer checks, and a fourth status to report them honestly.**
  `durable timers` fails when schedules are declared with no `timers: { store }` (they can
  never fire) and advises when flows declare resume gates but nothing can wake them.
  `timer wake ownership` advises when a TimerStore has no `timers.leases`: if more than one
  process polls it, every node resumes the same due execution — fencing makes that safe, not
  cheap, since the loser still pays for its effects up to the point it loses.

  Both are `advisory` (`!`), a new status, because they are defects on a multi-node
  deployment and fine on one — and `doctor` cannot see how many nodes you run. Failing the
  build would be a guess; staying silent would be the same "unchecked reads as checked"
  failure a skip avoids. Advisories are counted in the summary, and now so are caveats on a
  FAILED run, where they were previously dropped.

  The `durable timers` advisory also names what verification does *not* cover: a `timeout`
  lives in the runner body, so `suspension-safety`'s timed-suspend rule cannot see it either
  (`FlowSpec.suspends` has no producer) and a clean `loom verify` says nothing about it.

- **`loom doctor` and `loom verify` no longer fail on an ESM config module, and `doctor` no
  longer starts the app it inspects.** Both used a bare `require`, so a config with top-level
  await produced two spurious ✗ — and `doctor` composing an app meant starting its timer
  service, the same side-effect-of-being-inspected the other commands were fixed for. Both
  now use the shared loader, which sets `LOOM_NO_AUTOSTART` first; `doctor` loads the app
  once per run and hands the same result to every check that needs it.

- **`loom recover` / `loom branches retire` / `loom branches prune` — front doors for the
  three maintenance passes.** Recovering executions whose supervisor died, retiring branches
  nobody is coming back to, and pruning refs that name nothing all shipped as library
  functions a scheduled job had to be written by hand to call. All three are **dry by
  default** and act only under `--apply`.

  Each one turns on a judgement loom will not make for you, so each refuses rather than
  guesses: `recover` needs either `timers.leases` (an expired lease is evidence) or an
  explicit `--stale`, and says *why* no default is defensible; `branches retire` needs
  `--stale` because a branch parked on a human gate is someone's open question. `recover
  --apply` additionally requires `--config`, because re-driving an execution runs its steps
  and only a composition has the flows registered — the `--db` shorthand can preview, and the
  message says so instead of only refusing.

- **`dryRun` + `onCandidate` on `recoverAbandoned`, `retireAbandonedBranches` and
  `pruneBranchRefs`.** The preview runs through the pass rather than beside it, because
  `loom retention` shipped the other arrangement once: a dry run computed alongside the real
  pass skipped a guard the pass applied, and promised an outcome the run would not deliver.
  A preview claims no lease (claiming is a write, and would fence the real pass out of the
  execution it was about to take), deletes no ref, and leaves `deleted`/`recovered` at zero —
  a count of writes that never happened is the same lie in a different place.

- **Every storage-backed `loom` command takes `--config <module>`.** `census`, `retention`,
  `logs`, `debug`, `inspect`/`dev`, `profile`, `introspect`, `optimize`, `learn report|eval`,
  `compliance report` and `sweep content` resolve their stores from the app's composition, so
  they run on whatever it wired — SQLite, Postgres, or any conforming backend. Before this,
  ten CLI files constructed `SqliteEventStore` directly and the CLI had no Postgres dependency
  at all: the entire operator surface ran only on the single-node backend, while the features
  it serves (leases, placement, the live-descendant guard) exist *because* a deployment has
  more than one node. `--db` remains, as the SQLite shorthand it always was.

  Sniffing `postgres://` was considered and rejected: it would bless two backends in a
  framework whose premise is that storage is yours, leaving every 3P store unreachable. The
  resolver therefore knows *no* backends — a fitness test now keeps it that way, with an
  allowlist that states its reasons.

  Messages name which half to fix: missing lease coverage reads *"this app wires no lease
  store (`timers.leases`)"* on the config path and *"no --leases given"* on the shorthand. A
  capability a store lacks is named with the store, not raised as a stack trace.

- **`defineConfig({ autostart: false })` + `app.start()` — composing an app need not also run
  it.** Composition has always called `timerService.start()`, so a command that reads a
  deployment's stores by importing its config module would begin polling production storage and
  fire whatever was due — a side effect of being *inspected*, happening during `import`, before
  any of that command's own code runs. The flag builds without starting; `app.start()` is the
  other half, so "build now, run later" never means "built, and can never run". Default
  unchanged, and `start()` is idempotent.

- **`timers.leases` — the lease seam `defineConfig` never had.** `TimerService` has accepted a
  `LeaseStore` since #380 (claim before waking, renew while the wake is in flight), but
  `defineConfig` builds that service itself and forwarded every option except this one. Nothing
  in the repository wired `leases:` outside tests, so the leased-wake path had **no reachable
  entry point** from loom's own front door — while `docs/user-guide.md` taught the staleness
  predicate and then advised preferring "a real liveness signal". A lease *is* that signal; the
  guide now shows it.

- **`LoomStores.timerStore` / `LoomStores.leaseStore`.** Present only when configured, on the
  same contract as `memoryStore`: absent means *not wired*, which an operator pass must be able
  to see rather than infer. "Nobody is tracking ownership" and "every lease is expired" are
  different answers — the first is a coverage gap, the second is a fleet that died.

- **`loom census` — the operator half of the same thing.** A number that requires writing
  TypeScript against your own composition root is a number nobody looks at, so the census now
  has a front door: `loom census --db <path> [--leases <path>] [--buckets 5m,1h,6h,24h]`, which
  writes nothing and takes no predicate. It prints in-flight counts by age band and, with a
  lease store, the `held / expired / no lease at all` split that decides #408. Without
  `--leases` it says the coverage was **not asked** rather than printing zeros. Consecutive
  identical band breakdowns are collapsed — bands are cumulative, so repeating them turns a
  four-line answer into a wall, and a report nobody scans is a report nobody reads.

  `orphanCensus` now takes a `CensusStateReader` (`{ loadState }`) rather than a whole
  `WorkflowRuntime` — the same narrowing `@loom/live-query` uses, so asking a read-only question
  does not require a deployment's full wiring.

- **`orphanCensus` — the read-only pass that was missing (#408).** Every other maintenance pass
  reads state in order to *act*: `recoverAbandoned` resumes what a predicate claims,
  `retireAbandonedBranches` cancels, `pruneBranchRefs` deletes. Nothing just looked — which is
  why "defer until a deployment reports orphans the staleness predicate misses" was never a real
  condition: a false negative sits `running` forever, silently, and nobody files an issue about
  work that quietly never finished.

  The census takes **no predicate** — that is the point, since the question it answers is whether
  yours is right — and writes nothing. It bands in-flight executions by age (cumulative, with a
  sample of ids so a report points somewhere) and, given a lease store, classifies each as
  `held` / `expired` / `none`. `none` is the number [#408](https://github.com/chhetrisushil/loom/issues/408)
  turns on: a stuck execution nothing ever leased cannot be recovered from evidence at all, and
  counting those is how "should the runtime lease every run" stops being a guess. Lease counts are
  **omitted** rather than zeroed when no store is given, because zeros would read as "nothing is
  unwatched" instead of "not asked".

  `LeaseStore` gains an optional `get` (SPI 1.1.0) for exactly that classification: `expired()`
  cannot tell an actively-renewed lease from one that never existed.

- **Durable leases: only one node pays for a duplicated wake (#380, L1–L2).** `TimerStore.due()`
  has no claim, so two nodes polling the same store both receive the same due timer, both
  resume, and both pay for every effect until one loses at the fence. Fencing (K9.4) makes that
  outcome *safe*, not *cheap* — and durable placement (#392) made the duplicate expensive on
  purpose, since a branch is placed precisely when its work is heavy.

  New optional `LeaseStore` SPI (`acquire` / `renew` / `expired` / `release`), shaped like
  `TimerStore`: `acquire` returns `null` when another owner holds an unexpired lease — that
  single `null` is the mutual exclusion "only one node should run this execution" needs — and
  `renew` returns `false` once ownership is lost, so a node declared dead stops believing it is
  alive. `InMemoryLeaseStore` ships with it, held to `runLeaseStoreConformance`.

  `TimerService` takes `leases: { store, owner, ttlMs? }` and claims before firing. A node that
  cannot claim skips **without completing the timer**, so a wake is never lost if the holder
  dies between claiming and resuming; ownership is released afterwards, because it covers the
  fire rather than the execution's whole life. Unwired, every path is byte-identical.

  `recoverAbandoned` then stops needing a predicate: with `leases` wired, **`isAbandoned`
  becomes optional** — an expired lease *is* the evidence the log cannot hold — and the scan
  narrows from every execution to every expired lease, which is the set you wanted. A predicate
  passed anyway is still asked, so it never becomes a lie, and the pass **claims** each orphan
  before re-driving it so two recovery passes racing the same one do not both pay for it.

  `SqliteLeaseStore` and `PostgresLeaseStore` ship with it. Acquisition is **one statement** on
  both — read-then-write would let several nodes each observe a free lease and all take it,
  which is the race the whole primitive exists to lose loudly. Verified against a real
  PostgreSQL 17, including twelve simultaneous acquires granting exactly one.

  **A claim is renewed for as long as the work takes.** Both paths that take one hold it across
  the whole resumed run, because both await it settling. Unrenewed, the lease expired *under a
  healthy holder* and a recovery pass would fence that holder out mid-run — not duplicate work,
  a killed execution. `renewWhileHeld` covers both, and reports the case where ownership is lost
  anyway, since two nodes on one execution is worth being told about even when fencing keeps the
  log sound.

  Staged deliberately (`docs/requirements/2026-09-15-durable-lease.md`): the runtime does not
  yet hold a lease across a whole run, because renewal is a ticker on the owning process's
  event loop and a CPU-bound effect can starve it into declaring a healthy execution abandoned.
  That false positive is how this feature fails, and it is written down rather than buried in a
  TTL constant.

- **The audit chain can be verified by someone who could not have written it (#382,
  [ADR 0037](docs/adr/0037-tamper-evident-audit-chain.md) amendment).** The HMAC signature makes
  the log tamper-evident *against a third party who lacks the secret* — but verification needs
  that same secret, so anyone enabled to check the log can also rewrite it: re-chain the hashes,
  re-compute the HMACs, and it verifies cleanly. The verifier and the forger were the same role,
  which is exactly what an auditor must not be.

  The signature seam is now pluggable — `ChainSigner` / `ChainVerifier` — with `ed25519Signer`
  and `ed25519Verifier` shipped over `node:crypto` (no dependency, 64-byte signatures, nothing
  to parameterize wrongly). `ChainMetadata.keyId` names the signing key so rotation does not
  invalidate history; `hmacSecret` and `signer` are mutually exclusive because they make
  different promises; and `ChainVerification` gains **`signaturesChecked`**, so a hash-only
  `ok: true` can never be read as an authorship guarantee. An entry signed by a key the verifier
  does not know is **rejected, not skipped** — authorship that cannot be checked has not been.

  Loom still makes no trust-root decision: it signs with the key you hand it, exactly as it
  HMACs with the secret you hand it.

- **`defineConfig({ timers: { dispatcher } })`** — the composition-root half of #392. An app
  that places executions deliberately can now wire the wake path in one line, instead of
  building its own `TimerService` to get at the option.

- **Placement survives the process that chose it (#392).** `ExecutionPolicy` was a
  caller-side struct mapped to `DispatchMetadata` at dispatch time, so where an execution
  belonged lived in one process's memory. Invisible for an execution that runs once — and
  gone by the time anything re-drives one that suspended for a human, which is how a branch
  sized for a cloned database wakes up inside a web server.

  `start({ computeTarget })` now records the lane on the `EXECUTION_STARTED` anchor
  (sequence 0 — where `truncatePrefix` preserves it through compaction, `deleteExecution`
  removes it, and `metadata.fence` already established that operational data rides), and
  `placementOf(eventStore, executionId)` reads it back in one indexed point-read. **No
  syscall and no EVENT_SCHEMA change**: metadata is descriptive, nothing folds it, replay is
  byte-identical.

  Both wake paths can then use it. `TimerService` and `recoverAbandoned` take an optional
  `dispatcher` and dispatch an `ExecutionPackage` to the recorded lane instead of resuming on
  whatever runtime they happen to hold; without one, behaviour is unchanged. A fork
  **inherits** its parent's lane for free (the prefix copy carries the anchor's metadata) and
  `fork(…, { computeTarget })` overrides it — the case that matters, since a simulation
  branch is exactly the work you do not want on the parent's lane.

  It is a **hint, not a pin**: it is input to a `PlacementPolicy`, which may route elsewhere.
  A target that has since been retired must not strand the executions that named it, so
  `PlacementDispatcher` falls back — and now warns once per unknown name, because falling
  back silently is how an execution placed on sized compute ends up running somewhere else
  forever. That matters most in `recoverAbandoned`, where a node is often recovering an
  execution *because* its original lane went away.

- **Branch registry rows no longer outlive the executions they describe (BranchRegistry SPI
  1.2.0).** Two rows survive a reclaimed branch and nothing collected either. A **fork edge**
  described data that no longer exists — and `LogLifecycle` walks `children()` on every sweep,
  so dead edges make retention slower forever, in proportion to every fork ever taken; the new
  optional `removeLineage(executionId)` is called at the one point where the id is known and
  the data is provably gone, inside `applyRetention`'s delete. A **ref** survives it too, and
  that is worse than untidy: `promote(ghost, "main")` succeeds, leaving `main` naming an
  execution that cannot be read, resumed or replayed. `pruneBranchRefs(eventStore, registry)`
  pages over `listRefs` and deletes refs whose execution has no events — and takes **no
  predicate**, because unlike "is this branch abandoned" (someone's open question, only the app
  can judge), "the execution is gone" is a fact. It protects `main` by default and *reports* it
  as dangling instead: turning "main names a ghost" into "there is no main" makes the problem
  harder to diagnose, not easier.

- **`retireAbandonedBranches()` — a forked parent could never be reclaimed.** `applyRetention`
  refuses anything non-terminal, and refuses a parent while a live descendant branch still has
  events (R5.3, correctly: the fork's copied prefix aliases the parent's). A branch that was
  forked, simulated and then never answered is suspended *forever* — so it is never reclaimed,
  so its parent is never reclaimed either: `blocked-by-branch`, every sweep, permanently. The
  retention policy quietly stopped applying to exactly the executions that did the most work.

  The lever is not deletion. An abandoned branch should become **terminal**, which `cancel()`
  already does durably and auditably — `EXECUTION_CANCELLED` records that the branch was
  abandoned and why, rather than erasing that it existed — after which ordinary retention
  collects the branch on its own TTL and the parent unblocks behind it. The new pass is
  parent-centric (bounded by one parent's children, no global scan), and `isAbandoned` is
  **required with no default** for `recoverAbandoned`'s reason: a branch parked on a human gate
  is someone's open question, not garbage, and only the application knows whether that person
  is still coming. It reports what it left alone, so "still open" is an answer rather than a
  silence.

- **A declared deadline no runtime can honour now says so.** `suspend({ timeout })` becomes a
  durable `wakeAt` only when a `TimerStore` is wired; unwired, the condition is committed
  *without* one — byte-identically, and silently. That is invisible while everything runs in
  one process and becomes a permanently parked execution the moment compute is split: a
  worker built as "a runtime with the flows registered" discards every timeout of every
  execution it suspends, and nothing downstream can tell "no deadline" from "the deadline was
  dropped on the machine that suspended". `WorkflowRuntime` now warns at exactly that point,
  once per (flow, gate), naming both and pointing at `loom verify`'s `suspension-safety` rule
  — which catches it statically, if you run verify against the composition that suspends.
  Routed through a new `onWarn` dep (defaulting to `console.warn`, like `defineConfig`'s
  warning for schedules that can never fire) and wired to `defineConfig({ onWarn })`. The log
  is untouched: this is a diagnostic, not a behaviour, and a test pins the committed condition
  byte-for-byte.

- **`fork()` no longer reads the parent's whole log (EventStore SPI 1.4.0).** It needed the
  tip to validate a fork point and was calling `read()` to get it — materializing every event
  of a long-lived parent, including the entire tail *above* the fork point, and paying that
  even when the store could copy the prefix natively. The SPI gains an optional
  `head(executionId)` (one indexed `MAX(sequence)`; `headOf()` falls back to reading for
  stores that omit it), and `fork()` now reads exactly one window: the tail a snapshot does
  not already cover, widened to the full prefix only when the copy itself needs it (no native
  `copyPrefix`, or live projections that must see the copied events). In the common case — a
  branch forked at a durable gate, where the suspend path has just checkpointed — it reads
  **no events at all**. Implemented natively on SQLite/Postgres/in-memory and forwarded by
  every store decorator (tenant-scoping, coalescing, sharding, profiling, content-resolving,
  hash-chaining, encrypting), so a capability probe behaves the same through a wrapper stack.

- **`BranchRegistry.promote` can be a compare-and-set, and `listRefs` can be paged
  (BranchRegistry SPI 1.1.0).** `promote(from, to)` was read-then-write on every backend, so
  two nodes promoting different winners onto `main` both succeeded and the loser silently
  became what `main` named — a pointer move with no way to say *"only if it still names what
  I read"*. It now takes `{ expect }`: the executionId `to` must name right now, or `null`
  for "must not exist yet". A mismatch throws `BranchPromotionConflictError` and **nothing
  moves**, so a caller re-reads and decides rather than retrying blind. Each backend does the
  check where it is actually atomic — one `UPDATE … WHERE execution_id = $expected` (or an
  `INSERT … ON CONFLICT DO NOTHING`) on Postgres, inside a transaction on SQLite, and
  in-process for the Map. Omitting `expect` keeps 1.0.0's last-write-wins behaviour
  byte-identically. `listRefs({ limit, after })` adds keyset paging for a ref table that is
  unbounded by design — forking is cheap — and the shared `assertListRefsLimit` guard refuses
  a non-positive or fractional `limit` on every backend, because `LIMIT -1` is SQLite for *no
  limit* and would hand the whole table to a caller that asked for one row.

  Found while writing the conformance cases: **the Postgres `BranchRegistry` had never been
  run against the conformance kit at all.** SQLite was held to the portable contract while
  the Postgres implementation — the one with hand-written SQL — was merely assumed to match
  it. `plugins/postgres/src/conformance.test.ts` now runs `runBranchRegistryConformance`
  too (verified against a real PostgreSQL 17: 71/71, up from 64).

- **Recovering executions whose supervisor died ([ADR 0004](docs/adr/0004-failure-recovery.md)
  amendment).** A dead or wedged *worker* was already handled: the dispatcher's
  `executeTimeoutMs` turns a hung attempt into a failed one, redispatches, and the worker
  resumes idempotently from durable state. What that cannot cover is the *supervisor* itself
  dying — detection lives in the dispatcher's process memory, so killing that process leaves
  an execution `running` in the log with no owner. Loom cannot resolve this from the log:
  a `running` execution owned by a healthy node elsewhere is byte-identical to an orphaned
  one, because the difference is a fact about your cluster. `recoverAbandoned(runtime, {
  source, isAbandoned })` (`@loom/workflow-runtime`) therefore does everything *except*
  decide — enumerate, filter to `running`/`pending`, ask your predicate, and resume what it
  claims through the same `EXECUTION_RECOVERED` path the worker uses under redispatch.
  `isAbandoned` is **required with no default**: `true` would preempt live work on other
  nodes, `false` would be a pass that silently recovers nothing while reading as coverage.
  Run it from a cron or a Kubernetes Job — it is a maintenance pass, not a service. A
  `LeaseStore`/heartbeat SPI that would let Loom answer the question itself is deliberately
  deferred to a second consumer ([ADR 0083](docs/adr/0083-second-consumer-rule.md)).

- **A query is an input, and an input has a bound (MemoryStore SPI 2.0.0 → 2.1.0).** Terms are
  OR-ed, so a repeated term is the same term — it cannot change which entries match, only how
  long a store takes to say so. A 128 KB question repeating one word 20,000 times built a
  20,000-clause FTS5 `MATCH` and took `SqliteMemoryStore` **32.7 seconds**: a denial of service
  bought from a text box, on a call any agent makes with whatever a user typed. `queryTerms`
  now deduplicates and caps at `MAX_QUERY_TERMS` (256, far past any real question, and the
  point at which distinct terms stop being signal), and all three backends derive their terms
  from it. It degrades rather than refuses — the choice `searchableText`'s depth limit already
  makes — and a similarity backend, which derives no terms, is unaffected. The same bound is
  applied to `SkillRegistry.find` and `CapabilityCatalog.find`, whose keyword scoring is
  `O(entries × terms)` of substring searches over an equally unbounded query.

- **A pin map is read as data, never as an object.** A derivation id is an untrusted string —
  the premise of ADR 0088 is that a model may have composed the blueprint that names it — and
  `{}["__proto__"] = version` sets a prototype instead of adding a key. The pin vanished,
  `Object.keys` never saw it, and the binding dropped out of `checkBlueprintPins` entirely:
  `compared` counted one fewer and **no finding was raised**, which is precisely the silent
  omission the seam exists to prevent. Every pin map is now built without a prototype
  (`blueprintPins`, `checkBlueprintPins`, `InMemoryProjectionRuntime.pins`,
  `ReadModelService.pins`/`checkPins`) and every read is an own-property read, so a derivation
  called `constructor` or `toString` can no longer be answered for by `Object.prototype`.
  `parseArgs` gets the same treatment: with a prototype, `flags["valueOf"] ?? fallback`
  answered with a function for a flag nobody passed.

- **The binding-semantics pin — a content address that freezes a name, not a meaning.** A
  composed surface is content-addressed, and `docs/composed-surfaces.md` listed *bindings* among
  the things that address freezes, under the heading "the meaning of a view never changes
  silently". It froze `{ projectionId, path }` — a **name**. The projection behind it is live code
  registered under that name with no version, so the query, the filter predicates, the join keys,
  the aggregation and the window all sat on the floating side, and editing a fold changed what
  every pinned view meant under an unchanged hash. The same hole was a live defect in
  `plugins/read-model`, where an edited `extract` leaves old rows in place, the watermark already
  past them, one `query` answering from two extractors, and `rebuild()` the fix nobody is told to
  run. An optional declared `version` on `ProjectionDefinition` / `Projection` /
  `ReadModelDefinition` (declared, not derived — `flowContentHash` excludes handler code for the
  same reason a fold closure has no stable fingerprint), `checkVersionPins(recorded, current)`
  reporting `drift` as an error and `unpinned` as a warn with the side it is missing from, and
  `compared` as the denominator so `ok: true` over nothing cannot read as a pass. The recorded pin
  rides in `Blueprint.projectionVersions`, inside the content address rather than beside it — a
  test asserts two views differing only in their recorded versions hash differently, which is
  what makes the recipe's frozen list true rather than aspirational. `projectionRuntime.pins()`
  is what a composer records; `checkBlueprintPins(view, pins)` is what a render compares.
  Second consumer, wired: `ReadModelService.pins()` / `checkPins(recorded)` — a query, like
  `identityDiff`, that reports what is wrong without rebuilding anything (ADR 0095).

- **Row-granular `purge` on the read-model store SPI (1.0.0 → 1.1.0).** Erasing one subject
  from a read model used to mean `clear` + rebuild — work proportional to the whole log, no
  matter how few rows the subject owned. `purge(modelId, where)` deletes by indexed-field
  equality with the same semantics `query` uses, so a caller can see what it is about to erase
  with the tool it already has, and returns the count. Measured at **68×** on
  `purge.bench.ts` (0.49 ms vs 33.8 ms, one subject of 50 in a 20k-event corpus).
  Three refusals, because an erasure that quietly does nothing is worse than one that fails:
  an empty filter throws rather than meaning either "every row" or "no rows"; a filter naming
  an undeclared field throws rather than reporting zero; and a backend without the method
  raises a typed `PurgeUnsupportedError` naming the fallback rather than resolving with zero.
  Watermarks are deliberately untouched — clearing them would let the next catch-up re-derive
  the rows just erased. Implemented for the in-memory, SQLite and Postgres backends and pinned
  by the conformance kit, which `PostgresReadModelStore` now runs for the first time
  (ADR 0093).

- **`preservesNodes` — node identity across a structural change.** A widget's `id` is derived
  from kind + props unless supplied, so a prop edit *re-identifies* the node: it remounts, and
  any pin, annotation or agent reference keyed on the old id dangles. `validateBlueprint` checks
  one tree (including `duplicate-node-id` within it); nothing compared one tree to another, which
  is where identity is actually lost. `preservesNodes(before, after)` reports which ids the change
  dropped, with `added` as data (a `dropped` beside an `added` is what a re-identification looks
  like) and `compared` as the denominator, so `ok: true` over an empty `before` cannot read as a
  pass. `blueprintNodeIds` / `preservesBlueprintNodes` spell the blueprint case; passing a floor's
  ids as `before` answers "does this variant contain the floor?" with no new vocabulary. Second
  consumer: `A2UISurfaceBridge.identityDiff(next)`, which reports what a proposed `recompose`
  would unmount without committing the tree or emitting — and which is why the API takes id sets
  rather than blueprints, A2UI components being a flat list (ADR 0094).

- **A corpus can have more than one writer** — `DocRecord.source`, `sync(docs, { source })`,
  `putDoc(doc, { source })`, and `SyncResult.retained`. `sync` is a destructive reconcile over
  everything the manifest holds, so an agent writing down what it learned from feedback into the
  same scope as an authored corpus would lose all of it to the next nightly wiki job: those
  documents are not in the set the wiki produced, and never will be. Stamped with a writer, a
  reconcile only ever touches its own documents; the rest come back as `retained`, so the
  protection is visible rather than silent. A write to a document ANOTHER writer owns is refused
  loudly — silently re-stamping would make the two delete each other's revisions on alternate
  syncs, with every individual run looking correct. An absent document has no owner, so any
  writer may create it, and an unstamped corpus behaves exactly as before (the default writer is
  a source of its own, never a wildcard). `loom knowledge sync --source <s>` carries it.

- **Blueprint conformance** ([ADR 0088](docs/adr/0088-blueprint-conformance.md)). A blueprint a
  *person* writes is checked by the type system; one a *model* composes at run time is data, and
  the only thing between an off-catalogue component and a viewer is whatever validates it on the
  way out. `validateBlueprint` / `catalogCoverage` in `@loom/blueprint-runtime` check a composed
  blueprint against the widget catalogue the app already declared — two pure functions and a
  declaration type, no kernel change.

- **Worker-thread sandbox evaluation and the hard kill**
  ([ADR 0089](docs/adr/0089-sandbox-worker-pool.md)). `vm.evalCode` is synchronous and cannot
  yield, so `wallClockMs` was not only the longest a script may run — it was the longest the
  CALLING thread was unavailable. The opt-in `workers` option on `SandboxSpec` moves evaluation
  to a worker pool, which adds the one guarantee the in-engine guards structurally cannot: a hard
  kill for a script that never reaches the interrupt handler (measured at 790ms against a 50ms
  wall clock). In-process stays the default and ADR 0064's security list is parameterized over
  both engines rather than copied.

- **`app.knowledge(scope)`, `loom knowledge`, and a `loom doctor` memory-store check** — the DX
  follow-on to ADR 0091. `app.knowledge` opens a corpus over the app's configured `memoryStore`
  (one per scope, cached; options honoured on the first call only, since two parts of an app
  configuring one corpus with different chunkers would chunk it differently on alternate ingests),
  and refuses a tier a registered `memory$` would evict — both run over the same store, and only
  the runtime that reads applies its own policy.

  `loom knowledge sync --dir <path>` reconciles a directory into a corpus, `list` shows what it
  holds, `search` asks it what a flow would retrieve. `sync` is a **dry run by default** because
  the reconcile is destructive — a document the directory no longer contains is deleted — and the
  preview runs `KnowledgeBase.planSync`, the same classification `sync` itself uses. Skipped files
  (symlinks, over the size cap, empty) are listed rather than quietly dropped, because a file the
  corpus does not contain is the answer to a "why did retrieval miss that" question. `search`
  prints that it is **not a recorded retrieval**: an operator query has no execution to record
  into, so a transcript of it is not what an execution saw. All three refuse an app with no
  configured `memoryStore` — that corpus lives in a store the process discards on exit.

  `loom doctor` gains a memory-store check: no `memoryStore` is a SKIP that names the cost (memory
  and any corpus lost on restart — the shape ADR 0090 opened with), while a configured store
  without `search` is a FAILURE, since `recallRelevant`/`retrieve` refuse it at run time rather
  than degrading.

- **`@loom/memory` is in `SPI_PACKAGES`**, so `loom plugin check` finally holds a memory backend
  to the peer-dependency rule. It had been absent for as long as the seam existed, reporting a
  green "SPI packages are peer dependencies" while being unable to see the one package that
  matters to it. A bundled copy here is not a duplicate kernel but a duplicate CONTRACT:
  `searchableText`/`tokenize`/`clampSearchLimit` decide what a backend indexes and what counts
  as a term, so a plugin carrying its own copy can answer a different question than the app
  asked and still pass conformance.

- **A corpus is mutable, and the SPI could not say so**
  ([ADR 0091](docs/adr/0091-corpus-lifecycle-and-the-knowledge-package.md)). `MemoryStore.search`
  ranks within ONE key, so a searchable corpus has to be one key — while a DOCUMENT, the unit that
  actually gets revised and deleted, is a subset of that key the SPI could not name. Re-ingesting
  an edited document therefore DUPLICATED it (retrieval returning the superseded passage beside the
  current one, with nothing saying which was live), the only removal verb was `clear` on the whole
  scope, and a document deleted upstream kept answering questions. None of it shows in a green
  suite, because every test ingests once.

  `MemoryEntry.id` is now optional for a caller and **required for a backend to round-trip**, with
  the optional `MemoryStore.remove(key, ids)` beside it. The asymmetry is deliberate: `remove` has
  a correct fallback (read-filter-`replace`), but that fallback matches on the id `read` gives
  back, so a backend that dropped ids would turn a delete into a silent no-op on exactly the path
  taken by backends with no native delete. **`MEMORY_STORE_SPI_VERSION` is 2.0.0** — MAJOR because
  a backend that decomposes an entry into columns drops a field nobody told it to keep, which is
  invisible to every case that only checks `content`. Neither first-party SQL backend needed a
  migration: both already store the entry as JSON, so removal reads the id back out of it
  (`json_extract` / `entry->>'id'`) behind a partial expression index.

- **`@loom/knowledge` — document corpora over a memory tier.** `KnowledgeBase.putDoc` is an UPSERT
  and `sync(docs)` reconciles a corpus against its source: write what changed (by a
  `canonicalJson`+`fnv1a64` fingerprint), leave what did not, remove what the source dropped — an
  unchanged source costs one manifest read and zero writes. Manifest rows are APPENDED and pruned
  only after the new one is durable, because the obvious alternative (delete the old row, write the
  new one) has a crash window in which a document has no row at all, and a document nothing counts
  is a document nothing can remove.

  `groundedRequest`/`passageMessages` assemble the one prompt shape `guardRequest` accepts — one
  `user` message per passage, taint intact, never joined — so the shape every RAG tutorial writes
  (passages in the SYSTEM prompt) does not compile rather than being refused at run time.
  `openKnowledgeBase(store, { scope })` is the two-line form of the four every consumer was
  writing by hand — a corpus needs exactly one tier and that tier must not evict, which is a
  fact about corpora rather than a decision each app re-derives (and `app.memory` is a
  `MemoryRuntime`, one layer below the `TieredMemory` the constructor takes, so the
  boilerplate was mandatory rather than incidental).

  `checkCitations`/`assertGrounded` reject a citation to a document that was never retrieved: the
  one hallucination in a RAG answer that is decidable rather than judged, because the retrieval was
  recorded. Chunking stays injected (`packParagraphs` is an ignorable default), embeddings stay
  third-party, and the `knowledge$` construct stays rejected.

- **The `MemoryStore` SPI is versioned** (`MEMORY_STORE_SPI_VERSION`, 1.0.0), carried in the kernel
  manifest and `checkCompatibility` beside the event-store / snapshot / branch / dispatcher SPIs.
  A formality while every implementation lived in this workspace, where a breaking change breaks
  the build that made it — and not one once the seam grew a backend OUTSIDE it, which nothing here
  builds, tests, or can see.

- **A `memory` seam for `loom plugin new`**, and an exports-map rule in `loom plugin check`: an
  `exports` map declaring `require` with no `default`/`import` resolves for CJS and raises
  `ERR_PACKAGE_PATH_NOT_EXPORTED` for ESM — a shape neither tsc nor a CJS test runner can see.

- **Agent memory that survives a restart, and can answer a question**
  ([ADR 0090](docs/adr/0090-knowledge-is-retrieval-over-memory.md)). `@loom/memory` shipped tiers,
  TTL/size policy, summarization and `ctx.decide`-recorded recall over a pluggable `MemoryStore` —
  and exactly one implementation of it, `InMemoryMemoryStore`. Every store plugin carried an event
  store, a snapshot store, a timer store, a durable-state store and a read model, and no memory
  store, so what shipped was a prompt-context manager: an agent that restarted remembered nothing.

  `SqliteMemoryStore` and `PostgresMemoryStore` live in the plugins that already own those
  databases — point them at the event log's file/URL and one backup captures both. A key names an
  ORDERED LIST read back in APPEND order, never timestamp order (entries routinely share a
  timestamp, and ordering by it reshuffles a conversation). `MemoryStore.replace` (OPTIONAL) is a
  durability fix rather than an optimisation: `MemoryRuntime` rewrites a scope's whole list on
  every eviction, and as clear-then-re-append a crash between the two makes routine eviction the
  thing that loses the scope.

- **`MemoryStore.search` — recall by relevance, not just by recency.** `read` answers *what
  happened last*; the `semantic`/`procedural` tiers never evict, so their "newest N" means nothing
  and the only way to use one was to load it whole. `search` ships with three first-party
  implementations (in-memory IDF, SQLite FTS5, Postgres `tsvector`) plus a third-party cosine
  backend, all passing one `runMemoryStoreConformance` — which is what makes the seam a contract
  rather than a description of an inverted index. `searchableText` and `tokenize` are exported
  because *what gets indexed* and *what counts as a term* are the contract; ranking is not, and the
  kit deliberately does not pin an order.

  `TieredMemory.recallRelevant(tier, scope, query, { decide })` takes `decide` as a **required**
  option where `recall`'s is optional: relevance ranks over a corpus that grows, so the set it
  returns differs between a run and its replay, and a type requirement beats a documented one.
  `MemoryRuntime.search` refuses a store without `search` rather than degrading to `read` — a
  silent fallback would look like retrieval and be undetectable downstream.

- **A `memory` seam for `loom plugin new`.** Emits only the three required verbs and explains
  `replace`/`search`/`close` in prose, because for an optional method presence IS the feature flag:
  the runtime tests for it and falls back when absent, so a generated stub that throws advertises a
  capability the store does not have. `loom plugin check` gains an exports-map rule — `require`
  with no `default`/`import` resolves for CJS and raises `ERR_PACKAGE_PATH_NOT_EXPORTED` for ESM.

- **The agent loop is a runner body, and the seams it can now reach are wired**
  ([ADR 0087](docs/adr/0087-durable-agent-loop.md)). `agentStep$` wrapped the whole ReAct loop in
  one `step$({ handler })`, and a handler receives `StepHandlerContext` — `emit`, and nothing else.
  So forty model calls and N tool calls were ONE frame (a crash at turn 39 re-ran all 39), approval
  had to be hoisted out of the agent entirely, and routing choices were hand-emitted in a shape
  `@loom/learning` cannot evaluate. Nothing was missing from the kernel; the loop was on the wrong
  side of it.

  `agentLoop$(ctx, config, input)` is an ordinary function over `ExecutionContext`, called from a
  runner body, issuing `ctx.execute` per turn with ids minted `#turn:<i>` / `#turn:<i>:tool:<j>` per
  the [ADR 0061](docs/adr/0061-step-identity-interpreter-guardrails.md) identity rule. The model
  call resolves through the `EffectRuntime` by `modelToolId`, so K2, metering, retry,
  `idempotencyKey` and K9 in-doubt all apply to it. `requireApproval` parks the execution on a gate
  BEFORE a destructive tool runs, and a refusal is fed back to the model as a tool result rather
  than thrown — a human declining is information the agent can settle on.

  Its choices go through the decision seam: skill selection and memory recall via `ctx.decide`
  (so a replay reconstructs the prompt that actually ran, not the one a re-selection would build),
  compaction via `ctx.execute` (a lossy, nondeterministic summary has to be a recorded fact), and
  Reasoning-Runtime routing likewise. `agentStep$` is retained and NOT deprecated: one frame instead
  of 2N, for an agent that wants none of this.

- **A streamed model call that is still one durable outcome.** `LlmStreamChunk` carries optional
  `toolCalls`/`stopReason`/`usage` on its terminal chunk — without them a stream could carry prose
  to a human and nothing else, since a ReAct loop branches on exactly those. `assembleStream` /
  `collectStream` fold a stream into the `LlmResponse` it represents, and
  `runLlmProviderConformance` pins the contract that makes two paths to one outcome safe: **a
  streamed result MUST equal what `complete` returns** — [ADR 0059](docs/adr/0059-content-put-stream.md)
  D1's streamed-≡-buffered discipline applied to the model call. `createLlmEffect({ stream: true })`
  consumes it internally: deltas reach a transient sink, the journal sees one `STEP_COMPLETED`, and
  an interrupted generation keeps its partial text on an ADR 0060 channel instead of discarding it.

- **K8.4 — a runaway generation is severed while it generates**
  ([ADR 0020](docs/adr/0020-k8-cancellation-deadlines-bounded-effects.md) A8). Every other K3 gate
  is admission control: it decides whether the NEXT effect runs, so a model that emits 100K tokens
  was billed in full and stopped afterwards. `streamTokenBudget(budget)` (`@loom/middleware`) guards
  `collectStream`, estimating output tokens from the text so far plus what `ctx.resources` already
  metered, and on breach emits `QUOTA_EXCEEDED` — the same durable fact `meteringMiddleware`
  writes — then throws `QuotaExceededError`. The estimate is named as an estimate in the type, in
  the reason, and in the default; final metering still uses the provider's own numbers.

### Fixed

- **`loom retention run` could delete a parent its branches still depended on.** The command
  built `LogLifecycle` with **no branch registry**, and R5.3's live-descendant guard is a no-op
  without one — so `--apply` on a branched database deleted parents whose forks alias their
  prefix, breaking exactly the invariant the guard exists for. The file's own comment said the
  opposite (*"the branch-integrity guard … handled by `LogLifecycle.applyRetention`"*), true of
  the method and false of this caller.

  It also re-implemented eligibility locally for the dry run — terminal + aged — so the preview
  silently skipped the branch **and** pin gates and printed `would-reclaim` for executions the
  library would refuse. A `--apply` flag whose preview disagrees with its apply is worse than no
  preview. `LogLifecycle.evaluate()` now holds every gate and `applyRetention` consults it, so
  the two cannot drift; the CLI takes `--branches <path>`, and **says the guard is off** when it
  is not given rather than looking complete.

- **`wallClockMs` charged the parent's own latency to the script.** The sandbox pool's kill
  deadline is a `setTimeout` on the parent's event loop, and the worker's reply arrives as a
  message to that same loop — so the budget measured the script *plus* however long the parent
  took to post the eval and to drain the reply. libuv runs the timers phase before the poll
  phase, so on a contended host a due deadline fires ahead of a reply that already arrived,
  and a trivial script comes back `limitExceeded { wallClock }`: a resource kill routed to
  drift-repair, where an LLM rewrites a script that was never the problem. (Same failure the
  pool already fixed for cold starts, by a different route.) The deadline is now a **question
  asked of shared memory** rather than a verdict: the worker stamps when the script actually
  started and when it stopped into a `SharedArrayBuffer`, which the parent reads
  *synchronously* inside the timer callback — where it cannot receive a message. A script is
  killed only if it is still running and has outrun its budget **by the worker's own clock**;
  otherwise the parent re-asks. A worker that never starts the run at all is still reclaimed,
  as a worker fault rather than a script breach. Pinned by a test that starves the parent for
  four times the deadline and asserts the fast script still resolves.

- **The retention guard read whole logs to ask a yes/no question.** `hasLiveDescendant` called
  `eventStore.read(child)` and checked `.length > 0` — per child, per swept execution, against
  branch logs, which are the long ones precisely because a branch is forked to do expensive
  work. It is a tip query, and now uses `headOf` (EventStore SPI 1.4.0).

- **A fork copied the gate but not the alarm.** `WorkflowRuntime.fork()` copies the parent's
  prefix verbatim, so a branch forked at a suspension is parked on the same condition —
  including a `wakeAt` derived from `suspend({ timeout })`. But a timer row is keyed by
  executionId, and `timerStore.schedule` was called from exactly one place: the suspend path
  of the run loop. A branch therefore inherited, in its own log, a deadline that nothing
  would ever fire, and nothing else could catch it — `recoverAbandoned` ignores suspended
  executions by design, because suspension is a normal outcome rather than an abandonment.
  The parent timed out on schedule while every branch waited forever. `fork()` now schedules
  the child's wake, after the prefix and seed snapshot are durable (the same invariant the
  suspend path holds: a timer must never fire into a log that does not yet record the
  suspend), and reports a failed schedule through `onStorageError` rather than failing a fork
  that is already complete. **The branch inherits the recorded deadline and cannot re-base
  it**: `TimerService` fires only when `state.suspendedOn.wakeAt === timer.wakeAt` and the
  copied prefix is byte-identical by design, so a re-based deadline would be a timer that
  could never match its own log. A branch that wants its own deadline resumes the gate and
  suspends again with a fresh `timeout` — a fact it appends, not one it inherits. Untimed
  gates gain no timer, a fork before the gate gains none, and with no `TimerStore` wired the
  behaviour is byte-identical to before.

- **`DelegationAuthorizer`'s `base` is required (potentially breaking).** It was optional,
  documented as "omit to allow the full verified delegated set (the callee delegates all of
  its authority decisions upstream)". That mode cannot deliver what it claims: the delegation
  secret is **symmetric**, so the party that verifies a token is also a party that can mint
  one. A callee can sign itself `{ grants: ["*"] }` and the result is *genuine* — no signature
  check can reject it, because it is not forgery. What actually bounds a callee is the
  intersection with `base`, so an absent `base` silently reduced that check to a no-op while
  still reading as a working gate. `base` is now required, with a constructor guard as well as
  the type (the type is not enforcement for JS callers). No production construction sites
  existed in this repo or any sibling, so the practical blast radius is zero;
  [ADR 0024](docs/adr/0024-k12-identity-tenancy-delegated-authority.md) now records the trust
  model and marks cross-organisation delegation — where the verifier must not be able to mint,
  and which needs asymmetric signatures — an explicit non-goal. The same symmetry applies to
  [ADR 0037](docs/adr/0037-tamper-evident-audit-chain.md)'s audit chain: an auditor handed the
  HMAC secret to verify history can also rewrite it, so it is tamper-*evident* against third
  parties rather than third-party *verifiable*.

- **Subject erasure never reached a derived read model, and "just rebuild it" did not work
  either.** A crypto-shred (K10.2) erases the log; it says nothing about anything built from
  the log, and `eraseSubject` does not know a read model exists. Every derived row kept the
  plaintext its extractor copied out before the key died — and those rows are what a query
  reads. The prescribed repair, `clear(modelId)` + re-scan, then failed on its own terms: the
  authoritative read of a shredded subject throws `PayloadShreddedError` by design, and a
  rebuild is a read, so it needs a source configured `onShredded: "tolerate"` — the throw is
  at the SOURCE, before any extractor runs. Under a tolerant source the extractor must then
  decide what `{ $shredded: true }` means, because indexing it verbatim rebuilds the
  placeholder into the cache and collapses every erased subject onto one bucket. All three are
  now documented (`docs/compliance.md`, the `ReadModelStore.clear` contract) and pinned by
  `plugins/read-model/src/erasure.test.ts`. Erasure cost is *O(log)*, not *O(subject)*; a
  row-granular purge stays deferred behind a measured cost (ADR 0092 D6).

- **Indexing recursed without a bound over ingested memory content.** `searchableText` walked
  `entry.content` recursively with no depth cap and no cycle guard, and `content` is whatever was
  ingested. A nesting depth of 5,000 is still JSON-serializable — so it satisfies the documented
  contract AND every durable backend's own `JSON.stringify` — and it exhausted the call stack,
  failing a write the store had promised to accept; a cyclic value never terminated, and the
  in-memory store accepted one at `append` only to detonate later inside an unrelated `search`.
  Now an iterative walk with an explicit stack and a depth cap, indexing over-deep content as far
  as the cap rather than refusing it.

- **`MemoryStore.search` trusted its `limit`.** Three backends, three behaviours: `.slice(0, -1)`
  dropped the last hit, SQLite read `LIMIT -1` as NO LIMIT and returned the entire matching set,
  Postgres threw. The unbounded one is the quiet failure, and `recallRelevant` records what it
  retrieved through `ctx.decide` — so an unbounded search writes the whole corpus into a
  `DECISION_RECORDED` payload, permanently. `clampSearchLimit` mirrors
  `@loom/plugin-read-model`'s `MAX_QUERY_LIMIT`; four conformance cases pin it, and backends MUST
  route their limit through it.

- **`SupervisingDispatcher` never forgot a circuit.** `recordSuccess` reset one in place and
  nothing deleted it, so a `policy.circuit.key` with tenant or execution cardinality — which the
  hook invites, since it receives the whole `ExecutionPackage` — grew for the process lifetime.
  Deleting on success is observationally identical at all three read sites.

- **Two SPI-map claims that understated what ships.** The Timers row said its conformance kit was
  `— (future)` while `runTimerStoreConformance` had shipped and SQLite was running it, and the
  compute section called a dispatcher kit "a natural follow-up" with
  `runExecutionDispatcherConformance` already exported. Four seams with kits and no row at all
  (content store, carry state, read models, subject keys) are now listed, and a fitness function
  keeps the column honest in both directions.

- **Every package's `exports` map was unreachable from ESM.** Forty-nine declared
  `{ require, types }` and nothing else. Node matches export conditions in order and stops at the
  first hit, and an `import` offers `["node", "import"]` — never `"require"` — so it matched
  nothing. Invisible from inside: loom's own test config forces `conditions: ["require",
  "default"]`, TypeScript reads `types` directly, and neither turbo nor tsc resolves at runtime.
  Now `types` / `require` / `default`, with `default` last because it matches everything and
  anything after it is dead. A fitness function in `@loom/spec` holds all three properties, and the
  scaffold no longer mints the defect into new plugins.

- **Three ways a check could silently not run.** The Postgres suites (94 tests) had never executed
  in CI — gated on `LOOM_TEST_POSTGRES_URL`, skipping cleanly, and a skipped suite renders exactly
  like a passing one; CI now provisions a service container, and the requirement lives in the repo
  as a test that fails when `CI` is set and the URL is not. `LOOM_TEST_POSTGRES_URL` and
  `LOOM_TEST_SRC` were absent from turbo's `test` cache key, so a cached result from a run WITHOUT
  a database was replayed verbatim for a run that had one. And seven packages ran vitest with no
  config at all — there is no root config to inherit — so they silently opted out of the shared
  resolution, which is how a value import from `@loom/memory` first broke, and made
  `LOOM_TEST_SRC=1` inert in exactly those packages.

- **`ctx.decide` could not be passed as a value.** Every decider-taking helper takes it as an
  option and the documented spelling is `decide: ctx.decide`, which lost its receiver and died
  inside the context with a `TypeError` naming neither `decide` nor binding. `agentLoop$` carried a
  hand-written wrapper at two call sites, with a comment instructing the reader to do the same — so
  the workaround was known and the fix was not. The context now binds it.

- **A tainted value's `origin` was indexed as searchable text.** An ingested corpus taints every
  entry ([ADR 0085](docs/adr/0085-untrusted-content-integrity-axis.md)), so the label rode into
  `searchableText` as a string leaf and one term matched the whole corpus — on an FTS backend that
  widens the match *set*, not just the ranking. Provenance is metadata by exactly the rule that
  already excludes `role` and the timestamp.

- **Two tests that asserted the clock instead of the property.** A cross-node LISTEN/NOTIFY test
  fired `subscribe` and slept 100ms; `NOTIFY` is not durable, so a listener registering after the
  publish never receives it and the wait could only time out — it now awaits the subscription,
  which the store already resolves after its LISTEN registers. A content-batching test measured
  elapsed time against a 20 x 5ms serialized floor with a 2x margin; it now asserts peak in-flight
  calls, which a serialized fallback can only ever drive to 1.

- **The prompt-boundary guard runs where prompts are actually built.**
  [ADR 0085](docs/adr/0085-untrusted-content-integrity-axis.md)'s protection did not cover the
  agent: `guardRequest` ran only inside `createLlmEffect`, which had no production consumer, while
  `AgentRunner` and `ReasoningRuntime` called `provider.complete` directly. The agent path was worse
  than unguarded — `JSON.stringify` of a tool result flattened the taint envelope into ordinary
  text, so `isTainted` was false downstream and no guard added later could recover the origin.
  Evidence erased, not merely unused. Both paths now guard, and a tool result keeps its taint
  outside the serialization.

- **An agent's declared tool menu is its reachable effect set.** `resolveVerifyInput` read
  `AgentDefinition.tools` nowhere, and an `agentStep$` declares no `toolId` of its own — so a flow
  whose only step was an agent contributed NO effects, and `capability-compat`, `effect-class` and
  ADR 0084's unclassified-effects warn all passed vacuously over it. `StepDefinition.reachableTools`
  declares the menu reachable THROUGH a step; `agentStep$` populates it from the agent's tools.

- **A capability denial is terminal for the turn.** `AgentRunner` swallowed every throw into
  `{ error }` and handed it to the model, which reads "not authorized", reformulates, and probes a
  neighbouring tool — turning one denial into a search over the grant table. `EFFECT_DENIED` was
  always logged, but auditable is not the same as stopped.

- **A spawned child can be given less authority than the flow it runs.** `superviseChildren` started
  children with no principal at all, so K12.4's `DelegatedGrant` — which verifies signature, expiry,
  holder-binding and the intersection with the callee's own grants — had nothing to check.
  `awaitChild({ grants })` names the conferred subset and a supervisor wired with
  `delegation: { secret }` mints the token at start time, bound to the child's own execution id.
  The signed token is never written to the log: an append-only, archived log is the wrong place for
  a bearer credential, so the log records the subset and the mint is re-derived on recovery.

- **Envelope ids are unique too, and a re-used one is its own error**
  ([#309](https://github.com/chhetrisushil/loom/issues/309)). The sibling of #306 on the events
  table's other key: both SQL backends declare `PRIMARY KEY (id)`, `InMemoryAsyncEventStore` had no
  equivalent check, and two envelopes sharing an `id` both landed. All three backends now reject
  with `DuplicateEnvelopeIdError` — deliberately a **different type** from `DuplicateSequenceError`,
  because they are different failures: a taken sequence means another writer reached that slot (a
  lost race, retryable by re-reading and re-allocating), a taken id means the same envelope identity
  was minted twice (a bug in whatever produced it). Ids are conventionally derived from
  `${executionId}-${sequence}`, so a lost slot race trips both constraints; the sequence is
  reported, being the actionable one.

  The in-memory store keeps an id index, which has to be maintained everywhere the log changes,
  not just on append: `deleteExecution` and `truncatePrefix` free the ids of the events they drop
  (an index outliving its events makes an erased execution impossible to re-create, and leaks
  across a retention sweep), and `copyPrefix` claims the ids of the events it copies — rejecting,
  all-or-nothing, if a re-stamped id collides.

  **Uniqueness is required within an execution; cross-execution is explicitly not.**
  `ShardedEventStore` cannot provide it — separate executions live on separate backing stores and
  no shard sees another's ids — the same carve-out `appendBatch` already makes for cross-execution
  atomicity. A single-log backend gets store-wide uniqueness from its primary key and is free to be
  stricter (the in-memory store is); a caller must not depend on it.

  The new clause found one more thing: `fanout.test.ts` built its crash-residue fixture by
  renumbering sequences while keeping the original ids, so the surviving events carried ids
  belonging to sequences that were no longer theirs — a log neither SQL backend would have
  accepted. The fixture now re-stamps both.

- **`(executionId, sequence)` is unique in every backend, and the contract now says so**
  ([#306](https://github.com/chhetrisushil/loom/issues/306)). SQLite and Postgres enforce
  `UNIQUE (execution_id, sequence)`; `InMemoryAsyncEventStore` — which is not a test double but
  `defineConfig`'s `kind: "memory"` backend, the one an app gets when no store plugin is wired —
  accepted both writes and interleaved them into the log. Not covered by fencing: fencing engages
  only once a token has been *acquired*, while sequences are allocated per-process from folded
  state (`ExecutionJournal` seeds from `vm.getState().sequence` and increments locally), so two
  unfenced writers recovering the same execution allocate the same next sequence with neither one
  a zombie. `appendBatch` additionally validates the batch against **itself** — two envelopes
  claiming one slot conflict only with each other, so a check against stored rows alone admits the
  pair.

  All three backends now reject with a shared `DuplicateSequenceError`, so a caller need not know
  which store it is talking to (or match driver text) to recognise a lost sequence race. The
  mapping is narrowed by constraint, since both tables also key `id` and a re-used envelope id is
  a different bug.

  The gap was never a missing suite — `runEventStoreConformance` exists (ADR 0033) and all three
  stores already ran it. It was a missing **clause**: the portable contract said nothing about
  uniqueness, so a backend could omit the check and still conform. Three cases added there, which
  is what makes every backend (including a third-party one) agree. Two pre-existing tests named
  "rejects duplicate (executionId, sequence)" were rewritten: both built their two envelopes with
  the same derived id, so they collided on the id primary key and never reached the constraint
  they were named for — `.rejects.toThrow()` could not tell the difference.

- **The resume ingress gate: a caller-supplied `eventType` no longer writes kernel state, and a
  resume must name the gate it answers** ([#304](https://github.com/chhetrisushil/loom/issues/304),
  [#305](https://github.com/chhetrisushil/loom/issues/305)). `eventType` travels from an ingress
  adapter — A2A `provideInput` and the wire-ABI `execution.resume` both forward a network-supplied
  `ResumeEvent` — into the log verbatim, and the fold dispatches by NAME. A resume typed
  `STEP_COMPLETED` therefore forged a step outcome that the completed short-circuit served
  *without running the effect*; `EXECUTION_MIGRATED` rewrote the K11 code pin and `_input` (and
  could wedge an execution permanently); `APPROVAL_GRANTED` wrote the K12.2 evidence the
  authenticator exists to produce, while the authenticator was rejecting the honest attempt.
  Separately, `suspendedOn.on` was folded and read by nothing, so any name resumed any gate —
  which also skipped the ADR 0077 `resumeSchemas` lookup, since that keys off the caller's event
  type: a declared shape gate was evaded by renaming the event. And `resume()` refused only a
  *cancelled* execution, so a completed one was still writable.

  `resume()` now refuses, before anything is appended, an event type in the K5-governed
  `knownEventTypes()` set, an execution that is not `suspended`, and an event type that is not the
  parked gate. Refusal is **fold-identical for every legitimate log** (G2): a non-kernel event type
  already folded to a no-op. `TIMER_FIRED` remains allowed as the kernel's own wake, and a *timed*
  suspend is wakeable by it whatever its gate is called; `EXECUTION_RECOVERED` remains the
  dispatcher's re-drive of a crashed execution and is now refused on a parked one. `resumeAs`
  enforces the kernel-namespace rule only — the recorded gate belongs to the code being migrated
  away from. New `ResumeRefusedError` carries a machine-readable `reason`; `@loom/orchestration`
  retries the one transient reason (`not-suspended`, a parent whose suspend is not yet readable on
  an async store) instead of matching message text. `KERNEL_ABI`/`EVENT_SCHEMA` unchanged.

  **Behavioural tightening, not a pure fix:** an app resuming with a name that does not match its
  `suspend({ on })` was succeeding by accident and will now be refused.

### Added

- **The verify tier stops needing hand-plumbed source, and gains a front door.** The compiler
  transform now emits all three per-flow source analyses into `loom-manifest.json` —
  `loopIdentity` ([ADR 0061](docs/adr/0061-step-identity-interpreter-guardrails.md)),
  `nonDeterministic`, and `runnerReach` ([ADR 0086](docs/adr/0086-runner-body-reach-analysis.md)) —
  and `loom verify` auto-injects them from a discovered manifest, so `determinism`,
  `capability-compat`, `effect-class` and `suspension-safety` are on whenever you build with the
  Loom compiler rather than requiring a developer to feed their own runner source to a linter.
  New **`loom doctor`** runs every pre-flight check whose input it can discover and **names the
  ones it skipped and why** — "all checks passed" and "passed, but N check(s) could not run —
  coverage is partial" are deliberately different strings. Whole-module analysis skips memoized
  `handler$` bodies (`{ skipMemoized: true }`): a handler's result is served from the log on
  replay, so non-determinism inside one is safe by construction.
- **Runner-body reach analysis, and two `suspension-safety` checks it proved wrong**
  ([ADR 0086](docs/adr/0086-runner-body-reach-analysis.md)). `capability-compat`, `effect-class`
  and `suspension-safety` previously defined "what a flow reaches" as its *declared* steps, so a
  step invoked through `ctx.run` was invisible and `FlowSpec.suspends` had no producer at all.
  `analyzeRunnerReach` resolves `ctx.run` targets by shape and **reports what it could not
  resolve** as a `warn` on each rule. Populating the input showed the blanket `correlationKey`
  error was wrong (`resume` routes by `executionId`) — removed — and that the `wakeAt` check must
  be conditional on a wired `TimerStore`. `KERNEL_ABI`/`EVENT_SCHEMA` unchanged.
- **The integrity axis: untrusted content as a value, refused at the prompt boundary**
  ([ADR 0085](docs/adr/0085-untrusted-content-integrity-axis.md)). `tainted()`/`unwrapTainted()`
  in `@loom/classify` wrap third-party bytes in plain JSON that survives the log verbatim, so a
  replay hands back a value that is *still* tainted. `@loom/llm`'s `guardRequest` runs inside
  every `createLlmEffect` and throws `UntrustedContentError` if tainted content reaches a system
  message, an assistant turn, or a tool name/description; in a `user` message it is fenced as
  `<untrusted-input origin="…">`. Two opt-in producers ship: `registerMcpInvoke(…, {
  taintResults: true })` and `new A2APeerClient({ …, taintResults: true })`.
- **Effect classes — a static ceiling beside K2's runtime floor**
  ([ADR 0084](docs/adr/0084-effect-classes-static-ceiling-k2-floor.md)). An eighth `@loom/verify`
  rule: a flow may not reach an effect whose declared class exceeds its own, composed
  conservatively as the max over everything reachable. The class *vocabulary* is app-supplied
  (`checks: { verify: { effectClasses } }`) — loom checks the ordering it is given rather than
  defining one. A **granted** capability can still bust the class, and K2 will not stop it; the
  finding says so.
- **`@loom/learning` — the substrate for continuous learning, not the learner**
  (ADRs [0078](docs/adr/0078-exploration-in-the-routing-seam.md)–[0080](docs/adr/0080-learning-substrate.md)).
  `context` and `policy` (including `propensity`) now ride `DECISION_RECORDED`
  (**EVENT_SCHEMA 1.18.0**; `KERNEL_ABI` untouched), which is what makes off-policy evaluation
  possible at all — propensity cannot be reconstructed after the fact. Ships trajectory
  extraction, SNIPS evaluation with unit-level ESS and a cluster-robust estimate for pooling
  across units, a promotion gate, the third-party `Policy` SPI (the one seam consumed from flow
  code rather than `defineConfig`), and `loom learn report` / `loom learn eval`. The router's
  greedy collapse onto one lucky arm is fixed with `ucb1`/`epsilonGreedy`. Pooled reports never
  name a unit — asserted by an invariant test that injects a leak.
- **Storage scale-out as composable decorators** (ADRs
  [0074](docs/adr/0074-storage-scale-out-decorators.md)–[0075](docs/adr/0075-shard-rebalancing.md))
  — sharding, batching and rebalancing (virtual buckets, lazy drain, no coordinator) layered over
  any `EventStore` rather than built into one backend. `EVENT_STORE_SPI_VERSION` → 1.3.0.
  Measured ceilings and the method are written up in [`docs/scaling.md`](docs/scaling.md).
- **Two boundaries that looked enforced and were not.** Array crossings in classification paths
  now expand late and walk once ([ADR 0076](docs/adr/0076-wildcard-classification-paths.md)),
  and resume payloads get per-gate contracts enforced **before** the append —
  `flow$({ resumeSchemas })` plus a generic `ctx.suspend<T>`
  ([ADR 0077](docs/adr/0077-typed-resume-payloads.md), `ResumePayloadValidationError`).
- **`@loom/replay-inspector` — read-only replay** ([ADR 0071](docs/adr/0071-read-only-replay-inspector.md),
  IX series): inspect an execution's replay without a live runtime, bounded by an explicit budget
  (`InspectorBudgetError`).
- **MCP Apps (SEP-1865) placement** ([ADR 0072](docs/adr/0072-mcp-apps-ui-extension-placement.md)):
  ingress fidelity plus `createMcpServer`, and `ui://` egress as one static, content-pinned
  surface-host template in `@loom/plugin-mcp-app` (`TemplateDriftError`). The **host** role is
  where a third party belongs, not a reason for loom to build one.
- **Effect mode — `journaled` vs `ambient`** ([ADR 0073](docs/adr/0073-effect-mode-journaled-vs-ambient.md)):
  a declaration plus a boundary check (`EffectModeViolationError`) that keeps user-driven
  enrichment reads out of the durable log.
- **The second-consumer rule** ([ADR 0083](docs/adr/0083-second-consumer-rule.md)) — before a
  workload-derived requirement becomes a first-party package, verify rule, seam, or exported
  vocabulary, name a second unrelated consumer. Recorded because this repo had a strong antibody
  against kernel growth and none against first-party surface growth.
- **Two kernel promotions refused, with evidence gates recorded rather than scheduled**:
  long-lived suspensions need a benchmark, not a promotion
  ([ADR 0081](docs/adr/0081-long-lived-suspensions-no-promotion.md)), and substitutive replay is
  deferred until branch-from-prefix is eliminated
  ([ADR 0082](docs/adr/0082-substitutive-replay-deferred.md)).

- **A2UI `callFunction` (bidirectional RPC) in `@loom/plugin-a2ui`.** The A2UI adapter now covers the
  agent→client `callFunction` leg (the agent invokes a named catalog function; the client answers with a
  `functionResponse`), promoting the surface deferred in ADR 0069. Two composition grains on
  transport-agnostic primitives: **grain A** — a read via a `ctx.suspend` gate
  (`bridge.callFunction` → `ingestFunctionResponse` → `runtime.resume`); **grain B** — a side-effecting
  call via a delegated effect (`registerA2UICallFunction`, `idempotent: false` so a crash mid-call parks at
  `EFFECT_INDOUBT`). Determinism rests on **result-as-recorded-fact + a deterministic, call-site-unique
  `callId`** — no client-side effect runtime, no new event types (`EVENT_SCHEMA`/`KERNEL_ABI` unchanged).
  Inbound replies are correlation-checked (`ingestFunctionResponse(msg, expectedCallId)` and an effect-side
  `callId`/`surfaceId` match), and `registerA2UICallFunction` accepts a `requestTimeoutMs`. New
  `examples/a2ui-callfunction` demonstrates both grains + a crash→in-doubt recovery. See
  [ADR 0070](docs/adr/0070-a2ui-callfunction-bidirectional-rpc.md).
- **`loom appgen` — natural-language → Loom app.** New `@loom/cli` subcommand that turns a
  natural-language intent into a Loom app following the **folder convention** (the same shape
  `create-loom-app` / `loom new` / `loom gen` produce), wiring the pure `@loom/appgen` library
  (`parseIntent` → `generateProject` / `generateFlows`) into the CLI. Output is plain, static,
  inspectable TypeScript with `TODO` handlers; parsing and code generation are deterministic and
  offline (no model call at generate time, none in the output).
  - **Adapts to the target `dir` (the project root, default `.`):** a new/empty dir gets a full
    runnable project (`package.json`, `tsconfig.json`, `app/config.ts` with `defineConfig({
    flowModules })`, `app/main.ts`, `app/loom.gen.ts`, and one `app/flows/<id>/flow.ts` per
    capability) so `pnpm install && pnpm start` works out of the box; an existing Loom app gets
    just the `app/flows/<id>/flow.ts` files, then `app/loom.gen.ts` is regenerated from the
    filesystem (the `loom gen` step) so pre-existing flows stay wired.
  - Reuses `@loom/scaffold` (`appFiles` / `generateRegistration`) rather than hand-rolling, so
    appgen output now matches every other generator. Flows export a `RegisteredFlow` (the older
    `capability$` / `CapabilityCatalog` composition root is gone). The one value-add over
    `loom new` is the NL-derived flow body (reasoning ladder, approval suspend gate, UI surface).
  - Intent is supplied as a quoted positional string or via `--from <file>`.
  - Writes each file directly when the target path is free; on a collision it prompts
    interactively per file — `[r]ename / [s]kip / [o]verwrite` — backed by a stdin line-queue
    reader that works for both TTYs and piped input.
  - `cmdAppgen` is exported from `@loom/cli` for programmatic use, with an injectable IO seam.
  - Docs: new section in [`docs/usage-cli.md`](docs/usage-cli.md) and the CLI overview in
    [`docs/user-guide.md`](docs/user-guide.md).

- **`loom appgen` — brownfield-aware, four-stage pipeline (foundation for AI-driven appgen).**
  `appgen` now *scans the existing app* and applies a **delta** rather than only scaffolding from
  scratch. Four stages, all deterministic and offline: **scan** (`scanApp(dir) → AppModel`,
  a compact TS-AST summary of flows/steps/gates — never raw file dumps), **plan**
  (`planChangesDeterministic(intent, appModel) → ChangeSpec`, tagging each capability/step
  `create` / `extend` / `modify`), **apply** (`applyChanges` → creates via the existing templates,
  surgical formatting-preserving edits to existing flows), and **validate** (in-process `tsc`).
  The plan stage is the single seam where NL understanding lives and it emits a structured
  `ChangeSpec` — a local model can be swapped in here later without touching codegen.
  - **Plan → diff → confirm DX.** `--dry-run` renders a terraform-style plan (creates / edits /
    skips) and writes nothing; omit it to apply. `--check` typechecks the app after applying.
  - **Safety gate.** appgen only overwrites a handler body that still hashes to the generated
    `TODO` stub; any human-edited handler is **insert-only**, never clobbered (`FlowEditor`,
    content-hash gate). Brownfield edits add step consts, register them in the flow's `steps: []`
    array, and insert approval / UI gates into the runner while preserving surrounding code.
  - **Replayable spec lockfile.** Each apply records the accepted `ChangeSpec` to
    `.loom/appgen/<timestamp>.spec.json`; `loom appgen --from-spec <file>` reproduces it
    byte-for-byte with no model — the appgen equivalent of a golden log.
  - `@loom/appgen` stays zero-dependency and offline (only `typescript` promoted to a runtime
    dep for the AST scan/edit); the framework kernel is untouched. New exports: `scanApp`,
    `planChangesDeterministic`, `applyChanges`, `FlowEditor`, `typecheck`, lockfile helpers.

- **`@loom/appgen-model` — optional local-Gemma planner (truly AI-driven appgen).** A new,
  **optional** package that swaps a small on-device Gemma model into appgen's single NL stage.
  `loom appgen --model <gguf>` plans the `ChangeSpec` with the model instead of the grammar
  parser — real language understanding, no token cost, minimal footprint. Everything downstream
  is unchanged, because the model still emits only a `ChangeSpec`.
  - **Grammar-constrained JSON.** Output is constrained to the `ChangeSpec` JSON schema via
    node-llama-cpp, so a compact model reliably produces valid, on-schema plans.
  - **Reasoning-ladder-on-itself.** Planning runs through `@loom/reasoning`'s cheap-first
    elevation ladder with a *validator* confidence signal ("does it parse into a usable
    ChangeSpec?"); a weak tier that emits junk elevates to a stronger one, and each elevation is
    logged (P9) and recorded in the spec lockfile. Recommended tiers: Gemma **E4B** 4-bit QAT
    default (~5 GB), E2B floor (~4 GB), 12B ceiling (~8 GB), selectable via `--model-tier` /
    `--model-big`.
  - **Deterministic fallback / footprint discipline.** Falls back to the deterministic parser
    when the model or `node-llama-cpp` is unavailable or every tier fails (same as `--offline`);
    loads/disposes the model per invocation (transient, not resident); prompts carry only the
    compact scanned `AppModel` summary, never raw file contents.
  - `node-llama-cpp` is an `optionalDependency`, lazily imported; `@loom/cli` loads
    `@loom/appgen-model` only when `--model` is passed, so neither the framework nor default CLI
    users carry the native runtime. Kernel and existing packages untouched.
  - **Verified end-to-end against a real Gemma GGUF (node-llama-cpp 3.19, Metal), which fixed four
    bugs that previously made `--model` silently fall back every time:** (1) `tsc` under
    `module: CommonJS` down-levelled dynamic `import()` to `require()`, which cannot load the
    ESM-only, top-level-await node-llama-cpp (`ERR_REQUIRE_ASYNC_MODULE`) — now a genuine dynamic
    import is preserved via `new Function` in both `GemmaProvider` and the CLI; (2) the v3 grammar is
    built with `llama.createGrammarForJsonSchema(schema)`, not the `LlamaJsonSchemaGrammar`
    constructor; (3) the CLI now resolves the optional `@loom/appgen-model` peer **from the target
    project dir** (`pnpm add @loom/appgen-model node-llama-cpp` in your app), not from the CLI itself;
    (4) the JSON-schema `minItems` constraint crashed node-llama-cpp's native sampler and was removed
    (an empty plan is rejected by the ladder validator instead). Generation is now bounded
    (`maxTokens` 512, `contextSize` 2048) for footprint and native stability. The package README
    documents environment requirements: a Node 20/22 LTS (bleeding-edge Node majors show intermittent
    native segfaults) and enough RAM for the tier (the E4B default is ~5 GB; a 2B model that fits 8 GB
    is often too weak and degrades to the deterministic parser).

- **`loom appgen` completeness — delete/grant ops, runner wiring, self-repair, real diffs, confirm.**
  Closes the remaining gaps against the requirement (captured in
  [`docs/requirements/2026-07-12-ai-native-brownfield-appgen.md`](docs/requirements/2026-07-12-ai-native-brownfield-appgen.md)
  + evaluation, and [ADR 0042](docs/adr/0042-ai-native-brownfield-appgen.md)):
  - **`delete` op.** New grammar `delete <name>` / `delete step <s> from <flow>`; deletes generated
    flow files and removes steps (const + `steps: []` entry + runner call). Refuses to delete a flow or
    step that carries hand-written code. Tracked in `FilePlan.deletes`, honored by `--dry-run`.
  - **New steps are wired into the runner.** `FlowEditor.addStep` now inserts a `ctx.run(<step>, …)`
    call before the runner's `return`, not just a "wire it yourself" note.
  - **`wireGrants` → `app/config.ts`.** New grammar `grant <tool>[, <tool>] to <cap>` (and a model
    schema field) insert a `GrantTable` authorizer (and its import) into `defineConfig` via a
    formatting-preserving `ConfigEditor`; it declines to guess a merge if an authorizer already exists.
  - **Model self-repair loop.** `@loom/appgen-model` now runs `validateChangeSpec` (does the plan
    reference real flows/steps with the right ops?) after the ladder and re-prompts the model with the
    exact issues (bounded retries) before falling back to the deterministic parser.
  - **Real `--dry-run` diffs.** Edits render as a dependency-free unified line diff instead of a summary.
  - **Interactive confirm.** On a TTY (and without `--yes`), appgen shows the plan and asks before
    writing; the CLI surfaces the planner (deterministic vs model) and any ladder elevations.
  - Docs: `docs/usage-cli.md` rewritten for the full surface; a brownfield walkthrough at
    `examples/appgen-brownfield/README.md`. `@loom/appgen` stays offline; kernel untouched.
  - **Planner provenance surfaced + loud model fallback.** The plan header and `--dry-run` output are
    tagged `[deterministic]` / `[model]` (with any `[model, elevated e4b→12b]` ladder steps), matching
    the spec lockfile's `changeSpec.planner`. When `--model` is passed but the model can't produce a
    usable plan, `appgen` now prints a **loud warning** and falls back — so a silent, wrong-looking
    generation no longer masquerades as a model result. Also fixed `--model` failing in-repo with
    "Cannot find package '@loom/appgen-model'": the CLI now resolves the optional peer as a sibling of
    `@loom/appgen` (works in `packages/*` and `node_modules/@loom/*` alike).
