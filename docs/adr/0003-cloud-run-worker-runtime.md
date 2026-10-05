# ADR 0003 — CloudRunWorkerRuntime + Platform SPI

- Status: Accepted (Step 3 of 5 — Cloud Run compute provider)
- Date: 2026-07-07
- Builds on: [ADR 0002](0002-http-worker-and-remote-worker-runtime.md)

## Context

With the HTTP worker (ADR 0002) in place, executions can run in a separate
process. Step 3 makes that process a Cloud Run instance and keeps every
cloud-specific concern isolated behind an adapter, per ADR 0001's Platform SPI.

## Decision

New package `@loom/platform-cloudrun`:

- **`CloudRunPlatform`** — the Cloud Run Platform SPI. Load-bearing method
  `resolveEndpoint(config: CloudRunConfig): Promise<string>` returns the base URL
  of a service able to serve `POST /execute` at a given size. Capability slots
  (`secrets`, `identity`, `logs`, `metrics`) keep those concerns behind the same
  adapter. `StaticCloudRunPlatform` is the simplest impl (one service URL for all
  sizes); a deploy-per-size adapter can provision revisions instead.
- **`CloudRunWorkerRuntime implements WorkerRuntime`** = `RemoteWorkerRuntime`
  (HTTP transport) + *placement*. On `allocate` it sizes the execution from the
  dispatch metadata via a `SizingPolicy`, asks the platform for an endpoint, and
  stashes it on the lease; `execute` invokes that endpoint (with an optional
  `requestTimeoutMs`); `release` calls the platform teardown hook.
- **`defaultSizingPolicy`** maps `DispatchMetadata` → `CloudRunConfig`: explicit
  estimates win, else `planning`/`heavy` lane → 4 vCPU / 8 GiB, else 1 vCPU /
  512 MiB (the plan's Epic 7 example).
- Container: `startWorkerServer(worker)` (in `@loom/worker-server`) reads Cloud
  Run's `$PORT` and binds `$HOST` (default `0.0.0.0`; `createWorkerServer` itself is loopback); a reference `Dockerfile` + `deploy.md` document the image and
  `gcloud run deploy`.

**Suspend/timeout reconciliation (the crux for Cloud Run).** A worker returns
within one request: `completed`, `failed`, or `suspended`. A `suspended` result
is normal — the instance then scales to zero while a human approves. The resume
is a *fresh* dispatch (`resumeEvent` set) → a fresh `allocate` → possibly a cold
instance, which is safe because the worker is stateless and rebuilds from the
shared stores. `requestTimeoutMs` must stay at/under Cloud Run's request deadline
(≤60 min).

## Consequences

- The core runtime, SDK, and orchestrator remain cloud-agnostic; only this
  package imports Cloud Run concepts. Kubernetes/other platforms are new adapters
  behind the same SPI.
- Placement is driven by advisory `DispatchMetadata` (never correctness).
- Real GCP is not exercised in CI; the recycling-platform integration test is a
  faithful proxy (fresh instance per dispatch over shared SQLite).

## Verification

- Unit: default sizing (planning → 4/8192, projection → 1/512) via a recording
  platform; `requestTimeoutMs` rejection.
- Integration: an instance-recycling `CloudRunPlatform` boots a *fresh*
  WorkflowRuntime per `resolveEndpoint` over the *same* SQLite files and tears it
  down on `release`. A suspend→resume therefore spans two cold instances sharing
  only durable stores and still completes — the strongest statelessness proof.
- Full repo: build + typecheck clean, 64/64 test tasks green, biome clean.
