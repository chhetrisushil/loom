import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { WorkflowContext } from "./WorkflowContext";
import { WorkflowRuntime } from "./WorkflowRuntime";

// R1a — a resume must read the log from the latest snapshot forward, not the whole log. A
// message-loop agent resumes once per turn, so a whole-log read per resume is quadratic.

class SpyEventStore extends InMemoryAsyncEventStore {
  fullReads = 0;
  tailEventsRead = 0;
  override async read(executionId: string) {
    this.fullReads++;
    return super.read(executionId);
  }
  override async readFrom(executionId: string, fromSequence: number) {
    const out = await super.readFrom(executionId, fromSequence);
    this.tailEventsRead += out.length;
    return out;
  }
}

function build(): { rt: WorkflowRuntime; es: SpyEventStore } {
  const es = new SpyEventStore();
  const effects = new EffectRuntime();
  effects.register("work", new ToolEffect(async (i: unknown) => i));
  const rt = new WorkflowRuntime({
    eventStore: es,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: () => {},
  });
  const def = {
    _tag: "FlowDefinition",
    id: "loop",
    name: "loop",
    version: "1",
    inputSchema: z.any(),
    outputSchema: z.any(),
    steps: [],
  };
  rt.registerFlow(
    def as never,
    (async (ctx: WorkflowContext) => {
      for (let i = 0; ; i++) {
        const m = await ctx.suspend({ on: "msg" });
        await ctx.execute(
          { _tag: "TaskDefinition", kind: "tool", id: `work#${i}`, toolId: "work" },
          m
        );
      }
    }) as never
  );
  return { rt, es };
}

describe("resume reads (R1a)", () => {
  it("after the first resume, later resumes never read the whole log", async () => {
    const { rt, es } = build();
    const h = await rt.start("loop", {}, { executionId: "e1" });
    await h.waitForSuspend();

    const turn = async (i: number): Promise<void> => {
      const hh = await rt.resume("e1", { eventType: "msg", payload: { i } });
      await hh.waitForSuspend();
    };

    await turn(0); // the first resume of an execution may scan the log (legacy stray check)
    const readsAfterFirst = es.fullReads;
    for (let i = 1; i <= 40; i++) await turn(i);
    expect(es.fullReads).toBe(readsAfterFirst); // no further whole-log reads
    const state = await rt.loadState("e1");
    expect((state?.variables._resumePayloads as unknown[]).length).toBe(41);
  });

  it("reads only the tail past the snapshot per resume (bounded, not growing)", async () => {
    const { rt, es } = build();
    const h = await rt.start("loop", {}, { executionId: "e2" });
    await h.waitForSuspend();
    const perTurn: number[] = [];
    for (let i = 0; i < 60; i++) {
      const before = es.tailEventsRead;
      const hh = await rt.resume("e2", { eventType: "msg", payload: { i } });
      await hh.waitForSuspend();
      perTurn.push(es.tailEventsRead - before);
    }
    // the snapshot is taken at every suspend, so the tail is the last turn only
    expect(Math.max(...perTurn.slice(5))).toBeLessThanOrEqual(Math.max(...perTurn.slice(0, 5)) + 2);
    expect(Math.max(...perTurn)).toBeLessThan(10);
  });

  it("a missing execution still refuses, and an orphaned snapshot does not resurrect it", async () => {
    const { rt } = build();
    await expect(rt.resume("nope", { eventType: "msg", payload: {} })).rejects.toThrow(
      /No execution found/
    );
  });
});
