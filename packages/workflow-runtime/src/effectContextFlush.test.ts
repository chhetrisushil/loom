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
import { guardUserspaceEmit } from "./userspaceEmit";

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
    step?: typeof stepA;
    fireAndForget?: boolean;
    /** Runs inside the effect body, before it returns. */
    onEffect?: () => Promise<void>;
  }
) {
  const ran: string[] = [];
  const flushErrors: unknown[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const meter: EffectMiddleware = async (ctx, _input, next) => {
    signals.push(ctx.signal);
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
  const stepX = opts.step ?? stepA;
  const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => {
    if (opts.fireAndForget === true) {
      void ctx.run(stepX, {}).catch(() => {});
      return { ok: true };
    }
    return ctx.run(stepX, {});
  };
  const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id: "meter",
    name: "meter",
    version: "1.0.0",
    inputSchema: io.inputSchema,
    outputSchema: io.outputSchema,
    steps: [stepX],
  };
  runtime.registerFlow(definition, runner);
  return { runtime, flow: { definition, runner }, ran, flushErrors, signals };
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

  it("(m2) a step whose deadline fired while flush() awaited never dispatches the effect", async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const held = meterStore(durable, order, "hold");
    const timed = step$({ id: "a", name: "A", toolId: "tool-a", timeoutMs: 100, ...io });
    const a = boot(held.store, { useFlush: true, order, step: timed });
    const h = await a.runtime.start(a.flow, {}, { executionId: "fl-m2" });
    await until(() => order.includes("append:RESOURCE_METERED"), "the held meter append");
    // Condition, not a sleep: the step signal the middleware holds aborts when the deadline fires.
    // The run cannot settle while the append is held (completion drains the journal).
    await until(() => a.signals[0]?.aborted === true, "the step deadline to fire");
    held.release();
    const err = await h.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).name).toBe("StepTimeoutError");
    await until(() => a.flushErrors.length === 1, "flush() to settle after release");
    expect((a.flushErrors[0] as Error).name).toBe("StepTimeoutError");
    expect(a.ran).toEqual([]);
    expect(order).not.toContain("effect:a");
  });

  it("(m3) cancelling the run while the meter append is held settles promptly and never runs the effect", async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const held = meterStore(durable, order, "hold");
    const a = boot(held.store, { useFlush: true, order });
    const h = await a.runtime.start(a.flow, {}, { executionId: "fl-m3" });
    await until(() => order.includes("append:RESOURCE_METERED"), "the held meter append");
    await a.runtime.cancel("fl-m3");
    held.release();
    // Without prompt settlement the handle would stay live for parkDrainMs = 30 s; until() allows 5 s.
    await until(() => a.runtime.liveHandle("fl-m3") === undefined, "the live handle to release");
    await h.waitForCompletion().catch(() => undefined);
    const log = await types(durable, "fl-m3");
    expect(log).toContain("EXECUTION_CANCELLED");
    expect(log).toContain("STEP_CANCELLED");
    expect(a.ran).toEqual([]);
    expect(order).not.toContain("effect:a");
  }, 15_000);
});

// ── ADR 0151 D6: EffectContext.readResources() ─────────────────────────────────────────────────
const stepB = step$({ id: "b", name: "B", toolId: "tool-b", ...io });

/** Runs `steps` (in parallel when more than one) through ONE middleware; every tool returns ok. */
async function runWith(
  mw: EffectMiddleware,
  steps: Array<typeof stepA>,
  id: string
): Promise<InMemoryAsyncEventStore> {
  const store = new InMemoryAsyncEventStore();
  const effects = new EffectRuntime([mw]);
  for (const s of steps)
    effects.register(s.toolId as string, new ToolEffect(async () => ({ ok: true })));
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: () => {},
  });
  const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => {
    if (steps.length === 1) return ctx.run(steps[0] as typeof stepA, {});
    return (
      await ctx.parallel(steps.map((s) => [s, {}] as [typeof stepA, Record<string, never>]))
    )[0] as {
      ok: boolean;
    };
  };
  const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    inputSchema: io.inputSchema,
    outputSchema: io.outputSchema,
    steps,
  };
  runtime.registerFlow(definition, runner);
  const h = await runtime.start({ definition, runner }, {}, { executionId: id });
  await h.waitForCompletion();
  return store;
}

