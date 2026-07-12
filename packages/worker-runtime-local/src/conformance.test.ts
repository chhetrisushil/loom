import { runWorkerRuntimeConformance } from "@loom/conformance";
import { flow$, handler$, step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { ExecutionPackage, WorkerRuntime } from "@loom/worker-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { z } from "zod";
import { LocalWorkerRuntime } from "./LocalWorkerRuntime";

// Dogfood the WorkerRuntime conformance kit (@loom/conformance) against the reference
// LocalWorkerRuntime — a fresh in-memory runtime with a registered one-step flow, plus
// a package that runs exactly that flow (their ids match).
let n = 0;
function freshLocalWorker(): { worker: WorkerRuntime; pkg: ExecutionPackage } {
  n += 1;
  const io = z.object({ n: z.number() });
  const s = step$({
    id: "s",
    inputSchema: io,
    outputSchema: io,
    handler: handler$(async (i: { n: number }) => ({ n: i.n + 1 })),
  });
  const flowId = `wf-${n}`;
  const def = flow$({
    id: flowId,
    name: "W",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [s as never],
  });
  const runner = ((ctx, input) => ctx.run(s as never, input)) as FlowRunner<unknown, unknown>;
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  runtime.registerFlow(def, runner);
  return {
    worker: new LocalWorkerRuntime(runtime),
    pkg: { executionId: `e-${n}`, workflowId: flowId, flowId, input: { n: 1 } },
  };
}

runWorkerRuntimeConformance(() => freshLocalWorker(), "LocalWorkerRuntime");
