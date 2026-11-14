import { step$ } from "@loomwork/core";
import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import {
  type EventStore,
  InMemoryAsyncEventStore,
  InMemoryTimerStore,
  isPayloadShredded,
} from "@loomwork/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore, shredSubject } from "@loomwork/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// A sleeping execution whose subject was erased (crypto-shredded) can never be loaded again, on any
// node. Its timer row must be retired and reported ONCE, not left to report on every poll forever.

const schema = z.object({ n: z.number() });
type IO = { n: number };
const after = step$({
  id: "after",
  name: "After",
  toolId: "after-tool",
  inputSchema: schema,
  outputSchema: schema,
});

function sleepy(id: string, wakeAt: number): RegisteredFlow<IO, IO> {
  const definition: FlowDefinition<IO, IO> = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    inputSchema: schema,
    outputSchema: schema,
    steps: [after],
  };
  const runner: FlowRunner<IO, IO> = async (ctx, input) => {
    await ctx.sleepUntil(wakeAt);
    return await ctx.run(after, input);
  };
  return { definition, runner };
}

function boot(
  flow: RegisteredFlow<IO, IO>,
  stores: { eventStore: EventStore; timerStore: InMemoryTimerStore },
  inboxEnabled = false
) {
  const effects = new EffectRuntime();
  effects.register("after-tool", new ToolEffect(async (i: IO) => i));
  const runtime = new WorkflowRuntime({
    eventStore: stores.eventStore,
    // A fresh snapshot store: the fold reads the log, as a node with no checkpoint does.
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    timerStore: stores.timerStore,
    allowPlaintextCheckpoints: true, // the checkpoint store is not under test here
    inboxEnabled,
  });
  runtime.registerFlow(flow.definition, flow.runner);
  return runtime;
}

describe("TimerService: an erased execution's timer row", () => {
  it("is retired and reported once, and a live timer in the same poll still fires", async () => {
    const wakeAt = Date.now() + 30;
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const eventStore = new EncryptingEventStore(inner, keys, {
      sensitive: { EXECUTION_STARTED: ["input"] },
    });
    const timerStore = new InMemoryTimerStore();
    const erasedFlow = sleepy("erased-sleeper", wakeAt);
    const liveFlow = sleepy("live-sleeper", wakeAt);
    const a = boot(erasedFlow, { eventStore, timerStore });
    a.registerFlow(liveFlow.definition, liveFlow.runner);
    await (await a.start(erasedFlow, { n: 1 }, { executionId: "te-erased" })).waitForSuspend();
    await (await a.start(liveFlow, { n: 2 }, { executionId: "te-live" })).waitForSuspend();
    await shredSubject(keys, inner, "te-erased", {
      snapshotStore: { loadLatest: async () => null },
    });

    const b = boot(erasedFlow, { eventStore, timerStore });
    b.registerFlow(liveFlow.definition, liveFlow.runner);
    await expect(b.loadState("te-erased")).rejects.toSatisfy(isPayloadShredded);
    const errors: Array<[string, unknown]> = [];
    const service = new TimerService(b, timerStore, {
      onError: (id, err) => errors.push([id, err]),
    });
    const before = await inner.read("te-erased");

    for (let poll = 1; poll <= 4; poll++) await service.tick(wakeAt + poll * 1_000);

    expect(errors.map(([id]) => id)).toEqual(["te-erased"]); // once, not once per poll
    expect(isPayloadShredded(errors[0]?.[1])).toBe(true);
    expect(await timerStore.due(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await inner.read("te-erased")).toEqual(before); // nothing appended to it
    expect((await b.loadState("te-live"))?.status).toBe("completed");
  });

  it("a REFUSAL row (ADR 0130 D10) for an erased execution is retired at once, not held or re-tried", async () => {
    const wakeAt = Date.now() + 30;
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const eventStore = new EncryptingEventStore(inner, keys, {
      sensitive: { EXECUTION_STARTED: ["input"] },
    });
    const timerStore = new InMemoryTimerStore();
    const flow = sleepy("erased-refused", wakeAt);
    const a = boot(flow, { eventStore, timerStore }, true);
    await (await a.start(flow, { n: 1 }, { executionId: "te-refused" })).waitForSuspend();
    await shredSubject(keys, inner, "te-refused", {
      snapshotStore: { loadLatest: async () => null },
    });
    const head = (await inner.read("te-refused")).at(-1)?.sequence as number;
    await timerStore.schedule({ executionId: "te-refused", wakeAt: 7, refused: { head } });

    const b = boot(flow, { eventStore, timerStore }, true);
    const errors: Array<[string, unknown]> = [];
    const service = new TimerService(b, timerStore, {
      isAbandoned: () => true, // evidence configured: this node judges refusal rows
      onError: (id, err) => errors.push([id, err]),
    });
    await service.tick(wakeAt + 1_000);

    expect(errors.map(([id]) => id)).toEqual(["te-refused", "te-refused"]); // the refusal + the timer
    expect(errors.every(([, e]) => isPayloadShredded(e))).toBe(true);
    expect(await timerStore.due(Number.MAX_SAFE_INTEGER)).toEqual([]); // both rows retired
    await service.tick(wakeAt + 60_000);
    expect(errors).toHaveLength(2); // nothing left to report
  });
});
