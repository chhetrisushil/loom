import { tainted } from "@loomwork/classify";
import { step$ } from "@loomwork/core";
import type { ExecutionState, FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loomwork/event-runtime";
import { seenOriginsList } from "@loomwork/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { WorkflowRuntimeDeps } from "./WorkflowRuntime";
import { inboxArchiveFor, settle, until } from "./__tests__/r2Harness";
import type { FlowRunner, RegisteredFlow } from "./types";

// ADR 0152 S2b: the fleet gate, the stamped limits, and EffectContext.seenOrigins.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const mk = (id: string) => step$({ id, name: id, toolId: id, ...io });
const taint = mk("taint");
const probe = mk("probe");
const live = step$({ id: "live", name: "live", toolId: "live", ...io });
const probe2b = step$({ id: "probe-b", name: "probe-b", toolId: "probe", ...io });

type Probe = { present: boolean; list?: readonly string[] };

function world() {
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const timerStore = new InMemoryTimerStore();
  const archive = inboxArchiveFor(eventStore);
  const probes: Probe[] = [];
  const transient: Probe[] = [];
  const liveReads: { before: string[]; after: string[] }[] = [];
  const runtime = (deps: Partial<WorkflowRuntimeDeps> = {}) => {
    const effects = new EffectRuntime();
    effects.register("taint", new ToolEffect(async (i: unknown) => tainted(i, "lineage:A")));
    effects.register(
      "probe",
      new ToolEffect(async (i: unknown, ctx) => {
        const p: Probe = { present: ctx.seenOrigins !== undefined };
        if (ctx.seenOrigins) p.list = ctx.seenOrigins();
        (i === "t" ? transient : probes).push(p);
        return i;
      })
    );
    effects.register(
      "live",
      new ToolEffect(async (_i: unknown, ctx) => {
        const before = [...(ctx.seenOrigins?.() ?? ["<absent>"])];
        ctx.emit("DECISION_RECORDED", { decisionId: "d-live", choice: tainted(1, "lineage:Z") });
        await ctx.flush?.();
        liveReads.push({ before, after: [...(ctx.seenOrigins?.() ?? ["<absent>"])] });
        return 1;
      })
    );
    return new WorkflowRuntime({
      eventStore,
      snapshotStore,
      timerStore,
      effectRuntime: effects,
      inboxEnabled: true,
      inboxArchive: archive,
      onWarn: () => {},
      ...deps,
    });
  };
  return { eventStore, snapshotStore, probes, transient, liveReads, runtime };
}

function reg(rt: WorkflowRuntime, id: string, runner: FlowRunner<unknown, unknown>) {
  const definition = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    ...io,
    steps: [taint, probe, probe2b, live],
  } as unknown as FlowDefinition<unknown, unknown>;
  rt.registerFlow(definition, runner);
  return { definition, runner } as RegisteredFlow<unknown, unknown>;
}

const straight: FlowRunner<unknown, unknown> = async (ctx) => {
  await ctx.run(probe, "a");
  await ctx.run(taint, "x");
  await ctx.run(probe2b, "b");
  return "done";
};
const started = async (w: ReturnType<typeof world>, id: string) =>
  (await w.eventStore.read(id))[0]?.payload as { seenOriginsLimits?: unknown };