describe("ADR 0151 D6: EffectContext.readResources()", () => {
  it("(g) shows the middleware's own emit in the same synchronous block; ctx.resources does not", async () => {
    const seen: Array<{ live: number; snapshot: number }> = [];
    await runWith(
      async (ctx, _i, next) => {
        ctx.emit("RESOURCE_METERED", { count: 1 });
        seen.push({ live: ctx.readResources!().count, snapshot: ctx.resources!.count });
        return next();
      },
      [stepA],
      "rr-g"
    );
    expect(seen).toEqual([{ live: 1, snapshot: 0 }]);
  });

  it("(h) concurrent effects of one execution: each reads the others' meters, the snapshot is stale", async () => {
    const reads: number[] = [];
    const snaps: number[] = [];
    let arrived = 0;
    let open: () => void = () => {};
    const barrier = new Promise<void>((r) => {
      open = r;
    });
    await runWith(
      async (ctx, _i, next) => {
        ctx.emit("RESOURCE_METERED", { count: 1 });
        if (++arrived === 2) open();
        await barrier;
        reads.push(ctx.readResources!().count);
        snaps.push(ctx.resources!.count);
        return next();
      },
      [stepA, stepB],
      "rr-h"
    );
    expect(reads).toEqual([2, 2]);
    expect(Math.min(...snaps)).toBe(0); // the first context's snapshot never saw either meter
    expect(Math.max(...snaps)).toBeLessThan(2);
  });

  it("(i) the fold drops a 33rd custom dimension; readResources() after the emit shows it absent", async () => {
    let custom: Record<string, number> | undefined;
    await runWith(
      async (ctx, _i, next) => {
        const full: Record<string, number> = {};
        for (let i = 0; i < 32; i++) full[`dim_${i}`] = 1;
        ctx.emit("RESOURCE_METERED", { custom: full });
        ctx.emit("RESOURCE_METERED", { custom: { lease_count: 1 } });
        custom = ctx.readResources!().custom as Record<string, number>;
        return next();
      },
      [stepA],
      "rr-i"
    );
    expect(Object.keys(custom ?? {})).toHaveLength(32);
    expect(Object.hasOwn(custom ?? {}, "lease_count")).toBe(false);
  });

  it("(j) mutating the returned object does not change a later read", async () => {
    const after: Array<{ count: number; gpu: number | undefined }> = [];
    await runWith(
      async (ctx, _i, next) => {
        ctx.emit("RESOURCE_METERED", { count: 1, custom: { gpu: 5 } });
        const r = ctx.readResources!() as { count: number; custom: Record<string, number> };
        r.count = 999;
        r.custom.gpu = 999;
        const again = ctx.readResources!();
        after.push({ count: again.count, gpu: again.custom?.gpu });
        return next();
      },
      [stepA],
      "rr-j"
    );
    expect(after).toEqual([{ count: 1, gpu: 5 }]);
  });
});

