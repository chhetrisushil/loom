# @loom/graph-executor — distributed fan-out

`executeGraph` runs a set of nodes as independent executions and joins their results. Each node becomes
its own execution (its own id, so exactly one writer per log), dispatched through an
[`ExecutionDispatcher`](../dispatcher/README.md), and the call returns once every node has settled.
Because placement belongs to the dispatcher, the same graph can run in-process or one worker per node. The
"graph" lives in the branch registry as lineage, not in a shared log. Use it for fan-out where each branch
is a flow of its own (the agent-swarm example does this); for fan-out inside one execution use
`ctx.parallel`.

```ts
import { LocalDispatcher } from "@loom/dispatcher";
import { InMemoryBranchRegistry } from "@loom/event-runtime";
import { executeGraph } from "@loom/graph-executor";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import { app } from "./config"; // your defineConfig({ storage, flows, ... }) result

const dispatcher = new LocalDispatcher(new LocalWorkerRuntime(app.runtime));
const branchRegistry = new InMemoryBranchRegistry();

const run = await executeGraph(
  dispatcher,
  [
    { id: "ada", flowId: "hello", input: { name: "Ada" } },
    { id: "grace", flowId: "hello", input: { name: "Grace" } },
  ],
  { parentExecutionId: "audit-7", branchRegistry, limit: 2 }
);

console.log(run.completed, run.byId.ada?.output); // each node ran as "audit-7:ada", "audit-7:grace"
console.log(await branchRegistry.children("audit-7")); // the lineage records, for the join
```

## Surface

- **`executeGraph(dispatcher, nodes, options?)`** returns `GraphExecution`: `nodes` (each with `id`,
  `executionId`, `result`), `byId`, and `completed`.
- **`GraphNode`:** `id`, `flowId`, optional `input` and `metadata` (`DispatchMetadata` placement hints).
- **Options:** `parentExecutionId` and `branchRegistry` (record parent to child lineage), `limit` (branches
  in flight, default all), `executionIdFor` (default `${parentExecutionId ?? "graph"}:${node.id}`), and
  `principal` (the identity every node is dispatched as).

## Behaviour that surprises people

- **`completed` means every node reached `completed`.** A node that suspended or failed returns a result,
  not an error; check `byId` for which.
- **A dispatch that throws rejects the whole call.** Nodes already running are not cancelled, and results
  of the others are not returned. That includes a superseded refusal: if a node's execution id is already
  owned by another holder (a duplicate run with deterministic ids), the join rejects, and the caller
  should await that node by id.
- **Lineage is recorded only when both `parentExecutionId` and `branchRegistry` are set.** The recorded
  `forkSequence` is always 0.
- **Ids are deterministic by default**, so re-running a graph with the same parent targets the same
  executions. Pass `executionIdFor` if that is not what you want.
- **A strict worker refuses a node without a principal.** Pass `principal` when the dispatcher fronts a
  worker under `security.strict`.
- **There is no dependency ordering between nodes.** They all dispatch, up to `limit` at a time.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loom/graph-executor` — distributed fan-out" in [docs/api-reference.org](../../docs/api-reference.org).
- Guide: [user guide, section 13: where executions run](../../docs/user-guide.md#13-where-executions-run-compute); the `agent-swarm` example in [examples](../../docs/examples.md).
- ADR: [0005 distributed graph fork-join](../../docs/adr/0005-distributed-graph-fork-join.md).
- Source: `packages/graph-executor/src`. Concurrency comes from [`@loom/scheduler`](../scheduler/README.md)'s `parallelLimit`.
