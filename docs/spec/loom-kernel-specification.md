# Loom Kernel Specification

> **Status:** Normative. This document defines **what the Loom kernel guarantees** — the stable
> contract that implementers, SPI/adapter authors, and downstream frameworks (GenUI, AetherOS) may
> rely on. The [ADRs](../adr/) explain **why** each decision was made; this is the **what**.
> **Version:** tracks the kernel manifest (`loom kernel-manifest`), the machine-readable projection
> of this document. Every guarantee here is anchored to a versioned constant + a conformance test.
> **Conventions:** the key words **MUST / MUST NOT / SHOULD / MAY** are used per RFC 2119.

## 0. Scope

Loom is a **durable execution kernel**: a minimal, event-sourced core that runs long-lived,
suspendable, replay-deterministic executions for intelligent software, and exposes pluggable seams
(storage, compute, effects, policy) around it. This spec covers the kernel and its SPIs. It does
**not** cover application concerns (UI/blueprints → GenUI) or autonomous-cloud policy (→ AetherOS).

## 1. Principles & invariants (normative)

The kernel is bound by these at all times. Full definitions: [architecture.md](../architecture.md)
(P1–P8) and [loom-2.0/00-overview.md](../loom-2.0/00-overview.md) (P9/P10). The two most
load-bearing, plus the global guardrails that gate every additive capability:

- **P2 — Deterministic replay.** Folding a stored event log MUST reconstruct identical state.
  `state = fold(events)` is a pure function; the fold MUST NOT read wall-clock, randomness, or any
  ambient input. (Anchor: `packages/replay-vm/src/foldEvents.ts`.)
- **P9 — Non-determinism only when logged.** A non-deterministic choice (model routing, sampling,
  optimization) MUST be recorded as a `DECISION_RECORDED` event and served from the log on replay,
  never re-computed. (Anchor: `ctx.decide` in `packages/workflow-runtime/src/WorkflowContext.ts`.)
- **P10 — Minimal kernel.** The kernel carries **mechanism**; **policy** (which hosts, tenants,
  budgets, models) lives above it. Enforcement rings and optional runtimes are opt-in.
- **G1 (guardrail).** Every additive capability MUST preserve P2 + P9.
- **G2 (guardrail).** Every additive capability MUST be opt-in: **unwired, behaviour is
  byte-identical** to the kernel without it (zero overhead when disabled — see §10, and the
  fitness gate in [fitness-functions.md](fitness-functions.md)).

## 2. Execution model

- The unit of execution is an **Execution** — an event-sourced instance of a flow, identified by a
  stable `executionId`. Its folded form is `ExecutionState`
  (`packages/core/src/types/execution.ts`): `{ status, frames, variables, sequence, startedAt,
  updatedAt }`. Per-task lifecycle lives in `ExecutionFrame`.
- The kernel exposes execution to flow code through the **`ExecutionContext`** syscall surface. The
  authoritative, versioned syscall set is **`KERNEL_SYSCALLS`**
  (`packages/workflow-runtime/src/abi.ts`), version **`KERNEL_ABI_VERSION`**, pinned by
  `abi.test.ts`. The syscalls: `execute`, `run`, `decide`, `parallel`, `suspend`, `sleep`,
  `sleepUntil`, `emit`, `stream`, `ui`.
- `ctx.execute(task, input)` is the generalized durable primitive; on replay a completed task is
  **served from the log** and its effect MUST NOT re-run. `ctx.run(step, input)` is the step-shaped
  alias. Task kinds (step/llm/agent/tool/ui/…) resolve through the effect boundary by `toolId`; the
  wire events stay `STEP_*` so existing logs replay byte-identically.
- **Compatibility (K1):** adding a syscall is a MINOR bump (`since` recorded per syscall); removing
  or repurposing one is a MAJOR break. `abi.test.ts` fails on undocumented drift.

## 3. Replay semantics

