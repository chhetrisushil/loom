import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import { TypedFailure } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CHILD_FAILED,
  type ChildResult,
  type ChildSupervisor,
  awaitAll,
  awaitChildren,
  superviseChildren,
} from "./orchestration";

// ── Child: doubles `n`, optionally after `delayMs` (so completion order can be made
//    to differ from input order) and optionally throwing (to exercise settled failure). ──
type ChildIn = { n: number; delayMs?: number | undefined; boom?: boolean | undefined };
type ChildOut = { v: number };
const childRunner: FlowRunner<ChildIn, ChildOut> = async (_ctx, input) => {
  if (input.delayMs) await new Promise((r) => setTimeout(r, input.delayMs));
  if (input.boom) throw new Error(`boom(${input.n})`);
  return { v: input.n * 2 };
};
const childFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "child",
    name: "child",
    version: "1.0.0",
    inputSchema: z.object({
      n: z.number(),
      delayMs: z.number().optional(),
      boom: z.boolean().optional(),
    }),
    outputSchema: z.object({ v: z.number() }),
    steps: [],
  } satisfies FlowDefinition<ChildIn, ChildOut>,
  runner: childRunner,
} as RegisteredFlow<ChildIn, ChildOut>;

// ── Parent: fans out over `items`, awaits them all, returns their SETTLED results. ──
type ParentIn = { items: ChildIn[] };
type ParentOut = { results: ChildResult<ChildOut>[] };
const parentRunner: FlowRunner<ParentIn, ParentOut> = async (ctx, input) => {
  const results = await awaitChildren<ChildOut>(ctx, {
    key: "g",
    children: input.items.map((it) => ({ flowId: "child", input: it })),
  });
  return { results };
};
const parentFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "parent",
    name: "parent",
    version: "1.0.0",
    inputSchema: z.object({
      items: z.array(
        z.object({ n: z.number(), delayMs: z.number().optional(), boom: z.boolean().optional() })
      ),
    }),
    outputSchema: z.object({ results: z.array(z.any()) }),
    steps: [],
  } satisfies FlowDefinition<ParentIn, ParentOut>,
  runner: parentRunner,
} as RegisteredFlow<ParentIn, ParentOut>;

// ── allParent: awaitAll (all-or-nothing) → unwrapped values, or catches childFailed. ──
type AllOut = { vs: number[]; failedIndex: number };
const allRunner: FlowRunner<ParentIn, AllOut> = async (ctx, input) => {
  try {
    const vs = await awaitAll<ChildOut>(ctx, {
      key: "g",
      children: input.items.map((it) => ({ flowId: "child", input: it })),
    });
    return { vs: vs.map((o) => o.v), failedIndex: -1 };
  } catch (err) {
    if (err instanceof TypedFailure && err.channel === CHILD_FAILED) {
      return { vs: [], failedIndex: (err.payload as { index: number }).index };
    }
    throw err;
  }
};
const allFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "all",
    name: "all",
    version: "1.0.0",
    inputSchema: parentFlow.definition.inputSchema,
    outputSchema: z.object({ vs: z.array(z.number()), failedIndex: z.number() }),
    steps: [],
  } satisfies FlowDefinition<ParentIn, AllOut>,
  runner: allRunner,
} as RegisteredFlow<ParentIn, AllOut>;

function build(eventStore: EventStore = new InMemoryAsyncEventStore()) {
  const holder: { supervisor?: ChildSupervisor } = {};
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onEvent: (e) => holder.supervisor?.onEvent(e),
  });
  runtime.registerFlow(parentFlow.definition, parentRunner);
  runtime.registerFlow(allFlow.definition, allRunner);
  runtime.registerFlow(childFlow.definition, childRunner);
  holder.supervisor = superviseChildren({ runtime, flows: { child: childFlow as RegisteredFlow } });
  return runtime;
}

const outputOf = (s: ExecutionState): unknown => s.variables._output;
const resultsOf = (s: ExecutionState): ChildResult<ChildOut>[] =>
  (outputOf(s) as ParentOut).results;

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
  subscribe(...args: Parameters<EventStore["subscribe"]>) {
    return this.inner.subscribe(...args);
  }
  close() {
    return this.inner.close();
  }
}

