# Deploying a Loom worker to Cloud Run

The worker is a stateless `POST /execute` endpoint (see `@loom/plugin-worker-server`).
It holds no execution state between requests — everything is rebuilt from the
shared event + snapshot stores — so Cloud Run's request/response model and
scale-to-zero are a natural fit.

## Prerequisites

- Shared, network-reachable stores (e.g. Postgres / Cloud SQL) for events and
  snapshots. **Do not** use local SQLite in the container — each instance is
  ephemeral; state must live outside it.
- A worker entrypoint that registers your flows/effects and calls
  `startWorkerServer(new LocalWorkerRuntime(runtime))`.

## Wiring (caller side)

```ts
import { LocalDispatcher } from "@loom/dispatcher";
import { CloudRunWorkerRuntime, StaticCloudRunPlatform } from "@loom/plugin-cloudrun";

const platform = new StaticCloudRunPlatform(process.env.WORKER_URL!, {
  // optional capability adapters
  secrets: mySecretManagerAdapter,
  identity: myWorkloadIdentityAdapter,
  logs: myLogAdapter,
  metrics: myMetricAdapter,
});

const dispatcher = new LocalDispatcher(
  new CloudRunWorkerRuntime(platform, { requestTimeoutMs: 55 * 60_000 }),
);

// Placement hints flow through as the second dispatch arg → sizing policy.
await dispatcher.dispatch(pkg, { lane: "planning", estimatedCpu: 4, estimatedMemory: 8192 });
```

## Sizing

`CloudRunWorkerRuntime` maps `DispatchMetadata` → a `CloudRunConfig` via the
`SizingPolicy` (default: `planning`/`heavy` lane → 4 vCPU / 8 GiB, else 1 vCPU /
512 MiB). A deploy-per-size `CloudRunPlatform` can pick the matching revision, or
`StaticCloudRunPlatform` can ignore size and serve one service.

## Suspend / long-running gates

A worker returns within one request: either `completed`, `failed`, or
`suspended`. A `suspended` result is normal — the instance scales to zero while a
human approves. The resume is a **fresh dispatch** (`resumeEvent` set) that lands
on a possibly-cold instance; because the worker is stateless this Just Works.
Keep `requestTimeoutMs` at or under Cloud Run's request deadline (≤60 min).

## Build & deploy

```sh
# Build the image (see the reference Dockerfile in this package).
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/loom/worker:latest

gcloud run deploy loom-worker \
  --image REGION-docker.pkg.dev/PROJECT/loom/worker:latest \
  --cpu 4 --memory 8Gi --concurrency 1 \
  --set-env-vars "DATABASE_URL=..." \
  --no-allow-unauthenticated
```
