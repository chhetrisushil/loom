import { unwrapTainted } from "@loom/classify";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { continueEvery } from "./continueEvery";

describe("continueEvery (ADR 0109 D1)", () => {
  it("is true on every n-th turn and counts from zero per counter", () => {
    const c = continueEvery(3);
    expect([1, 2, 3, 4, 5, 6, 7].map(() => c.turn())).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(c.turns).toBe(7);
    expect(continueEvery(1).turn()).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses n = %s", (n) => {
    expect(() => continueEvery(n)).toThrow(RangeError);
  });

  it("rotates a real message loop: the counter is per generation, the chain keeps going", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const rt = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      inboxEnabled: true,
      continueAsNewEnabled: true,
    });
    const definition = {
      _tag: "FlowDefinition",
      id: "agent-chat",
      name: "agent-chat",
      version: "1.0.0",
      inputSchema: { parse: (x: unknown) => x },
      outputSchema: { parse: (x: unknown) => x },
      steps: [],
    } as unknown as FlowDefinition;
    const runner: FlowRunner<{ total?: number }, unknown> = async (ctx, input) => {
      const turns = continueEvery(2);
      let total = input?.total ?? 0;
      for (;;) {
        unwrapTainted(await ctx.receive("user"));
        total++;
        if (turns.turn()) return ctx.continueAsNew({ total });
      }
    };
    rt.registerFlow(definition, runner as FlowRunner<unknown, unknown>);
    const h = await rt.start(definition.id, {}, { executionId: "ac" });
    await h.waitForSuspend();
    const until = async (p: () => Promise<boolean>): Promise<void> => {
      const t0 = Date.now();
      while (!(await p())) {
        if (Date.now() - t0 > 3000) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    for (let i = 0; i < 5; i++) {
      await rt.send("ac", { topic: "user", payload: i, messageId: `m${i}` });
      await until(async () => {
        const head = await rt.followToHead("ac");
        return (
          head !== null &&
          (head.state.variables._inbox as { cursors: Record<string, number> } | undefined)?.cursors
            ?.user === i
        );
      });
    }
    const head = await rt.followToHead("ac");
    expect(head?.executionId).toBe("ac~2"); // 5 messages, a rotation every 2 turns: ac -> ac~1 -> ac~2
    expect(head?.hops).toBe(2);
  });
});