describe("awaitChildren — parallel children (wait-all settled)", () => {
  it("settles every child, resumes once with results in INPUT order (not completion order)", async () => {
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
    expect(resultsOf(parent)).toEqual([
      { status: "completed", output: { v: 2 } },
      { status: "completed", output: { v: 4 } },
      { status: "completed", output: { v: 6 } },
    ]);
  }, 20000);

  it("weathers a partial failure: the failed member settles as `failed`, the rest complete", async () => {
    const rt = build();
    await rt.start(
      parentFlow,
      { items: [{ n: 1 }, { n: 2, boom: true }, { n: 3 }] },
      { executionId: "PF" }
    );
    // Wait-all: the parent still COMPLETES (no throw) — the failure is data, not an exception.
    const parent = await waitForStatus(rt, "PF", "completed");
    const results = resultsOf(parent);
    expect(results[0]).toEqual({ status: "completed", output: { v: 2 } });
    expect(results[1]?.status).toBe("failed");
    expect((results[1] as { error: string }).error).toMatch(/boom\(2\)/);
    expect(results[2]).toEqual({ status: "completed", output: { v: 6 } });
  }, 20000);

  it("resolves to [] for an empty group without ever suspending", async () => {
    const rt = build();
    await rt.start(parentFlow, { items: [] }, { executionId: "E" });
    const parent = await waitForStatus(rt, "E", "completed");
    expect(resultsOf(parent)).toEqual([]);
  });

  it("is replay-safe: a recovery re-run does not spawn a second fan-out", async () => {
    const rt = build();
    await rt.start(parentFlow, { items: [{ n: 4 }, { n: 5 }] }, { executionId: "R" });
    await waitForStatus(rt, "R", "completed");

    // Each child log holds a single EXECUTION_STARTED — the group was fixed by one decision.
    for (const i of [0, 1]) {
      const events = await (rt as unknown as { eventStore: EventStore }).eventStore.read(
        `R::g#${i}`
      );
      expect(events.filter((e) => e.eventType === "EXECUTION_STARTED")).toHaveLength(1);
    }
  }, 20000);

  it("does not strand the parent when instant children outrun the suspend write", async () => {
    const rt = build(new SlowAppendStore());
    // No delays → children complete almost instantly, N of them racing ONE suspend.
    await rt.start(parentFlow, { items: [{ n: 1 }, { n: 2 }, { n: 3 }] }, { executionId: "S1" });
    const parent = await waitForStatus(rt, "S1", "completed");
    expect(resultsOf(parent).map((r) => (r.status === "completed" ? r.output.v : null))).toEqual([
      2, 4, 6,
    ]);
  }, 20000);
});

describe("awaitAll — all-or-nothing fan-out", () => {
  it("returns unwrapped outputs in input order when every child completes", async () => {
    const rt = build();
    await rt.start(allFlow, { items: [{ n: 1 }, { n: 2 }, { n: 3 }] }, { executionId: "A" });
    const parent = await waitForStatus(rt, "A", "completed");
    expect(outputOf(parent)).toEqual({ vs: [2, 4, 6], failedIndex: -1 });
  }, 20000);

  it("throws childFailed (first failure, by index) if any member fails", async () => {
    const rt = build();
    await rt.start(
      allFlow,
      { items: [{ n: 1 }, { n: 2, boom: true }, { n: 3 }] },
      { executionId: "AF" }
    );
    // The parent caught the throw and recorded which index failed (still WAITED for all).
    const parent = await waitForStatus(rt, "AF", "completed");
    expect(outputOf(parent)).toEqual({ vs: [], failedIndex: 1 });
  }, 20000);

  it("an uncaught awaitAll failure fails the parent", async () => {
    const holder: { supervisor?: ChildSupervisor } = {};
    const rt = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      onEvent: (e) => holder.supervisor?.onEvent(e),
    });
    // A parent that does NOT catch: awaitAll's throw escapes and fails it.
    const raw: FlowRunner<ParentIn, { vs: number[] }> = async (ctx, input) => {
      const vs = await awaitAll<ChildOut>(ctx, {
        key: "g",
        children: input.items.map((it) => ({ flowId: "child", input: it })),
      });
      return { vs: vs.map((o) => o.v) };
    };
    const rawFlow = {
      definition: {
        _tag: "FlowDefinition",
        id: "rawall",
        name: "rawall",
        version: "1.0.0",
        inputSchema: parentFlow.definition.inputSchema,
        outputSchema: z.object({ vs: z.array(z.number()) }),
        steps: [],
      } satisfies FlowDefinition<ParentIn, { vs: number[] }>,
      runner: raw,
    } as RegisteredFlow<ParentIn, { vs: number[] }>;
    rt.registerFlow(rawFlow.definition, raw);
    rt.registerFlow(childFlow.definition, childRunner);
    holder.supervisor = superviseChildren({
      runtime: rt,
      flows: { child: childFlow as RegisteredFlow },
    });

    await rt.start(rawFlow, { items: [{ n: 1 }, { n: 2, boom: true }] }, { executionId: "AR" });
    const parent = await waitForStatus(rt, "AR", "failed");
    expect(parent.status).toBe("failed");
  }, 20000);
});

