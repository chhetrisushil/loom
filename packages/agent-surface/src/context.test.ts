import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { surface } from "./context";
import { createSurfaceEmitter } from "./emitter";
import type { SurfaceEmitter } from "./emitter";
import { agentSurfaceProjection } from "./surfaceProjection";

// ADR 0114 — `ctx.ui` leaves the kernel. Three spellings must put the SAME events in the log:
//   1. `ctx.ui` from the injected factory (`deps.surface: createSurfaceEmitter`, what defineConfig does)
//   2. `surface(ctx)` (the documented spelling; needs only `ctx.emit`, works on a bare runtime)
//   3. the pre-0114 accessor: `createSurfaceEmitter((t, p) => ctx.emit(t, p))`, built in the kernel.

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;
type Drive = (ctx: {
  ui?: SurfaceEmitter;
  emit: (t: string, p: unknown) => void;
}) => SurfaceEmitter;

function flow(
  runner: FlowRunner<Record<string, unknown>, Record<string, unknown>>
): RegisteredFlow {
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: "surface-eq",
    name: "surface-eq",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [step$({ id: "x", name: "X", toolId: "x", inputSchema: io, outputSchema: io })],
  };
  return { definition, runner: runner as FlowRunner<unknown, unknown> };
}

async function run(opts: { inject: boolean; pick: Drive }): Promise<EventEnvelope[]> {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    ...(opts.inject && { surface: createSurfaceEmitter }),
  });
  const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
    const ui = opts.pick(ctx as never);
    ui.set("phase", "investigating");
    ui.merge("stats", { items: 3 });
    ui.append("log", "a");
    ui.append("log", "b");
    ui.increment("steps");
    ui.as({ by: "planner", note: "n" }).set("panels.why", { x: 1 });
    ui.remove("log");
    ui.patch([
      { op: "set", path: "p", value: 1 },
      { op: "increment", path: "p", by: 2 },
    ]);
    return {};
  };
  const handle = await runtime.start(flow(runner), {}, { executionId: "e1" });
  await handle.waitForCompletion();
  return eventStore.read("e1");
}

// Everything but the wall clock: type, payload and metadata (the `flowEmit` stamp), in order.
const shape = (events: EventEnvelope[]) =>
  events.map((e) => ({ type: e.eventType, payload: e.payload, metadata: e.metadata }));

// Hand-written expected log. Captured from the pre-0114 behaviour (the in-kernel accessor was
// `createSurfaceEmitter((t, p) => ctx.emit(t, p))`; `emitter.ts` and the `flowEmit` stamping are
// untouched by ADR 0114), then frozen as literals so a regression in the emitter ITSELF fails —
// the three-way comparison below can't see that, since every arm goes through the emitter.
const patch = (flowEmit: string, patches: unknown[], by?: unknown) => ({
  type: "SURFACE_PATCH",
  payload: { surface: "ui", patches, ...(by !== undefined && { by }) },
  metadata: { flowEmit },
});
const PRE_0114_LOG = [
  { type: "EXECUTION_STARTED", payload: { input: {}, principal: { v: 1 } } },
  patch("8e637de275a7181e", [{ op: "set", path: "phase", value: "investigating" }]),
  patch("008660edb1d1207b", [{ op: "merge", path: "stats", value: { items: 3 } }]),
  patch("04302d0b32367968", [{ op: "append", path: "log", value: "a" }]),
  patch("f174004085e48e11", [{ op: "append", path: "log", value: "b" }]),
  patch("8612f099c681ddce", [{ op: "increment", path: "steps" }]),
  patch("f84e4d3a7799070f", [{ op: "set", path: "panels.why", value: { x: 1 } }], {
    by: "planner",
    note: "n",
  }),
  patch("05472bbae7bb17dc", [{ op: "remove", path: "log" }]),
  patch("c6b46eb2719befe4", [
    { op: "set", path: "p", value: 1 },
    { op: "increment", path: "p", by: 2 },
  ]),
  { type: "EXECUTION_COMPLETED", payload: { output: {} } },
];

describe("ADR 0114 — ctx.ui and surface(ctx) produce byte-identical events", () => {
  it("injected ctx.ui, surface(ctx), and the pre-0114 in-kernel accessor agree", async () => {
    const injected = await run({ inject: true, pick: (ctx) => ctx.ui as SurfaceEmitter });
    const spelled = await run({ inject: false, pick: (ctx) => surface(ctx) });
    const old = await run({
      inject: false,
      pick: (ctx) => createSurfaceEmitter((t, p) => ctx.emit(t, p)),
    });
    expect(injected.filter((e) => e.eventType === "SURFACE_PATCH")).toHaveLength(8);
    // Literal arms: all three must equal the frozen pre-0114 log, key order included.
    expect(JSON.stringify(shape(old))).toBe(JSON.stringify(PRE_0114_LOG));
    expect(JSON.stringify(shape(injected))).toBe(JSON.stringify(PRE_0114_LOG));
    expect(JSON.stringify(shape(injected))).toBe(JSON.stringify(shape(old)));
    expect(JSON.stringify(shape(spelled))).toBe(JSON.stringify(PRE_0114_LOG));
    // The fold of the log is what a UI sees; it agrees as well.
    const projection = agentSurfaceProjection();
    const fold = (events: EventEnvelope[]) => {
      let state = projection.initialState;
      for (const e of events) {
        if (e.eventType === "SURFACE_PATCH") state = projection.handlers.SURFACE_PATCH!(state, e);
      }
      return state;
    };
    expect(fold(spelled)).toEqual(fold(injected));
    expect(fold(injected)).toMatchObject({ phase: "investigating", steps: 1, p: 3 });
  });

  it("a bare runtime (no surface dep) throws on ctx.ui but surface(ctx) works", async () => {
    await expect(
      run({
        inject: false,
        pick: (ctx) => ctx.ui as SurfaceEmitter, // the getter throws inside the flow
      })
    ).rejects.toThrow(/ctx\.ui is not available/);
    const events = await run({ inject: false, pick: (ctx) => surface(ctx) });
    expect(events.some((e) => e.eventType === "SURFACE_PATCH")).toBe(true);
  });
});
