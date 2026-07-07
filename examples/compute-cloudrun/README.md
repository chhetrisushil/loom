# compute-cloudrun — compute layer pluggability

The **same durable flow runs unchanged on three interchangeable compute backends** —
in-process, a remote HTTP worker, and Cloud Run — by swapping only the dispatcher's
`WorkerRuntime`. It runs **fully offline** (no GCP): a `StaticCloudRunPlatform` points
the Cloud Run path at a local worker server.

The flow (`rebuild-index`) is a small durable DB-index rebuild; nothing about it knows
or cares where it executes. That's the point.

```
             ┌──────────────── the SAME ExecutionPackage ────────────────┐
             ▼                          ▼                                 ▼
   LocalDispatcher              LocalDispatcher                   LocalDispatcher
        │                            │                                  │
  LocalWorkerRuntime          RemoteWorkerRuntime            CloudRunWorkerRuntime
        │                            │  POST /execute                   │  resolveEndpoint()→POST /execute
   WorkflowRuntime            ┌──────┴───────┐                  StaticCloudRunPlatform
   (in this process)          │ worker-server │                         │
                              └──────┬───────┘                    (points at the
                              LocalWorkerRuntime  ◀───────────────  same worker-server)
                              WorkflowRuntime
```

## Why it works

An `ExecutionPackage` carries **resume coordinates, never code**: `{ executionId,
flowId, input?, resumeEvent? }`. The worker is a `WorkflowRuntime` with the flows
registered + backed by event/snapshot stores (`src/worker.ts`) — the code+state bundle
each backend runs. Every backend is `LocalDispatcher(someWorkerRuntime)`:

- **in-process** — `LocalWorkerRuntime(runtime)` runs it here.
- **remote HTTP** — `RemoteWorkerRuntime(url)` POSTs the package to `worker-server`'s
  `POST /execute`, which runs it on its own `LocalWorkerRuntime` and returns the
  `ExecutionResult` as JSON.
- **Cloud Run** — `CloudRunWorkerRuntime(platform)` asks the platform to `resolveEndpoint`
  (sized from dispatch hints), then POSTs to it with the *exact same* HTTP contract.
  `StaticCloudRunPlatform(url)` returns our local worker-server URL, so the whole path
  runs offline. Swap in a real `CloudRunPlatform` (deploy/reuse a revision, wire
  secrets/identity/logs/metrics) and nothing else changes.

Because the worker is **stateless** (it rebuilds state from the shared log), a
suspended execution can resume on a *different* backend than it started on — the demo
suspends `rebuild-index-gated` on the remote HTTP worker and resumes it on Cloud Run.

## Run it

```bash
pnpm --filter @loom/compute-cloudrun start   # runs the flow on all 3 backends + a cross-backend suspend/resume
pnpm --filter @loom/compute-cloudrun test    # asserts equivalent results, cross-backend resume, and Cloud Run sizing
```

Expected: identical business output on every backend; the gated flow suspends on one
backend and completes on another; the Cloud Run platform records its `allocate`
(endpoint resolution) and the `heavy` lane maps to a bigger machine via the sizing policy.

## Files

| Path | Purpose |
|------|---------|
| `src/flow.ts` | The durable `rebuild-index` (+ gated) flows |
| `src/worker.ts` | `buildWorkerRuntime()` — a `WorkflowRuntime` + stores + registered flows |
| `src/backends.ts` | The three `ExecutionDispatcher`s (in-process / remote / Cloud Run) |
| `src/main.ts` | Headless driver |
| `test/compute.test.ts` | Equivalence, cross-backend resume, Cloud Run sizing |

See also [`@loom/platform-cloudrun` deploy guide](../../packages/platform-cloudrun/deploy.md).
