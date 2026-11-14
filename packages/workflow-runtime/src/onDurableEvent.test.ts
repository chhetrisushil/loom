import { step$ } from "@loomwork/core";
import type { EventEnvelope, FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { ReplayVM } from "@loomwork/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExecutionJournal } from "./ExecutionJournal";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";

// ADR 0147: `onDurableEvent` only reports what the log holds. These tests use a rejected or
// unresolved write: a store that swallows a write and resolves, as `crashingEventStore` does,
// cannot show this.

const io = z.object({}).passthrough();
const work = step$({ id: "work", name: "Work", toolId: "t", inputSchema: io, outputSchema: io });
const definition: FlowDefinition<unknown, unknown> = {
  _tag: "FlowDefinition",
  id: "f",
  name: "f",
  version: "1.0.0",
  inputSchema: io,
  outputSchema: io,
  steps: [work],
};
const runner: FlowRunner<unknown, unknown> = async (ctx) => ctx.run(work, {});
const parkFirst: FlowRunner<unknown, unknown> = async (ctx) => {
  await ctx.suspend({ on: "GO" });
  return {};
};

function boot(
  options: {
    rejectOn?: string;
    gate?: Promise<void>;
    onDurableEvent?: (event: EventEnvelope) => void;
    onEvent?: (event: EventEnvelope) => void;
    onWarn?: (message: string) => void;
    flow?: FlowRunner<unknown, unknown>;
  } = {}
) {
  const store = new InMemoryAsyncEventStore();
  const append = store.append.bind(store);
  store.append = async (event) => {
    if (options.gate !== undefined) await options.gate;
    if (event.eventType === options.rejectOn) throw new Error("disk full");
    return append(event);
  };
  const effects = new EffectRuntime();
  effects.register("t", new ToolEffect(async () => ({ ok: true })));
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    ...(options.onEvent !== undefined && { onEvent: options.onEvent }),
    ...(options.onDurableEvent !== undefined && { onDurableEvent: options.onDurableEvent }),
    ...(options.onWarn !== undefined && { onWarn: options.onWarn }),
  });
  runtime.registerFlow(definition, options.flow ?? runner);
  return { runtime, store };
}

const label = (e: EventEnvelope): string => `${e.sequence}:${e.eventType}`;

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met within 10 s");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

class GatedBatchStore extends InMemoryAsyncEventStore {
  gate: Promise<void> = Promise.resolve();
  fail = false;
  override async appendBatch(events: EventEnvelope[]): Promise<void> {
    await this.gate;
    if (this.fail) throw new Error("disk full");
    return super.appendBatch(events);
  }
}

function journalRig() {
  const store = new GatedBatchStore();
  const order: string[] = [];
  const journal = new ExecutionJournal(
    store,
    { executionId: "e", workflowId: "f" },
    new ReplayVM([]),
    (e) => order.push(`live:${e.eventType}`),
    () => {},
    undefined,
    undefined,
    Date.now,
    (e) => order.push(`durable:${e.eventType}`)
  );
  let open!: () => void;
  store.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { store, journal, order, open };
}

describe("onDurableEvent over an atomic batch", () => {
  const batch = [
    { eventType: "A", payload: {} },
    { eventType: "B", payload: {} },
  ];

  it("waits for the batch, then reports it in order", async () => {
    const r = journalRig();
    r.journal.commitAtomic(batch);
    expect(r.order).toEqual(["live:A", "live:B"]); // onEvent's timing is unchanged
    r.open();
    await r.journal.drain();
    expect(r.order).toEqual(["live:A", "live:B", "durable:A", "durable:B"]);
  });

  it("after a deferred onEvent, in order", async () => {
    const r = journalRig();
    r.journal.commitAtomic(batch, { deferOnEvent: true });
    expect(r.order).toEqual([]);
    r.open();
    await r.journal.drain();
    expect(r.order).toEqual(["live:A", "live:B", "durable:A", "durable:B"]);
  });

  it("never reports a lost batch", async () => {
    const r = journalRig();
    r.store.fail = true;
    r.journal.commitAtomic(batch);
    r.open();
    await expect(r.journal.drain()).rejects.toThrow();
    expect(r.order).toEqual(["live:A", "live:B"]);
  });
});

