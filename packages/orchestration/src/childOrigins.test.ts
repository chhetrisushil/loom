import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { awaitChild, superviseChildren } from "./orchestration";

// ADR 0150 D7 / S-R9: a child's seen origins reach the parent on the CHILD_DONE body.
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
const tainted = (value: unknown, origin: string) => ({ __loomTainted: { origin }, value });
const task = { _tag: "TaskDefinition", kind: "tool", id: "p", toolId: "probe" } as never;

const taintTask = { _tag: "TaskDefinition", kind: "tool", id: "t", toolId: "taint" } as never;

// The child is shown the origin by an EFFECT result (its input is clean: a spawn input would reach the parent
// anyway, through the parent's own recorded spawn decision).
function boot(gate: boolean, childOrigin: string | undefined) {
  const seen: { list: readonly string[] | undefined }[] = [];
  const effects = new EffectRuntime();
  effects.register(
    "probe",
    new ToolEffect(async (_i: unknown, ctx) => {
      seen.push({ list: ctx.seenOrigins?.() });
      return 1;
    })
  );
  effects.register(
    "taint",
    new ToolEffect(async () => (childOrigin === undefined ? "plain" : tainted("x", childOrigin)))
  );
  const holder: { sup?: ReturnType<typeof superviseChildren> } = {};
  const store = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    effectRuntime: effects,
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    ...(gate && { seenOriginsEnabled: true }),
    onWarn: () => {},
    onEvent: (e) => holder.sup?.onEvent(e),
  });
  const child: FlowRunner<unknown, unknown> = async (ctx) => {
    await ctx.run(taintTask, {});
    return "ok";
  };
  const parent: FlowRunner<unknown, unknown> = async (ctx) => {
    await awaitChild(ctx, { key: "k", flowId: "child", input: {} });
    await ctx.run(task, {});
    return "done";
  };
  runtime.registerFlow(def("child"), child);
  runtime.registerFlow(def("parent"), parent);
  holder.sup = superviseChildren({
    runtime,
    flows: { child: { definition: def("child"), runner: child } as RegisteredFlow },
    onError: () => {},
  });
  const run = () =>
    runtime.start({ definition: def("parent"), runner: parent } as never, {}, { executionId: "P" });
  return { run, seen, store };
}
const until = async (c: () => boolean) => {
  for (let i = 0; i < 400 && !c(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!c()) throw new Error("timeout");
};

describe("CHILD_DONE carries the child's seen origins", () => {
  it("the parent's next effect sees the origin its child was shown", async () => {
    const h = boot(true, "lineage:A");
    await h.run();
    await until(() => h.seen.length === 1);
    expect(h.seen[0]?.list).toContain("lineage:A");
  });

  // kills: an implementation that taints every CHILD_DONE (a clean child must not poison the parent)
  it("a clean child adds no origin and no childOrigins key", async () => {
    const h = boot(true, undefined);
    await h.run();
    await until(() => h.seen.length === 1);
    expect(h.seen[0]?.list).toEqual([]);
    const done = (await h.store.read("P")).find((e) => e.eventType === "EXECUTION_RESUMED");
    expect(JSON.stringify(done?.payload)).not.toContain("childOrigins");
  });

  // kills: reading the child's set when the gate is off (untracked child: absent key, nothing added, byte-identical)
  it("untracked runs (gate off) add nothing", async () => {
    const h = boot(false, "lineage:A");
    await h.run();
    await until(() => h.seen.length === 1);
    expect(h.seen[0]?.list).toBeUndefined();
    const done = (await h.store.read("P")).find((e) => e.eventType === "EXECUTION_RESUMED");
    expect(JSON.stringify(done?.payload)).not.toContain("childOrigins");
  });
});
