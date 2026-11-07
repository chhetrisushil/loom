# @loom/plugin-worker-remote — run an execution on another process over HTTP

`RemoteWorkerRuntime` is a `WorkerRuntime` that sends an `ExecutionPackage` to a worker's
`POST /execute` endpoint and returns the `ExecutionResult`. The package carries resume coordinates
(execution id, flow id, input or resume event), never code, so the worker has to have the same flows
registered and must read the same event and snapshot stores. It is the client half; the server half
is `@loom/plugin-worker-server`, and `@loom/plugin-cloudrun` builds placement on top of this class.
Use it when a dispatcher should run executions off-box.

```ts
import { LocalDispatcher } from "@loom/dispatcher";
import { RemoteWorkerRuntime } from "@loom/plugin-worker-remote";

const worker = new RemoteWorkerRuntime("https://worker.internal:8080");
const dispatcher = new LocalDispatcher(worker);

const result = await dispatcher.dispatch({
  executionId: "exec-1",
  workflowId: "greet",
  flowId: "greet",
  input: { name: "Ada" },
});
console.log(result.status); // "completed" | "suspended" | "failed"
```

## Surface

- **`new RemoteWorkerRuntime(baseUrl, { fetchImpl? })`** implements `allocate`, `execute` and `release`
  (the first and last keep no client-side state) and adds `cancel(executionId, reason?)`.
- **`cancel`** posts to `/cancel`. It is best-effort and returns `false`, without throwing, if the worker
  is unreachable, does not support cancel, or does not know the execution.

## Behaviour that surprises people

- **There is no authentication option.** The client sends no credentials. If the worker's `authorize`
  hook or a proxy expects a token, supply a `fetchImpl` that adds it.
- **A `409` with `code: "superseded"` becomes `ExecutionSupersededError`**, but only when the body also
  names this execution id, so an unrelated `409` from a proxy stays an ordinary failure. Any other
  non-2xx response throws an error carrying the status and body.
- **Redispatch is the dispatcher's decision.** This class makes one request per `execute`; retry and
  superseded handling are in `@loom/dispatcher`.
- **The worker keeps no execution state between requests.** It rebuilds from the shared event and snapshot
  stores on each call, so those stores must be reachable from every worker (the Cloud Run deploy guide
  advises against a local SQLite file in a container).

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0001](../../docs/adr/0001-execution-dispatcher-and-worker-runtime.md) and
  [ADR 0002](../../docs/adr/0002-http-worker-and-remote-worker-runtime.md): the dispatcher and the HTTP worker.
- API reference: section "`@loom/plugin-worker-remote` — the HTTP client side" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/scaling.md](../../docs/scaling.md), [docs/user-guide.md](../../docs/user-guide.md).
