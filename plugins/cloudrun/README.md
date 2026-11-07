# @loom/plugin-cloudrun — decide where an execution runs, then send it to a worker

`CloudRunWorkerRuntime` is a `WorkerRuntime` that sizes a dispatch from its metadata, asks a
`CloudRunPlatform` for an endpoint of that size, and sends the package there through
`RemoteWorkerRuntime`. Cloud-specific logic stays behind the `CloudRunPlatform` interface; the only
platform shipped is `StaticCloudRunPlatform`, which returns one URL you deployed yourself. It places
trusted, registered flows. It is not a sandbox for model-written code (ADR 0144), and it does not deploy
anything for you.

```ts
import { LocalDispatcher } from "@loom/dispatcher";
import { CloudRunWorkerRuntime, StaticCloudRunPlatform } from "@loom/plugin-cloudrun";

const platform = new StaticCloudRunPlatform(process.env.WORKER_URL!);
const worker = new CloudRunWorkerRuntime(platform, { requestTimeoutMs: 55 * 60_000 });
const dispatcher = new LocalDispatcher(worker);

// The second argument is the dispatch metadata that the sizing policy reads.
await dispatcher.dispatch(
  { executionId: "exec-1", workflowId: "report", flowId: "report", input: {} },
  { lane: "planning", estimatedCpu: 4, estimatedMemory: 8192 }
);
```

## Surface

- **`CloudRunWorkerRuntime(platform, { sizing?, requestTimeoutMs?, fetchImpl? })`.**
- **`defaultSizingPolicy`** maps metadata to `{ cpu, memoryMb }`: explicit `estimatedCpu` and
  `estimatedMemory` win; otherwise the `planning` and `heavy` lanes get 4 vCPU and 8 GiB, and anything
  else 1 vCPU and 512 MiB. Replace it with the `sizing` option.
- **`CloudRunPlatform`** needs `resolveEndpoint(config)`; `release`, `secrets`, `identity`, `logs` and
  `metrics` are optional. `StaticCloudRunPlatform` ignores the size and returns its one URL.

## Behaviour that surprises people

- **`identity` and `secrets` are not used by the runtime.** The platform interface declares them, but
  nothing in this package calls them or adds a token to a request. To authenticate against a private
  service, give `fetchImpl` a function that attaches the credential. Only `logs` (on allocate) and
  `metrics` (the `cloudrun.execute.ms` timing) are called.
- **The sizing result reaches only your platform.** With `StaticCloudRunPlatform` it has no effect.
- **`requestTimeoutMs` stops waiting, not the request.** It rejects the call after that long; Cloud Run's
  own deadline (60 minutes at most) is the hard bound, so keep it at or below that.
- **A suspended result is normal.** The instance can scale to zero while a human decides; the resume is a
  fresh dispatch that may land on a cold instance, which works because the worker rebuilds from shared
  stores. Use Postgres or another network store, not SQLite files in the container.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [Cloud Run deploy guide](deploy.md) and [ADR 0003](../../docs/adr/0003-cloud-run-worker-runtime.md).
- The container side is [`@loom/plugin-worker-server`](../worker-server/README.md); the transport is
  [`@loom/plugin-worker-remote`](../worker-remote/README.md).
- API reference: section "`@loom/plugin-cloudrun`" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/scaling.md](../../docs/scaling.md), [docs/user-guide.md](../../docs/user-guide.md).
