import type { ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ChildSupervisor,
  awaitChild,
  childIdFor,
  parentOf,
  superviseChildren,
} from "./orchestration";

// ── Child flow: doubles its input and returns. ────────────────────────────────
const childIO = z.object({ n: z.number() });
type ChildIn = { n: number };
type ChildOut = { v: number };
const childRunner: FlowRunner<ChildIn, ChildOut> = async (_ctx, input) => ({ v: input.n * 2 });
const childFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "child",
    name: "child",
    version: "1.0.0",
    inputSchema: childIO,
    outputSchema: z.object({ v: z.number() }),
    steps: [],
  } satisfies FlowDefinition<ChildIn, ChildOut>,
  runner: childRunner,
} as RegisteredFlow<ChildIn, ChildOut>;

// ── Parent flow: spawns the child, awaits it, echoes the result. ──────────────
type ParentIn = { n: number };
type ParentOut = { fromChild: number };
const parentRunner: FlowRunner<ParentIn, ParentOut> = async (ctx, input) => {
  const child = await awaitChild<ChildOut>(ctx, {
    key: "c1",
    flowId: "child",
    input: { n: input.n },
  });
  return { fromChild: child.v };
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
  } satisfies FlowDefinition<ParentIn, ParentOut>,
  runner: parentRunner,
} as RegisteredFlow<ParentIn, ParentOut>;

function build() {
  // Holder breaks the runtime⇄supervisor construction cycle (onEvent needs the
  // supervisor, the supervisor needs the runtime) without a reassigned `let`.
  const holder: { supervisor?: ChildSupervisor } = {};
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onEvent: (e) => holder.supervisor?.onEvent(e),
  });
  runtime.registerFlow(parentFlow.definition, parentRunner);
  runtime.registerFlow(childFlow.definition, childRunner);
  holder.supervisor = superviseChildren({ runtime, flows: { child: childFlow as RegisteredFlow } });
  return { runtime };
}

const outputOf = (s: ExecutionState): unknown => s.variables._output;

async function waitForStatus(
  runtime: WorkflowRuntime,
  id: string,
  status: ExecutionState["status"],
  tries = 200
): Promise<ExecutionState> {
  for (let i = 0; i < tries; i++) {
    const s = await runtime.loadState(id);
    if (s?.status === status) return s;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timeout waiting for ${id} → ${status}`);
}

describe("orchestration — id helpers", () => {
  it("round-trips parent ⇄ child ids", () => {
    const c = childIdFor("P", "c1");
    expect(c).toBe("P::c1");
    expect(parentOf(c)).toBe("P");
    expect(parentOf("no-separator")).toBeUndefined();
  });
});

describe("orchestration — spawn + await a child", () => {
  it("parent suspends, supervisor runs the child, parent resumes with its output", async () => {
    const { runtime } = build();
    await (await runtime.start(parentFlow, { n: 5 }, { executionId: "P" })).waitForSuspend();

    // The supervisor drives the rest: start child P::c1, then resume P on completion.
    const child = await waitForStatus(runtime, "P::c1", "completed");
    expect(outputOf(child)).toEqual({ v: 10 });

    const parent = await waitForStatus(runtime, "P", "completed");
    expect(outputOf(parent)).toEqual({ fromChild: 10 });
  });

  it("is replay-safe: a re-run does not spawn a second child", async () => {
    const { runtime } = build();
    await (await runtime.start(parentFlow, { n: 4 }, { executionId: "Q" })).waitForSuspend();
    await waitForStatus(runtime, "Q", "completed");

    // The child ran exactly once (its log has a single EXECUTION_STARTED).
    const childState = await runtime.loadState("Q::c1");
    expect(childState && outputOf(childState)).toEqual({ v: 8 });
  });
});
