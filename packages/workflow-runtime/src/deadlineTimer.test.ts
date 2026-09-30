import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { MAX_TIMER_MS, armDeadline, remainingBudget } from "./deadlineTimer";
import type { RegisteredFlow } from "./types";

// L26 follow-up — Node clamps a setTimeout above 2^31-1 ms (~24.8 days) to 1ms, so a long
// (or clock-inflated) remaining budget fired the deadline almost immediately. Fake timers
// only: nothing here waits in real time.

const DAY = 86_400_000;
const io = z.object({ n: z.number() });
type Io = { n: number };

const hang = (timeoutMs?: number) =>
  step$({
    id: "hang",
    name: "hang",
    toolId: "hang-tool",
    inputSchema: io,
    outputSchema: io,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });

function boot(now: () => number, opts: { timeoutMs?: number; deadlineMs?: number }) {
  const step = hang(opts.timeoutMs);
  const effectRuntime = new EffectRuntime();
  effectRuntime.register("hang-tool", new ToolEffect(() => new Promise<never>(() => {})));
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime,
    now,
  });
  const definition: FlowDefinition<Io, Io> = {
    _tag: "FlowDefinition",
    id: "dt",
    name: "dt",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [step],
    ...(opts.deadlineMs !== undefined && { deadlineMs: opts.deadlineMs }),
  };
  const flow: RegisteredFlow<Io, Io> = {
    definition,
    runner: async (ctx, input) => ctx.run(step, input),
  };
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, flow, eventStore };
}

const has = async (store: InMemoryAsyncEventStore, id: string, type: string) =>
  (await store.read(id)).some((e: EventEnvelope) => e.eventType === type);

/** Track a completion promise so an eventual rejection is observed, never unhandled. */
function track(p: Promise<unknown>) {
  const s = { settled: false, error: undefined as unknown };
  p.then(
    () => {
      s.settled = true;
    },
    (e) => {
      s.settled = true;
      s.error = e;
    }
  );
  return s;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("remainingBudget / armDeadline", () => {
  it("caps the remaining budget at the full budget when the clock steps backwards", () => {
    expect(remainingBudget(5000, 1_000_000, () => 1_000_000 - 30 * DAY)).toBe(5000);
    expect(remainingBudget(5000, 1_000_000, () => 1_002_000)).toBe(3000);
  });

  it("clear() cancels a pending (chunked) timer", () => {
    const onBreach = vi.fn();
    const clear = armDeadline(() => 30 * DAY, onBreach);
    clear();
    vi.advanceTimersByTime(60 * DAY);
    expect(onBreach).not.toHaveBeenCalled();
  });

  it("re-arms in chunks and breaches exactly at the budget", () => {
    const start = Date.now();
    const onBreach = vi.fn();
    armDeadline(() => remainingBudget(30 * DAY, start, Date.now), onBreach);
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(onBreach).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30 * DAY - MAX_TIMER_MS - 1);
    expect(onBreach).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onBreach).toHaveBeenCalledTimes(1);
  });
});

describe("L26 follow-up — long and inflated deadlines", () => {
  it("deadlineMs = 30 days is NOT cancelled ~1ms after start, and breaches at 30 days", async () => {
    const { runtime, flow, eventStore } = boot(Date.now, { deadlineMs: 30 * DAY });
    const handle = await runtime.start(flow, { n: 1 }, { executionId: "d30" });
    const done = track(handle.waitForCompletion());
    await vi.advanceTimersByTimeAsync(1000);
    expect(done.settled).toBe(false);
    expect(await has(eventStore, "d30", "EXECUTION_CANCELLED")).toBe(false);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS); // past the first chunk, still inside budget
    expect(done.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * DAY - MAX_TIMER_MS - 1000 + 1);
    expect(done.settled).toBe(true);
    expect(String(done.error)).toMatch(/deadline exceeded/);
    expect(await has(eventStore, "d30", "EXECUTION_CANCELLED")).toBe(true);
  });

  it("a step with timeoutMs = 30 days does not time out early, and times out at 30 days", async () => {
    const { runtime, flow, eventStore } = boot(Date.now, { timeoutMs: 30 * DAY });
    const handle = await runtime.start(flow, { n: 1 }, { executionId: "s30" });
    const done = track(handle.waitForCompletion());
    await vi.advanceTimersByTimeAsync(1000);
    expect(done.settled).toBe(false);
    expect(await has(eventStore, "s30", "STEP_FAILED")).toBe(false);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS);
    expect(done.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * DAY - MAX_TIMER_MS - 1000 + 1);
    expect(done.settled).toBe(true);
    expect(String(done.error)).toMatch(/exceeded its deadline/);
  });

  async function seedStarted(store: InMemoryAsyncEventStore, id: string, at: number) {
    await store.append({
      id: `${id}-0`,
      workflowId: "dt",
      executionId: id,
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: at,
      payload: { input: { n: 1 } },
    });
  }

  it("a clock that stepped BACKWARDS gets at most the full budget (no 1ms clamp)", async () => {
    // Log written under the wall clock; the recovering node's clock is 30 days behind.
    const { runtime, eventStore } = boot(() => Date.now() - 30 * DAY, { deadlineMs: 10_000 });
    await seedStarted(eventStore, "back", Date.now());
    const handle = await runtime.resume(
      "back",
      { eventType: "EXECUTION_RECOVERED", payload: {} },
      { deadlineMs: 10_000 }
    );
    const done = track(handle.waitForCompletion());
    await vi.advanceTimersByTimeAsync(1000);
    expect(done.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(9000 + 1);
    expect(done.settled).toBe(true);
    expect(String(done.error)).toMatch(/deadline exceeded/);
  });

  it("A4 under `now`: elapsed budget carries across a crash and resume (total, not a fresh budget)", async () => {
    const offset = 5e9; // an offset clock that still advances in real time
    const now = () => Date.now() + offset;
    const { runtime, eventStore } = boot(now, { deadlineMs: 10_000 });
    await seedStarted(eventStore, "a4", now()); // execution started...
    await vi.advanceTimersByTimeAsync(4000); // ...ran 4s, then the process crashed
    const handle = await runtime.resume(
      "a4",
      { eventType: "EXECUTION_RECOVERED", payload: {} },
      { deadlineMs: 10_000 }
    );
    const done = track(handle.waitForCompletion());
    await vi.advanceTimersByTimeAsync(5000); // 4s + 5s = 9s of 10s
    expect(done.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1001); // 10s total — a fresh budget would run to 14s
    expect(done.settled).toBe(true);
    expect(String(done.error)).toMatch(/deadline exceeded/);
  });
});

