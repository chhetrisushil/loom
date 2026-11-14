# @loomwork/plugin-worker-server — the HTTP endpoint a remote worker runs

A small `node:http` server that runs one `ExecutionPackage` per `POST /execute` on a `WorkerRuntime` you
inject and returns the `ExecutionResult`. It keeps no execution state: every request allocates a lease,
runs to completion or suspension, and releases. It is the container entrypoint for remote and Cloud Run
execution, paired with `@loomwork/plugin-worker-remote` on the calling side. Skip it if executions run in
the same process as your app.

```ts
import { LocalWorkerRuntime } from "@loomwork/worker-runtime-local";
import { startWorkerServer } from "@loomwork/plugin-worker-server";
import type { WorkflowRuntime } from "@loomwork/workflow-runtime";

declare const runtime: WorkflowRuntime; // flows and effects registered, stores shared with the caller

const server = await startWorkerServer(new LocalWorkerRuntime(runtime), {
  authorize: (req) => req.headers.authorization === `Bearer ${process.env.WORKER_TOKEN}`,
});
console.log("listening on", server.url);
```

## Surface

- **`createWorkerServer(worker, options?)`** returns `{ start, stop, url, port }`. Routes: `POST /execute`
  (`{ executionPackage }`), `POST /cancel` (`{ executionId, reason? }`) and `GET /health`.
- **`startWorkerServer(worker, options?)`** is the container helper: port from `options.port`, else
  `PORT`, else 8080; host from `options.host`, else `HOST`, else `0.0.0.0`.
- **Options.** `port` (0 picks a free one), `host`, `authorize`, `onError(errorId, err)` and
  `onSuperseded(executionId, err)`.

## Behaviour that surprises people

- **Unauthenticated unless you pass `authorize`.** With none, any caller that can reach the port can run
  any registered flow and send resume events to any execution. `/health` is always open; every other
  route is gated when `authorize` is set.
- **The two entry points bind differently.** `createWorkerServer` listens on `127.0.0.1` by default;
  `startWorkerServer` listens on all interfaces, which Cloud Run needs.
- **A worker that runs as the system identity requires `authorize`.** If the injected worker has
  `runsAsSystem` set, `createWorkerServer` throws without it, because every admitted caller would
  otherwise act as the system.
- **`principal` on a package is trusted only behind `authorize`.** Without it the field is dropped and
  the dispatch is anonymous, which a `security.strict` runtime refuses.
- **A lost start race is a `409`, not a `500`.** `/execute` answers `{ code: "superseded", executionId }`
  when another holder owns the execution, and `RemoteWorkerRuntime` turns that into
  `ExecutionSupersededError`. Other failures return an opaque `500` with an `errorId`; the detail only
  reaches `onError`.
- **Request bodies are capped at 10 MB.**

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0002](../../docs/adr/0002-http-worker-and-remote-worker-runtime.md): the HTTP worker.
- [Cloud Run deploy guide](../cloudrun/deploy.md).
- API reference: section "`@loomwork/plugin-worker-server` — the stateless HTTP worker" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/scaling.md](../../docs/scaling.md), [docs/user-guide.md](../../docs/user-guide.md).
