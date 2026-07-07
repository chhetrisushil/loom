import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { RebuildIndexFlow, RebuildIndexGatedFlow } from "./flow";

// The "worker" is nothing more than a WorkflowRuntime with the flows registered and
// backed by (here in-memory) event + snapshot stores. That runtime is the code+state
// bundle every compute backend runs — LocalWorkerRuntime wraps it directly, and the
// HTTP worker server hosts exactly this behind POST /execute. registerFlow also
// auto-registers each handler$ step as an effect, so no manual effect wiring.
export function buildWorkerRuntime(): WorkflowRuntime {
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  for (const flow of [RebuildIndexFlow, RebuildIndexGatedFlow]) {
    runtime.registerFlow(flow.definition, flow.runner);
  }
  return runtime;
}
