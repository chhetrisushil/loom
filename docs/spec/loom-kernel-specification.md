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
- **Compatibility (K5):** adding an event type or an **optional** payload field is a MINOR bump
  (folds treat absence as legacy); removing/renaming a type is a MAJOR break. Both the version and
  the pinned type set MUST change together.

## 5. Suspension semantics

- `ctx.suspend(config)` durably parks an execution; `config` is `SuspendConfig`
  (`packages/workflow-runtime/src/types.ts`): `{ on, timeout?, correlationKey?, wakeAt? }`.
- A suspension MUST carry a `correlationKey` so its resume event can be routed. A **timed** suspend
  (`sleep`/`sleepUntil`/`suspend({timeout})`) MUST record a durable `wakeAt`, fired as a
  `TIMER_FIRED` resume that survives restart (T1). The scheduled time is in the log — wall-clock
  drift never enters the fold.
- Resume MAY be authority-gated: a `ResumeAuthenticator` verdict is recorded as `APPROVAL_GRANTED`
  (K12); a rejected resume never reaches the log.

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
  `acquireFence`, `copyPrefix`, `deleteExecution`). An implementation MAY omit optional methods; the
  conformance kit skips them. A store that omits `acquireFence` performs no fencing (single-node).
- **Compatibility:** an SPI version is semver; a MINOR bump adds an optional method, a MAJOR bump
  changes a required-method contract. Kits import from `@loom/testing/conformance`.

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
- **SPI conformance kits:** `run<Spi>Conformance` (`@loom/testing/conformance`), run against the
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
