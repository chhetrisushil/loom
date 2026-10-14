import { StorageWriteError, step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { DuplicateSequenceError, InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { recoverAbandoned } from "./recoverAbandoned";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── K9.3 vs the write-behind journal ───────────────────────────────────────────
//
// ADR 0021 A3: an `idempotent: false` step whose frame is left "running" (STEP_STARTED, no
// terminal event) parks as EFFECT_INDOUBT on recovery instead of silently re-running. That
// guard reads the FOLDED log, so it only works if STEP_STARTED is DURABLE before the effect
// body can have any external side effect. `ExecutionJournal.commit` is write-behind (fold
// now, append later), and `executeLive` dispatches the effect without awaiting that append.
//
// This test models a store that is slow to ack the STEP_STARTED append (it never acks — the
// process dies first), while the effect body runs and has its side effect. A fresh process
// over the same store then recovers the execution.

const io = { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
const stepA = step$({ id: "a", name: "A", toolId: "tool-a", ...io });
const stepB = step$({ id: "b", name: "B", toolId: "tool-b", ...io });

const until = async (cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

/**
 * Delegates everything to `inner`, except a STEP_STARTED append: `hold` parks it until
 * `release()` (never, if the process "dies" first), `refuse` rejects it with a stale-fence style
 * write conflict. Every append issued is recorded in `order`.
 */
function stepStartedStore(
  inner: InMemoryAsyncEventStore,
  order: string[],
  mode: "hold" | "refuse"
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
          if (envelope.eventType === "STEP_STARTED") {
            if (mode === "refuse") {
              throw new DuplicateSequenceError(envelope.executionId, envelope.sequence);
            }
            await gate;
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
    hang: boolean;
    order?: string[];
    /** Registered idempotence of `tool-a` / `tool-b` (default `false`; `undefined` = undeclared). */
    idempotent?: boolean | undefined;
    fanOut?: boolean;
    /** The flow starts the step and returns without awaiting it. */
    fireAndForget?: boolean;
  }
) {
  const toolOpts =
    opts.idempotent === undefined && "idempotent" in opts
      ? {}
      : { idempotent: opts.idempotent ?? false };
  const ran: string[] = [];
  const effects = new EffectRuntime();
  effects.register(
    "tool-a",
    new ToolEffect(async () => {
      ran.push("a");
      opts.order?.push("effect:a");
      // The process dies while the (external) effect is in flight.
      if (opts.hang) await new Promise<void>(() => {});
      return { ok: true };
    }, toolOpts)
  );
  effects.register(
    "tool-b",
    new ToolEffect(async () => {
      ran.push("b");
      return { ok: true };
    }, toolOpts)
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
    return opts.fanOut === true
      ? (
          await ctx.parallel([
            [stepA, {}],
            [stepB, {}],
          ])
        )[0]
      : ctx.run(stepA, {});
  };
  const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id: "pay",
    name: "pay",
    version: "1.0.0",
    inputSchema: io.inputSchema,
    outputSchema: io.outputSchema,
    steps: [stepA, stepB],
  };
  const flow: RegisteredFlow<Record<string, never>, { ok: boolean }> = { definition, runner };
  runtime.registerFlow(definition, runner);
  return { runtime, flow, ran };
}

describe("K9.3: STEP_STARTED must be durable before a non-idempotent effect runs", () => {
  it("a crash in the gap (STEP_STARTED unacked) never ran the effect, so recovery runs it exactly once, not in doubt", async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];

    // Process A: the STEP_STARTED append is never acked (the process dies first). With the fix the
    // effect is not dispatched; without it the effect would run with no durable marker.
    const held = stepStartedStore(durable, order, "hold");
    const a = boot(held.store, { hang: false, order });
    void a.runtime.start(a.flow, {}, { executionId: "pay-gap" });
    await until(() => order.includes("append:STEP_STARTED"), "the held STEP_STARTED append");
    // Abandon A (never release): its effect never ran and the durable log is only the start.
    expect(a.ran).toEqual([]);
    expect((await durable.read("pay-gap")).map((e) => e.eventType)).toEqual(["EXECUTION_STARTED"]);

    // Process B: a fresh runtime over the same UNDERLYING store.
    const b = boot(durable, { hang: false });
    await recoverAbandoned(b.runtime, { source: durable, isAbandoned: () => true });
    let types: string[] = [];
    const deadline = Date.now() + 5_000;
    while (!types.includes("EXECUTION_COMPLETED") && Date.now() < deadline) {
      types = (await durable.read("pay-gap")).map((e) => e.eventType);
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(types).toContain("EXECUTION_COMPLETED");
    expect(types).not.toContain("EFFECT_INDOUBT");
    expect(b.ran).toEqual(["a"]); // exactly once: A's effect never ran
    expect(a.ran).toEqual([]);
  });

  // Pins the RECOVERY half only: given a durable STEP_STARTED and an effect that ran (and a crash
  // before its terminal event), a fresh process parks EFFECT_INDOUBT and does not re-run. It does
  // not depend on the drain (the plain store's append lands first); the gap test above does.
  it("STEP_STARTED durable + effect ran + crash: recovery parks in doubt, does not re-run", async () => {
    const durable = new InMemoryAsyncEventStore();
    const a = boot(durable, { hang: true });
    void a.runtime.start(a.flow, {}, { executionId: "pay-1" });
    await until(() => a.ran.length === 1, "process A's effect to run");
    expect((await durable.read("pay-1")).map((e) => e.eventType)).toContain("STEP_STARTED");

    const b = boot(durable, { hang: false });
    await recoverAbandoned(b.runtime, { source: durable, isAbandoned: () => true });
    const logB = (await durable.read("pay-1")).map((e) => e.eventType);

    expect(logB).toContain("EFFECT_INDOUBT");
    expect(b.ran).toEqual([]);
  });

  it("a context sealed while STEP_STARTED is being made durable never dispatches the effect", async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const held = stepStartedStore(durable, order, "hold");
    const a = boot(held.store, { hang: false, order, fireAndForget: true });
    const handle = await a.runtime.start(a.flow, {}, { executionId: "seal-1" });
    await until(() => order.includes("append:STEP_STARTED"), "the held STEP_STARTED append");
    // The flow returned without awaiting the step; its terminal commit sealed the context while
    // the drain is still pending.
    held.release();
    await handle.waitForCompletion();
    // The held append has resolved (waitForCompletion drained the journal, STEP_STARTED included).
    // Condition, not a timer: the STEP_STARTED is in the durable log, then a few store round trips
    // and microtask hops let the post-drain continuation (the code under test) run.
    expect((await durable.read("seal-1")).map((e) => e.eventType)).toContain("STEP_STARTED");
    for (let i = 0; i < 5; i++) {
      await durable.read("seal-1");
      for (let j = 0; j < 20; j++) await Promise.resolve();
    }
    expect(a.ran).toEqual([]);
    expect(order).not.toContain("effect:a");
  });

  it("an idempotent:false effect does not start while its STEP_STARTED append is unacked", async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const held = stepStartedStore(durable, order, "hold");
    const a = boot(held.store, { hang: false, order });
    const handle = await a.runtime.start(a.flow, {}, { executionId: "pay-2" });
    await until(() => order.includes("append:STEP_STARTED"), "the held STEP_STARTED append");
    // The append is in flight and unacked: the effect has not been dispatched.
    expect(a.ran).toEqual([]);
    expect((await durable.read("pay-2")).map((e) => e.eventType)).toEqual(["EXECUTION_STARTED"]);
    held.release();
    await handle.waitForCompletion();
    expect(a.ran).toEqual(["a"]);
    expect(order.indexOf("append:STEP_STARTED")).toBeLessThan(order.indexOf("effect:a"));
  });

  it("a refused STEP_STARTED write never runs the effect and fails the run as a storage failure", async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const refused = stepStartedStore(durable, order, "refuse");
    const a = boot(refused.store, { hang: false, order });
    const handle = await a.runtime.start(a.flow, {}, { executionId: "pay-3" });
    const err = await handle.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(StorageWriteError);
    expect((err as StorageWriteError).cause).toBeInstanceOf(DuplicateSequenceError);
    expect(a.ran).toEqual([]); // the effect was never dispatched
    expect(order).not.toContain("effect:a");
  });

  it.each([
    ["undeclared", undefined],
    ["idempotent:true", true],
  ] as const)(
    "a %s effect keeps the write-behind hot path (starts before STEP_STARTED is acked)",
    async (_name, idempotent) => {
      const durable = new InMemoryAsyncEventStore();
      const order: string[] = [];
      const held = stepStartedStore(durable, order, "hold");
      const a = boot(held.store, {
        hang: false,
        order,
        ...(idempotent === undefined ? { idempotent: undefined } : { idempotent }),
      });
      const handle = await a.runtime.start(a.flow, {}, { executionId: "hot-1" });
      // The effect ran while its STEP_STARTED append is still held: no drain on this path.
      await until(() => a.ran.length === 1, "the effect to start");
      expect((await durable.read("hot-1")).map((e) => e.eventType)).not.toContain("STEP_STARTED");
      held.release();
      await handle.waitForCompletion();
    }
  );

  it("a ctx.parallel fan-out of idempotent:false steps dispatches none before STEP_STARTED is durable", async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const held = stepStartedStore(durable, order, "hold");
    const a = boot(held.store, { hang: false, order, fanOut: true });
    const handle = await a.runtime.start(a.flow, {}, { executionId: "fan-1" });
    await until(() => order.includes("append:STEP_STARTED"), "the held STEP_STARTED append");
    expect(a.ran).toEqual([]); // neither branch's effect started
    held.release();
    await handle.waitForCompletion();
    expect([...a.ran].sort()).toEqual(["a", "b"]);
  });

  // A park DECIDED while a non-idempotent step is still draining its STEP_STARTED: the step is
  // in flight (it holds activeWork), so the park barrier waits for it and it runs to completion,
  // journaling its result BEFORE EXECUTION_SUSPENDED. No parkDrainMs (30 s) stall, no stranded
  // STEP_STARTED, so resume never parks EFFECT_INDOUBT.
  it.each([
    ["a sibling ctx.suspend", "suspend"],
    ["a ctx.parallel branch that suspends", "parallel"],
  ] as const)(
    "%s while a non-idempotent step drains: the step completes before EXECUTION_SUSPENDED, no stall, no in-doubt on resume",
    async (_name, kind) => {
      const durable = new InMemoryAsyncEventStore();
      const order: string[] = [];
      const held = stepStartedStore(durable, order, "hold");
      const ran: string[] = [];
      const effects = new EffectRuntime();
      effects.register(
        "tool-a",
        new ToolEffect(
          async () => {
            ran.push("a");
            return { ok: true };
          },
          { idempotent: false }
        )
      );
      const runtime = new WorkflowRuntime({
        eventStore: held.store,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        effectRuntime: effects,
        onWarn: () => {},
      });
      const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => {
        if (kind === "suspend") {
          void ctx.run(stepA, {}).catch(() => {});
          await ctx.suspend({ on: "Approval" });
        } else {
          await ctx.parallel([
            async () => ctx.run(stepA, {}),
            async () => ctx.suspend({ on: "Approval" }),
          ]);
        }
        return { ok: true };
      };
      const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
        _tag: "FlowDefinition",
        id: "park-drain",
        name: "park-drain",
        version: "1.0.0",
        inputSchema: io.inputSchema,
        outputSchema: io.outputSchema,
        steps: [stepA],
      };
      runtime.registerFlow(definition, runner);
      const flow: RegisteredFlow<Record<string, never>, { ok: boolean }> = { definition, runner };
      const id = `park-drain-${kind}`;
      void runtime.start(flow, {}, { executionId: id });
      await until(() => order.includes("append:STEP_STARTED"), "the held STEP_STARTED append");
      expect(ran).toEqual([]);
      held.release();
      const types = async () => (await durable.read(id)).map((e) => e.eventType);
      // Bounded far below parkDrainMs (30 s): a drain-stranded step would stall past this.
      // timing-bound: the stall being excluded is parkDrainMs = 30 s; 5 s is far below it.
      const deadline = Date.now() + 5_000;
      let log = await types();
      while (!log.includes("EXECUTION_SUSPENDED")) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for EXECUTION_SUSPENDED; log=${log.join(",")}`);
        }
        await new Promise((r) => setTimeout(r, 2));
        log = await types();
      }
      expect(ran).toEqual(["a"]);
      expect(log.indexOf("STEP_COMPLETED")).toBeGreaterThan(-1);
      expect(log.indexOf("STEP_COMPLETED")).toBeLessThan(log.indexOf("EXECUTION_SUSPENDED"));
      expect(log).not.toContain("EFFECT_INDOUBT");
      // Resume: the step is already complete, so it is neither re-run nor parked in doubt.
      const handle = await runtime.resume(id, { eventType: "Approval", payload: {} });
      await handle.waitForCompletion();
      const after = await types();
      expect(after).not.toContain("EFFECT_INDOUBT");
      expect(after).toContain("EXECUTION_COMPLETED");
      expect(ran).toEqual(["a"]);
    },
    10_000
  );
});

// A park decided while a non-idempotent step drains its STEP_STARTED, then the execution is
// cancelled or the parallel scope aborts on park (`onPark: "abort"`).
describe("K9.3 STEP_STARTED drain: cancel and onPark abort during the drain", () => {
  function bootPark(
    store: InMemoryAsyncEventStore,
    kind: "suspend" | "abort"
  ): {
    runtime: WorkflowRuntime;
    flow: RegisteredFlow<Record<string, never>, { ok: boolean }>;
    ran: string[];
  } {
    const ran: string[] = [];
    const effects = new EffectRuntime();
    effects.register(
      "tool-a",
      new ToolEffect(
        async () => {
          ran.push("a");
          return { ok: true };
        },
        { idempotent: false }
      )
    );
    const runtime = new WorkflowRuntime({
      eventStore: store,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
      scopes: kind === "abort",
      onWarn: () => {},
    });
    const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => {
      if (kind === "suspend") {
        void ctx.run(stepA, {}).catch(() => {});
        await ctx.suspend({ on: "Approval" });
      } else {
        await ctx.parallel(
          [async () => ctx.run(stepA, {}), async () => ctx.suspend({ on: "Approval" })],
          { onPark: "abort" }
        );
      }
      return { ok: true };
    };
    const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
      _tag: "FlowDefinition",
      id: `park-${kind}`,
      name: `park-${kind}`,
      version: "1.0.0",
      inputSchema: io.inputSchema,
      outputSchema: io.outputSchema,
      steps: [stepA],
    };
    runtime.registerFlow(definition, runner);
    return { runtime, flow: { definition, runner }, ran };
  }

  it("cancel while a park waits on the draining step releases the live handle promptly (no parkDrainMs stall)", async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const held = stepStartedStore(durable, order, "hold");
    const a = bootPark(held.store, "suspend");
    void a.runtime.start(a.flow, {}, { executionId: "cancel-drain" });
    await until(() => order.includes("append:STEP_STARTED"), "the held STEP_STARTED append");
    await until(() => a.runtime.liveHandle("cancel-drain") !== undefined, "the live handle");
    await new Promise((r) => setTimeout(r, 50)); // let the sibling suspend decide the park
    await a.runtime.cancel("cancel-drain");
    held.release();
    // timing-bound: without the fix the handle stays live for parkDrainMs = 30 s; until() allows 5 s.
    await until(
      () => a.runtime.liveHandle("cancel-drain") === undefined,
      "the live handle to release"
    );
    expect(a.ran).toEqual([]);
    expect((await durable.read("cancel-drain")).map((e) => e.eventType)).toContain(
      "EXECUTION_CANCELLED"
    );
  }, 15_000);

  it('onPark:"abort" with scopes: the draining step is STEP_CANCELLED before the park, never runs, and resume completes it with no in-doubt', async () => {
    const durable = new InMemoryAsyncEventStore();
    const order: string[] = [];
    const held = stepStartedStore(durable, order, "hold");
    const a = bootPark(held.store, "abort");
    void a.runtime.start(a.flow, {}, { executionId: "abort-drain" });
    await until(() => order.includes("append:STEP_STARTED"), "the held STEP_STARTED append");
    await new Promise((r) => setTimeout(r, 50));
    held.release();
    const types = async () => (await durable.read("abort-drain")).map((e) => e.eventType);
    // timing-bound: the stall being excluded is parkDrainMs = 30 s; 5 s is far below it.
    const deadline = Date.now() + 5_000;
    let log = await types();
    while (!log.includes("EXECUTION_SUSPENDED")) {
      if (Date.now() > deadline) throw new Error(`timed out; log=${log.join(",")}`);
      await new Promise((r) => setTimeout(r, 2));
      log = await types();
    }
    expect(log.slice(0, 4)).toEqual([
      "EXECUTION_STARTED",
      "STEP_STARTED",
      "STEP_CANCELLED",
      "EXECUTION_SUSPENDED",
    ]);
    expect(a.ran).toEqual([]);
    const handle = await a.runtime.resume("abort-drain", { eventType: "Approval", payload: {} });
    await handle.waitForCompletion();
    const after = await types();
    expect(after).not.toContain("EFFECT_INDOUBT");
    expect(after.slice(-3)).toEqual(
      ["STEP_STARTED", "STEP_COMPLETED", "EXECUTION_COMPLETED"].slice(-3)
    );
    expect(after.at(-1)).toBe("EXECUTION_COMPLETED");
    expect(a.ran).toEqual(["a"]);
  }, 15_000);
});
