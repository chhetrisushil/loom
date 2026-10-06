import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ChildSupervisor,
  awaitChild,
  awaitChildren,
  superviseChildren,
} from "./orchestration";

// ── ADR 0112 D5 — cancelling a parent cancels its non-detached children ─────────────────────
//
// 1P: the kernel has no child relation. The supervisor reads the parent's recorded spawn
// decisions on its `EXECUTION_CANCELLED` (live), and `recover()` sweeps orphans by their
// RECORDED lineage (the guarantee for a parent cancelled where no supervisor was listening).

const io = { inputSchema: z.any(), outputSchema: z.any() };
const def = (id: string): FlowDefinition<unknown, unknown> => ({
  _tag: "FlowDefinition",
  id,
  name: id,
  version: "1.0.0",
  ...io,
  steps: [],
});
const reg = (id: string, runner: FlowRunner<unknown, unknown>): RegisteredFlow =>
  ({ definition: def(id), runner }) as RegisteredFlow;

// A child that parks forever (non-terminal until something cancels it).
const waiter = reg("waiter", async (ctx) => {
  await ctx.suspend({ on: "never" });
  return {};
});
// Awaits one child (`detached` per input), then completes.
const parent = reg("parent", async (ctx, input) => {
  const detached = (input as { detached?: boolean } | undefined)?.detached === true;
  await awaitChild(ctx, { key: "c", flowId: "waiter", input: {}, ...(detached && { detached }) });
  return {};
});
// Awaits a GROUP: member 0 attached, member 1 detached.
const groupParent = reg("group-parent", async (ctx) => {
  await awaitChildren(ctx, {
    key: "g",
    children: [
      { flowId: "waiter", input: {} },
      { flowId: "waiter", input: {}, detached: true },
    ],
  });
  return {};
});
// Awaits a GROUP of three attached members.
const trioParent = reg("trio-parent", async (ctx) => {
  await awaitChildren(ctx, {
    key: "t",
    children: [
      { flowId: "waiter", input: {} },
      { flowId: "waiter", input: {} },
      { flowId: "waiter", input: {} },
    ],
  });
  return {};
});
// Nested: the child is itself a parent.
const middle = reg("middle", async (ctx) => {
  await awaitChild(ctx, { key: "leaf", flowId: "waiter", input: {} });
  return {};
});
const top = reg("top", async (ctx) => {
  await awaitChild(ctx, { key: "mid", flowId: "middle", input: {} });
  return {};
});

function build() {
  const holder: { supervisor?: ChildSupervisor } = {};
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onEvent: (e) => holder.supervisor?.onEvent(e),
  });
  const flows = {
    waiter,
    parent,
    "group-parent": groupParent,
    "trio-parent": trioParent,
    middle,
    top,
  };
  for (const f of Object.values(flows)) {
    runtime.registerFlow(f.definition, f.runner as FlowRunner<unknown, unknown>);
  }
  const wire = () => {
    holder.supervisor = superviseChildren({ runtime, flows });
    return holder.supervisor;
  };
  return { runtime, holder, wire };
}

async function until(pred: () => Promise<boolean>, tries = 400): Promise<void> {
  for (let i = 0; i < tries && !(await pred()); i++) await new Promise((r) => setTimeout(r, 5));
}
const statusOf = async (rt: WorkflowRuntime, id: string) => (await rt.loadState(id))?.status;
const parked = async (rt: WorkflowRuntime, id: string) => (await statusOf(rt, id)) === "suspended";