describe("onDurableEvent", () => {
  it("a rejected write matches the log exactly, while onEvent still reports it first", async () => {
    const durable: string[] = [];
    const live: string[] = [];
    const { runtime, store } = boot({
      rejectOn: "STEP_COMPLETED",
      onDurableEvent: (e) => durable.push(label(e)),
      onEvent: (e) => live.push(label(e)),
    });
    const handle = await runtime.start("f", {}, { executionId: "x" });
    await handle.waitForCompletion().catch(() => {});
    expect(durable).toEqual(["0:EXECUTION_STARTED", "1:STEP_STARTED"]);
    expect((await store.read("x")).map(label)).toEqual(durable);
    expect(live).toContain("2:STEP_COMPLETED"); // onEvent's timing is unchanged
  });

  it("a write that never resolves is never delivered, as when the process dies first", async () => {
    const durable: string[] = [];
    const live: string[] = [];
    const { runtime } = boot({
      gate: new Promise<void>(() => {}),
      onDurableEvent: (e) => durable.push(label(e)),
      onEvent: (e) => live.push(label(e)),
    });
    void runtime.start("f", {}).catch(() => {});
    await until(() => live.length > 0);
    expect(durable).toEqual([]);
  });

  it("delivers every event of a run in order", async () => {
    const durable: string[] = [];
    const { runtime, store } = boot({ onDurableEvent: (e) => durable.push(label(e)) });
    const handle = await runtime.start("f", {}, { executionId: "x" });
    await handle.waitForCompletion();
    expect(durable).toEqual((await store.read("x")).map(label));
    expect(durable).toHaveLength(4);
  });

  it("delivers an event written outside a journal", async () => {
    const durable: string[] = [];
    const parked = boot({ flow: parkFirst });
    const handle = await parked.runtime.start("f", {}, { executionId: "x" });
    await handle.waitForSuspend();
    const other = new WorkflowRuntime({
      eventStore: parked.store,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      onDurableEvent: (e) => durable.push(e.eventType),
    });
    await other.cancel("x");
    expect(durable).toContain("EXECUTION_CANCELLED");
    expect((await parked.store.read("x")).map((e) => e.eventType)).toContain("EXECUTION_CANCELLED");
  });

  it("a fork delivers the copied prefix", async () => {
    const durable: string[] = [];
    const { runtime } = boot({ onDurableEvent: (e) => durable.push(e.executionId) });
    const handle = await runtime.start("f", {}, { executionId: "x" });
    await handle.waitForCompletion();
    const before = durable.length;
    await runtime.fork("x", 1);
    const copied = durable.slice(before);
    expect(copied).toHaveLength(2);
    expect(copied.every((id) => id !== "x")).toBe(true);
  });

  it("a throwing consumer does not fail the run or stop later events, and is reported once a minute", async () => {
    const warnings: string[] = [];
    const seen: string[] = [];
    const { runtime, store } = boot({
      onDurableEvent: (e) => {
        seen.push(e.eventType);
        throw new Error("sink down");
      },
      onWarn: (m) => warnings.push(m),
    });
    const handle = await runtime.start("f", {}, { executionId: "x" });
    expect((await handle.waitForCompletion()).status).toBe("completed");
    expect(seen).toHaveLength(4);
    expect(await store.read("x")).toHaveLength(4);
    const reports = warnings.filter((m) => m.includes("onDurableEvent failed"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/EXECUTION_STARTED.*"x".*sink down/);
  });

  it("a rejecting async consumer is reported, and does not fail the run or the process", async () => {
    const warnings: string[] = [];
    const { runtime, store } = boot({
      onDurableEvent: async () => {
        throw new Error("pager down");
      },
      onWarn: (m) => warnings.push(m),
    });
    const handle = await runtime.start("f", {}, { executionId: "x" });
    expect((await handle.waitForCompletion()).status).toBe("completed");
    expect(await store.read("x")).toHaveLength(4);
    await until(() => warnings.some((m) => m.includes("pager down")));
    expect(warnings.filter((m) => m.includes("onDurableEvent failed"))).toHaveLength(1);
  });

  it("a throwing onEvent still propagates on a direct path, and does not hide the landed event", async () => {
    const durable: string[] = [];
    const parked = boot({ flow: parkFirst });
    const handle = await parked.runtime.start("f", {}, { executionId: "x" });
    await handle.waitForSuspend();
    const other = new WorkflowRuntime({
      eventStore: parked.store,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      onEvent: () => {
        throw new Error("projection bug");
      },
      onDurableEvent: (e) => durable.push(e.eventType),
    });
    await expect(other.cancel("x")).rejects.toThrow("projection bug");
    expect(durable).toEqual(["EXECUTION_CANCELLED"]);
  });

  it("a fork without a native copy delivers the prefix once", async () => {
    const durable: string[] = [];
    const { runtime, store } = boot({ onDurableEvent: (e) => durable.push(e.executionId) });
    const handle = await runtime.start("f", {}, { executionId: "x" });
    await handle.waitForCompletion();
    (store as { copyPrefix?: unknown }).copyPrefix = undefined;
    const before = durable.length;
    await runtime.fork("x", 1);
    const copied = durable.slice(before);
    expect(copied).toHaveLength(2);
    expect(copied.every((id) => id !== "x")).toBe(true);
  });

  it("a caller-chosen id delivers its adopted first event once, even if onEvent throws on it", async () => {
    const durable: string[] = [];
    let threw = false;
    const { runtime, store } = boot({
      onEvent: () => {
        if (!threw) {
          threw = true;
          throw new Error("projection bug");
        }
      },
      onDurableEvent: (e) => durable.push(label(e)),
    });
    await runtime.start("f", {}, { executionId: "x" }).catch(() => {});
    await until(() => durable.length > 0);
    expect(durable[0]).toBe("0:EXECUTION_STARTED");
    expect((await store.read("x"))[0]?.eventType).toBe("EXECUTION_STARTED");
  });

  it("a throwing onWarn is contained too", async () => {
    const { runtime, store } = boot({
      onDurableEvent: () => {
        throw new Error("sink down");
      },
      onWarn: () => {
        throw new Error("warn down");
      },
    });
    const handle = await runtime.start("f", {}, { executionId: "x" });
    expect((await handle.waitForCompletion()).status).toBe("completed");
    expect(await store.read("x")).toHaveLength(4);
  });

  it("a throwing consumer on a direct path does not reject the write that landed", async () => {
    const parked = boot({ flow: parkFirst });
    const handle = await parked.runtime.start("f", {}, { executionId: "x" });
    await handle.waitForSuspend();
    const other = new WorkflowRuntime({
      eventStore: parked.store,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      onDurableEvent: () => {
        throw new Error("sink down");
      },
      onWarn: () => {},
    });
    await expect(other.cancel("x")).resolves.toBeDefined();
  });

  it("unset, the write path is unchanged", async () => {
    const { runtime, store } = boot();
    const handle = await runtime.start("f", {}, { executionId: "x" });
    expect((await handle.waitForCompletion()).status).toBe("completed");
    expect(await store.read("x")).toHaveLength(4);
  });
});
