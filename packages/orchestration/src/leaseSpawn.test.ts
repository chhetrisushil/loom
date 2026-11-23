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
  executionId: string;
  taskId?: string;
  childId: string;
  lease: Record<string, number>;
};

function boot(
  taskAuthority: SupervisorDeps["taskAuthority"],
  parent: FlowRunner<unknown, unknown>
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
  runtime.registerFlow(def("child"), childRunner);
  runtime.registerFlow(def("parent"), parent);
  holder.sup = superviseChildren({
    runtime,
    flows: { child: { definition: def("child"), runner: childRunner } as RegisteredFlow },
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
  it("awaitChild: the hook mints once with the recorded numbers; usage keeps only lease.* totals", async () => {
    const seen: Seen[] = [];
    let usage: unknown;
    const h = boot(
      {
        async mintChildGrant(parent, spec) {
          seen.push({ ...parent, childId: spec.childId, lease: spec.lease });
          return { actor: spec.childId };
        },
      },
      async (ctx) => {
        await awaitChild(ctx, {
          key: "k",
          flowId: "child",
          input: {},
          lease: { w: 6 },
          leaseParent: "task-P",
          onUsage: (u) => {
            usage = u;
          },
        });
        return { usage };
      }
    );
    await h.start();
    expect(await output(h.runtime, "P")).toEqual({
      usage: { "lease.w": 3, "lease.w.reserved": 1 },
    });
    expect(seen).toEqual([
      { executionId: "P", taskId: "task-P", childId: "P::k", lease: { w: 6 } },
    ]);
    expect(h.errors).toEqual([]);
  });

  it("awaitChildren: each completed member carries usage; a refused mint fails the whole group", async () => {
    const group: FlowRunner<unknown, unknown> = async (ctx) =>
      awaitChildren(ctx, {
        key: "g",
        children: [
          { flowId: "child", input: {}, lease: { w: 4 } },
          { flowId: "child", input: {} },
        ],
      });
    const ok = boot({ mintChildGrant: async (_p, s) => ({ actor: s.childId }) }, group);
    await ok.start();
    const settled = (await output(ok.runtime, "P")) as ChildResult[];
    expect(settled.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(settled.map((r) => (r as { usage?: unknown }).usage)).toEqual([
      { "lease.w": 3, "lease.w.reserved": 1 },
      { "lease.w": 3, "lease.w.reserved": 1 },
    ]);

    const refused = boot(
      {
        mintChildGrant: async () => {
          throw new Error("over the headroom");
        },
      },
      group
    );
    await refused.start();
    const out = (await output(refused.runtime, "P")) as ChildResult[];
    expect(out.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(await refused.runtime.loadState("P::g#0")).toBeNull(); // nothing started
  });

  it("without a hook a lease spawn fails closed and no usage is added to a plain child", async () => {
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

    const plain = boot(undefined, async (ctx) =>
      awaitChildren(ctx, {
        key: "g",
        children: [{ flowId: "child", input: {} }],
      })
    );
    await plain.start();
    expect(await output(plain.runtime, "P")).toEqual([
      { status: "completed", output: { done: true } },
    ]);
  });
});
