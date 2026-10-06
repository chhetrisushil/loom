import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";

// ADR 0118 D2 — a FENCED timer wake takes its fence as an acquire-IF-PARKED (P2-2).

const io = {
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
};
interface Hold {
  entered: Promise<void>;
  enteredResolve?: () => void;
  gate?: Promise<void>;
  release: () => void;
  on: boolean;
}
const echo = step$({ id: "echo", name: "Echo", toolId: "echo", ...io });
const runner: FlowRunner<{ n: number }, { ok: boolean }> = async (ctx) => {
  await ctx.suspend({ on: "GO", wakeAt: 500 });
  return ctx.run(echo, { n: 1 });
};
const definition: FlowDefinition<{ n: number }, { ok: boolean }> = {
  _tag: "FlowDefinition",
  id: "timed",
  name: "timed",
  version: "1.0.0",
  ...io,
  steps: [echo],
};

async function boot(
  before?: (rt: WorkflowRuntime, hold: Hold, inner: InMemoryAsyncEventStore) => Promise<void>,
  contend?: { acquires: number }
) {
  const hold: Hold = { entered: Promise.resolve(), release: () => undefined, on: false };
  const inner = new InMemoryAsyncEventStore();
  let calls = 0;
  const holder: { rt?: WorkflowRuntime } = {};
  const view = Object.create(inner) as InMemoryAsyncEventStore;
  const trigger = async () => {
    if (contend !== undefined) {
      // a rival that acts at the worst moment EVERY time: acquire, never append (dead acquirer)
      contend.acquires++;
      await inner.acquireFence("e1");
      return;
    }
    if (++calls === 1 && before !== undefined)
      await before(holder.rt as WorkflowRuntime, hold, inner);
  };
  view.acquireFenceIf = async (id, expect) => {
    await trigger();
    return inner.acquireFenceIf(id, expect);
  };
  // The unconditional acquire (what the timer used before ADR 0118 D2 reached it) is hooked at the
  // same point, so this test fails for the RIGHT reason against the old code.
  view.acquireFence = async (id) => {
    await trigger();
    return inner.acquireFence(id);
  };
  const effects = new EffectRuntime();
  effects.register(
    "echo",
    new ToolEffect(async () => {
      if (hold.on) {
        hold.enteredResolve?.();
        await hold.gate;
      }
      return { ok: true };
    })
  );
  const timers = new InMemoryTimerStore();
  const clock = { t: 0 };
  const runtime = new WorkflowRuntime({
    eventStore: view,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    timerStore: timers,
    clock: () => clock.t,
  });
  holder.rt = runtime;
  runtime.registerFlow(definition, runner);
  const errors: unknown[] = [];
  const service = new TimerService(runtime, timers, {
    fenced: true,
    onError: (_id, e) => errors.push(e),
    now: () => clock.t,
  });
  const handle = await runtime.start({ definition, runner }, { n: 1 }, { executionId: "e1" });
  await handle.waitForSuspend();
  const kinds = async () => (await inner.read("e1")).map((e) => e.eventType);
  return { inner, runtime, service, timers, errors, kinds, hold, clock };
}

describe("R8k P2-2 — fenced TimerService wake is acquire-if-parked", () => {
  it("fires an unanswered timed park under the conditional fence", async () => {
    const h = await boot();
    await h.service.tick(5000);
    expect(await h.kinds()).toContain("EXECUTION_COMPLETED");
    expect(h.errors).toEqual([]);
    expect(await h.timers.due(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("an external resume landing between the timer's read and its acquire: the running body is NOT fenced out, the timer retires as obsolete", async () => {
    let answered!: Awaited<ReturnType<WorkflowRuntime["resume"]>>;
    const h = await boot(async (rt, hold, inner) => {
      // The external answer lands and its body is INSIDE a step (still running) when the timer's
      // acquire arrives: an acquire that succeeds would fence that body out.
      hold.on = true;
      hold.entered = new Promise<void>((r) => {
        hold.enteredResolve = r;
      });
      hold.gate = new Promise<void>((r) => {
        hold.release = r;
      });
      answered = await rt.resume("e1", { eventType: "GO", payload: {} });
      await hold.entered;
      // The answer must be DURABLE (not merely buffered in the body's journal) when the timer's
      // acquire arrives, or this would test a different race.
      while (!(await inner.read("e1")).some((e) => e.eventType === "EXECUTION_RESUMED")) {
        await new Promise((r) => setTimeout(r, 1));
      }
    });
    await h.service.tick(5000);
    h.hold.release();
    await answered.waitForCompletion();
    const kinds = await h.kinds();
    expect(kinds.filter((k) => k === "EXECUTION_RESUMED")).toHaveLength(1);
    expect(kinds).toContain("EXECUTION_COMPLETED");
    expect(h.errors).toEqual([]);
    expect(await h.timers.due(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await h.inner.acquireFence("e1")).toBe(1); // the loser took no token
  });

  it("a CONTENDED plain wake backs off: not re-attempted on the next poll, retried after the backoff, exhaustion reported once", async () => {
    const contend = { acquires: 0 };
    const h = await boot(undefined, contend);
    // fixed jitter: delay = floor(0.5 * min(cap, base * 2^attempt)); base 100 => 100ms for attempt 1
    const svc = new TimerService(h.runtime, h.timers, {
      fenced: true,
      onError: (_id, e) => h.errors.push(e),
      now: () => h.clock.t,
      maxRedriveAttempts: 3,
      redriveBackoff: { baseMs: 100, capMs: 1000, random: () => 0.5 },
    });
    h.clock.t = 5000;
    await svc.tick(5000);
    const first = contend.acquires;
    expect(first).toBe(3); // the runtime's bounded retries
    expect(h.errors).toEqual([]);
    await svc.tick(5000); // the next poll, no time has passed: NO acquire
    expect(contend.acquires).toBe(first);
    h.clock.t = 5000 + 100; // attempt 1 backoff = 0.5*200 = 100
    await svc.tick(h.clock.t);
    expect(contend.acquires).toBe(first * 2);
    h.clock.t += 10_000;
    await svc.tick(h.clock.t); // attempt 2 -> exhausted (max 3)
    expect(h.errors).toHaveLength(1);
    expect(String(h.errors[0])).toContain("re-drive attempts");
    expect(await h.timers.due(Number.MAX_SAFE_INTEGER)).toEqual([]); // row retired
    h.clock.t += 10_000;
    await svc.tick(h.clock.t);
    expect(h.errors).toHaveLength(1); // once
  });
});
