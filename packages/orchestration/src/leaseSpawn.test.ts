import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  type ExecutionContext,
  type FlowRunner,
  type RegisteredFlow,
  WorkflowRuntime,
} from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ChildResult,
  type SupervisorDeps,
  awaitChild,
  awaitChildren,
  superviseChildren,
} from "./orchestration";

// ADR 0150 D6, the orchestration half: a spawn carries `lease` numbers, a configured `taskAuthority` hook
// mints the child's principal, a completed child reports its final `lease.*` totals, and a lease with no
// hook fails closed. Orchestration never imports `@loomwork/task-authority`.
const def = (id: string): FlowDefinition =>
  ({
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    steps: [],
  }) as unknown as FlowDefinition;

const childRunner: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) => {
  ctx.emit("RESOURCE_METERED", { custom: { "lease.w": 3, "lease.w.reserved": 1, other: 9 } });
  return { done: true };
};
type Seen = {
  resources: Record<string, number>;
  executionId: string;
  taskId?: string;
  childId: string;
  lease: Record<string, number>;
};

function boot(
  taskAuthority: SupervisorDeps["taskAuthority"],
  parent: FlowRunner<unknown, unknown>,
  child: FlowRunner<unknown, unknown> = childRunner
) {
  const errors: unknown[] = [];
  const holder: { sup?: ReturnType<typeof superviseChildren> } = {};
  const runtime = new WorkflowRuntime({
    effectRuntime: new EffectRuntime([]),
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    onWarn: () => {},
    onEvent: (e) => holder.sup?.onEvent(e),
  });
  runtime.registerFlow(def("child"), child);
  runtime.registerFlow(def("parent"), parent);
  holder.sup = superviseChildren({
    runtime,
    flows: { child: { definition: def("child"), runner: child } as RegisteredFlow },
    ...(taskAuthority !== undefined && { taskAuthority }),
    onError: (e) => errors.push(e),
  });
  const flow = { definition: def("parent"), runner: parent } as never;
  return { runtime, errors, start: () => runtime.start(flow, {}, { executionId: "P" }) };
}
async function output(rt: WorkflowRuntime, id: string): Promise<unknown> {
  for (let i = 0; i < 400; i++) {
    const s = await rt.loadState(id);
    if (s?.status === "completed") return s.variables._output;
    if (s?.status === "failed") throw new Error("parent failed");
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
}

describe("lease spawn (ADR 0150 D6, orchestration half)", () => {
  it("awaitChild: the hook gets the parent's live fold; a completed child is settled before the resume", async () => {
    const seen: Seen[] = [];
    const settled: [string, Record<string, number>][] = [];
    const h = boot(
      {
        async mintChildGrant(parent, spec) {
          seen.push({ ...parent, childId: spec.childId, lease: spec.lease });
          return { actor: spec.childId };
        },
        async settleChild(id, resources) {
          settled.push([id, resources]);
        },
      },
      async (ctx) => {
        ctx.emit("RESOURCE_METERED", { custom: { "lease.w.reserved": 6 } });
        await awaitChild(ctx, {
          key: "k",
          flowId: "child",
          input: {},
          lease: { w: 6 },
          leaseParent: "task-P",
        });
        return { done: true };
      }
    );
    await h.start();
    await output(h.runtime, "P");
    expect(seen).toEqual([
      {
        executionId: "P",
        taskId: "task-P",
        resources: { "lease.w.reserved": 6 }, // read from the parent's fold, not from the spawn
        childId: "P::k",
        lease: { w: 6 },
      },
    ]);
    expect(settled).toEqual([["P::k", { "lease.w": 3, "lease.w.reserved": 1, other: 9 }]]);
    expect(h.errors).toEqual([]);
  });

  it("a failed child is never settled (R7)", async () => {
    const settled: string[] = [];
    const h = boot(
      {
        mintChildGrant: async (_p, s) => ({ actor: s.childId }),
        settleChild: async (id) => {
          settled.push(id);
        },
      },
      async (ctx) => {
        try {
          await awaitChild(ctx, { key: "k", flowId: "child", input: {}, lease: { w: 1 } });
        } catch (e) {
          if ((e as Error).name === "SuspendError") throw e;
          return { failed: true };
        }
        return { failed: false };
      },
      async () => {
        throw new Error("boom");
      }
    );
    await h.start();
    expect(await output(h.runtime, "P")).toEqual({ failed: true });
    expect(settled).toEqual([]);
  });

  it("awaitChildren: completed members are settled; a refused mint fails the whole group", async () => {
    const group: FlowRunner<unknown, unknown> = async (ctx) =>
      awaitChildren(ctx, {
        key: "g",
        children: [
          { flowId: "child", input: {}, lease: { w: 4 } },
          { flowId: "child", input: {} },
        ],
      });
    const settled: string[] = [];
    const ok = boot(
      {
        mintChildGrant: async (_p, s) => ({ actor: s.childId }),
        settleChild: async (id) => {
          settled.push(id);
        },
      },
      group
    );
    await ok.start();
    const done = (await output(ok.runtime, "P")) as ChildResult[];
    expect(done.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(settled.sort()).toEqual(["P::g#0", "P::g#1"]);

    const refused = boot(
      {
        mintChildGrant: async () => {
          throw new Error("over the headroom");
        },
        settleChild: async () => {},
      },
      group
    );
    await refused.start();
    const out = (await output(refused.runtime, "P")) as ChildResult[];
    expect(out.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(await refused.runtime.loadState("P::g#0")).toBeNull(); // nothing started
  });

  it("without a hook a lease spawn fails closed", async () => {
    const closed = boot(undefined, async (ctx) => {
      try {
        await awaitChild(ctx, { key: "k", flowId: "child", input: {}, lease: { w: 6 } });
      } catch (e) {
        if ((e as Error).name === "SuspendError") throw e;
        return { failed: true };
      }
      return { failed: false };
    });
    await closed.start();
    expect(await output(closed.runtime, "P")).toEqual({ failed: true });
    expect(await closed.runtime.loadState("P::k")).toBeNull();
    expect(String(closed.errors[0])).toMatch(/taskAuthority is not configured/);
  });
});