- **Resume = re-run, served from the log.** Resuming an execution re-executes its flow runner; each
  `ctx.execute`/`run`/`decide`/suspend short-circuits from the recorded log, so completed work is
  never repeated and the orchestration between recorded points re-runs deterministically.
- **Flow-level emits are served from the log only when the log proves them (ADR 0102).** `emit`,
  `stream` and `ui` append ONCE per execution.
  - **Identity.** `d = fnv1a64(segment | canonical JSON of [eventType, payload])`. The segment is
    the number of gate passthroughs consumed at the emit. The canonical form is the persisted JSON
    form with object keys sorted.
  - **Stamp and fold.** A stamped emit carries `metadata.flowEmit = d`. The fold counts stamped
    emits per `d` in `variables._flowEmits`.
  - **Serving.** On a re-run, the *n*-th emit of `d` MUST NOT be appended iff the log holds more
    than *n* stamped emits of `d` AND no step or decision of the current segment has been
    executed live in this run (i.e. not served from the log). Otherwise it MUST be appended.
  - **Stamping.** An appended emit MUST be stamped only when all of these hold:
    - it exceeds the logged count;
    - none of the run's own effects or deciders is executing (an effect counts until it
      settles);
    - no step or decider earlier in the run ended in an outcome a re-run does not serve (an
      untyped failure, a timeout, a cancellation, an in-doubt park, a throwing decider).
  - **Never timing.** Skip decisions MUST NOT depend on timing or interleaving.
  - **Residual.** An emit can be served in place of a new one only if a code change moves
    identical content within a segment whose syscalls are all served, if flow code violates the
    determinism contract (ADR 0057/0061), or on a digest collision.
  - **Unmatchable payloads.** A payload with no JSON form is appended unstamped.
  - **Kernel facts** (`STEP_*`, `DECISION_RECORDED`, `EFFECT_INDOUBT`, `EXECUTION_*`) and
    `EffectContext.emit` are never stamped.
  - **Legacy logs.** An unstamped (pre-1.19.0) log counts nothing, so its pre-resume emits are
    appended once more, stamped where eligible.
- The fold is **copy-on-write** and **never mutates in place** a caller-visible state; audit lists
  grow via structural sharing within a single fold pass (`packages/replay-vm/src/eventHandlers.ts`).
- **Snapshots** (`SnapshotStore`, §7) bound the replay tail: `state = fold(snapshot, suffix)` MUST
  equal `fold(events)`. Snapshots are out-of-band (there is no snapshot event in the log).
- Determinism is enforced by golden-log replay (`@loom/eval` `replayAsFixture`/`diffRuns`), the
  wire fold-vectors (`packages/wire-abi/src/wire-abi.test.ts`), and deploy-simulation
  (`@loom/deploy-sim`).

## 4. Event model (K5)

- The event log is the kernel's **on-disk ABI**. The set of event types the fold understands is
  **`knownEventTypes()`** at version **`EVENT_SCHEMA_VERSION`**
  (`packages/replay-vm/src/eventHandlers.ts`), pinned by `eventSchema.test.ts`. The catalogue with
  payload shapes is [10-event-schema-reference.md](../loom-2.0/10-event-schema-reference.md).
- Every event is an **`EventEnvelope`** (`packages/core/src/types/event.ts`):
  `{ id, workflowId, executionId, eventType, sequence, timestamp, payload, metadata? }`.
