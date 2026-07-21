import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ChildSupervisor, awaitChildren, superviseChildren } from "./orchestration";

// ── Child: doubles `n`, optionally after `delayMs` so completion order can be
//    made to differ from input order (proves the aggregation is index-ordered). ──
type ChildIn = { n: number; delayMs?: number };
type ChildOut = { v: number };
const childRunner: FlowRunner<ChildIn, ChildOut> = async (_ctx, input) => {
  if (input.delayMs) await new Promise((r) => setTimeout(r, input.delayMs));
  return { v: input.n * 2 };
};
const childFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "child",
    name: "child",
    version: "1.0.0",
    inputSchema: z.object({ n: z.number(), delayMs: z.number().optional() }),
    outputSchema: z.object({ v: z.number() }),
    steps: [],
  } satisfies FlowDefinition<ChildIn, ChildOut>,
  runner: childRunner,
} as RegisteredFlow<ChildIn, ChildOut>;

// ── Parent: fans out over `items`, awaits them all, returns their doubled values. ──
type ParentIn = { items: ChildIn[] };
type ParentOut = { vs: number[] };
const parentRunner: FlowRunner<ParentIn, ParentOut> = async (ctx, input) => {
  const outs = await awaitChildren<ChildOut>(ctx, {
    key: "g",
    children: input.items.map((it) => ({ flowId: "child", input: it })),
  });
  return { vs: outs.map((o) => o.v) };
};
const parentFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "parent",
    name: "parent",
    version: "1.0.0",
    inputSchema: z.object({
      items: z.array(z.object({ n: z.number(), delayMs: z.number().optional() })),
    }),
    outputSchema: z.object({ vs: z.array(z.number()) }),
    steps: [],
  } satisfies FlowDefinition<ParentIn, ParentOut>,
  runner: parentRunner,
} as RegisteredFlow<ParentIn, ParentOut>;

function build(eventStore: EventStore = new InMemoryAsyncEventStore()) {
  const holder: { supervisor?: ChildSupervisor } = {};
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onEvent: (e) => holder.supervisor?.onEvent(e),
  });
  runtime.registerFlow(parentFlow.definition, parentRunner);
  runtime.registerFlow(childFlow.definition, childRunner);
  holder.supervisor = superviseChildren({ runtime, flows: { child: childFlow as RegisteredFlow } });
  return runtime;
}

const outputOf = (s: ExecutionState): unknown => s.variables._output;

async function waitForStatus(
  rt: WorkflowRuntime,
  id: string,
  status: ExecutionState["status"],
  tries = 400
): Promise<ExecutionState> {
  for (let i = 0; i < tries; i++) {
    const s = await rt.loadState(id);
    if (s?.status === status) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timeout waiting for ${id} → ${status} (last=${(await rt.loadState(id))?.status})`
  );
}

// A store that DELAYS append, reproducing the drain lag that lets an instant child
// outrun its parent's suspend write (the durability race, now multiplied by N).
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

describe("awaitChildren — parallel children", () => {
  it("spawns every child, resumes once with outputs in INPUT order (not completion order)", async () => {
    const rt = build();
    // Delays fall as n rises, so completion order is the REVERSE of input order —
    // a passing index-ordered result therefore can't be an accident of timing.
    const items = [
      { n: 1, delayMs: 30 },
      { n: 2, delayMs: 20 },
      { n: 3, delayMs: 10 },
    ];
    await rt.start(parentFlow, { items }, { executionId: "P" });

    const parent = await waitForStatus(rt, "P", "completed");
    expect(outputOf(parent)).toEqual({ vs: [2, 4, 6] });

    // All three child executions ran, each exactly once.
    for (let i = 0; i < 3; i++) {
      const child = await rt.loadState(`P::g#${i}`);
      expect(child && outputOf(child)).toEqual({ v: items[i]!.n * 2 });
    }
  }, 20000);

  it("resolves to [] for an empty group without ever suspending", async () => {
    const rt = build();
    await rt.start(parentFlow, { items: [] }, { executionId: "E" });
    const parent = await waitForStatus(rt, "E", "completed");
    expect(outputOf(parent)).toEqual({ vs: [] });
  });

  it("is replay-safe: a recovery re-run does not spawn a second fan-out", async () => {
    const rt = build();
    await rt.start(parentFlow, { items: [{ n: 4 }, { n: 5 }] }, { executionId: "R" });
    await waitForStatus(rt, "R", "completed");

    // Each child log holds a single EXECUTION_STARTED — the group was fixed by one decision.
    for (const [i, n] of [4, 5].entries()) {
      const log = await rt.loadState(`R::g#${i}`);
      expect(log && outputOf(log)).toEqual({ v: n * 2 });
      const events = await (rt as unknown as { eventStore: EventStore }).eventStore.read(
        `R::g#${i}`
      );
      expect(events.filter((e) => e.eventType === "EXECUTION_STARTED")).toHaveLength(1);
    }
  }, 20000);

  it("does not strand the parent when instant children outrun the suspend write", async () => {
    const rt = build(new SlowAppendStore() as unknown as EventStore);
    // No delays → children complete almost instantly, N of them racing ONE suspend.
    await rt.start(parentFlow, { items: [{ n: 1 }, { n: 2 }, { n: 3 }] }, { executionId: "S1" });
    const parent = await waitForStatus(rt, "S1", "completed");
    expect(outputOf(parent)).toEqual({ vs: [2, 4, 6] });
  }, 20000);
});

