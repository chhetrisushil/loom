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
  const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) =>
    opts.fanOut === true
      ? (
          await ctx.parallel([
            [stepA, {}],
            [stepB, {}],
          ])
        )[0]
      : ctx.run(stepA, {});
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
  it("a crash after the effect ran parks in doubt on recovery, not re-runs", async () => {
    const durable = new InMemoryAsyncEventStore();

    // Process A: the effect body runs and the process dies while it is in flight.
    const a = boot(durable, { hang: true });
    void a.runtime.start(a.flow, {}, { executionId: "pay-1" });
    await until(() => a.ran.length === 1, "process A's effect to run");
    // The effect ran, so its STEP_STARTED must already be in the durable log.
    expect((await durable.read("pay-1")).map((e) => e.eventType)).toContain("STEP_STARTED");

    // Process B: fresh runtime over the same durable log.
    const b = boot(durable, { hang: false });
    await recoverAbandoned(b.runtime, { source: durable, isAbandoned: () => true });
    const logB = (await durable.read("pay-1")).map((e) => e.eventType);

    expect(logB).toContain("EFFECT_INDOUBT");
    expect(b.ran).toEqual([]); // the non-idempotent effect must NOT run a second time
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
});
