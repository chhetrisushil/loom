import { SuspendError, VOCABULARY_NAME_PATTERN, step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { Effect, EffectContext } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { meteringMiddleware } from "@loom/middleware";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";
import { assertMeterCeilings, guardUserspaceEmit } from "./userspaceEmit";

// ADR 0115 (R15) — open vocabularies: effect kinds, task kinds, metering dimensions.

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;
const mkStep = (id: string, toolId = `${id}-tool`) =>
  step$({ id, name: id, toolId, inputSchema: io, outputSchema: io });

function flowOf(
  steps: ReturnType<typeof step$>[],
  runner: FlowRunner<Record<string, unknown>, Record<string, unknown>>
): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "f",
      name: "f",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps,
    },
    runner: runner as FlowRunner<unknown, unknown>,
  };
}

describe("effect kinds are an open vocabulary", () => {
  it("a custom kind round-trips through register / kindOf and the effect runs", async () => {
    const er = new EffectRuntime();
    const sensor: Effect = {
      kind: "sensor",
      execute: async () => ({ celsius: 21 }),
    } as Effect;
    er.register("read-temp", sensor);
    expect(er.kindOf("read-temp")).toBe("sensor");
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: er,
    });
    const S = mkStep("t", "read-temp");
    const done = await (
      await runtime.start(
        flowOf([S], async (ctx) => ({ out: await ctx.run(S, {}) })),
        {}
      )
    ).waitForCompletion();
    expect(done.status).toBe("completed");
    expect(done.variables).toMatchObject({});
  });

  it("a kind failing the pattern is refused at registration", () => {
    const er = new EffectRuntime();
    for (const kind of ["", "Sensor", "9lives", "has space", "__proto__", "a".repeat(65)]) {
      expect(
        () => er.register("x", { kind, execute: async () => 1 } as unknown as Effect),
        kind
      ).toThrow(/ADR 0115/);
    }
    expect(VOCABULARY_NAME_PATTERN.test("a".repeat(64))).toBe(true);
    expect(() => er.register("ok", new ToolEffect(async () => 1))).not.toThrow();
  });

  it('a custom effect declaring kind "human" still parks (the one semantic value)', async () => {
    const er = new EffectRuntime();
    // Not the first-party HumanEffect class: any effect that declares kind "human" is a park.
    const approval: Effect = {
      kind: "human",
      mode: "journaled",
      execute: (_i: unknown, _c: EffectContext) => {
        throw new SuspendError({ on: "approve" });
      },
    } as unknown as Effect;
    er.register("approval", approval);
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: er,
    });
    const H = mkStep("h", "approval");
    const handle = await runtime.start(
      flowOf([H], async (ctx) => {
        await ctx.run(H, {});
        return {};
      }),
      {},
      { executionId: "x" }
    );
    const s = await handle.waitForSuspend();
    expect(s.status).toBe("suspended");
    expect(s.suspendedOn).toMatchObject({ on: "approve", stepId: "h" });
  });

  it("a non-human custom kind that throws SuspendError is not treated as a park", async () => {
    const er = new EffectRuntime();
    er.register("robot-arm", { kind: "robot", execute: async () => ({ moved: true }) } as Effect);
    expect(er.kindOf("robot-arm")).not.toBe("human");
  });
});