// ── ADR 0151 D7: reserveEffectDimensions ───────────────────────────────────────────────────────
describe("ADR 0151 D7: reserveEffectDimensions", () => {
  type Emit = (ctx: { emit: (t: string, p: unknown) => void }) => void;
  function bootReserve(opts: {
    prefix?: string;
    flowEmit?: Emit;
    effectEmit?: Emit;
    suspend?: boolean;
  }) {
    const store = new InMemoryAsyncEventStore();
    const mk = () => {
      const effects = new EffectRuntime();
      effects.register(
        "tool-a",
        new ToolEffect(async (_i, c) => {
          opts.effectEmit?.(c);
          return { ok: true };
        })
      );
      const runtime = new WorkflowRuntime({
        eventStore: store,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        effectRuntime: effects,
        onWarn: () => {},
      });
      const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => {
        opts.flowEmit?.(ctx);
        const out = await ctx.run(stepA, {});
        if (opts.suspend === true) await ctx.suspend({ on: "Approval" });
        return out;
      };
      const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
        _tag: "FlowDefinition",
        id: "reserve",
        name: "reserve",
        version: "1.0.0",
        inputSchema: io.inputSchema,
        outputSchema: io.outputSchema,
        steps: [stepA],
      };
      runtime.registerFlow(definition, runner);
      return { runtime, flow: { definition, runner } };
    };
    const first = mk();
    if (opts.prefix !== undefined) first.runtime.reserveEffectDimensions(opts.prefix);
    return { store, first, mk };
  }
  const meter = (name: string) => ({ custom: { [name]: 1 } });

  it("refuses a flow emit under a reserved prefix, appends nothing, and allows other names", async () => {
    const t = bootReserve({
      prefix: "x.",
      flowEmit: (c) => c.emit("RESOURCE_METERED", meter("y.a")),
    });
    const h = await t.first.runtime.start(t.first.flow, {}, { executionId: "rs-1" });
    await h.waitForCompletion();
    expect(await types(t.store, "rs-1")).toContain("RESOURCE_METERED");

    const bad = bootReserve({
      prefix: "x.",
      flowEmit: (c) => c.emit("RESOURCE_METERED", meter("x.a")),
    });
    const hb = await bad.first.runtime.start(bad.first.flow, {}, { executionId: "rs-2" });
    const err = await hb.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(String(err)).toMatch(/reserved \(prefix "x\."\)/);
    expect(await types(bad.store, "rs-2")).not.toContain("RESOURCE_METERED");
  });

  it("allows an effect-scope emit under the reserved prefix, and it folds", async () => {
    const t = bootReserve({
      prefix: "x.",
      effectEmit: (c) => c.emit("RESOURCE_METERED", meter("x.a")),
    });
    const h = await t.first.runtime.start(t.first.flow, {}, { executionId: "rs-3" });
    await h.waitForCompletion();
    expect(await types(t.store, "rs-3")).toContain("RESOURCE_METERED");
  });

  it("reserving is idempotent; an invalid prefix throws", () => {
    const t = bootReserve({});
    t.first.runtime.reserveEffectDimensions("x.");
    t.first.runtime.reserveEffectDimensions("x.");
    for (const bad of ["", "X.", "1x", "a b", "x".repeat(65)]) {
      expect(() => t.first.runtime.reserveEffectDimensions(bad)).toThrow(/reserveEffectDimensions/);
    }
  });

  it("with no prefix reserved, a flow emit of any valid name is unchanged", async () => {
    const t = bootReserve({ flowEmit: (c) => c.emit("RESOURCE_METERED", meter("x.a")) });
    const h = await t.first.runtime.start(t.first.flow, {}, { executionId: "rs-4" });
    await h.waitForCompletion();
    expect(await types(t.store, "rs-4")).toContain("RESOURCE_METERED");
  });

  it("replay: an effect meter recorded before the prefix was reserved still replays on resume", async () => {
    const t = bootReserve({
      suspend: true,
      effectEmit: (c) => c.emit("RESOURCE_METERED", meter("x.a")),
    });
    await t.first.runtime.start(t.first.flow, {}, { executionId: "rs-5" });
    const deadline = Date.now() + 5_000;
    while (!(await types(t.store, "rs-5")).includes("EXECUTION_SUSPENDED")) {
      if (Date.now() > deadline) throw new Error("timed out waiting for EXECUTION_SUSPENDED");
      await new Promise((r) => setTimeout(r, 2));
    }
    // A fresh runtime reserves the prefix AFTER the effect meter was recorded; resume replays it.
    const second = t.mk();
    second.runtime.reserveEffectDimensions("x.");
    const h2 = await second.runtime.resume("rs-5", { eventType: "Approval", payload: {} });
    await h2.waitForCompletion();
    const log = await types(t.store, "rs-5");
    expect(log).toContain("EXECUTION_COMPLETED");
    expect(log.filter((e) => e === "RESOURCE_METERED")).toHaveLength(1);
  });

  it("(M2) a suspended flow that already emitted a now-reserved dimension fails on resume", async () => {
    const t = bootReserve({
      suspend: true,
      flowEmit: (c) => c.emit("RESOURCE_METERED", meter("x.a")),
    });
    await t.first.runtime.start(t.first.flow, {}, { executionId: "rs-6" });
    const deadline = Date.now() + 5_000;
    while (!(await types(t.store, "rs-6")).includes("EXECUTION_SUSPENDED")) {
      if (Date.now() > deadline) throw new Error("timed out waiting for EXECUTION_SUSPENDED");
      await new Promise((r) => setTimeout(r, 2));
    }
    const second = t.mk();
    second.runtime.reserveEffectDimensions("x.");
    const err = await second.runtime
      .resume("rs-6", { eventType: "Approval", payload: {} })
      .then((h) => h.waitForCompletion())
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(String(err)).toMatch(/reserved \(prefix "x\."\)/);
  });
});

