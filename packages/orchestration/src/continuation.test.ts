import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CHILD_DONE,
  type ChildSupervisor,
  awaitChild,
  awaitChildren,
  superviseChildren,
} from "./orchestration";

// ── ADR 0109 D5 / D6 — continue-as-new under the supervisor ──────────────────────────────────
//
// D5: a parent that continues cancels its non-detached children (the R6 cascade, on
// `EXECUTION_CONTINUED`); a detached child survives. D6: a CONTINUED child is "look at the head":
// the supervisor follows `_continuedTo` and settles the original slot from the head's outcome, any
// number of rotations, live (`onEvent`) and from the log (`recover`).

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

const waiter = reg("waiter", async (ctx) => {
  await ctx.suspend({ on: "never" });
  return {};
});

// A child that rotates once when told to `go`, then answers with the generation it finished in.
const rotChild = reg("rot-child", async (ctx, input) => {
  const gen = (input as { gen?: number } | undefined)?.gen ?? 0;
  if (gen === 0) {
    await ctx.receive("go");
    return ctx.continueAsNew({ gen: 1 });
  }
  if (gen === 1) {
    await ctx.receive("go");
    return ctx.continueAsNew({ gen: 2 });
  }
  return { finishedIn: gen };
});

// Awaits one child, then rotates itself (a parent that continues with children still alive).
const rotParent = reg("rot-parent", async (ctx, input) => {
  const i = (input as { gen?: number; detached?: boolean } | undefined) ?? {};
  if (i.gen === undefined) {
    await awaitChild(ctx, {
      key: "c",
      flowId: "waiter",
      input: {},
      ...(i.detached === true && { detached: true }),
    });
    return ctx.continueAsNew({ gen: 1 });
  }
  return "successor";
});

// Awaits a group of two rotating children.
const groupParent = reg("group-parent", async (ctx) => {
  const settled = await awaitChildren(ctx, {
    key: "g",
    children: [
      { flowId: "rot-child", input: {} },
      { flowId: "waiter", input: {}, detached: true },
    ],
  });
  return settled;
});

const awaitsRot = reg("awaits-rot", async (ctx) => {
  const out = await awaitChild(ctx, { key: "c", flowId: "rot-child", input: {} });
  return { got: out };
});

// A child that rotates MANY times in a row once told to `go` (no waiting between generations), then
// parks on `end` at generation 12.
const manyChild = reg("many-child", async (ctx, input) => {
  const gen = (input as { gen?: number } | undefined)?.gen ?? 0;
  if (gen === 0) await ctx.receive("go");
  if (gen < 12) return ctx.continueAsNew({ gen: gen + 1 });
  await ctx.suspend({ on: "end" });
  return { finishedIn: gen };
});
const awaitsMany = reg("awaits-many", async (ctx) => {
  const out = await awaitChild(ctx, { key: "c", flowId: "many-child", input: {} });
  return { got: out };
});

function build(withSupervisor = true, extra: { maxChainHops?: number; errors?: unknown[] } = {}) {
  const holder: { supervisor?: ChildSupervisor } = {};
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    inboxEnabled: true,
    continueAsNewEnabled: true,
    ...(extra.maxChainHops !== undefined && { maxChainHops: extra.maxChainHops }),
    onEvent: (e) => holder.supervisor?.onEvent(e),
  });
  const flows = {
    waiter,
    "rot-child": rotChild,
    "rot-parent": rotParent,
    "awaits-rot": awaitsRot,
    "many-child": manyChild,
    "awaits-many": awaitsMany,
  };
  for (const f of Object.values(flows)) {
    runtime.registerFlow(f.definition, f.runner as FlowRunner<unknown, unknown>);
  }
  runtime.registerFlow(groupParent.definition, groupParent.runner as FlowRunner<unknown, unknown>);
  const allFlows = { ...flows, "group-parent": groupParent };
  const wire = () => {
    holder.supervisor = superviseChildren({
      runtime,
      flows: allFlows,
      ...(extra.errors !== undefined && { onError: (e: unknown) => extra.errors?.push(e) }),
    });
    return holder.supervisor;
  };
  if (withSupervisor) wire();
  return { runtime, holder, wire };
}

