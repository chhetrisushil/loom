import type { EventEnvelope } from "@loomwork/core";
import { EffectRuntime } from "@loomwork/effect-runtime";
import {
  InMemoryAsyncEventStore,
  brandPayloadShredded,
  isPayloadShredded,
} from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  type FlowRunner,
  LogLifecycle,
  type RegisteredFlow,
  WorkflowRuntime,
  deepestGeneration,
  routeKeepSet,
} from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { awaitChild, awaitedByParent, superviseChildren } from "./index";
import type { ChildSupervisor } from "./orchestration";

// ADR 0145 / 0109 residual (0): the pin keeps only {@link routeKeepSet}(head) of a continued
// child's generations while the parent is alive, using the SAME exported search as the kernel.

const C = "P::k";
const idOf = (g: number): string => (g === 0 ? C : `${C}~${g}`);
const ev = (id: string, sequence: number, eventType: string, payload: unknown, kernel = false) =>
  ({
    id: `${id}-${sequence}`,
    workflowId: "perp",
    executionId: id,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
    ...(kernel && { metadata: { kernel: true } }),
  }) as unknown as EventEnvelope;

/** Append generation `g` of the chain (STARTED, then SUSPENDED = the live head). */
async function addGeneration(store: InMemoryAsyncEventStore, g: number, extra = {}) {
  await store.append(
    ev(
      idOf(g),
      0,
      "EXECUTION_STARTED",
      g === 0
        ? { parent: "P" }
        : {
            parent: "P",
            chainId: C,
            generation: g,
            continuedFrom: { executionId: idOf(g - 1) },
            ...extra,
          }
    )
  );
  await store.append(ev(idOf(g), 1, "EXECUTION_SUSPENDED", {}));
}
/** Rotate: generation `g` (the old head) records the kernel's EXECUTION_CONTINUED. */
const markContinued = (store: InMemoryAsyncEventStore, g: number) =>
  store.append(ev(idOf(g), 2, "EXECUTION_CONTINUED", {}, true));

async function seedChain(
  head: number,
  parentEvents = ["EXECUTION_STARTED", "EXECUTION_SUSPENDED"]
) {
  const store = new InMemoryAsyncEventStore();
  for (let i = 0; i < parentEvents.length; i++) {
    await store.append(ev("P", i, parentEvents[i] as string, {}));
  }
  for (let g = 0; g <= head; g++) {
    await addGeneration(store, g);
    if (g < head) await markContinued(store, g);
  }
  return store;
}

/** The generations the pin would release (not pinned) among those present. */
async function releasable(
  store: InMemoryAsyncEventStore,
  head: number,
  onWarn: (m: string) => void = () => {}
) {
  const pin = awaitedByParent(store, { onWarn });
  const out: number[] = [];
  for (let g = 0; g <= head; g++) {
    if ((await store.read(idOf(g))).length === 0) continue;
    if (!(await pin(idOf(g)))) out.push(g);
  }
  return out;
}
const complement = (head: number): number[] =>
  Array.from({ length: head + 1 }, (_, g) => g).filter((g) => !routeKeepSet(head).has(g));
const existsIn = (store: InMemoryAsyncEventStore) => async (g: number) =>
  (await store.read(idOf(g))).length > 0;