describe("cancel cascade (ADR 0112 D5)", () => {
  it("cancelling a parent cancels the child it awaits, with a cascade reason naming the parent", async () => {
    const { runtime, wire } = build();
    wire();
    await runtime.start(parent, {}, { executionId: "p1" });
    await until(async () => (await statusOf(runtime, "p1::c")) === "suspended");
    expect(await statusOf(runtime, "p1::c")).toBe("suspended");
    await runtime.cancel("p1", "operator");
    await until(async () => (await statusOf(runtime, "p1::c")) === "cancelled");
    expect(await statusOf(runtime, "p1::c")).toBe("cancelled");
    const cancelled = (await runtime.events.read("p1::c")).find(
      (e) => e.eventType === "EXECUTION_CANCELLED"
    );
    expect(JSON.parse((cancelled?.payload as { reason: string }).reason)).toEqual({
      kind: "cascade",
      parent: "p1",
    });
  });

  it("is transitive: parent → child → grandchild", async () => {
    const { runtime, wire } = build();
    wire();
    await runtime.start(top, {}, { executionId: "t1" });
    await until(async () => await parked(runtime, "t1::mid::leaf"));
    await runtime.cancel("t1", "operator");
    await until(async () => (await statusOf(runtime, "t1::mid::leaf")) === "cancelled");
    expect(await statusOf(runtime, "t1::mid")).toBe("cancelled");
    expect(await statusOf(runtime, "t1::mid::leaf")).toBe("cancelled");
  });

  it("a detached child survives its parent's cancel", async () => {
    const { runtime, wire } = build();
    wire();
    await runtime.start(parent, { detached: true }, { executionId: "p2" });
    await until(async () => await parked(runtime, "p2::c"));
    await runtime.cancel("p2", "operator");
    await new Promise((r) => setTimeout(r, 100));
    expect(await statusOf(runtime, "p2")).toBe("cancelled");
    expect(await statusOf(runtime, "p2::c")).toBe("suspended"); // untouched
  });

  it("a group: attached members are cancelled, the detached member is not", async () => {
    const { runtime, wire } = build();
    wire();
    await runtime.start(groupParent, {}, { executionId: "g1" });
    await until(
      async () => (await parked(runtime, "g1::g#0")) && (await parked(runtime, "g1::g#1"))
    );
    await runtime.cancel("g1", "operator");
    await until(async () => (await statusOf(runtime, "g1::g#0")) === "cancelled");
    expect(await statusOf(runtime, "g1::g#0")).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 50));
    expect(await statusOf(runtime, "g1::g#1")).toBe("suspended");
  });

  it("cancelling a child never cancels its parent", async () => {
    const { runtime, wire } = build();
    wire();
    await runtime.start(parent, {}, { executionId: "p3" });
    await until(async () => await parked(runtime, "p3::c"));
    await runtime.cancel("p3::c", "operator");
    await new Promise((r) => setTimeout(r, 100));
    expect(await statusOf(runtime, "p3")).not.toBe("cancelled");
  });

  it("an orphan of a parent cancelled where NO supervisor listened is swept by recover(); a detached one is not", async () => {
    const { runtime, holder, wire } = build();
    wire();
    await runtime.start(parent, {}, { executionId: "o1" });
    await runtime.start(parent, { detached: true }, { executionId: "o2" });
    await until(async () => (await parked(runtime, "o1::c")) && (await parked(runtime, "o2::c")));
    // The parents are cancelled with no supervisor wired: the live cascade never runs.
    holder.supervisor = undefined;
    await runtime.cancel("o1", "operator");
    await runtime.cancel("o2", "operator");
    await new Promise((r) => setTimeout(r, 50));
    expect(await statusOf(runtime, "o1::c")).toBe("suspended"); // the orphan
    const supervisor = wire();
    const summary = await supervisor.recover();
    expect(summary.cascaded).toBe(1);
    expect(await statusOf(runtime, "o1::c")).toBe("cancelled");
    expect(await statusOf(runtime, "o2::c")).toBe("suspended"); // detached: untouched
    // Idempotent: a second pass finds nothing to do.
    expect((await supervisor.recover()).cascaded).toBe(0);
  });

  it("recover() reads a gone parent's log ONCE per pass, however many orphans it left", async () => {
    const { runtime, holder, wire } = build();
    wire();
    await runtime.start(trioParent, {}, { executionId: "m1" });
    await until(
      async () =>
        (await parked(runtime, "m1::t#0")) &&
        (await parked(runtime, "m1::t#1")) &&
        (await parked(runtime, "m1::t#2"))
    );
    holder.supervisor = undefined;
    await runtime.cancel("m1", "operator");
    await new Promise((r) => setTimeout(r, 50));
    const supervisor = wire();
    let parentReads = 0;
    const events = runtime.events as unknown as { read: (id: string, ...a: unknown[]) => unknown };
    const realRead = events.read.bind(events);
    events.read = (id: string, ...a: unknown[]) => {
      if (id === "m1") parentReads++;
      return realRead(id, ...a);
    };
    const summary = await supervisor.recover();
    expect(summary.cascaded).toBe(3);
    // One read of the parent's recorded spawns for the whole pass (not one per orphan).
    expect(parentReads).toBeLessThanOrEqual(1);
  });
});
