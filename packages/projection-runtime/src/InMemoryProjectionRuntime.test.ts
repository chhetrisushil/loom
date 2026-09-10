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

  it("never evicts an execution something is SUBSCRIBED to", () => {
    // Eviction is a cache decision the caller never made. Dropping a state that is being
    // folded into resets it to `initialState` — corruption, not a cache miss.
    const rt = new InMemoryProjectionRuntime({ maxExecutions: 2 });
    rt.register(stepCounterProjection);
    rt.handleEvent(makeEvent("a", 1, "STEP_COMPLETED"));
    rt.subscribe<S>("step-counter", "a", () => {});
    rt.handleEvent(makeEvent("b", 1, "STEP_COMPLETED"));
    rt.handleEvent(makeEvent("c", 1, "STEP_COMPLETED")); // "a" is oldest but subscribed

    expect(rt.getState<S>("step-counter", "a").completedSteps).toBe(1); // survived
    expect(rt.getState<S>("step-counter", "b").completedSteps).toBe(0); // evicted instead
  });

  it("keeps DELIVERING to a subscriber whose execution came up for eviction", () => {
    // The harm eviction used to do was not only losing state: `forget` also dropped the
    // subscriber registry, and the handler set is captured by closure — so `notify` looked
    // up a key that no longer existed and the subscriber went silent forever.
    const rt = new InMemoryProjectionRuntime({ maxExecutions: 2 });
    rt.register(stepCounterProjection);
    const seen: S[] = [];
    rt.handleEvent(makeEvent("a", 1, "STEP_COMPLETED"));
    rt.subscribe<S>("step-counter", "a", (s) => seen.push(s));
    rt.handleEvent(makeEvent("b", 1, "STEP_COMPLETED"));
    rt.handleEvent(makeEvent("c", 1, "STEP_COMPLETED")); // eviction pass runs

    rt.handleEvent(makeEvent("a", 2, "STEP_COMPLETED"));
    expect(seen).toEqual([{ completedSteps: 2 }]); // still connected
  });

  it("an explicit forget() still drops state AND subscribers (the caller asked)", () => {
    // The counterpart: `forget` is a deliberate "this execution is done", so it keeps its
    // full meaning. Only EVICTION is narrowed to state.
    const rt = new InMemoryProjectionRuntime();
    rt.register(stepCounterProjection);
    const seen: S[] = [];
    rt.subscribe<S>("step-counter", "x", (s) => seen.push(s));
    rt.handleEvent(makeEvent("x", 1, "STEP_COMPLETED"));
    expect(seen).toHaveLength(1);
    rt.forget("x");
    rt.handleEvent(makeEvent("x", 2, "STEP_COMPLETED"));
    expect(seen).toHaveLength(1); // unchanged — the caller detached it
  });

  it("a stale unsubscribe cannot disconnect a later subscriber on the same key", () => {
    // After `forget`, a new subscriber installs a FRESH set under the same key. The old
    // closure still holds the orphaned one; without an identity check, emptying it would
    // delete the live entry and silence a subscriber that did nothing wrong.
    const rt = new InMemoryProjectionRuntime();
    rt.register(stepCounterProjection);
    const stale = rt.subscribe<S>("step-counter", "x", () => {});
    rt.forget("x");

    const seen: S[] = [];
    rt.subscribe<S>("step-counter", "x", (s) => seen.push(s));
    stale(); // the orphaned subscription retires

    rt.handleEvent(makeEvent("x", 1, "STEP_COMPLETED"));
    expect(seen).toEqual([{ completedSteps: 1 }]);
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

    it("abandons a projection whose load permanently fails — no retry storm, no buffer leak", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const load = vi.fn(async () => {
        throw new Error("missing chunk");
      });
      const rt = new InMemoryProjectionRuntime();
      rt.register(lazyCounter(load));
      rt.handleEvent(makeEvent("a", 1, "STEP_COMPLETED"));
      await Promise.resolve();
      await Promise.resolve();
      // Many more matching events must NOT re-trigger the load (it's abandoned).
      for (let i = 2; i < 50; i++) rt.handleEvent(makeEvent("a", i, "STEP_COMPLETED"));
      expect(load).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to load"));
      warn.mockRestore();
    });
  });

  describe("subscribeSelector (fine-grained slice subscription)", () => {
    // A projection with two independent slices, so we can prove a subscriber bound
    // to one slice is not woken by a change to the other.
    const abProjection: Projection<{ a: number; b: number }> = {
      id: "ab",
      initialState: { a: 0, b: 0 },
      handlers: {
        INCR_A: (s) => ({ ...s, a: s.a + 1 }),
        INCR_B: (s) => ({ ...s, b: s.b + 1 }),
      },
    };

    it("fires only when the selected slice changes, with the new slice value", () => {
      const runtime = new InMemoryProjectionRuntime();
      runtime.register(abProjection);
      const seen: number[] = [];
      runtime.subscribeSelector<{ a: number; b: number }, number>(
        "ab",
        "e1",
        (s) => s.a,
        (a) => seen.push(a)
      );
      runtime.handleEvent(makeEvent("e1", 0, "INCR_A"));
      runtime.handleEvent(makeEvent("e1", 1, "INCR_A"));
      expect(seen).toEqual([1, 2]);
    });

    it("does NOT fire when a different slice of the same projection changes", () => {
      const runtime = new InMemoryProjectionRuntime();
      runtime.register(abProjection);
      const handler = vi.fn();
      runtime.subscribeSelector<{ a: number; b: number }, number>("ab", "e2", (s) => s.a, handler);
      runtime.handleEvent(makeEvent("e2", 0, "INCR_B"));
      runtime.handleEvent(makeEvent("e2", 1, "INCR_B"));
      expect(handler).not.toHaveBeenCalled();
    });

    it("is change-only: does not fire on subscribe", () => {
      const runtime = new InMemoryProjectionRuntime();
      runtime.register(abProjection);
      runtime.handleEvent(makeEvent("e3", 0, "INCR_A")); // state now { a: 1 }
      const handler = vi.fn();
      runtime.subscribeSelector<{ a: number; b: number }, number>("ab", "e3", (s) => s.a, handler);
      // Seeded from current state — no initial call, and no fire until a real change.
      expect(handler).not.toHaveBeenCalled();
      runtime.handleEvent(makeEvent("e3", 1, "INCR_A"));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(2);
    });

    it("stops firing after unsubscribe", () => {
      const runtime = new InMemoryProjectionRuntime();
      runtime.register(abProjection);
      const handler = vi.fn();
      const unsub = runtime.subscribeSelector<{ a: number; b: number }, number>(
        "ab",
        "e4",
        (s) => s.a,
        handler
      );
      runtime.handleEvent(makeEvent("e4", 0, "INCR_A"));
      unsub();
      runtime.handleEvent(makeEvent("e4", 1, "INCR_A"));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("honours a custom isEqual — a structurally-equal new slice does not fire", () => {
      const tagProjection: Projection<{ tags: string[] }> = {
        id: "tags",
        initialState: { tags: ["x"] },
        // TOUCH replaces the array with a fresh, equal-contents array (new reference).
        handlers: { TOUCH: (s) => ({ tags: [...s.tags] }) },
      };
      const runtime = new InMemoryProjectionRuntime();
      runtime.register(tagProjection);
      const arraysEqual = (a: string[], b: string[]) =>
        a.length === b.length && a.every((v, i) => v === b[i]);
      const handler = vi.fn();
      runtime.subscribeSelector<{ tags: string[] }, string[]>(
        "tags",
        "e5",
        (s) => s.tags,
        handler,
        arraysEqual
      );
      runtime.handleEvent(makeEvent("e5", 0, "TOUCH"));
      // New array reference but equal contents — custom isEqual suppresses the fire.
      expect(handler).not.toHaveBeenCalled();
    });

    it("routes independent slices to independent subscribers", () => {
      const runtime = new InMemoryProjectionRuntime();
      runtime.register(abProjection);
      const aSeen = vi.fn();
      const bSeen = vi.fn();
      runtime.subscribeSelector<{ a: number; b: number }, number>("ab", "e6", (s) => s.a, aSeen);
      runtime.subscribeSelector<{ a: number; b: number }, number>("ab", "e6", (s) => s.b, bSeen);
      runtime.handleEvent(makeEvent("e6", 0, "INCR_A"));
      expect(aSeen).toHaveBeenCalledTimes(1);
      expect(aSeen).toHaveBeenCalledWith(1);
      expect(bSeen).not.toHaveBeenCalled();
    });

    it("coalesce mode: a burst collapses to one selector call with the latest slice", async () => {
      const runtime = new InMemoryProjectionRuntime({ coalesceNotifications: true });
      runtime.register(abProjection);
      const handler = vi.fn();
      runtime.subscribeSelector<{ a: number; b: number }, number>("ab", "e7", (s) => s.a, handler);
      for (let i = 0; i < 5; i++) runtime.handleEvent(makeEvent("e7", i, "INCR_A"));
      expect(handler).not.toHaveBeenCalled(); // deferred to a microtask
      await Promise.resolve();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(5);
    });
  });
});

