import { Priority } from "@loom/scheduler";
import { describe, expect, it } from "vitest";
import { createFairScheduler } from "./fairScheduler";

/** A task that records its label into `order` when it runs, then resolves. */
const mark = (order: string[], label: string) => () => {
  order.push(label);
  return Promise.resolve(label);
};

describe("createFairScheduler — fast path (Infinity)", () => {
  it("runs immediately with no gating and reports zero counts", async () => {
    const s = createFairScheduler();
    const order: string[] = [];
    const results = await Promise.all([s.schedule(mark(order, "a")), s.schedule(mark(order, "b"))]);
    expect(results).toEqual(["a", "b"]);
    expect(s.inFlight).toBe(0);
    expect(s.pending).toBe(0);
  });

  it("rejects a pre-aborted task without running it", async () => {
    const s = createFairScheduler();
    const ac = new AbortController();
    ac.abort();
    await expect(s.schedule(mark([], "x"), { signal: ac.signal })).rejects.toBeDefined();
  });
});

describe("createFairScheduler — fairness under a cap", () => {
  it("does not let one tenant starve another (round-robin across tenants)", async () => {
    const s = createFairScheduler({ concurrency: 1 });
    const order: string[] = [];
    const tasks: Promise<unknown>[] = [];
    // Submit ALL of tenant A, then ALL of tenant B. A naive global FIFO would drain
    // A entirely before touching B; a fair scheduler interleaves them.
    for (let i = 0; i < 3; i++) tasks.push(s.schedule(mark(order, `A${i}`), { tenant: "A" }));
    for (let i = 0; i < 3; i++) tasks.push(s.schedule(mark(order, `B${i}`), { tenant: "B" }));
    await Promise.all(tasks);

    // Tenant B is served before tenant A's queue is drained.
    expect(order.indexOf("B0")).toBeLessThan(order.indexOf("A2"));
    // No tenant runs 3 in a row after the first slot frees (fairness).
    expect(order.join(",")).not.toBe("A0,A1,A2,B0,B1,B2");
  });

  it("gives a higher-weight tenant proportionally more turns", async () => {
    const s = createFairScheduler({ concurrency: 1 });
    const order: string[] = [];
    const tasks: Promise<unknown>[] = [];
    // A has weight 2, B weight 1: A should drain faster.
    for (let i = 0; i < 4; i++)
      tasks.push(s.schedule(mark(order, `A${i}`), { tenant: "A", weight: 2 }));
    for (let i = 0; i < 4; i++)
      tasks.push(s.schedule(mark(order, `B${i}`), { tenant: "B", weight: 1 }));
    await Promise.all(tasks);

    const lastA = order.lastIndexOf("A3");
    const lastB = order.lastIndexOf("B3");
    expect(lastA).toBeLessThan(lastB); // weighted tenant finishes first
  });
});

describe("createFairScheduler — within a tenant", () => {
  it("orders a tenant's queued tasks by priority", async () => {
    const s = createFairScheduler({ concurrency: 1 });
    const order: string[] = [];
    // First task occupies the only slot; the next two queue and must come out by priority.
    const t0 = s.schedule(mark(order, "first"), { tenant: "T" });
    const tIdle = s.schedule(mark(order, "idle"), { tenant: "T", priority: Priority.Idle });
    const tUrgent = s.schedule(mark(order, "urgent"), {
      tenant: "T",
      priority: Priority.UserBlocking,
    });
    await Promise.all([t0, tIdle, tUrgent]);
    expect(order).toEqual(["first", "urgent", "idle"]);
  });
});

describe("createFairScheduler — cancellation", () => {
  it("drops a queued task on abort without ever running it", async () => {
    const s = createFairScheduler({ concurrency: 1 });
    const order: string[] = [];
    let releaseBlocker: () => void = () => {};
    const blocker = s.schedule(() => {
      order.push("blocker");
      return new Promise<void>((r) => {
        releaseBlocker = r;
      });
    });
    const ac = new AbortController();
    const queued = s.schedule(mark(order, "queued"), { signal: ac.signal });
    expect(s.pending).toBe(1);

    ac.abort();
    await expect(queued).rejects.toBeDefined();
    expect(s.pending).toBe(0);

    releaseBlocker();
    await blocker;
    expect(order).toEqual(["blocker"]); // the aborted task never ran
  });
});