async function until(pred: () => Promise<boolean>, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const statusOf = async (rt: WorkflowRuntime, id: string) => (await rt.loadState(id))?.status;
const sys = (rt: WorkflowRuntime) => rt.systemOptions();

describe("D5 — a continuing parent cancels its non-detached children", () => {
  async function continued(detached: boolean) {
    const { runtime } = build();
    const id = detached ? "pd" : "pa";
    await runtime.start(rotParent, { detached }, { executionId: id });
    await until(async () => (await statusOf(runtime, `${id}::c`)) === "suspended");
    // The parent is parked on its child; an operator answers that park by hand, so the parent
    // moves on (and rotates) while the child is still alive.
    await runtime.resume(
      id,
      { eventType: CHILD_DONE, payload: { output: "by hand", viewDigest: `${id}::c` } },
      sys(runtime)
    );
    await until(async () => (await statusOf(runtime, id)) === "continued");
    return { runtime, id };
  }

  it("the attached child is cancelled with a cascade reason naming the parent; the detached one survives", async () => {
    const attached = await continued(false);
    await until(async () => (await statusOf(attached.runtime, "pa::c")) === "cancelled");
    const cancelled = (await attached.runtime.events.read("pa::c")).find(
      (e) => e.eventType === "EXECUTION_CANCELLED"
    );
    expect(JSON.parse((cancelled?.payload as { reason: string }).reason)).toEqual({
      kind: "cascade",
      parent: "pa",
    });

    const detached = await continued(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(await statusOf(detached.runtime, "pd::c")).toBe("suspended"); // outlives the rotation
    // its id (as a successor would carry it) is still addressable: it can be completed by id
    await detached.runtime.cancel("pd::c", "done with it");
    expect(await statusOf(detached.runtime, "pd::c")).toBe("cancelled");
  });
});

describe("D6 — a continued CHILD is followed to its head", () => {
  it("live: the parent resumes with the HEAD's output, however many rotations, never with `continued`", async () => {
    const { runtime } = build();
    await runtime.start(awaitsRot, {}, { executionId: "pr" });
    await until(async () => (await statusOf(runtime, "pr::c")) === "suspended");
    await runtime.send("pr::c", { topic: "go", payload: 1 }, sys(runtime));
    await until(async () => (await statusOf(runtime, "pr::c")) === "continued");
    // the continuation of a child did NOT resume the parent as if the child had finished
    await new Promise((r) => setTimeout(r, 50));
    expect(await statusOf(runtime, "pr")).toBe("suspended");
    await until(async () => (await statusOf(runtime, "pr::c~1")) === "suspended");
    await runtime.send("pr::c", { topic: "go", payload: 2 }, sys(runtime)); // the OLD id still routes
    await until(async () => (await statusOf(runtime, "pr")) === "completed");
    expect((await runtime.loadState("pr"))?.variables._output).toEqual({
      got: { finishedIn: 2 },
    });
    expect(await statusOf(runtime, "pr::c~1")).toBe("continued");
    expect(await statusOf(runtime, "pr::c~2")).toBe("completed");
  });

  it("recover(): a parent whose child's head finished while no supervisor listened is resumed from the log", async () => {
    const { runtime, holder, wire } = build(true);
    await runtime.start(awaitsRot, {}, { executionId: "rc" });
    await until(async () => (await statusOf(runtime, "rc::c")) === "suspended");
    holder.supervisor = undefined; // the supervisor dies
    await runtime.send("rc::c", { topic: "go", payload: 1 }, sys(runtime));
    await until(async () => (await statusOf(runtime, "rc::c~1")) === "suspended");
    await runtime.send("rc::c", { topic: "go", payload: 2 }, sys(runtime));
    await until(async () => (await statusOf(runtime, "rc::c~2")) === "completed");
    expect(await statusOf(runtime, "rc")).toBe("suspended"); // nobody told the parent
    const supervisor = wire();
    await supervisor.recover();
    await until(async () => (await statusOf(runtime, "rc")) === "completed");
    expect((await runtime.loadState("rc"))?.variables._output).toEqual({ got: { finishedIn: 2 } });
  });

  it("a group member that rotates settles its OWN slot from the head, the detached sibling untouched", async () => {
    const { runtime } = build();
    await runtime.start(groupParent, {}, { executionId: "gp" });
    await until(async () => (await statusOf(runtime, "gp::g#0")) === "suspended");
    await runtime.send("gp::g#0", { topic: "go", payload: 1 }, sys(runtime));
    await until(async () => (await statusOf(runtime, "gp::g#0~1")) === "suspended");
    await runtime.send("gp::g#0", { topic: "go", payload: 2 }, sys(runtime));
    await until(async () => (await statusOf(runtime, "gp::g#0~2")) === "completed");
    expect(await statusOf(runtime, "gp")).toBe("suspended"); // member 1 (a waiter) is still out
    await runtime.cancel("gp::g#1", "stop"); // settle it as cancelled: the group is done
    await until(async () => (await statusOf(runtime, "gp")) === "completed");
    const settled = (await runtime.loadState("gp"))?.variables._output as Array<{
      status: string;
      output?: unknown;
    }>;
    expect(settled[0]).toEqual({ status: "completed", output: { finishedIn: 2 } });
    expect(settled[1]?.status).toBe("cancelled");
  });
});

describe("D6 - a child that rotated far more than maxChainHops while no supervisor listened", () => {
  it("recover() follows it to the end and registers the head, so the parent completes (it used to stall at 8 hops)", async () => {
    const { runtime, holder, wire } = build(true);
    await runtime.start(awaitsMany, {}, { executionId: "mp" });
    await until(async () => (await statusOf(runtime, "mp::c")) === "suspended");
    holder.supervisor = undefined; // the supervisor dies
    await runtime.send("mp::c", { topic: "go", payload: 1 }, sys(runtime));
    await until(async () => (await statusOf(runtime, "mp::c~12")) === "suspended");
    const supervisor = wire();
    await supervisor.recover();
    await supervisor.recover(); // a second sweep must not be stuck re-walking the same 8 hops
    expect(await statusOf(runtime, "mp")).toBe("suspended");
    await runtime.resume("mp::c~12", { eventType: "end", payload: 1 }, sys(runtime));
    await until(async () => (await statusOf(runtime, "mp")) === "completed");
    expect((await runtime.loadState("mp"))?.variables._output).toEqual({
      got: { finishedIn: 12 },
    });
  });
});

describe("D6 - an unverifiable deepest generation past the hop bound", () => {
  it("settledOf fails safe: the child stays running, onError hears ChainHopLimitError, recover() does not throw and the parent is not resumed", async () => {
    const errors: unknown[] = [];
    const { runtime, holder, wire } = build(true, { maxChainHops: 2, errors });
    await runtime.start(awaitsMany, {}, { executionId: "sq" });
    await until(async () => (await statusOf(runtime, "sq::c")) === "suspended");
    holder.supervisor = undefined;
    await runtime.send("sq::c", { topic: "go", payload: 1 }, sys(runtime));
    await until(async () => (await statusOf(runtime, "sq::c~12")) === "suspended");
    // a squatter at the deepest id, written straight to the store, naming another execution
    await runtime.events.append({
      id: "sq::c~13-0",
      workflowId: "many-child",
      executionId: "sq::c~13",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: {
        input: {},
        chainId: "sq::c",
        generation: 13,
        continuedFrom: { executionId: "elsewhere" },
      },
    });
    const supervisor = wire();
    await expect(supervisor.recover()).resolves.toBeDefined();
    expect(errors.some((e) => (e as Error).name === "ChainHopLimitError")).toBe(true);
    expect(await statusOf(runtime, "sq")).toBe("suspended");
    expect(await statusOf(runtime, "sq::c~12")).toBe("suspended");
    expect(supervisor.size().started).toBe(1); // still tracked as running: a later sweep retries
  });
});
