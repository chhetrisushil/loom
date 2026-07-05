import { describe, expect, it } from "vitest";
import { Priority } from "./priority";
import { createScheduler } from "./scheduler";

const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("createScheduler (unbounded fast path)", () => {
  it("runs the task and forwards the caller signal", async () => {
    const sched = createScheduler();
    const ctrl = new AbortController();
    const seen = await sched.schedule((signal) => Promise.resolve(signal), { signal: ctrl.signal });
    expect(seen).toBe(ctrl.signal);
  });

  it("hands a never-aborting signal when the caller supplies none", async () => {
    const sched = createScheduler();
    const seen = await sched.schedule((signal) => Promise.resolve(signal.aborted));
    expect(seen).toBe(false);
  });

  it("rejects immediately when the caller signal is already aborted", async () => {
    const sched = createScheduler();
    const ctrl = new AbortController();
    ctrl.abort(new Error("nope"));
    await expect(sched.schedule(() => Promise.resolve(1), { signal: ctrl.signal })).rejects.toThrow(
      "nope"
    );
  });

  it("reports zero in-flight/pending (no bookkeeping)", () => {
    const sched = createScheduler();
    expect(sched.inFlight).toBe(0);
    expect(sched.pending).toBe(0);
  });
});

describe("createScheduler (bounded concurrency)", () => {
  it("never runs more than `concurrency` tasks at once", async () => {
    const sched = createScheduler({ concurrency: 2 });
    let active = 0;
    let peak = 0;
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];

    const runs = gates.map((g, i) =>
      sched.schedule(async () => {
        active++;
        peak = Math.max(peak, active);
        await g.promise;
        active--;
        return i;
      })
    );

    await tick();
    expect(sched.inFlight).toBe(2);
    expect(sched.pending).toBe(2);

    for (const g of gates) g.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it("dequeues higher priority (lower enum) first", async () => {
    const sched = createScheduler({ concurrency: 1 });
    const order: string[] = [];
    const block = deferred<void>();

    // Occupy the single slot so the rest queue up.
    const first = sched.schedule(async () => {
      await block.promise;
      order.push("first");
    });
    await tick();

    const idle = sched.schedule(
      () => {
        order.push("idle");
        return Promise.resolve();
      },
      { priority: Priority.Idle }
    );
    const urgent = sched.schedule(
      () => {
        order.push("urgent");
        return Promise.resolve();
      },
      { priority: Priority.Immediate }
    );
    const normal = sched.schedule(
      () => {
        order.push("normal");
        return Promise.resolve();
      },
      { priority: Priority.Normal }
    );

    block.resolve();
    await Promise.all([first, idle, urgent, normal]);
    expect(order).toEqual(["first", "urgent", "normal", "idle"]);
  });

  it("drops a queued task and rejects when aborted before it runs", async () => {
    const sched = createScheduler({ concurrency: 1 });
    const block = deferred<void>();
    const running = sched.schedule(() => block.promise);
    await tick();

    const ctrl = new AbortController();
    let ran = false;
    const queued = sched.schedule(
      () => {
        ran = true;
        return Promise.resolve();
      },
      { signal: ctrl.signal }
    );

    expect(sched.pending).toBe(1);
    ctrl.abort(new Error("cancelled"));
    await expect(queued).rejects.toThrow("cancelled");
    expect(sched.pending).toBe(0);

    block.resolve();
    await running;
    expect(ran).toBe(false);
  });

  it("emits telemetry events in lifecycle order", async () => {
    const events: string[] = [];
    const sched = createScheduler({
      concurrency: 1,
      onEvent: (e) => events.push(e.type),
    });
    await sched.schedule(() => Promise.resolve(42));
    expect(events).toEqual(["scheduled", "started", "settled"]);
  });
});
