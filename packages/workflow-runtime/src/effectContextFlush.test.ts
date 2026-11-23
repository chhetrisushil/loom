import { StorageWriteError, step$ } from "@loomwork/core";
import type { EventEnvelope, FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import type { EffectMiddleware } from "@loomwork/effect-runtime";
import { DuplicateSequenceError, InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { recoverAbandoned } from "./recoverAbandoned";
import type { FlowRunner } from "./types";

// ── ADR 0151: EffectContext.flush() — a durable barrier for middleware ─────────────────────────
//
// `EffectContext.emit` folds now and appends later (write-behind). A lease/metering middleware that
// emits RESOURCE_METERED and then calls `next()` could let the effect's side effect happen with the
// meter never stored. `flush()` awaits the journal's write-behind tail. These tests use an
// UNDECLARED-idempotence tool, so the K9.3 STEP_STARTED drain is not in play: `flush` is the only
// barrier between the middleware's emit and the effect body.

const io = { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
const stepA = step$({ id: "a", name: "A", toolId: "tool-a", ...io });

const until = async (cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** Parks (`hold`) or rejects (`refuse`) the RESOURCE_METERED append; everything else delegates. */
function meterStore(
  inner: InMemoryAsyncEventStore,
  order: string[],
  mode: "hold" | "refuse" | "pass"
): { store: InMemoryAsyncEventStore; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "append") {
        return async (envelope: EventEnvelope, ...rest: unknown[]) => {
          order.push(`append:${envelope.eventType}`);
          if (envelope.eventType === "RESOURCE_METERED") {
            if (mode === "refuse") {
              throw new DuplicateSequenceError(envelope.executionId, envelope.sequence);
            }
            if (mode === "hold") await gate;
          }
          return (target.append as (...a: unknown[]) => Promise<void>)(envelope, ...rest);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { store, release };
}

function boot(
  eventStore: InMemoryAsyncEventStore,
  opts: {
    useFlush: boolean;
    order?: string[];
    hang?: boolean;
    fireAndForget?: boolean;
    /** Runs inside the effect body, before it returns. */
    onEffect?: () => Promise<void>;
  }
) {
  const ran: string[] = [];
  const flushErrors: unknown[] = [];
  const meter: EffectMiddleware = async (ctx, _input, next) => {
    ctx.emit("RESOURCE_METERED", { tokens: 1 });
    if (opts.useFlush) {
      try {
        await ctx.flush?.();
      } catch (e) {
        flushErrors.push(e);
        throw e;
      }
    }
    return next();
  };
  const effects = new EffectRuntime([meter]);
  effects.register(
    "tool-a",
    new ToolEffect(async () => {
      ran.push("a");
      opts.order?.push("effect:a");
      await opts.onEffect?.();
      if (opts.hang === true) await new Promise<void>(() => {}); // the process dies mid-effect
      return { ok: true };
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: () => {},
  });
  const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => {
    if (opts.fireAndForget === true) {
      void ctx.run(stepA, {}).catch(() => {});
      return { ok: true };
    }
    return ctx.run(stepA, {});
  };
  const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id: "meter",
    name: "meter",
    version: "1.0.0",
    inputSchema: io.inputSchema,
    outputSchema: io.outputSchema,
    steps: [stepA],
  };
  runtime.registerFlow(definition, runner);
  return { runtime, flow: { definition, runner }, ran, flushErrors };
}

const types = async (store: InMemoryAsyncEventStore, id: string): Promise<string[]> =>
  (await store.read(id)).map((e) => e.eventType);

describe("ADR 0151: EffectContext.flush()", () => {
  it("(a) the middleware's RESOURCE_METERED is already in the store when the effect body starts", async () => {
    const durable = new InMemoryAsyncEventStore();
    let seenAtEffect: string[] = [];
    const a = boot(durable, {
      useFlush: true,
      onEffect: async () => {
        seenAtEffect = await types(durable, "fl-a");
      },
    });
    const h = await a.runtime.start(a.flow, {}, { executionId: "fl-a" });
    await h.waitForCompletion();
    expect(a.ran).toEqual(["a"]);
    expect(seenAtEffect).toContain("RESOURCE_METERED");
  });

  it("(b) flush() stays pending while the meter append is held, and the effect has not started", async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const held = meterStore(durable, order, "hold");
    const a = boot(held.store, { useFlush: true, order });
    const h = await a.runtime.start(a.flow, {}, { executionId: "fl-b" });
    await until(() => order.includes("append:RESOURCE_METERED"), "the held meter append");
    // Give the (would-be) effect ample chances to start: it must not, while the append is held.
    for (let i = 0; i < 5; i++) {
      await durable.read("fl-b");
      for (let j = 0; j < 20; j++) await Promise.resolve();
    }
    expect(a.ran).toEqual([]);
    expect(await types(durable, "fl-b")).not.toContain("RESOURCE_METERED");
    held.release();
    await h.waitForCompletion();
    expect(a.ran).toEqual(["a"]);
    expect(order.indexOf("append:RESOURCE_METERED")).toBeLessThan(order.indexOf("effect:a"));
  });

  it("(c) a rejected append rejects flush() with StorageWriteError and the effect never runs", async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const refused = meterStore(durable, order, "refuse");
    const a = boot(refused.store, { useFlush: true, order });
    const h = await a.runtime.start(a.flow, {}, { executionId: "fl-c" });
    const err = await h.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(StorageWriteError);
    expect(a.flushErrors).toHaveLength(1);
    expect(a.flushErrors[0]).toBeInstanceOf(StorageWriteError);
    expect(a.ran).toEqual([]);
    expect(order).not.toContain("effect:a");
  });

  it("(d) a context sealed while flush() awaits the store never dispatches the effect", async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const held = meterStore(durable, order, "hold");
    const a = boot(held.store, { useFlush: true, order, fireAndForget: true });
    const h = await a.runtime.start(a.flow, {}, { executionId: "fl-d" });
    await until(() => order.includes("append:RESOURCE_METERED"), "the held meter append");
    // The flow returned without awaiting the step; its terminal commit sealed the context.
    held.release();
    await h.waitForCompletion();
    expect(await types(durable, "fl-d")).toContain("RESOURCE_METERED");
    for (let i = 0; i < 5; i++) {
      await durable.read("fl-d");
      for (let j = 0; j < 20; j++) await Promise.resolve();
    }
    expect(a.ran).toEqual([]);
    expect(order).not.toContain("effect:a");
  });

  it("(e) crash safety: with flush the meter is durable once the effect ran; without it, it need not be", async () => {
    // Control: no flush, the meter append never acks (the process dies first). The effect ran and
    // its side effect happened, yet the count is not in the log: the window ADR 0151 closes.
    const ctrlStore = new InMemoryAsyncEventStore();
    const ctrlOrder: string[] = [];
    const ctrlHeld = meterStore(ctrlStore, ctrlOrder, "hold");
    const ctrl = boot(ctrlHeld.store, { useFlush: false, order: ctrlOrder, hang: true });
    void ctrl.runtime.start(ctrl.flow, {}, { executionId: "fl-e0" });
    await until(() => ctrl.ran.length === 1, "the unflushed effect to run");
    await until(() => ctrlOrder.includes("append:RESOURCE_METERED"), "the held meter append");
    expect(await types(ctrlStore, "fl-e0")).not.toContain("RESOURCE_METERED");

    // With flush: the effect ran and then the process "dies" mid-effect; a fresh runtime over the
    // same store sees the meter.
    const durable = new InMemoryAsyncEventStore();
    const a = boot(durable, { useFlush: true, hang: true });
    void a.runtime.start(a.flow, {}, { executionId: "fl-e" });
    await until(() => a.ran.length === 1, "the flushed effect to run");
    const b = boot(durable, { useFlush: true });
    await recoverAbandoned(b.runtime, { source: durable, isAbandoned: () => true });
    expect(await types(durable, "fl-e")).toContain("RESOURCE_METERED");
  });
});
