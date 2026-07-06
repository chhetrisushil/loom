# ADR 0001 — Execution Dispatcher + Worker Runtime SPI

- Status: Accepted (Step 1 of 5 — Cloud Run compute provider)
- Date: 2026-07-07

## Context

We want Loom executions to run on pluggable compute (in-process today, Cloud Run
next) without leaking cloud concerns into the core runtime. Before this change,
the dispatch seam lived in example code: `InProcessA2ABus.dispatch()` called
`WorkflowRuntime.start()` / `resume()` directly and drove the suspend→approve→
resume cycle in-process. There was no placement abstraction — nothing decided
*where* an execution runs, only *what* runs.

An earlier proposal placed a Dispatcher "under the Scheduler" and a "Replay VM"
at the bottom of the stack, with a serializable `ExecutionPackage` that would let
a worker "reconstruct execution only from the package." That model does not match
the code:

- `@loom/scheduler` is an ephemeral concurrency utility, not the execution
  driver. The driver is `WorkflowRuntime.start()/resume()`.
- `ReplayVM` is a pure `EventEnvelope[] → ExecutionState` fold with no I/O — not
  an execution sandbox.
- Flow runners, effects, and LLM providers are live JS closures/singletons that
  cannot be serialized. A worker can reconstruct *state* from durable events +
  snapshots, but it must already hold the *code*.

## Decision

Introduce a placement seam between the orchestrator and the runtime:

```
Orchestrator / A2A boundary
        │  ExecutionPackage
   ExecutionDispatcher      decides WHERE; owns allocate / result / retry / (Step 4) timeout
        │
   WorkerRuntime (Platform SPI)   allocate → execute → release
        │
   LocalWorkerRuntime → WorkflowRuntime.start/resume → ReplayVM (fold)
```

New packages:

- `@loom/worker-runtime` — the SPI + transport types. `ExecutionPackage` is the
  immutable, JSON-serializable payload carrying **identity + resume coordinates**
  (`executionId`, `workflowId`, `flowId`, `input?`, `resumeEvent?`, `snapshotId?`,
  `fromSequence?`). It references code by `flowId`; it never contains closures.
  `ExecutionResult` is what a worker returns (and the future `/execute` wire
  shape): outcome, folded state, and highest persisted sequence.
- `@loom/worker-runtime-local` — `LocalWorkerRuntime`, the zero-cloud reference
  impl. Runs a package on the in-process `WorkflowRuntime` (its "code bundle").
- `@loom/dispatcher` — `ExecutionDispatcher` SPI + `LocalDispatcher`, which wraps
  one `WorkerRuntime`.

Supporting change: `WorkflowRuntime.getFlow(flowId)` — the additive "code by id"
lookup a worker uses to resolve a package's `flowId` to a `RegisteredFlow` for a
fresh `start` (`resume` already resolves it internally). No public API removed or
changed.

Two semantic rules that make the seam distribution-ready:

1. **A worker runs to suspend-or-complete, then returns.** A durable
   human-in-the-loop suspend is a normal, non-terminal `ExecutionResult`
   (`status: "suspended"`), not a failure.
2. **Resume-after-approval is a fresh dispatch.** The caller collects the
   approval decision and dispatches a new package carrying a `resumeEvent`. The
   worker stays disposable across the gate — the prerequisite for Cloud Run's
   request/response + timeout model (Step 3).

`InProcessA2ABus` was refactored to route through an injected
`ExecutionDispatcher` (defaulting to `LocalDispatcher(LocalWorkerRuntime)`), so
all `new InProcessA2ABus(runtime)` call sites are unchanged. The suspend/resume
loop now tolerates multiple gates.

## Consequences

- Moving execution off-box is a one-line swap of the injected `WorkerRuntime`
  (Local → Remote → CloudRun); the orchestrator/transport is unaware.
- Public SDK (`flow$/step$/handler$/agent$`, `WorkflowRuntime.start/resume`) is
  unchanged. The seam is additive.
- The single-writer invariant (`ExecutionJournal`: exactly one allocator per
  execution) is preserved — one worker owns one execution at a time. Distributed
  fan-out (Step 5) will use per-branch `executionId`s via `fork()`, never
  concurrent writers on one execution.
- Cancellation/timeout in `LocalDispatcher` are minimal in Step 1 (lease release
  + optional retry); true mid-flight interruption and failure redispatch land in
  Step 4.

## Verification

- New unit tests: `LocalWorkerRuntime` (start→complete, suspend, resume,
  unregistered-flow), `LocalDispatcher` (allocate/execute/release ordering,
  retry, health, cancel), and `@loom/worker-runtime` contract tests.
- All five example suites (db-command-center, -wc, -server, incident-war-room,
  schema-migration-planner) pass unchanged through the dispatcher — including
  approval gates, operator reject/cancel, and the fork/simulate/promote branching
  demos. Full repo: 59/59 test tasks green, typecheck clean.
