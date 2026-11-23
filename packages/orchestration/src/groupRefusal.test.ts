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
import { type ChildResult, awaitChildren, superviseChildren } from "./orchestration";

// R33 (T15): a group member's mint refused DURING RECOVERY must not leave the members that already started
// running (they would spend a lease nobody awaits): they are cancelled through the ADR 0112 cascade, and the
// members that never started return their reservation.
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
const reg = (id: string, runner: FlowRunner<unknown, unknown>): RegisteredFlow =>
  ({ definition: def(id), runner }) as RegisteredFlow;

const waiter: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) => {
  await ctx.suspend({ on: "never" }); // runs until something cancels it
  return {};
};
const group: FlowRunner<unknown, unknown> = async (ctx) =>
  awaitChildren(ctx, {
    key: "g",
    children: [
      { flowId: "waiter", input: {}, lease: { w: 2 }, leaseParent: "task-P" },
      { flowId: "late", input: {}, lease: { w: 3 }, leaseParent: "task-P" },
    ],
  });

async function until(pred: () => Promise<boolean>): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > 20_000) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("a refused group mint during recovery (R33)", () => {
  it("cancels the members that already started, returns the others' reservations, and the parent sees all failed", async () => {
    const holder: { sup?: ReturnType<typeof superviseChildren> } = {};
    const runtime = new WorkflowRuntime({
      effectRuntime: new EffectRuntime([]),
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      onWarn: () => {},
      onEvent: (e) => holder.sup?.onEvent(e),
    });
    runtime.registerFlow(def("parent"), group);
    runtime.registerFlow(def("waiter"), waiter);
    runtime.registerFlow(def("late"), waiter);
    const status = async (id: string) => (await runtime.loadState(id))?.status;

    // supervisor 1 knows only `waiter`: member 0 starts, member 1 has no flow (the crash stand-in)
    const mint = async (_p: unknown, s: { childId: string }) => ({ actor: s.childId });
    holder.sup = superviseChildren({
      runtime,
      flows: { waiter: reg("waiter", waiter) },
      taskAuthority: { mintChildGrant: mint, settleChild: async () => {} },
      onError: () => {},
    });
    await runtime.start(reg("parent", group) as never, {}, { executionId: "P" });
    await until(async () => (await status("P::g#0")) === "suspended");
    expect(await runtime.loadState("P::g#1")).toBeNull();

    // supervisor 2 (a restart) refuses member 1's mint
    const unstarted: [string, string][] = [];
    const errors: unknown[] = [];
    holder.sup = superviseChildren({
      runtime,
      flows: { waiter: reg("waiter", waiter), late: reg("late", waiter) },
      taskAuthority: {
        mintChildGrant: async (p, s) => {
          if (s.childId === "P::g#1") throw new Error("over the headroom");
          return mint(p, s);
        },
        settleChild: async () => {},
        settleUnstarted: async (c, p) => {
          unstarted.push([c, p]);
        },
      },
      onError: (e) => errors.push(e),
    });
    await holder.sup.recover();

    await until(async () => (await status("P")) === "completed");
    const out = (await runtime.loadState("P"))?.variables._output as ChildResult[];
    expect(out.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(await status("P::g#0")).toBe("cancelled"); // before R33 it kept running
    expect(await runtime.loadState("P::g#1")).toBeNull();
    expect(unstarted).toEqual([["P::g#1", "task-P"]]); // only the never-started member returns its reservation
    expect(String(errors[0])).toMatch(/over the headroom/);
  }, 30_000);
});
