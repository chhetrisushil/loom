import { Priority, createScheduler } from "@loom/scheduler";
import { describe, expect, it, vi } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import { ToolEffect } from "./effects/ToolEffect";
import type { EffectContext, Warmer } from "./types";

function ctx(overrides: Partial<EffectContext> = {}): EffectContext {
  return {
    executionId: "e",
    workflowId: "wf",
    stepId: "s",
    attempt: 1,
    emit: vi.fn(),
    ...overrides,
  };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("EffectRuntime — scheduler in the hot path (M6)", () => {
  it("bounds concurrency across effects when a capped scheduler is configured", async () => {
    const scheduler = createScheduler({ concurrency: 1 });
    const rt = new EffectRuntime([], { scheduler });

    let active = 0;
    let maxActive = 0;
    const gates = [deferred(), deferred(), deferred()];
    gates.forEach((g, i) => {
      rt.register(
        `t${i}`,
        new ToolEffect(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await g.promise;
          active--;
          return i;
        })
      );
    });

    const runs = [0, 1, 2].map((i) => rt.execute(`t${i}`, {}, ctx()));
    // With concurrency 1, only one effect runs at a time.
    await Promise.resolve();
    expect(scheduler.inFlight).toBe(1);
    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    expect(maxActive).toBe(1);
  });

  it("orders queued effects by ctx.priority", async () => {
    const scheduler = createScheduler({ concurrency: 1 });
    const rt = new EffectRuntime([], { scheduler });
    const order: string[] = [];
    for (const id of ["blocker", "idle", "urgent"]) {
      rt.register(
        id,
        new ToolEffect(async () => {
          order.push(id);
          return id;
        })
      );
    }

    // Occupy the single slot so the next two queue, then release.
    const gate = deferred();
    rt.register(
      "blocker",
      new ToolEffect(async () => {
        order.push("blocker");
        await gate.promise;
      })
    );

    const p0 = rt.execute("blocker", {}, ctx());
    await Promise.resolve();
    // Queue an Idle then an Immediate task; the urgent one should run first.
    const p1 = rt.execute("idle", {}, ctx({ priority: Priority.Idle }));
    const p2 = rt.execute("urgent", {}, ctx({ priority: Priority.Immediate }));
    gate.resolve();
    await Promise.all([p0, p1, p2]);

    expect(order).toEqual(["blocker", "urgent", "idle"]);
  });

  it("calls the warmer off-log before running (no events emitted by warming)", async () => {
    const warm = vi.fn();
    const warmer: Warmer = { warm };
    const rt = new EffectRuntime([], { warmer });
    rt.register("t", new ToolEffect(async () => "ok"));
    const emit = vi.fn();

    await rt.execute("t", {}, ctx({ emit }));

    expect(warm).toHaveBeenCalledWith("t");
    expect(emit).not.toHaveBeenCalled(); // warming is pure latency, off the log
  });

  it("no scheduler ⇒ zero-overhead direct path (unchanged)", async () => {
    const rt = new EffectRuntime();
    rt.register("t", new ToolEffect(async () => "ok"));
    await expect(rt.execute("t", {}, ctx())).resolves.toBe("ok");
  });
});