describe("awaitedByParent - a continued child keeps routeKeepSet(head), not every generation", () => {
  it("releases exactly the complement of K(head) for every head to 40, and the kernel's search still finds the head from what remains", async () => {
    for (let head = 1; head <= 40; head++) {
      const store = await seedChain(head);
      const released = await releasable(store, head);
      expect(released, `head ${head}`).toEqual(complement(head));
      for (const g of released) await store.deleteExecution?.(idOf(g));
      expect(await deepestGeneration(0, existsIn(store))).toBe(head);
    }
  }, 60000);

  it("a child that is not a continuation (generation 0) is judged by the parent alone, as before", async () => {
    const store = await seedChain(0);
    expect(await awaitedByParent(store)(C)).toBe(true);
  });

  it("monotone across rotations: what is released at head H stays released-safe at H+1 (7->8, 15->16, 63->64)", async () => {
    for (const head of [7, 15, 63]) {
      const store = await seedChain(head);
      for (const g of await releasable(store, head)) await store.deleteExecution?.(idOf(g));
      // rotate: the old head records CONTINUED, the successor starts
      await markContinued(store, head);
      await addGeneration(store, head + 1);
      expect(await deepestGeneration(0, existsIn(store)), `rotation ${head}->${head + 1}`).toBe(
        head + 1
      );
      for (const g of routeKeepSet(head + 1)) {
        expect((await store.read(idOf(g))).length, `K(${head + 1}) member ${g}`).toBeGreaterThan(0);
      }
      // and the next pass only ever releases what is outside the new K
      for (const g of await releasable(store, head + 1)) {
        expect(routeKeepSet(head + 1).has(g)).toBe(false);
      }
    }
  }, 60000);

  it("a parent that ended releases nothing extra here (it is judged first), and a live one never releases generation 0 or the last two", async () => {
    const store = await seedChain(20);
    const released = await releasable(store, 20);
    for (const g of [0, 19, 20]) expect(released).not.toContain(g);
    const ended = await seedChain(20, ["EXECUTION_STARTED", "EXECUTION_COMPLETED"]);
    expect(await releasable(ended, 20)).toEqual(Array.from({ length: 21 }, (_, g) => g));
  });
});