- **Fold contract:** an unknown event type is **inert** (ignored); a handler MUST be a pure
  `(state, event) => state`; a `__proto__` container key MUST be rejected (fold hardening).
  Execution `status` MUST be moved only by execution-level events (`EXECUTION_STARTED`,
  `_SUSPENDED`, `_RESUMED`, `_COMPLETED`, `_FAILED`, `_CANCELLED`); a `STEP_*` event folds into
  its frame only. In particular `STEP_FAILED` MUST NOT fail the execution — the flow may catch it
  — and only `EXECUTION_FAILED` does (ADR 0105, EVENT_SCHEMA 1.21.0). A `STEP_FAILED` that lands
  while the execution is `suspended` MUST set `variables._failedWhileParked`; whatever ends the
  park (`EXECUTION_SUSPENDED`, `EXECUTION_RESUMED`, `EXECUTION_COMPLETED` / `_FAILED` /
  `_CANCELLED`) MUST remove it; and a `null` `EXECUTION_RESUMED` while it is set MUST be
  status-only (fail-closed). A caller's `null` gate answer in that position MUST be refused at
  ingress (`ResumeRefusedError`, `null-answer-after-parked-failure`), nothing appended. A snapshot
  folded before 1.21.0 MUST be read through `normalizeSnapshotState`. For every log and every
  sequence k, folding the snapshot at k plus the tail MUST equal folding the whole log. For a
  snapshot written by a pre-1.21.0 fold this holds except for two shapes `normalizeSnapshotState`
  cannot tell from a genuine failure (ADR 0105 D4): an `EXECUTION_FAILED` without `error` (never
  kernel-written), and an execution that genuinely failed, was re-opened by `resumeAs` (which
  keeps the stale `_error`) and then caught a step failure. The remedy for both is to delete that
  execution's snapshots, which makes the log authoritative.
- **Compatibility (K5):** adding an event type or an **optional** payload field is a MINOR bump
  (folds treat absence as legacy); removing/renaming a type is a MAJOR break. Both the version and
  the pinned type set MUST change together. The current version is **1.21.0** — after the
  K10.1/T3 audit facts (1.13.0/1.14.0), the perpetual-agents series added two additive MINORs
  with **no new event kinds**: 1.15.0 extends `EXECUTION_MIGRATED` with an optional
  `migratedInput` payload field (K11.5 contract-versioned state migration — the fold replaces
  `variables._input` with the recorded transformed value, ADR 0056), and 1.16.0 folds the
  ordered `variables._resumePayloads` list from existing `EXECUTION_RESUMED` events (the
  multi-gate suspend fix, ADR 0057). The GenUI/DE series added 1.17.0 (ADR 0060, again no new
  event kind): optional `channel`/`payload` fields on `STEP_FAILED` — a **typed failure** on a
  contract-declared error channel, folded into the frame as `errorChannel`/`errorPayload`.
  The learning substrate added 1.18.0 (ADR 0079, no new event kind): optional `context` and
  `policy` fields on `DECISION_RECORDED` — the observation a policy saw and the policy that
  saw it (with the propensity that makes unbiased off-policy evaluation possible), folded
  verbatim into `_decisions` and never read back by `getDecision`.
  A kernel replay fix added 1.19.0 (ADR 0102, no new event kind, no payload change): the fold
  step `variables._flowEmits`: the count of stamped flow-level emits per (gate segment, content)
  digest, keyed
  on the envelope stamp `metadata.flowEmit` for ANY event type, so flow-level `emit`/`stream`/`ui`
  append once per execution (§3).
  ADR 0104 added 1.20.0 (no new event kind, no payload field): an `EXECUTION_RESUMED` whose
  payload is `null` and which answers no suspend point — the execution was not parked, or was
  parked in doubt — re-opens the execution WITHOUT adding a gate passthrough.
  ADR 0105 added 1.21.0 (no new event kind, no payload field): `STEP_FAILED` no longer moves the
  execution status — a log that ends after a caught step failure now folds `running` (it was
  `failed`), and a parallel sibling's `STEP_FAILED` after the flow parked leaves it `suspended`
  with the new reserved key `_failedWhileParked`, under which a `null` resume stays status-only
  exactly as 1.20.0 folded it. Every gate passthrough is therefore unchanged from 1.20.0; the
  status and the new key are what differ.
  Logs that never migrate state, resume twice, fail typed, record a policy, stamp a flow emit, or
  resume `null` into an unparked or in-doubt execution, or hold a `STEP_FAILED`
  that no status-setting event follows, replay byte-identically.