describe("invalid budgets are rejected, never armed as a 1ms timer", () => {
  const bad = [Number.NaN, 0, -5, Number.POSITIVE_INFINITY];
  for (const v of bad) {
    it(`a step with timeoutMs = ${v} (built without step$) fails before STEP_STARTED`, async () => {
      const step = { ...hang(), timeoutMs: v };
      const effectRuntime = new EffectRuntime();
      effectRuntime.register("hang-tool", new ToolEffect(() => new Promise<never>(() => {})));
      const eventStore = new InMemoryAsyncEventStore();
      const runtime = new WorkflowRuntime({
        eventStore,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        effectRuntime,
      });
      // steps: [] so registerFlow does not catch it; the ctx.run guard must.
      const definition: FlowDefinition<Io, Io> = {
        _tag: "FlowDefinition",
        id: "bad",
        name: "bad",
        version: "1.0.0",
        inputSchema: io,
        outputSchema: io,
        steps: [],
      };
      runtime.registerFlow(definition, async (ctx, input) => ctx.run(step, input));
      const handle = await runtime.start(definition, { n: 1 }, { executionId: "bs" });
      const done = track(handle.waitForCompletion());
      await vi.advanceTimersByTimeAsync(10);
      expect(done.settled).toBe(true);
      expect(String(done.error)).toMatch(/timeoutMs must be a finite number > 0/);
      expect(await has(eventStore, "bs", "STEP_STARTED")).toBe(false);
    });

    it(`registerFlow rejects deadlineMs = ${v} and a step timeoutMs = ${v}`, () => {
      const { runtime } = boot(Date.now, {});
      const base = {
        _tag: "FlowDefinition" as const,
        name: "x",
        version: "1.0.0",
        inputSchema: io,
        outputSchema: io,
      };
      expect(() =>
        runtime.registerFlow({ ...base, id: "x1", steps: [], deadlineMs: v }, async () => ({
          n: 1,
        }))
      ).toThrow(/deadlineMs must be a finite number > 0/);
      expect(() =>
        runtime.registerFlow(
          { ...base, id: "x2", steps: [{ ...hang(), timeoutMs: v }] },
          async () => ({
            n: 1,
          })
        )
      ).toThrow(/timeoutMs must be a finite number > 0/);
    });

    it(`a per-call deadlineMs = ${v} is rejected and cancels nothing at 1ms`, async () => {
      const { runtime, flow, eventStore } = boot(Date.now, {});
      await expect(
        runtime.start(flow, { n: 1 }, { executionId: "pc", deadlineMs: v })
      ).rejects.toThrow(/deadlineMs must be a finite number > 0/);
      expect(await has(eventStore, "pc", "EXECUTION_CANCELLED")).toBe(false);
    });
  }
});

describe("fixed clock with a budget over 2^31 ms", () => {
  it("never fires within a single run and does not busy-loop", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const fixed = () => 1_000_000;
    const { runtime, flow, eventStore } = boot(fixed, { deadlineMs: 30 * DAY });
    const handle = await runtime.start(flow, { n: 1 }, { executionId: "fx" });
    const done = track(handle.waitForCompletion());
    const before = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6 * MAX_TIMER_MS); // ~149 days, several chunks
    expect(done.settled).toBe(false);
    expect(await has(eventStore, "fx", "EXECUTION_CANCELLED")).toBe(false);
    // one re-arm per elapsed chunk, not a spin
    expect(spy.mock.calls.length - before).toBeLessThanOrEqual(8);
    spy.mockRestore();
  });

  it("armDeadline: a fixed clock re-arms once per chunk, never breaches", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const onBreach = vi.fn();
    const clear = armDeadline(() => 30 * DAY, onBreach);
    vi.advanceTimersByTime(5 * MAX_TIMER_MS);
    expect(onBreach).not.toHaveBeenCalled();
    expect(spy.mock.calls.length).toBeLessThanOrEqual(6);
    clear();
    spy.mockRestore();
  });
});