describe("awaitedByParent - generations fail safe (keep + warn once)", () => {
  it("a pre-pin gap in the search path (a member of E(H) deleted directly) pins every generation and warns once", async () => {
    const store = await seedChain(20);
    await store.deleteExecution?.(idOf(15)); // 15 in E(20): the search now ends at 14, a CONTINUED generation
    const warnings: string[] = [];
    expect(await releasable(store, 20, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(C);
  });

  it("a pre-pin gap that ends the search early keeps every generation SILENTLY (all candidates in K(D) or >= D-1)", async () => {
    const store = await seedChain(20);
    // 1 is the search's first probe: with it gone the search ends at D=0, so every surviving m >= D-1 is kept by the
    // cheap decision and no verification (hence no doubt warning) runs.
    await store.deleteExecution?.(idOf(1));
    const warnings: string[] = [];
    expect(await releasable(store, 20, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a pre-pin gap that leaves a candidate outside K(D) below D-1 keeps everything and WARNS", async () => {
    const store = await seedChain(20);
    // 7 in E(20): the search now ends at D=6 (a CONTINUED generation); 2 is outside K(6) and below 5, so it is verified,
    // the head check fails, and the pin keeps and warns once.
    await store.deleteExecution?.(idOf(7));
    const warnings: string[] = [];
    expect(await releasable(store, 20, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("generation 6 is continued");
  });

  it("a probe read that throws pins and warns", async () => {
    const store = await seedChain(20);
    const failing = new Proxy(store, {
      get: (t, p, r) =>
        p === "readRange"
          ? async (id: string, from: number, to: number) => {
              if (id === idOf(15)) throw new Error("backend down");
              return t.readRange(id, from, to);
            }
          : Reflect.get(t, p, r),
    });
    const warnings: string[] = [];
    const pin = awaitedByParent(failing, { onWarn: (m) => warnings.push(m) });
    expect(await pin(idOf(2))).toBe(true);
    expect(await pin(idOf(4))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("backend down");
  });

  it("a shredded probe read keeps (no release) and, as for any shredded log, is silent", async () => {
    const store = await seedChain(20);
    const failing = new Proxy(store, {
      get: (t, p, r) =>
        p === "readRange"
          ? async (id: string, from: number, to: number) => {
              if (id === idOf(15)) {
                const e = new Error("shredded");
                brandPayloadShredded(e);
                expect(isPayloadShredded(e)).toBe(true);
                throw e;
              }
              return t.readRange(id, from, to);
            }
          : Reflect.get(t, p, r),
    });
    const warnings: string[] = [];
    expect(await awaitedByParent(failing, { onWarn: (m) => warnings.push(m) })(idOf(2))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("a busy head (70 events after its newest lifecycle event: the tip scan is capped) still releases exactly the complement of K(D) and does not warn", async () => {
    const store = await seedChain(20);
    for (let i = 0; i < 70; i++) await store.append(ev(idOf(20), 2 + i, "STEP_COMPLETED", {}));
    const warnings: string[] = [];
    expect(await releasable(store, 20, (m) => warnings.push(m))).toEqual(complement(20));
    expect(warnings).toEqual([]);
  });

  it("the cheap keep decision runs first: a K(D) member skips verification (no tip read) and a doubt never names it", async () => {
    const store = await seedChain(20);
    await markContinued(store, 20); // head 20 is "continued": verification would doubt
    const tipReads: string[] = [];
    const counting = new Proxy(store, {
      get: (t, p, r) =>
        p === "head"
          ? async (id: string) => {
              tipReads.push(id);
              return t.head(id);
            }
          : Reflect.get(t, p, r),
    });
    const warnings: string[] = [];
    const pin = awaitedByParent(counting, { onWarn: (m) => warnings.push(m) });
    const parentTipReads = () => tipReads.filter((id) => id === idOf(20)).length;
    expect(routeKeepSet(20).has(7)).toBe(true);
    expect(await pin(idOf(7))).toBe(true);
    expect(parentTipReads()).toBe(0); // the saving: no tip scan of the head for a K member
    expect(warnings).toEqual([]);
    expect(routeKeepSet(20).has(2)).toBe(false);
    expect(await pin(idOf(2))).toBe(true); // doubt: the head is continued
    expect(parentTipReads()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(idOf(2));
  });

  it("a rotation between the pin's head search and its decision keeps the candidate; the next pass collects against the new head", async () => {
    const store = await seedChain(20);
    let rotated = false;
    const rotating = new Proxy(store, {
      get: (t, p, r) =>
        p === "readRange"
          ? async (id: string, from: number, to: number) => {
              const out = await t.readRange(id, from, to);
              if (id === idOf(20) && !rotated) {
                rotated = true; // the search has just found head 20; the chain rotates now
                await markContinued(t, 20);
                await addGeneration(t, 21);
              }
              return out;
            }
          : Reflect.get(t, p, r),
    });
    const warnings: string[] = [];
    expect(await awaitedByParent(rotating, { onWarn: (m) => warnings.push(m) })(idOf(2))).toBe(
      true
    );
    expect(rotated).toBe(true);
    for (const g of await releasable(store, 21)) await store.deleteExecution?.(idOf(g));
    expect(await deepestGeneration(0, existsIn(store))).toBe(21);
    for (const g of routeKeepSet(21)) expect((await store.read(idOf(g))).length).toBeGreaterThan(0);
  });

  it("a squatter beyond the head (not a verified successor) pins and warns, and is never taken for the head", async () => {
    const store = await seedChain(20);
    await store.append(
      ev(idOf(21), 0, "EXECUTION_STARTED", {
        parent: "P",
        chainId: C,
        generation: 21,
        continuedFrom: { executionId: "elsewhere" },
      })
    );
    const warnings: string[] = [];
    expect(await releasable(store, 20, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("a found head whose newest lifecycle event is a kernel CONTINUED (successor missing) pins and warns", async () => {
    const store = await seedChain(20);
    await markContinued(store, 20);
    const warnings: string[] = [];
    expect(await releasable(store, 20, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("a generation whose recorded number disagrees with its id pins and warns", async () => {
    const store = await seedChain(20);
    await store.deleteExecution?.(idOf(5));
    await store.append(
      ev(idOf(5), 0, "EXECUTION_STARTED", {
        parent: "P",
        chainId: C,
        generation: 9,
        continuedFrom: { executionId: idOf(4) },
      })
    );
    const warnings: string[] = [];
    expect(await awaitedByParent(store, { onWarn: (m) => warnings.push(m) })(idOf(5))).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it("the original id's seq 0 missing from the chain root pins (nothing to reason about)", async () => {
    const store = await seedChain(20);
    await store.deleteExecution?.(C);
    expect(await awaitedByParent(store)(idOf(2))).toBe(true);
  });
});

describe("awaitedByParent - a perpetual child under a parked parent, end to end", () => {
  const io = { inputSchema: z.any(), outputSchema: z.any() };
  const mk = (id: string, runner: FlowRunner<never, unknown>): RegisteredFlow =>
    ({
      definition: { _tag: "FlowDefinition", id, name: id, version: "1.0.0", ...io, steps: [] },
      runner,
    }) as unknown as RegisteredFlow;
  const N = 12;
  const perp = mk("perp", async (ctx, input: { g?: number }) => {
    const g = input?.g ?? 0;
    if (g < N)
      return (ctx as unknown as { continueAsNew(c: unknown): never }).continueAsNew({ g: g + 1 });
    await ctx.suspend({ on: "fin" });
    return "child-done";
  });
  const parent = mk("parent", async (ctx) =>
    awaitChild(ctx, { key: "k", flowId: "perp", input: { g: 0 } })
  );
  const flows: Record<string, RegisteredFlow> = { perp, parent };

  async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
    const t0 = Date.now();
    while (Date.now() - t0 <= 30_000) {
      const v = await read();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timeout");
  }

  it("rotates N times, retention leaves exactly K(N), the parent still gets the child's REAL output, then everything reclaims", async () => {
    const events = new InMemoryAsyncEventStore();
    const snaps = new InMemoryAsyncSnapshotStore();
    const holder: { sup?: ChildSupervisor } = {};
    const runtime = new WorkflowRuntime({
      eventStore: events,
      snapshotStore: snaps,
      effectRuntime: new EffectRuntime(),
      continueAsNewEnabled: true,
      onEvent: (e) => holder.sup?.onEvent(e),
    });
    for (const f of Object.values(flows)) {
      runtime.registerFlow(f.definition, f.runner as FlowRunner<unknown, unknown>);
    }
    holder.sup = superviseChildren({ runtime, flows });
    await runtime.start("parent", {}, { executionId: "P" });
    const sys = runtime.systemOptions();
    const head = `${C}~${N}`;
    await waitFor(async () =>
      (await runtime.loadState(head, sys))?.status === "suspended" ? true : undefined
    );

    const lifecycle = new LogLifecycle(events, snaps, {
      pinned: awaitedByParent(events, { snapshots: snaps }),
    });
    const POLICY = { terminalTtlMs: 0 };
    const now = Date.now() + 10;
    const ids = Array.from({ length: N + 1 }, (_, g) => idOf(g));
    for (const id of ids) {
      // evaluate agrees with apply
      const verdict = await lifecycle.evaluate(id, POLICY, now);
      const applied = await lifecycle.applyRetention(id, POLICY, now);
      expect(verdict === "pinned", id).toBe(applied === "pinned");
    }
    const kept = new Set<number>();
    for (let g = 0; g <= N; g++) if ((await events.read(idOf(g))).length > 0) kept.add(g);
    expect([...kept].sort((a, b) => a - b)).toEqual([...routeKeepSet(N)].sort((a, b) => a - b));
    expect(kept.size).toBeLessThan(N + 1);

    // the child finishes from the ORIGINAL id (routed over the reclaimed gaps) and the parent collects it
    await runtime.resume(C, { eventType: "fin", payload: 1 });
    const done = await waitFor(async () => {
      const s = await runtime.loadState("P", sys);
      return s?.status === "completed" || s?.status === "failed" ? s : undefined;
    });
    expect(done.status).toBe("completed");
    expect(done.variables._output).toBe("child-done");

    // the parent ended: nothing is pinned any more
    for (const id of ids) {
      const verdict = await lifecycle.evaluate(id, POLICY, Date.now() + 10);
      const applied = await lifecycle.applyRetention(id, POLICY, Date.now() + 10);
      expect(verdict === "pinned", id).toBe(false);
      expect(applied === "pinned", id).toBe(false);
    }
    for (const id of ids) expect(await events.read(id)).toEqual([]);
  }, 60000);
});