describe("seen origins: fleet gate, stamps and EffectContext.seenOrigins", () => {
  it("gate on: stamps the limits and exposes the live set to the next effect", async () => {
    const w = world();
    const rt = w.runtime({ seenOriginsEnabled: true, seenOriginsLimits: { maxOrigins: 8 } });
    const f = reg(rt, "g", straight);
    await (await rt.start(f, {}, { executionId: "g1" })).waitForCompletion();
    expect((await started(w, "g1")).seenOriginsLimits).toEqual({
      maxOrigins: 8,
      maxScanNodes: 10_000,
    });
    expect(w.probes.map((p) => p.list)).toEqual([[], ["lineage:A"]]);
  });

  it("gate on: an inbox message tainted with a lineage shows inbox:<topic> and the lineage; a reboot keeps the set", async () => {
    const w = world();
    const on = { seenOriginsEnabled: true };
    const rt = w.runtime(on);
    const f = reg(rt, "m", async (ctx) => {
      await ctx.receive("t1");
      await ctx.receive("t2");
      await ctx.run(probe, "after");
      return "done";
    });
    const h = await rt.start(f, {}, { executionId: "m1" });
    await settle(h);
    await rt.send("m1", { topic: "t1", payload: tainted("p", "lineage:B"), messageId: "1" });
    await until(async () =>
      (await w.eventStore.read("m1")).some((e) => e.eventType === "MESSAGE_CONSUMED")
    );
    await settle(h);
    // the process dies here; another runtime over the same stores finishes the run
    const rt2 = w.runtime(on);
    reg(rt2, "m", async (ctx) => {
      await ctx.receive("t1");
      await ctx.receive("t2");
      await ctx.run(probe, "after");
      return "done";
    });
    await rt2.send("m1", { topic: "t2", payload: "plain", messageId: "2" });
    await until(async () =>
      (await w.eventStore.read("m1")).some((e) => e.eventType === "EXECUTION_COMPLETED")
    );
    const list = w.probes.at(-1)?.list ?? [];
    expect([...list].sort()).toEqual(["inbox:t1", "inbox:t2", "lineage:B"].sort());
  });

  it("gate off: no stamp, seenOrigins absent, and the sequence-0 event is the 1.26 shape", async () => {
    const w = world();
    const rt = w.runtime();
    const f = reg(rt, "off", straight);
    await (await rt.start(f, {}, { executionId: "o1" })).waitForCompletion();
    const first = (await w.eventStore.read("o1"))[0];
    expect(Object.keys(first?.payload as object)).not.toContain("seenOriginsLimits");
    expect(JSON.stringify(await w.eventStore.read("o1"))).not.toMatch(/origins|_seenOrigins/i);
    expect(w.probes.map((p) => p.present)).toEqual([false, false]);
  });

  it("recorded limits beat config: a restart with larger limits still overflows at the recorded cap", async () => {
    const w = world();
    // five distinct origins arrive through five distinct tools
    const small = w.runtime({ seenOriginsEnabled: true, seenOriginsLimits: { maxOrigins: 4 } });
    const effects = (small as unknown as { effectRuntime: EffectRuntime }).effectRuntime;
    for (const o of ["a", "b", "c", "d", "e"]) {
      effects.register(`o${o}`, new ToolEffect(async (i: unknown) => tainted(i, `lineage:${o}`)));
    }
    const steps = ["a", "b", "c", "d", "e"].map((o) => mk(`o${o}`));
    const body: FlowRunner<unknown, unknown> = async (ctx) => {
      for (const s of steps) await ctx.run(s, 1);
      await ctx.receive("go");
      await ctx.run(probe, "p");
      return "done";
    };
    const defn = (rt: WorkflowRuntime) => {
      const definition = {
        _tag: "FlowDefinition",
        id: "lim",
        name: "lim",
        version: "1.0.0",
        ...io,
        steps: [...steps, probe],
      } as unknown as FlowDefinition<unknown, unknown>;
      rt.registerFlow(definition, body);
      return { definition, runner: body } as RegisteredFlow<unknown, unknown>;
    };
    const h = await small.start(defn(small), {}, { executionId: "l1" });
    await settle(h);
    const big = w.runtime({ seenOriginsEnabled: true, seenOriginsLimits: { maxOrigins: 64 } });
    const be = (big as unknown as { effectRuntime: EffectRuntime }).effectRuntime;
    for (const o of ["a", "b", "c", "d", "e"]) {
      be.register(`o${o}`, new ToolEffect(async (i: unknown) => tainted(i, `lineage:${o}`)));
    }
    defn(big);
    await big.send("l1", { topic: "go", payload: 1, messageId: "g" });
    await until(async () =>
      (await w.eventStore.read("l1")).some((e) => e.eventType === "EXECUTION_COMPLETED")
    );
    const list = w.probes.at(-1)?.list ?? [];
    expect(list.at(-1)).toBe("unknown:seen-origins-overflow");
    expect(list).toHaveLength(5); // 4 kept + the marker
  });

  it("continueAsNew carries the set to the successor and stamps it", async () => {
    const w = world();
    const rt = w.runtime({ seenOriginsEnabled: true, continueAsNewEnabled: true });
    const f = reg(rt, "c", async (ctx, input) => {
      if ((input as { n?: number } | undefined)?.n === 1) {
        await ctx.run(probe, "succ");
        return "done";
      }
      await ctx.run(taint, "x");
      return ctx.continueAsNew({ n: 1 });
    });
    await rt.start(f, {}, { executionId: "ca" });
    await until(async () =>
      (await w.eventStore.read("ca~1").catch(() => [])).some(
        (e) => e.eventType === "EXECUTION_COMPLETED"
      )
    );
    expect((await started(w, "ca~1")).seenOriginsLimits).toBeDefined();
    expect(w.probes.at(-1)?.list).toEqual(["lineage:A"]);
  });

  it("the transient seam and the decide scope's invokeTransient have no seenOrigins", async () => {
    const w = world();
    const rt = w.runtime({ seenOriginsEnabled: true });
    const f = reg(rt, "d", async (ctx) => {
      await ctx.decide("d", (scope) => scope.invokeTransient("probe", "t"));
      return "done";
    });
    await (await rt.start(f, {}, { executionId: "d1" })).waitForCompletion();
    await rt.invokeTransient("probe", "t");
    expect(w.transient.map((p) => p.present)).toEqual([false, false]);
  });

  it("restoreFromState ignores a forged clean _seenOrigins: it is rebuilt from the log (S2c)", async () => {
    const w = world();
    const rt = w.runtime({ seenOriginsEnabled: true });
    const f = reg(rt, "r", async (ctx) => {
      await ctx.run(taint, "x");
      await ctx.receive("go");
      await ctx.run(probe, "p");
      return "done";
    });
    const h = await rt.start(f, {}, { executionId: "r1" });
    await settle(h);
    const state = (await rt.loadState("r1", rt.systemOptions())) as ExecutionState;
    const forged: ExecutionState = {
      ...state,
      variables: {
        ...state.variables,
        _seenOrigins: {
          v: 1,
          limits: { maxOrigins: 64, maxScanNodes: 10_000 },
          origins: [],
          through: state.sequence,
        },
      },
    };
    const rt2 = w.runtime({ seenOriginsEnabled: true });
    reg(rt2, "r", async (ctx) => {
      await ctx.run(taint, "x");
      await ctx.receive("go");
      await ctx.run(probe, "p");
      return "done";
    });
    const h2 = await rt2.restoreFromState(forged, undefined, rt2.systemOptions());
    await settle(h2);
    await rt2.send("r1", { topic: "go", payload: 1, messageId: "g" });
    await until(() => w.probes.length > 0);
    expect(w.probes.at(-1)?.list).toEqual(["lineage:A", "inbox:go"]); // the forged clean key was not trusted
  });

  it("a gate-off continueAsNew of a tracked predecessor writes no carry and no stamp; its successor reads absent", async () => {
    const w = world();
    const body: FlowRunner<unknown, unknown> = async (ctx, input) => {
      if ((input as { n?: number } | undefined)?.n === 1) {
        await ctx.run(probe, "succ");
        return "done";
      }
      await ctx.run(taint, "x");
      await ctx.receive("go");
      return ctx.continueAsNew({ n: 1 });
    };
    const on = w.runtime({ seenOriginsEnabled: true, continueAsNewEnabled: true });
    const h = await on.start(reg(on, "co", body), {}, { executionId: "co" });
    await settle(h);
    const off = w.runtime({ continueAsNewEnabled: true }); // the gate is off on the node that rotates
    reg(off, "co", body);
    await off.send("co", { topic: "go", payload: 1, messageId: "g" });
    await until(async () =>
      (await w.eventStore.read("co~1").catch(() => [])).some(
        (e) => e.eventType === "EXECUTION_COMPLETED"
      )
    );
    const first = (await w.eventStore.read("co~1"))[0]?.payload as {
      seenOriginsLimits?: unknown;
      continuedFrom?: { carried?: Record<string, unknown> };
    };
    expect(first.seenOriginsLimits).toBeUndefined();
    expect(first.continuedFrom?.carried).not.toHaveProperty("seenOrigins");
    expect(w.probes.at(-1)?.present).toBe(false);
  });

  it("a read inside one effect is live: an emitted tainted decision shows on the second read", async () => {
    const w = world();
    const rt = w.runtime({ seenOriginsEnabled: true });
    const f = reg(rt, "lv", async (ctx) => {
      await ctx.run(live, 1);
      return "done";
    });
    await (await rt.start(f, {}, { executionId: "lv1" })).waitForCompletion();
    expect(w.liveReads).toEqual([{ before: [], after: ["lineage:Z"] }]);
  });

  it("a run started gate-off then resumed on a gate-on runtime is adopted (S2c), not left absent", async () => {
    const w = world();
    const body: FlowRunner<unknown, unknown> = async (ctx) => {
      await ctx.receive("go");
      await ctx.run(probe, "p");
      return "done";
    };
    const off = w.runtime();
    await settle(await off.start(reg(off, "up", body), {}, { executionId: "up1" }));
    const on = w.runtime({ seenOriginsEnabled: true });
    reg(on, "up", body);
    await on.send("up1", { topic: "go", payload: 1, messageId: "g" });
    await until(() => w.probes.length > 0);
    expect(w.probes.at(-1)?.list).toEqual(["inbox:go"]);
  });

  it("a fork of a tracked run sees the parent's origins; a fork of an untracked run reads absent", async () => {
    const w = world();
    const body: FlowRunner<unknown, unknown> = async (ctx) => {
      await ctx.run(taint, "x");
      await ctx.receive("go");
      return "done";
    };
    for (const tracked of [true, false]) {
      const rt = w.runtime(tracked ? { seenOriginsEnabled: true } : {});
      const id = `fk-${tracked}`;
      await settle(await rt.start(reg(rt, "fk", body), {}, { executionId: id }));
      const log = await w.eventStore.read(id);
      const at = log.filter((e) => e.eventType === "STEP_COMPLETED").at(-1)?.sequence ?? 0;
      const child = await rt.fork(id, at, { executionId: `${id}-child`, system: true } as never);
      const st = await rt.loadState(child.executionId, rt.systemOptions());
      expect(seenOriginsList(st as ExecutionState)).toEqual(tracked ? ["lineage:A"] : undefined);
    }
  });

  it("refuses out-of-range limits at construction", () => {
    const w = world();
    for (const bad of [
      { maxOrigins: 0 },
      { maxOrigins: 1025 },
      { maxOrigins: 1.5 },
      { maxScanNodes: 99 },
      { maxScanNodes: 100_001 },
      { maxScanNodes: Number.NaN },
    ]) {
      expect(() => w.runtime({ seenOriginsEnabled: true, seenOriginsLimits: bad })).toThrow(
        RangeError
      );
    }
    expect(() =>
      w.runtime({ seenOriginsLimits: { maxOrigins: 1024, maxScanNodes: 100 } })
    ).not.toThrow();
  });
});
