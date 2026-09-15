import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import {
  InMemoryAsyncEventStore,
  InMemoryBranchRegistry,
  InMemoryTimerStore,
} from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import type { TimerDispatcher } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { placementOf } from "./placement";
import { recoverAbandoned } from "./recoverAbandoned";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── #392 — a wake that knows where the execution belongs ─────────────────────
//
// Placement used to live in the memory of whichever process dispatched: `ExecutionPolicy`
// is a caller-side struct mapped to `DispatchMetadata` at dispatch time. Invisible for an
// execution that runs once; gone by the time a timer re-drives one that suspended for a
// human — which is how a branch sized for a cloned database wakes inside a web server.

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });
type In = { n: number };
type Out = { done: boolean };

const afterStep = step$({
  id: "after",
  name: "After",
  toolId: "after-tool",
  inputSchema,
  outputSchema,
});

function makeFlow(flowId: string, runner: FlowRunner<In, Out>): RegisteredFlow<In, Out> {
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: flowId,
    name: flowId,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [afterStep],
  };
  return { definition, runner };
}

const gated = makeFlow("placed", async (ctx, input) => {
  await ctx.suspend({ on: "Approval", timeout: 60_000 });
  return await ctx.run(afterStep, input);
});

function boot() {
  const effects = new EffectRuntime();
  effects.register("after-tool", new ToolEffect(async () => ({ done: true })));
  const eventStore = new InMemoryAsyncEventStore();
  const timerStore = new InMemoryTimerStore();
  const branchRegistry = new InMemoryBranchRegistry();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    timerStore,
    branchRegistry,
  });
  runtime.registerFlow(gated.definition, gated.runner);
  return { runtime, eventStore, timerStore, branchRegistry };
}

/**
 * Records where each dispatch was routed. `redrive` stands in for a worker actually running
 * it — off when the flow under test never settles, since what a target does with a package
 * is the target's business, not the seam's.
 */
function recordingDispatcher(runtime: WorkflowRuntime, redrive = true) {
  const routed: Array<{ executionId: string; target: string | undefined }> = [];
  const dispatcher: TimerDispatcher = {
    async dispatch(pkg, meta) {
      routed.push({ executionId: pkg.executionId, target: meta?.target });
      if (!redrive) return undefined;
      const handle = await runtime.resume(pkg.executionId, pkg.resumeEvent);
      return await Promise.race([
        handle.waitForSuspend().catch(() => undefined),
        handle.waitForCompletion().catch(() => undefined),
      ]);
    },
  };
  return { dispatcher, routed };
}

describe("#392 — placement survives the process that chose it", () => {
  it("records the lane on the anchor, where compaction keeps it and the fold ignores it", async () => {
    const app = boot();
    const handle = await app.runtime.start(
      gated,
      { n: 1 },
      { executionId: "p1", computeTarget: "big" }
    );
    const state = await handle.waitForSuspend();

    expect(await placementOf(app.eventStore, "p1")).toBe("big");
    // Sequence 0 — the metadata anchor, not the payload.
    const [anchor] = await app.eventStore.read("p1");
    expect(anchor?.eventType).toBe("EXECUTION_STARTED");
    expect((anchor as EventEnvelope).metadata).toMatchObject({ computeTarget: "big" });
    // Descriptive only: nothing about the folded state changed (G2).
    expect(state.status).toBe("suspended");
    expect(Object.keys(state.variables)).not.toContain("computeTarget");
  });

  it("an execution that names no lane reports none", async () => {
    const app = boot();
    await (await app.runtime.start(gated, { n: 1 }, { executionId: "p2" })).waitForSuspend();
    expect(await placementOf(app.eventStore, "p2")).toBeUndefined();
  });

  it("a timer wake goes back to the lane the execution was started in", async () => {
    const app = boot();
    const { dispatcher, routed } = recordingDispatcher(app.runtime);
    const handle = await app.runtime.start(
      gated,
      { n: 1 },
      { executionId: "p3", computeTarget: "big" }
    );
    const parked = await handle.waitForSuspend();

    const service = new TimerService(app.runtime, app.timerStore, { dispatcher });
    await service.tick((parked.suspendedOn?.wakeAt ?? 0) + 1);

    expect(routed).toEqual([{ executionId: "p3", target: "big" }]);
    expect((await app.runtime.loadState("p3"))?.status).toBe("completed");
  });

  it("without a dispatcher the wake is unchanged (G2)", async () => {
    const app = boot();
    const handle = await app.runtime.start(
      gated,
      { n: 1 },
      { executionId: "p4", computeTarget: "big" }
    );
    const parked = await handle.waitForSuspend();

    await new TimerService(app.runtime, app.timerStore).tick((parked.suspendedOn?.wakeAt ?? 0) + 1);
    expect((await app.runtime.loadState("p4"))?.status).toBe("completed");
  });

  it("recovery re-drives on the recorded lane too", async () => {
    const app = boot();
    const { dispatcher, routed } = recordingDispatcher(app.runtime, false);
    // A `running` execution with no owner: started, never settled.
    const running = makeFlow("stuck", async () => new Promise<Out>(() => ({ done: true })));
    app.runtime.registerFlow(running.definition, running.runner);
    void app.runtime.start(running, { n: 1 }, { executionId: "p5", computeTarget: "big" });
    await vi.waitFor(async () =>
      expect((await app.runtime.loadState("p5"))?.status).toBe("running")
    );

    await recoverAbandoned(app.runtime, {
      source: app.eventStore,
      isAbandoned: (c) => c.executionId === "p5",
      dispatcher,
    });
    expect(routed).toEqual([{ executionId: "p5", target: "big" }]);
  });

  it("a branch inherits its parent's lane, and can be placed elsewhere", async () => {
    const app = boot();
    const handle = await app.runtime.start(
      gated,
      { n: 1 },
      { executionId: "p6", computeTarget: "big" }
    );
    const parked = await handle.waitForSuspend();

    const inherited = await app.runtime.fork("p6", parked.sequence);
    expect(await placementOf(app.eventStore, inherited.executionId)).toBe("big");

    // The case that matters: a simulation branch clones a dataset, which is exactly the
    // work you do not want on the lane running the parent.
    const moved = await app.runtime.fork("p6", parked.sequence, { computeTarget: "huge" });
    expect(await placementOf(app.eventStore, moved.executionId)).toBe("huge");
    expect(await placementOf(app.eventStore, "p6")).toBe("big"); // parent untouched
  });
});