describe("custom metering dimensions (RESOURCE_METERED.custom)", () => {
  function meteredRuntime(opts: {
    budget?: Parameters<typeof meteringMiddleware>[0]["budget"];
    meterCeilings?: Record<string, number>;
    gpu?: number;
  }) {
    const er = new EffectRuntime([
      meteringMiddleware({
        pricing: () => ({ custom: { gpu_seconds: opts.gpu ?? 2 } }),
        ...(opts.budget !== undefined && { budget: opts.budget }),
        clock: () => 0,
      }),
    ]);
    for (const id of ["a", "b", "c"]) er.register(`${id}-tool`, new ToolEffect(async () => ({})));
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: er,
      ...(opts.meterCeilings !== undefined && { meterCeilings: opts.meterCeilings }),
    });
    return { runtime, eventStore };
  }
  const [A, B, C] = [mkStep("a"), mkStep("b"), mkStep("c")] as [
    ReturnType<typeof step$>,
    ReturnType<typeof step$>,
    ReturnType<typeof step$>,
  ];
  const three: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
    await ctx.run(A, {});
    await ctx.run(B, {});
    await ctx.run(C, {});
    return {};
  };

  it("folds, accumulates, snapshots and replays equal", async () => {
    const { runtime, eventStore } = meteredRuntime({});
    const done = await (await runtime.start(flowOf([A, B, C], three), {})).waitForCompletion();
    expect(done.variables._resources).toMatchObject({ count: 3, custom: { gpu_seconds: 6 } });
    const log = await eventStore.read(done.executionId);
    // Full replay equals the live fold, and a snapshot-then-suffix fold equals the full fold.
    const full = new ReplayVM(log, {
      executionId: done.executionId,
      workflowId: "f",
      workflowVersion: "1.0.0",
    });
    expect(full.peekState().variables._resources).toEqual(done.variables._resources);
    const mid = log.findIndex((e) => e.eventType === "RESOURCE_METERED") + 1;
    const head = new ReplayVM(log.slice(0, mid), {
      executionId: done.executionId,
      workflowId: "f",
      workflowVersion: "1.0.0",
    });
    const snapshot = JSON.parse(JSON.stringify(head.peekState()));
    expect(snapshot.variables._resources.custom.gpu_seconds).toBe(2);
    const resumed = new ReplayVM(log.slice(mid), snapshot);
    expect(resumed.peekState().variables._resources).toEqual(done.variables._resources);
  });

  it("a budget on a custom dimension trips QUOTA_EXCEEDED", async () => {
    const { runtime, eventStore } = meteredRuntime({ budget: { maxCustom: { gpu_seconds: 4 } } });
    const handle = await runtime.start(flowOf([A, B, C], three), {});
    await expect(handle.waitForCompletion()).rejects.toThrow(/Quota exceeded/);
    const state = handle.getState();
    expect(state.frames.c?.status).toBe("failed");
    expect(state.variables._resources).toMatchObject({
      exceeded: true,
      custom: { gpu_seconds: 4 },
    });
    const log = await eventStore.read(state.executionId);
    expect(log.some((e) => e.eventType === "QUOTA_EXCEEDED")).toBe(true);
  });

  it("negotiateBudget accepts a custom dimension and reads _resources.custom", async () => {
    const { runtime } = meteredRuntime({});
    const grants: number[] = [];
    const flow = flowOf([A, B], async (ctx) => {
      await ctx.run(A, {});
      grants.push(await ctx.negotiateBudget("gpu_seconds", 10, { ceiling: 5, id: "g1" }));
      // a never-metered name and a prototype-ish name read 0, not a prototype member
      grants.push(await ctx.negotiateBudget("constructor", 7, { ceiling: 7, id: "g2" }));
      grants.push(await ctx.negotiateBudget("never_metered", 3, { ceiling: 9, id: "g3" }));
      return {};
    });
    await (await runtime.start(flow, {})).waitForCompletion();
    expect(grants).toEqual([3, 7, 3]); // 5 - 2 spent; 7 - 0; min(3, 9 - 0)
  });

  it("meterCeilings lowers a custom ceiling and raises a built-in one", () => {
    const g = (p: unknown, c?: Record<string, number>) =>
      guardUserspaceEmit("RESOURCE_METERED", p, undefined, c);
    expect(() => g({ custom: { gpu_seconds: 11 } }, { gpu_seconds: 10 })).toThrow(/\[0, 10\]/);
    expect(g({ custom: { gpu_seconds: 10 } }, { gpu_seconds: 10 })).toEqual({
      custom: { gpu_seconds: 10 },
    });
    expect(() => g({ tokens: 2e12 })).toThrow(/tokens/);
    expect(g({ tokens: 2e12 }, { tokens: 1e13 })).toEqual({ tokens: 2e12 });
    expect(() => assertMeterCeilings({ gpu_seconds: 1e16 })).toThrow(/at most/);
    expect(() => assertMeterCeilings({ "Bad Name": 1 })).toThrow(/valid custom name/);
    expect(() => assertMeterCeilings({ gpu_seconds: 0 })).toThrow(/> 0/);
    expect(() => assertMeterCeilings({ tokens: 5, gpu_seconds: 5 })).not.toThrow();
  });

  it("cardinality, prototype, range and type negatives are refused before anything is appended", async () => {
    const { runtime, eventStore } = meteredRuntime({});
    let refused = 0;
    const flow = flowOf([A], async (ctx) => {
      const attempts: unknown[] = [
        Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`d${i}`, 1])),
        JSON.parse('{"__proto__": 1}'),
        { constructor: 1 },
        { gpu: -1 },
        { gpu: Number.NaN },
        { gpu: 1e16 },
        { "Bad Name": 1 },
      ];
      for (const custom of attempts) {
        try {
          ctx.emit("RESOURCE_METERED", { custom });
        } catch {
          refused++;
        }
      }
      return {};
    });
    const done = await (await runtime.start(flow, {})).waitForCompletion();
    expect(refused).toBe(7);
    const log = await eventStore.read(done.executionId);
    expect(log.filter((e) => e.eventType === "RESOURCE_METERED")).toHaveLength(0);
    expect(done.variables._resources).toBeUndefined();
  });

  it("the fold skips bad keys deterministically, identically on two replicas", () => {
    const mk = () => {
      const vm = new ReplayVM([], { executionId: "x", workflowId: "f", workflowVersion: "1" });
      const base = { workflowId: "f", executionId: "x", timestamp: 1 };
      const log = [
        { id: "a", sequence: 0, eventType: "EXECUTION_STARTED", payload: { input: {} } },
        {
          id: "b",
          sequence: 1,
          eventType: "RESOURCE_METERED",
          payload: {
            ms: 1,
            custom: JSON.parse(
              '{"gpu_seconds":2,"Bad Key":9,"__proto__":3,"constructor":4,"neg":-1,"big":1e16}'
            ),
          },
        },
      ].map((e) => ({ ...base, ...e }));
      return new ReplayVM(log as never, {
        executionId: "x",
        workflowId: "f",
        workflowVersion: "1",
      });
    };
    const a = mk().peekState().variables._resources;
    const b = mk().peekState().variables._resources;
    expect(a).toEqual({ tokens: 0, costUsd: 0, ms: 1, count: 1, custom: { gpu_seconds: 2 } });
    expect(b).toEqual(a);
    expect(Object.getPrototypeOf((a as { custom: object }).custom)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).gpu_seconds).toBeUndefined();
  });

  it("existing logs fold byte-identically: no `custom` key unless used", async () => {
    const er = new EffectRuntime([meteringMiddleware({ pricing: () => ({ costUsd: 1 }) })]);
    er.register("a-tool", new ToolEffect(async () => ({})));
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: er,
    });
    const done = await (
      await runtime.start(
        flowOf([A], async (ctx) => {
          await ctx.run(A, {});
          return {};
        }),
        {}
      )
    ).waitForCompletion();
    expect(Object.keys(done.variables._resources as object).sort()).toEqual(
      ["costUsd", "count", "ms", "tokens"].sort()
    );
  });
});

describe("decide({ estimatedCost }) — the open spelling beside estimatedCostUsd", () => {
  it("records a per-dimension cost map, descriptive only, and refuses a malformed one", async () => {
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });
    let refusal = "";
    const flow = flowOf([], async (ctx) => {
      await ctx.decide("d1", () => "go", {
        estimatedCostUsd: 0.5,
        estimatedCost: { gpu_seconds: 3, costUsd: 0.5 },
      });
      try {
        await ctx.decide("d2", () => "go", { estimatedCost: { "Bad Name": 1 } });
      } catch (e) {
        refusal = (e as Error).message;
      }
      return {};
    });
    const done = await (await runtime.start(flow, {})).waitForCompletion();
    const decisions = done.variables._decisions as Record<string, Record<string, unknown>>;
    expect(decisions.d1).toMatchObject({
      choice: "go",
      estimatedCostUsd: 0.5,
      estimatedCost: { gpu_seconds: 3, costUsd: 0.5 },
    });
    expect(decisions.d2).toBeUndefined();
    expect(refusal).toMatch(/estimatedCost.*ADR 0115/);
  });
});
