# ADR 0002 — Dedicated HTTP Worker + RemoteWorkerRuntime

- Status: Accepted (Step 2 of 5 — Cloud Run compute provider)
- Date: 2026-07-07
- Builds on: [ADR 0001](0001-execution-dispatcher-and-worker-runtime.md)

## Context

ADR 0001 introduced the `WorkerRuntime` SPI and an in-process `LocalWorkerRuntime`.
To run executions off-box we need (a) a network transport implementing the SPI
and (b) a worker process to receive dispatches. Per the decision recorded with
the user, the worker exposes a **new, dedicated endpoint** rather than reusing the
A2A agent-to-agent protocol — A2A stays a peer protocol; execution transport is a
separate concern.

## Decision

Two packages:

- `@loom/worker-server` — `createWorkerServer(worker: WorkerRuntime, options)`,
  a **stateless** `node:http` endpoint (borrowing A2AServer's `parseBody`/`json`
  mechanics, dropping its in-memory handle `Map`):
  - `POST /execute` with `{ "executionPackage": {...} }` → per request:
    `allocate → execute → release` on the injected worker → returns the
    `ExecutionResult` JSON. No execution state is retained between requests; the
    worker rebuilds from the shared event + snapshot stores the injected runtime
    points at.
  - `GET /health` → `{ healthy: true }`.
  The server is a thin HTTP adapter over a `WorkerRuntime`; the "code bundle"
  (flows + effects) lives in the `WorkflowRuntime` inside the injected
  `LocalWorkerRuntime`. This is the container entrypoint for Step 3.

- `@loom/worker-runtime-remote` — `RemoteWorkerRuntime(baseUrl)`, the HTTP client
  impl of the SPI. `allocate`/`release` are trivial (no client-side state);
  `execute` POSTs the package to `{baseUrl}/execute` and parses the result.
  Fetch is injectable (`fetchImpl`) and typed structurally so the package needs
  no DOM lib.

Nothing else changes: the same `LocalDispatcher` now wraps a `RemoteWorkerRuntime`
instead of a `LocalWorkerRuntime`, and callers (the orchestrator/bus) are
unchanged.

## Consequences

- Moving execution to a remote process is a one-line swap of the injected worker.
- Statelessness is proven, not assumed: a suspend followed by a resume are two
  independent `POST /execute` calls that succeed purely by rebuilding from shared
  SQLite — the worker keeps nothing in memory across the gate.
- `ExecutionResult` doubles as the wire contract; it round-trips through JSON
  (folded state included), so remote and in-process results are byte-comparable
  (modulo ids/timestamps).
- Cloud specifics (instance lifecycle, placement, cold start) are deliberately
  absent — they belong to `CloudRunWorkerRuntime` (Step 3), which is
  `RemoteWorkerRuntime` + instance management behind the same SPI.

## Verification

- Unit: `RemoteWorkerRuntime` (POST shape + trailing-slash normalization; non-2xx
  → throws with status + body) via injected fetch.
- Integration (`worker-server`): local dispatch → HTTP worker → shared SQLite →
  replay. Covers `/health`, straight-through completion, suspend-then-resume
  across two POSTs, and folded-state parity with in-process `LocalWorkerRuntime`.
- Full repo: build + typecheck clean, 62/62 test tasks green, biome clean.