// ── Nested fan-out: a group member is itself a group parent that TOLERATES a failing
//    grandchild via settled results. Proves ids compose (`T::g#0::g#1`), depth deepens,
//    reclaim survives nesting, and a partial failure stays contained at the level that
//    inspects it. ──
type MidIn = { base: number; boomSecond?: boolean | undefined };
type MidOut = { sum: number; failures: number };
const midRunner: FlowRunner<MidIn, MidOut> = async (ctx, input) => {
  const results = await awaitChildren<ChildOut>(ctx, {
    key: "g",
    children: [
      { flowId: "child", input: { n: input.base } },
      { flowId: "child", input: { n: input.base + 1, boom: input.boomSecond } },
    ],
  });
  // The mid decides what a partial failure means: sum the completed, count the failed.
  const sum = results.reduce((a, r) => (r.status === "completed" ? a + r.output.v : a), 0);
  const failures = results.filter((r) => r.status !== "completed").length;
  return { sum, failures };
};
const midFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "mid",
    name: "mid",
    version: "1.0.0",
    inputSchema: z.object({ base: z.number(), boomSecond: z.boolean().optional() }),
    outputSchema: z.object({ sum: z.number(), failures: z.number() }),
    steps: [],
  } satisfies FlowDefinition<MidIn, MidOut>,
  runner: midRunner,
} as RegisteredFlow<MidIn, MidOut>;

type TopOut = { mids: ChildResult<MidOut>[] };
const topRunner: FlowRunner<Record<string, never>, TopOut> = async (ctx) => {
  const mids = await awaitChildren<MidOut>(ctx, {
    key: "g",
    children: [
      { flowId: "mid", input: { base: 10 } },
      { flowId: "mid", input: { base: 20, boomSecond: true } },
    ],
  });
  return { mids };
};
const topFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "top",
    name: "top",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({ mids: z.array(z.any()) }),
    steps: [],
  } satisfies FlowDefinition<Record<string, never>, TopOut>,
  runner: topRunner,
} as RegisteredFlow<Record<string, never>, TopOut>;

describe("awaitChildren — nested fan-out with contained failure", () => {
  it("composes: a partial grandchild failure stays contained at the mid that inspects it", async () => {
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
    const mids = (outputOf(top) as TopOut).mids;
    // mid(10): (10*2)+(11*2)=42, 0 failures ; mid(20): 20*2=40 (grandchild 21 boomed), 1 failure.
    expect(mids[0]).toEqual({ status: "completed", output: { sum: 42, failures: 0 } });
    expect(mids[1]).toEqual({ status: "completed", output: { sum: 40, failures: 1 } });

    // The boomed grandchild (depth 2) settled as failed under its immediate mid parent;
    // its mid still COMPLETED (contained), so top saw a completed mid, not a failure.
    const grandchild = await rt.loadState("T::g#1::g#1");
    expect(grandchild?.status).toBe("failed");
  }, 20000);
});
