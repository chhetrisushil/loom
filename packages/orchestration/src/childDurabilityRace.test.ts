import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ChildSupervisor, awaitChild, superviseChildren } from "./orchestration";

// A store that DELAYS append (like a networked store where the durable write
// drains after onEvent has already fired synchronously). This reproduces the
// race where an INSTANT child completes before its parent's suspend is readable.
class SlowAppendStore implements EventStore {
  constructor(
    private readonly inner = new InMemoryAsyncEventStore(),
    private readonly delayMs = 40
  ) {}
  async append(e: EventEnvelope): Promise<void> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return this.inner.append(e);
  }
  read(id: string) {
    return this.inner.read(id);
  }
  readFrom(id: string, s: number) {
    return this.inner.readFrom(id, s);
  }
  // biome-ignore lint: pass-through for any remaining EventStore surface
  [k: string]: any;
}

// Instant child: no effects, returns immediately (completes before a slow append drains).
const childRunner: FlowRunner<{ n: number }, { v: number }> = async (_c, i) => ({ v: i.n * 2 });
const childFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "child",
    name: "child",
    version: "1.0.0",
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ v: z.number() }),
    steps: [],
  } satisfies FlowDefinition<{ n: number }, { v: number }>,
  runner: childRunner,
} as RegisteredFlow;
const parentRunner: FlowRunner<{ n: number }, { fromChild: number }> = async (ctx, input) => {
  const c = await awaitChild<{ v: number }>(ctx, {
    key: "c1",
    flowId: "child",
    input: { n: input.n },
  });
  return { fromChild: c.v };
};
const parentFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "parent",
    name: "parent",
    version: "1.0.0",
    inputSchema: z.object({ n: z.number() }),
    outputSchema: z.object({ fromChild: z.number() }),
    steps: [],
  } satisfies FlowDefinition<{ n: number }, { fromChild: number }>,
  runner: parentRunner,
} as RegisteredFlow;

function build() {
  const holder: { supervisor?: ChildSupervisor } = {};
  const runtime = new WorkflowRuntime({
    eventStore: new SlowAppendStore() as unknown as EventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onEvent: (e) => holder.supervisor?.onEvent(e),
  });
  runtime.registerFlow(parentFlow.definition, parentRunner);
  runtime.registerFlow(childFlow.definition, childRunner);
  holder.supervisor = superviseChildren({ runtime, flows: { child: childFlow } });
  return runtime;
}
async function waitDone(rt: WorkflowRuntime, id: string, tries = 400): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const s = await rt.loadState(id);
    if (s?.status === "completed") return "completed";
    if (s?.status === "failed") return "failed";
    await new Promise((r) => setTimeout(r, 5));
  }
  return `TIMEOUT(${(await rt.loadState(id))?.status})`;
}
describe("child durability race (slow-append store)", () => {
  it("an instant child does not strand its parent when the suspend write lags", async () => {
    const rt = build();
    await rt.start(parentFlow, { n: 1 }, { executionId: "p1" });
    expect(await waitDone(rt, "p1")).toBe("completed");
    await rt.start(parentFlow, { n: 2 }, { executionId: "p2" });
    expect(await waitDone(rt, "p2")).toBe("completed");
  }, 20000);
});