describe("ADR 0151 R28: guardUserspaceEmit snapshots custom once", () => {
  const flow = { kind: "flow" as const, conflicts: () => false };
  const reserved = new Set(["x."]);

  it("a Proxy whose keys change after the checks cannot smuggle a reserved name into the fold", () => {
    let reads = 0;
    const target = { ok: 1, "x.a": 1 };
    const proxy = new Proxy(target, {
      ownKeys: () => (++reads <= 2 ? ["ok"] : ["ok", "x.a"]),
      getOwnPropertyDescriptor: (t, k) =>
        Reflect.getOwnPropertyDescriptor(t, k) && {
          ...Reflect.getOwnPropertyDescriptor(t, k),
          enumerable: true,
          configurable: true,
        },
    });
    let out: { custom: Record<string, number> } | undefined;
    try {
      out = guardUserspaceEmit(
        "RESOURCE_METERED",
        { custom: proxy },
        flow,
        undefined,
        reserved
      ) as {
        custom: Record<string, number>;
      };
    } catch {
      return; // refused: acceptable
    }
    expect(Object.keys(out.custom)).not.toContain("x.a");
    // The committed object is a plain copy: re-reading it never consults the proxy again.
    expect(Object.keys(out.custom)).toEqual(Object.keys(out.custom));
    expect(out.custom).not.toBe(proxy);
  });

  it("an undefined scope is guarded like a flow", () => {
    expect(() =>
      guardUserspaceEmit(
        "RESOURCE_METERED",
        { custom: { "x.a": 1 } },
        undefined,
        undefined,
        reserved
      )
    ).toThrow(/reserved/);
  });

  it("an effect scope is not guarded", () => {
    const eff = { kind: "effect" as const, stepId: "a", attempt: 1, conflicts: () => false };
    expect(() =>
      guardUserspaceEmit("RESOURCE_METERED", { custom: { "x.a": 1 } }, eff, undefined, reserved)
    ).not.toThrow();
  });

  it("prefix edges with `x.`: `x` and `xy.a` pass, `x.a.b` is refused", () => {
    const g = (name: string) =>
      guardUserspaceEmit("RESOURCE_METERED", { custom: { [name]: 1 } }, flow, undefined, reserved);
    expect(() => g("x")).not.toThrow();
    expect(() => g("xy.a")).not.toThrow();
    expect(() => g("x.a.b")).toThrow(/reserved/);
  });
});