// ── ADR 0095 — the declared fold semantics ────────────────────────────────────
describe("pins() — what an artifact's recorded version is compared against", () => {
  it("reports the declared version of every registered projection that has one", () => {
    const runtime = new InMemoryProjectionRuntime();
    runtime.register({ ...stepCounterProjection, id: "latency", version: "3" });
    runtime.register({ ...stepCounterProjection, id: "deploys", version: "1" });
    expect(runtime.pins()).toEqual({ latency: "3", deploys: "1" });
  });

  it("keeps a version under a hostile id instead of setting a prototype", () => {
    // `{}` would swallow this: assigning `__proto__` sets a prototype rather than adding a
    // key, so the projection would vanish from every comparison with no finding anywhere.
    const runtime = new InMemoryProjectionRuntime();
    runtime.register({ ...stepCounterProjection, id: "__proto__", version: "3" });
    // `Object.entries`, not an index read: it asserts the key AND the value, and reads as
    // the data question this is — does the map contain this entry — rather than as a
    // property access that would look like prototype fiddling.
    expect(Object.entries(runtime.pins())).toEqual([["__proto__", "3"]]);
  });

  it("a projection declaring no version is ABSENT, not present-and-empty", () => {
    // Present-and-empty would compare equal to another empty declaration and read as a
    // verified match between two folds that said nothing about themselves.
    const runtime = new InMemoryProjectionRuntime();
    runtime.register({ ...stepCounterProjection, id: "latency" });
    expect(runtime.pins()).toEqual({});
    expect(Object.hasOwn(runtime.pins(), "latency")).toBe(false);
  });
});