// ── Nested fan-out: a group member is itself a group parent. Proves ids compose
//    (`T::g#0::g#1`), depth deepens per level, and reclaim survives nesting. ──
type MidIn = { base: number };
type MidOut = { sum: number };
const midRunner: FlowRunner<MidIn, MidOut> = async (ctx, input) => {
  const outs = await awaitChildren<ChildOut>(ctx, {
    key: "g",
    children: [
      { flowId: "child", input: { n: input.base } },
      { flowId: "child", input: { n: input.base + 1 } },
    ],
  });
  return { sum: outs.reduce((a, o) => a + o.v, 0) };
};
const midFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "mid",
    name: "mid",
    version: "1.0.0",
    inputSchema: z.object({ base: z.number() }),
    outputSchema: z.object({ sum: z.number() }),
    steps: [],
  } satisfies FlowDefinition<MidIn, MidOut>,
  runner: midRunner,
} as RegisteredFlow<MidIn, MidOut>;

type TopOut = { sums: number[] };
const topRunner: FlowRunner<Record<string, never>, TopOut> = async (ctx) => {
  const outs = await awaitChildren<MidOut>(ctx, {
    key: "g",
    children: [
      { flowId: "mid", input: { base: 10 } },
      { flowId: "mid", input: { base: 20 } },
    ],
  });
  return { sums: outs.map((o) => o.sum) };
};
const topFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "top",
    name: "top",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({ sums: z.array(z.number()) }),
    steps: [],
  } satisfies FlowDefinition<Record<string, never>, TopOut>,
  runner: topRunner,
} as RegisteredFlow;

describe("awaitChildren — nested fan-out", () => {
  it("composes: a group whose members each fan out again resolves bottom-up in order", async () => {
    const holder: { supervisor?: ChildSupervisor } = {};
    const rt = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      onEvent: (e) => holder.supervisor?.onEvent(e),
    });
    rt.registerFlow(topFlow.definition, topRunner);
    rt.registerFlow(midFlow.definition, midRunner);
    rt.registerFlow(childFlow.definition, childRunner);
    holder.supervisor = superviseChildren({
      runtime: rt,
      flows: { mid: midFlow as RegisteredFlow, child: childFlow as RegisteredFlow },
    });

    await rt.start(topFlow, {}, { executionId: "T" });
    const top = await waitForStatus(rt, "T", "completed");
    // mid(10) = (10*2)+(11*2) = 42 ; mid(20) = (20*2)+(21*2) = 82 — in input order.
    expect(outputOf(top)).toEqual({ sums: [42, 82] });

    // A grandchild executed at depth 2 under its immediate mid parent.
    const grandchild = await rt.loadState("T::g#0::g#1");
    expect(grandchild && outputOf(grandchild)).toEqual({ v: 22 });
  }, 20000);
});
