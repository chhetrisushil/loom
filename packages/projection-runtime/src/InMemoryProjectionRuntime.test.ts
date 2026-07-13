import type { EventEnvelope } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { InMemoryProjectionRuntime } from "./InMemoryProjectionRuntime";
import type { Projection, ProjectionFoldMap } from "./types";

function makeEvent(executionId: string, sequence: number, eventType: string): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "test-flow",
    executionId,
    eventType,
    sequence,
    timestamp: Date.now(),
    payload: {},
  };
}

const stepCounterProjection: Projection<{ completedSteps: number }> = {
  id: "step-counter",
  initialState: { completedSteps: 0 },
  handlers: {
    STEP_COMPLETED: (state) => ({ completedSteps: state.completedSteps + 1 }),
  },
};

describe("InMemoryProjectionRuntime", () => {
  it("returns initialState before any events", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register(stepCounterProjection);
    const state = runtime.getState<{ completedSteps: number }>("step-counter", "exec-1");
    expect(state).toEqual({ completedSteps: 0 });
  });

  it("throws for unknown projection", () => {
    const runtime = new InMemoryProjectionRuntime();
    expect(() => runtime.getState("unknown-proj", "exec-1")).toThrow(
      'Projection "unknown-proj" is not registered'
    );
  });

  it("folds events into projection state", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register(stepCounterProjection);
    runtime.handleEvent(makeEvent("exec-1", 0, "STEP_COMPLETED"));
    runtime.handleEvent(makeEvent("exec-1", 1, "STEP_COMPLETED"));
    runtime.handleEvent(makeEvent("exec-1", 2, "STEP_COMPLETED"));
    expect(
      runtime.getState<{ completedSteps: number }>("step-counter", "exec-1").completedSteps
    ).toBe(3);
  });

  it("ignores unhandled event types", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register(stepCounterProjection);
    runtime.handleEvent(makeEvent("exec-1", 0, "EXECUTION_STARTED"));
    runtime.handleEvent(makeEvent("exec-1", 1, "EXECUTION_SUSPENDED"));
    expect(
      runtime.getState<{ completedSteps: number }>("step-counter", "exec-1").completedSteps
    ).toBe(0);
  });

  it("isolates state by executionId", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register(stepCounterProjection);
    runtime.handleEvent(makeEvent("exec-A", 0, "STEP_COMPLETED"));
    runtime.handleEvent(makeEvent("exec-A", 1, "STEP_COMPLETED"));
    runtime.handleEvent(makeEvent("exec-B", 0, "STEP_COMPLETED"));
    expect(
      runtime.getState<{ completedSteps: number }>("step-counter", "exec-A").completedSteps
    ).toBe(2);
    expect(
      runtime.getState<{ completedSteps: number }>("step-counter", "exec-B").completedSteps
    ).toBe(1);
  });

  it("calls subscribe handler when event is processed", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register(stepCounterProjection);
    const handler = vi.fn();
    runtime.subscribe("step-counter", "exec-2", handler);
    runtime.handleEvent(makeEvent("exec-2", 0, "STEP_COMPLETED"));
    runtime.handleEvent(makeEvent("exec-2", 1, "STEP_COMPLETED"));
    runtime.handleEvent(makeEvent("exec-2", 2, "STEP_COMPLETED"));
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[2]?.[0]).toEqual({ completedSteps: 3 });
  });

  it("does not call handler after unsubscribe", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register(stepCounterProjection);
    const handler = vi.fn();
    const unsub = runtime.subscribe("step-counter", "exec-3", handler);
    unsub();
    runtime.handleEvent(makeEvent("exec-3", 0, "STEP_COMPLETED"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not notify subscribers for other executionIds", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register(stepCounterProjection);
    const handler = vi.fn();
    runtime.subscribe("step-counter", "exec-X", handler);
    runtime.handleEvent(makeEvent("exec-Y", 0, "STEP_COMPLETED"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("coalesce mode: a burst of N events fires the subscriber once with the latest state", async () => {
    const runtime = new InMemoryProjectionRuntime({ coalesceNotifications: true });
    runtime.register(stepCounterProjection);
    const handler = vi.fn();
    runtime.subscribe("step-counter", "exec-c", handler);

    for (let i = 0; i < 5; i++) {
      runtime.handleEvent(makeEvent("exec-c", i, "STEP_COMPLETED"));
    }

    // Nothing synchronously — notifications are deferred to a microtask.
    expect(handler).toHaveBeenCalledTimes(0);
    // State is still updated synchronously and correctly.
    expect(
      runtime.getState<{ completedSteps: number }>("step-counter", "exec-c").completedSteps
    ).toBe(5);

    await Promise.resolve();

    // One coalesced call carrying the final state, not five.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toEqual({ completedSteps: 5 });
  });

  it("coalesce mode: separate microtask ticks each flush once", async () => {
    const runtime = new InMemoryProjectionRuntime({ coalesceNotifications: true });
    runtime.register(stepCounterProjection);
    const handler = vi.fn();
    runtime.subscribe("step-counter", "exec-d", handler);

    runtime.handleEvent(makeEvent("exec-d", 0, "STEP_COMPLETED"));
    await Promise.resolve();
    runtime.handleEvent(makeEvent("exec-d", 1, "STEP_COMPLETED"));
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toEqual({ completedSteps: 2 });
  });

  it("integrates with workflow-runtime style: 3-step flow, subscription fires 3 times", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register(stepCounterProjection);

    const calls: Array<{ completedSteps: number }> = [];
    runtime.subscribe("step-counter", "exec-flow", (state) =>
      calls.push(state as { completedSteps: number })
    );

    for (let i = 0; i < 3; i++) {
      runtime.handleEvent(makeEvent("exec-flow", i, "STEP_COMPLETED"));
    }

    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({ completedSteps: 3 });
  });
});

describe("InMemoryProjectionRuntime — retention (leak fix)", () => {
  type S = { completedSteps: number };

  it("forget(executionId) drops retained state (reverts to initialState)", () => {
    const rt = new InMemoryProjectionRuntime();
    rt.register(stepCounterProjection);
    rt.handleEvent(makeEvent("x", 1, "STEP_COMPLETED"));
    expect(rt.getState<S>("step-counter", "x").completedSteps).toBe(1);
    rt.forget("x");
    expect(rt.getState<S>("step-counter", "x").completedSteps).toBe(0);
  });

  it("bounds retained executions via maxExecutions (LRU by touch)", () => {
    const rt = new InMemoryProjectionRuntime({ maxExecutions: 2 });
    rt.register(stepCounterProjection);
    rt.handleEvent(makeEvent("a", 1, "STEP_COMPLETED"));
    rt.handleEvent(makeEvent("b", 1, "STEP_COMPLETED"));
    rt.handleEvent(makeEvent("c", 1, "STEP_COMPLETED")); // evicts oldest (a)
    expect(rt.getState<S>("step-counter", "a").completedSteps).toBe(0); // evicted
    expect(rt.getState<S>("step-counter", "b").completedSteps).toBe(1);
    expect(rt.getState<S>("step-counter", "c").completedSteps).toBe(1);
  });

  it("keeps a re-touched execution alive (LRU recency)", () => {
    const rt = new InMemoryProjectionRuntime({ maxExecutions: 2 });
    rt.register(stepCounterProjection);
    rt.handleEvent(makeEvent("a", 1, "STEP_COMPLETED"));
    rt.handleEvent(makeEvent("b", 1, "STEP_COMPLETED"));
    rt.handleEvent(makeEvent("a", 2, "STEP_COMPLETED")); // touch a → b is now oldest
    rt.handleEvent(makeEvent("c", 1, "STEP_COMPLETED")); // evicts b
    expect(rt.getState<S>("step-counter", "a").completedSteps).toBe(2);
    expect(rt.getState<S>("step-counter", "b").completedSteps).toBe(0); // evicted
  });

  describe("event-type-gated lazy projections", () => {
    const lazyCounter = (load: () => Promise<ProjectionFoldMap<S>>): Projection<S> => ({
      id: "lazy-counter",
      initialState: { completedSteps: 0 },
      lazy: { eventTypes: ["STEP_COMPLETED"], load },
    });

    it("never loads the fold code when no handled event fires", async () => {
      const load = vi.fn();
      const rt = new InMemoryProjectionRuntime();
      rt.register(lazyCounter(load as never));
      rt.handleEvent(makeEvent("a", 1, "SOMETHING_ELSE")); // not in eventTypes
      rt.handleEvent(makeEvent("a", 2, "ANOTHER")); // not in eventTypes
      await Promise.resolve();
      expect(load).not.toHaveBeenCalled();
    });

    it("loads on the first matching event and folds buffered events in order", async () => {
      const foldMap: ProjectionFoldMap<S> = {
        STEP_COMPLETED: (state) => ({ completedSteps: state.completedSteps + 1 }),
      };
      const load = vi.fn(async () => foldMap);
      const rt = new InMemoryProjectionRuntime();
      rt.register(lazyCounter(load));

      // Three matching events arrive before the async load resolves — all buffered.
      rt.handleEvent(makeEvent("a", 1, "STEP_COMPLETED"));
      rt.handleEvent(makeEvent("a", 2, "STEP_COMPLETED"));
      rt.handleEvent(makeEvent("a", 3, "STEP_COMPLETED"));
      expect(load).toHaveBeenCalledTimes(1); // loaded once, not per event
      expect(rt.getState<S>("lazy-counter", "a").completedSteps).toBe(0); // not yet caught up

      await Promise.resolve(); // let the load promise resolve + buffer drain
      expect(rt.getState<S>("lazy-counter", "a").completedSteps).toBe(3); // caught up in order
    });

    it("folds synchronously once loaded (no re-import)", async () => {
      const foldMap: ProjectionFoldMap<S> = {
        STEP_COMPLETED: (state) => ({ completedSteps: state.completedSteps + 1 }),
      };
      const load = vi.fn(async () => foldMap);
      const rt = new InMemoryProjectionRuntime();
      rt.register(lazyCounter(load));
      rt.handleEvent(makeEvent("a", 1, "STEP_COMPLETED"));
      await Promise.resolve();
      rt.handleEvent(makeEvent("a", 2, "STEP_COMPLETED")); // now on the loaded fast path
      expect(load).toHaveBeenCalledTimes(1);
      expect(rt.getState<S>("lazy-counter", "a").completedSteps).toBe(2);
    });
  });
});