### 4.1 Typed failure channels (ADR 0060)

- A contract MAY declare `errors: { <channel>: schema }` (step-level wins; the registered
  effect's map is the fallback). A `TypedFailure` thrown on a **declared** channel is recorded
  as `STEP_FAILED { channel, payload }` with the payload validated against the channel schema
  **before** the append, and capped at 16 KiB (over-cap, invalid-payload, and
  undeclared-channel failures all degrade loudly to the legacy untyped `STEP_FAILED`).
- **Replay substitution:** a frame with `errorChannel` is served at the execute seam exactly as
  a completed frame is — the `TypedFailure` is rethrown with the recorded payload, the effect
  (and its middleware) is never re-invoked, and the flow deterministically re-takes the same
  catch branch. This applies to live re-invocation of the same step id too (the ADR 0061
  identity rule: a deliberate retry mints a new id). Untyped failures keep the legacy
  at-least-once re-execution.
- There is **no `ctx.fail` syscall** — `TypedFailure` is a userspace throw (`fail(channel,
  payload)` in `@loom/core`); `KERNEL_ABI` is unchanged.

## 5. Suspension semantics

- `ctx.suspend(config)` durably parks an execution; `config` is `SuspendConfig`
  (`packages/workflow-runtime/src/types.ts`): `{ on, timeout?, correlationKey?, wakeAt? }`.
- Resume routing is by **`executionId`**: `WorkflowRuntime.resume(executionId, event)` addresses the
  parked execution directly, and nothing in the runtime matches on `correlationKey`. A
  `correlationKey` is OPTIONAL metadata for an external dispatcher that holds a business key instead
  of an execution id. *(A normative "MUST carry a `correlationKey`" here, and the `@loom/verify` rule
  that enforced it, were both wrong; ADR 0086 removed the rule once the input that would have made it
  fire finally existed.)*
- A **timed** suspend (`sleep`/`sleepUntil`/`suspend({timeout})`) MUST record a durable `wakeAt`,
  fired as a `TIMER_FIRED` resume that survives restart (T1). The scheduled time is in the log —
  wall-clock drift never enters the fold. When a `TimerStore` is wired the runtime DERIVES `wakeAt`
  from a suspend's `timeout`, so `suspend({ on, timeout })` satisfies this; without one, the timed
  suspend is silently never woken, which is what `suspension-safety` reports.
- Resume is **ingress**-gated, always and un-opt-outably (#304/#305). `eventType` is caller-supplied
  — A2A `provideInput` and the wire-ABI `execution.resume` both hand a network-supplied
  `ResumeEvent` straight to `resume()` — and the log folds by NAME, so this gate decides WHICH event
  may be delivered and to an execution in WHICH state:
  - A resume event type MUST NOT be a kernel event type (`knownEventTypes()`, the K5-governed set).
    A caller-supplied `STEP_COMPLETED` forges a step outcome the completed short-circuit then serves
    without running the effect; `EXECUTION_MIGRATED` rewrites the K11 code pin and `_input`;
    `APPROVAL_GRANTED` forges the very evidence the authenticator exists to produce. `TIMER_FIRED`
    is the sole exception — the kernel raises it itself.
  - The execution MUST be `suspended`, and the event type MUST be the gate it is parked on
    (`suspendedOn.on`). A **timed** suspend is additionally wakeable by `TIMER_FIRED`, since
    `suspend({ on, timeout })` means either wake; that allowance is keyed on the recorded `wakeAt`,
    so an untimed gate is not wakeable by a synthetic timer event.
  - `EXECUTION_RECOVERED` is the one non-gate resume: a dispatcher re-driving a CRASHED execution,
    so it addresses a `running`/`pending` one and MUST be refused on a parked or terminal execution.
  - Every `_resumePayloads` entry MUST answer exactly one suspend point: a `ctx.suspend`, or a
    `kind: "human"` step, which consumes its entry in order with them (live and on replay past
    the completed step). `ctx.suspend` serves the list positionally, so an entry that answered
    nothing is served to the flow's NEXT gate as its approval (ADR 0104). Hence a re-drive of a
    crashed execution (`EXECUTION_RECOVERED`, `resumeAs` onto one) records no `EXECUTION_RESUMED`;
    `resumeAs` onto a terminal execution records `EXECUTION_RESUMED` with a `null` payload
    (status only, 1.20.0); and an in-doubt verdict (K9.3) is recorded as a kernel
    `DECISION_RECORDED` keyed by the step and the attempt it answers, beside a `null`
    `EXECUTION_RESUMED`. A resume at an in-doubt park that is not a verdict for the parked step
    MUST be refused (`ResumePayloadValidationError`) with nothing appended. Logs written before
    this rule MUST be replayed as written; a runtime SHOULD warn about the entries in them that
    answered no suspend point, saying whether each is already spent.
  - A resume that arrives before the execution parks (it is still `running`) is refused
    (`ResumeRefusedError`, `not-suspended`) with nothing appended; the caller retries once the
    execution is parked. Recording it would make it an answer to whatever gate came next.
  - All of these MUST refuse with nothing appended. Refusal is fold-identical for every legitimate
    log (G2): a non-kernel event type already folds to a no-op, so the resume-typed event never
    contributed to state unless it collided with a kernel name.
  - `resumeAs` onto a crashed or terminal execution enforces the kernel-namespace rule only:
    nothing is parked, and migrating a crashed execution onto fixed code is the documented exit
    from a `FlowCodeMismatchError`. Onto an execution PARKED at a gate it MUST enforce every rule
    `resume` does — the gate name (the RECORDED gate), the gate's `resumeSchemas` entry in the
    target flow, the `ResumeAuthenticator` and the execution authorizer — since its payload is
    that gate's answer (ADR 0104).
  - Userspace emits (`ctx.emit`/`stream`/`ui` and `EffectContext.emit`) MUST refuse every kernel
    event type except `RESOURCE_METERED`, `QUOTA_EXCEEDED`, `SAFETY_BLOCKED`, `EGRESS_DENIED`,
    `EFFECT_DENIED`, `OUTCOME_RECORDED` and `DECISION_RECORDED` (ADR 0104); otherwise flow code
    forges kernel state the fold trusts. The allowed types still fold, so they are validated:
    `RESOURCE_METERED` fields MUST be finite, non-negative and under a sanity ceiling;
    `QUOTA_EXCEEDED.reason` MUST be a bounded string; an EFFECT-written `DECISION_RECORDED` id MUST
    be rewritten into its step's namespace (`effect:<stepId>#<attempt>:<id>`) so it never reaches
    the flow's `ctx.decide`, and no userspace `DECISION_RECORDED` may change an already-recorded
    choice. An isolated tool's relay MUST forward application event types only.
  - Decision ids beginning `__loom_` are reserved for the kernel's own records (an in-doubt
    verdict, a `discardLegacyAnswers` override): `ctx.decide` and userspace `DECISION_RECORDED`
    emits MUST refuse them, checking the id that is folded (the payload is copied to plain data
    first). A verdict decision MUST only be honoured beside the kernel's `EFFECT_INDOUBT` fact for
    the same step and attempt.
  - A human step's park MUST record `condition.stepId` (kernel-only; `ctx.suspend` strips a
    caller-supplied one). A pre-0104 log in which an open human step's answer cannot be told apart
    from another entry (an unattributed park after an answer, or an unspent entry that answered no
    gate before its first start) MUST be refused (`ResumeRefusedError`, `ambiguous-legacy-answers`)
    rather than guessed, unless the operator's resume event carries `discardLegacyAnswers
    { stepId, count }` AND the `ResumeAuthenticator` verifies that event (never on
    `EXECUTION_RECOVERED`/`TIMER_FIRED`).
- Resume MAY be authority-gated: a `ResumeAuthenticator` verdict is recorded as `APPROVAL_GRANTED`
  (K12); a rejected resume never reaches the log. That gate authenticates **who** may resume.
- Resume MAY additionally be **shape**-gated: a flow MAY declare `resumeSchemas` (`on` → schema,
  ADR 0077). When an entry exists for the resume's event type the payload MUST be parsed BEFORE
  anything is appended, the PARSED value (defaults/transforms applied) MUST be what is recorded,
  and a failing parse MUST refuse with nothing appended — leaving the execution suspended and
  resumable. Absent map or absent entry = unchanged behaviour (G2). Shape is checked AFTER
  identity, so an authenticator sees the exact event the caller signed; the ingress gate sits
  between them, for the same reason — its gate-mismatch refusal names the gate, which an
  unauthenticated caller has no business learning. `resumeAs` validates against the TARGET flow's
  map. Note the shape gate is keyed on the caller's event type, so it is load-bearing only because
  the ingress gate already requires that type to BE the parked gate: without it a declared schema
  was evaded by renaming the event.
- On replay, resumed gates pass through **in order, each with its own recorded payload** (the
  `_resumePayloads` fold, ADR 0057); a gate beyond the recorded resumes parks as before.
- `resumeAs` (K11.3) MAY carry an operator-supplied state transform (K11.5, ADR 0056): the
  transform's RESULT is recorded on `EXECUTION_MIGRATED` (`migratedInput`), every later
  resume/restore folds the migrated input, and a failing transform refuses the migration with
  nothing appended.

## 6. Placement semantics

- **Placement is a kernel concern; cloud-provider logic is not (P10).** An execution is dispatched
  through the `ExecutionDispatcher` SPI (§7) onto a `WorkerRuntime`. The `ExecutionPackage` carries
  only coordinates (`executionId`, `flowId`, resume hints) — never live code; any worker
  reconstructs state from the shared stores.
- **Resume is migration.** Because workers are stateless and state is durable, re-dispatch to any
  worker resumes from the journal; fencing (K9.4) fences a zombie predecessor; `EXECUTION_MIGRATED`
  records a cross-code migration verdict. A pinned `computeTarget` MUST resolve to a registered
  dispatcher target (checked by `@loom/verify` placement-compat).

## 7. SPI contracts

The pluggable seams. Each has a version constant + a conformance kit that a third-party
implementation runs to prove alignment. Full map: [12-extension-seams.md](../loom-2.0/12-extension-seams.md).

| Seam | Interface | Version constant | Conformance kit |
|---|---|---|---|
| Event log | `EventStore` (`@loom/event-runtime`) | `EVENT_STORE_SPI_VERSION` | `runEventStoreConformance` |
| Snapshots | `SnapshotStore` (`@loom/snapshot-runtime`) | `SNAPSHOT_STORE_SPI_VERSION` | `runSnapshotStoreConformance` |
| Branches | `BranchRegistry` (`@loom/event-runtime`) | `BRANCH_REGISTRY_SPI_VERSION` | `runBranchRegistryConformance` |
| Dispatch | `ExecutionDispatcher` (`@loom/dispatcher`) | `DISPATCHER_SPI_VERSION` | `runExecutionDispatcherConformance` |
| Worker | `WorkerRuntime` (`@loom/worker-runtime`) | — | (staged) |
| Effect / middleware / authority | `Effect` / `EffectMiddleware` / `CapabilityAuthorizer` (`@loom/effect-runtime`) | — | (staged) |

- **Required vs optional:** each interface marks optional methods (e.g. `EventStore.readRange`,
  `acquireFence`, `copyPrefix`, `deleteExecution`, and the paged `listExecutionsPage` — SPI 1.2.0,
  the bounded-memory enumeration maintenance passes prefer). An implementation MAY omit optional
  methods; the conformance kit skips them. A store that omits `acquireFence` performs no fencing
  (single-node).
- **Plugin-tier SPIs** are pinned the same way, without kernel version constants:
  `ContentStore` (incl. the ADR 0059 `putStream` outcome contract), `DurableStateStore`, and
  `ReadModelStore` (incl. query limit/cursor validation) each ship a `run…Conformance` kit in
  `@loom/conformance`.
- **Compatibility:** an SPI version is semver; a MINOR bump adds an optional method, a MAJOR bump
  changes a required-method contract. Kits import from `@loom/conformance`.

## 8. Resource semantics

- Resources are metered per effect as `RESOURCE_METERED` and folded into a fixed-size accumulator
  (`_resources`), read via `EffectContext.resources` (`ResourceSnapshot`). Dimensions
  (`ResourceDimension`): `tokens`, `costUsd`, `ms`, and (ADR 0032) optional `memBytes`, `wallMs`,
  `netBytes`. A dimension is present only where an effect can measure it (no false zeros).
- A `Budget` MAY cap any dimension; exceeding it raises `QUOTA_EXCEEDED` via admission control.
  `ctx.negotiateBudget(dimension, request, opts?)` resolves a bounded grant **through the decision
  seam** (recorded, replay-safe) — advisory only; it never enforces.

## 9. Compatibility guarantees

- The kernel's contract versions are aggregated, machine-readable, in the **kernel manifest**
  (`@loom/spec` `kernelManifest()`; `loom kernel-manifest --json`). It is built by importing the
  real exported constants, so it can never drift from the code.
- **`checkCompatibility(deploymentVersions)`** validates a deployment's declared versions: two
  versions are compatible iff they share a **major** version. `loom compat --abi <v> …` exits
  non-zero on a mismatch (a deployment gate). Loom is a lockstep monorepo today (all `1.x`), so the
  supported set is a single row (see [compatibility-matrix.md](compatibility-matrix.md)); the
  mechanism exists for the day a MAJOR diverges.

## 10. Conformance & continuous enforcement

A third party proves alignment, and the kernel proves it hasn't regressed, via **executable**
checks — not reviewer memory:

- **ABI/schema pins:** `abi.test.ts` (K1), `eventSchema.test.ts` (K5), `wire-abi.test.ts` (T2
  fold-vectors) fail on undocumented drift.
- **SPI conformance kits:** `run<Spi>Conformance` (`@loom/conformance`), run against the
  in-memory + SQLite reference impls.
- **Replay-unchanged:** golden-log replay (`@loom/eval`) + deploy-simulation (`@loom/deploy-sim`).
- **Zero-overhead (G2):** behavioural disabled-path tests + a relative-ratio bench gate
  (`packages/verify/src/g2ratio.test.ts`).
- **Maturity is self-checking:** `@loom/spec` `spec.test.ts` fails if a capability's badge claims
  evidence (a version constant / conformance test / bench) it does not have.

These are enumerated, with their enforcement location, in
[fitness-functions.md](fitness-functions.md), and gated in CI (`pnpm fitness`).

## Appendix — normative anchors

| Guarantee | Anchor |
|---|---|
| Syscall ABI | `packages/workflow-runtime/src/abi.ts` (`KERNEL_ABI_VERSION`, `KERNEL_SYSCALLS`) |
| Event schema | `packages/replay-vm/src/eventHandlers.ts` (`EVENT_SCHEMA_VERSION`, `knownEventTypes`) |
| Fold | `packages/replay-vm/src/foldEvents.ts` |
| Wire ABI | `packages/wire-abi/src/protocol.ts` (`WIRE_ABI_VERSION`) |
| SPIs | `packages/{event-runtime,snapshot-runtime,dispatcher,worker-runtime}/src/…` |
| Suspension | `packages/workflow-runtime/src/types.ts` (`SuspendConfig`) |
| Resources | `packages/effect-runtime/src/types.ts` (`ResourceSnapshot`) |
| Manifest & compat | `packages/spec/src/{manifest,capabilities}.ts` |
