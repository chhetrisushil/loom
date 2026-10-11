import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── K8 — cancellation, deadlines & bounded effects ────────────────────────────

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });

type In = { n: number };
type Out = { done: boolean };

const hangStep = step$({
  id: "hang",
  name: "Hang",
  toolId: "hang-tool",
  inputSchema,
  outputSchema,
});

const hangStepT60 = step$({
  id: "hang",
  name: "Hang",
  toolId: "hang-tool",
  inputSchema,
  outputSchema,
  timeoutMs: 60,
});

const hangStepT100 = step$({
  id: "hang",
  name: "Hang",
  toolId: "hang-tool",
  inputSchema,
  outputSchema,
  timeoutMs: 100,
});

function makeFlow(
  flowId: string,
  step: typeof hangStep | undefined,
  runner: FlowRunner<In, Out>,
  deadlineMs?: number
): RegisteredFlow<In, Out> {
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: flowId,
    name: flowId,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: step !== undefined ? [step] : [],
    ...(deadlineMs !== undefined && { deadlineMs }),
  };
  return { definition, runner };
}

function boot(effects: Record<string, ToolEffect>, flow: RegisteredFlow<In, Out>) {
  const effectRuntime = new EffectRuntime();
  for (const [toolId, effect] of Object.entries(effects)) effectRuntime.register(toolId, effect);
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, eventStore, snapshotStore };
}

/** Poll until the durable write pipeline has flushed what we assert on. */
async function eventually(pred: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error("eventually: timed out"); // never fall through silently
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** An effect that hangs until aborted, then rejects — a cooperative long call. */
function cooperativeHang(): ToolEffect {
  return new ToolEffect(
    (_input: unknown, ctx: EffectContext) =>
      new Promise((_, reject) => {
        ctx.signal?.addEventListener(
          "abort",
          () => reject(ctx.signal?.reason ?? new Error("aborted")),
          { once: true }
        );
      })
  );
}

describe("K8.2 — cancel by executionId", () => {
  it("cancels a LIVE execution: aborts the in-flight effect, logs EXECUTION_CANCELLED, replays cancelled", async () => {
    const flow = makeFlow("live-cancel", hangStep, async (ctx, input) => ctx.run(hangStep, input));
    const { runtime, eventStore } = boot({ "hang-tool": cooperativeHang() }, flow);

    const handle = await runtime.start(flow, { n: 1 }, { executionId: "lc-1" });
    const completion = handle.waitForCompletion();
    completion.catch(() => {}); // asserted below

    // Give the effect a beat to be in flight, then cancel BY ID.
    await new Promise((r) => setTimeout(r, 20));
    expect(await runtime.cancel("lc-1", "operator kill")).toBe(true);

    await expect(completion).rejects.toThrow();
    // the kill path is prompt: the effect never settles on its own, so completing at all is the proof

    await eventually(async () => (await runtime.loadState("lc-1"))?.status === "cancelled");
    const events = await eventStore.read("lc-1");
    expect(events.some((e: EventEnvelope) => e.eventType === "EXECUTION_CANCELLED")).toBe(true);
    expect(events.some((e: EventEnvelope) => e.eventType === "STEP_CANCELLED")).toBe(true);
    // Replay (pure fold of the durable log) reconstructs the cancellation (G1).
    const state = await runtime.loadState("lc-1");
    expect(state?.status).toBe("cancelled");
    expect(state?.variables._cancelReason).toBe("operator kill");
  });

  it("cancels a SUSPENDED execution durably; resume of a cancelled execution is refused", async () => {
    const flow = makeFlow("susp-cancel", undefined, async (ctx) => {
      await ctx.suspend({ on: "Approval" });
      return { done: true };
    });
    const { runtime } = boot({}, flow);

    const handle = await runtime.start(flow, { n: 1 }, { executionId: "sc-1" });
    await handle.waitForSuspend();
    // Let the run fully settle (live-handle released) so cancel takes the
    // durable fence-then-append path deterministically.
    await new Promise((r) => setTimeout(r, 10));

    expect(await runtime.cancel("sc-1", "abandoned")).toBe(true);
    const state = await runtime.loadState("sc-1");
    expect(state?.status).toBe("cancelled");

    await expect(
      runtime.resume("sc-1", { eventType: "Approval", payload: { ok: true } })
    ).rejects.toThrow(/cancelled/);

    // Terminal: a second cancel is a no-op.
    expect(await runtime.cancel("sc-1")).toBe(false);
  });

  it("throws on an unknown executionId", async () => {
    const flow = makeFlow("unknown-cancel", undefined, async () => ({ done: true }));
    const { runtime } = boot({}, flow);
    await expect(runtime.cancel("nope")).rejects.toThrow(/No execution found/);
  });

  it("fence-then-cancel: cancelling a detached execution fences out its zombie writer (K8.5 ordering)", async () => {
    // Node A drives the execution under fence 1 with a non-cooperative effect.
    let releaseA!: () => void;
    const stalled = new Promise<Out>((resolve) => {
      releaseA = () => resolve({ done: true });
    });
    const flow = makeFlow("fence-cancel", hangStep, async (ctx, input) => ctx.run(hangStep, input));
    const a = boot({ "hang-tool": new ToolEffect(() => stalled) }, flow);
    const fenceA = await a.runtime.acquireFence("fc-1");
    const handleA = await a.runtime.start(
      flow,
      { n: 1 },
      { executionId: "fc-1", ...(fenceA !== undefined && { fence: fenceA }) }
    );
    const completionA = handleA.waitForCompletion();
    completionA.catch(() => {});
    await new Promise((r) => setTimeout(r, 20)); // STEP_STARTED durable

    // Node B (fresh runtime over the SAME stores) cancels by id: not live there,
    // so it acquires fence 2 FIRST, then appends the durable cancel fact.
    const runtimeB = new WorkflowRuntime({
      eventStore: a.eventStore,
      snapshotStore: a.snapshotStore,
      effectRuntime: new EffectRuntime(),
    });
    runtimeB.registerFlow(flow.definition, flow.runner);
    expect(await runtimeB.cancel("fc-1", "node A presumed dead")).toBe(true);

    // The zombie wakes and tries to append STEP_COMPLETED under fence 1 → rejected.
    releaseA();
    await expect(completionA).rejects.toThrow();

    await eventually(async () => (await runtimeB.loadState("fc-1"))?.status === "cancelled");
    const events = await a.eventStore.read("fc-1");
    expect(events.filter((e: EventEnvelope) => e.eventType === "STEP_COMPLETED").length).toBe(0);
    const cancels = events.filter((e: EventEnvelope) => e.eventType === "EXECUTION_CANCELLED");
    expect(cancels.length).toBe(1);
    expect((cancels[0]?.metadata as { fence?: number }).fence).toBe(2);
    expect((await runtimeB.loadState("fc-1"))?.status).toBe("cancelled");
  });
});

describe("K8.3 — step deadlines (timeoutMs)", () => {
  it("times out a non-cooperative effect and fails the step via STEP_FAILED", async () => {
    const neverSettles = new ToolEffect(() => new Promise<never>(() => {}));
    const flow = makeFlow("step-timeout", hangStepT60, async (ctx, input) =>
      ctx.run(hangStepT60, input)
    );
    const { runtime, eventStore } = boot({ "hang-tool": neverSettles }, flow);

    const handle = await runtime.start(flow, { n: 1 }, { executionId: "st-1" });
    await expect(handle.waitForCompletion()).rejects.toThrow(/exceeded its deadline/);
    // the effect never settles, so failing at all (within the test timeout) proves the deadline fired

    const events = await eventStore.read("st-1");
    const failed = events.filter((e: EventEnvelope) => e.eventType === "STEP_FAILED");
    expect(failed.length).toBe(1);
    expect(String((failed[0]?.payload as { error?: unknown }).error)).toMatch(/timeoutMs=60/);
    // A timeout is a step FAILURE, not a cancellation.
    expect(events.some((e: EventEnvelope) => e.eventType === "STEP_CANCELLED")).toBe(false);
  });

  it("aborts a cooperative effect's signal on timeout", async () => {
    const sawAbort = vi.fn();
    const effect = new ToolEffect(
      (_i: unknown, ctx: EffectContext) =>
        new Promise((_, reject) => {
          ctx.signal?.addEventListener(
            "abort",
            () => {
              sawAbort();
              reject(ctx.signal?.reason);
            },
            { once: true }
          );
        })
    );
    const flow = makeFlow("step-abort", hangStepT60, async (ctx, input) =>
      ctx.run(hangStepT60, input)
    );
    const { runtime } = boot({ "hang-tool": effect }, flow);

    const handle = await runtime.start(flow, { n: 1 }, { executionId: "sa-1" });
    await expect(handle.waitForCompletion()).rejects.toThrow(/exceeded its deadline/);
    expect(sawAbort).toHaveBeenCalled();
  });

  it("anchors the deadline to the FIRST logged STEP_STARTED — recovery never resets it", async () => {
    const effectFn = vi.fn(async () => ({ done: true }));
    const flow = makeFlow("anchored-timeout", hangStepT100, async (ctx, input) =>
      ctx.run(hangStepT100, input)
    );
    const { runtime, eventStore } = boot({ "hang-tool": new ToolEffect(effectFn) }, flow);

    // Hand-seed a crashed run whose step started 500ms ago (timeout: 100ms).
    const t0 = Date.now() - 500;
    const seed = (sequence: number, eventType: string, payload: unknown): EventEnvelope => ({
      id: `at-1-${sequence}`,
      workflowId: "anchored-timeout",
      executionId: "at-1",
      eventType,
      sequence,
      timestamp: t0 + sequence,
      payload,
    });
    await eventStore.append(seed(0, "EXECUTION_STARTED", { input: { n: 1 } }));
    await eventStore.append(seed(1, "STEP_STARTED", { stepId: "hang", input: { n: 1 } }));

    // Recovery: the re-run must observe the elapsed ~500ms > 100ms budget and
    // fail the step immediately — WITHOUT invoking the effect.
    const handle = await runtime.resume("at-1", { eventType: "EXECUTION_RECOVERED", payload: {} });
    await expect(handle.waitForCompletion()).rejects.toThrow(/exceeded its deadline/);
    expect(effectFn).not.toHaveBeenCalled();

    const events = await eventStore.read("at-1");
    expect(events.some((e: EventEnvelope) => e.eventType === "STEP_FAILED")).toBe(true);
  });
});

describe("K8.3 — execution deadlines (deadlineMs)", () => {
  it("cancels a live run that exceeds its deadline", async () => {
    const flow = makeFlow("exec-deadline", hangStep, async (ctx, input) =>
      ctx.run(hangStep, input)
    );
    const { runtime } = boot({ "hang-tool": cooperativeHang() }, flow);

    const handle = await runtime.start(flow, { n: 1 }, { executionId: "ed-1", deadlineMs: 60 });
    await expect(handle.waitForCompletion()).rejects.toThrow(/deadline exceeded/);
    await eventually(async () => (await runtime.loadState("ed-1"))?.status === "cancelled");
    expect((await runtime.loadState("ed-1"))?.status).toBe("cancelled");
  });

  it("anchors to the LOGGED EXECUTION_STARTED: resuming past the deadline cancels immediately", async () => {
    const effectFn = vi.fn(async () => ({ done: true }));
    const flow = makeFlow("exec-deadline-resume", hangStep, async (ctx, input) =>
      ctx.run(hangStep, input)
    );
    const { runtime, eventStore } = boot({ "hang-tool": new ToolEffect(effectFn) }, flow);

    const t0 = Date.now() - 1000;
    await eventStore.append({
      id: "edr-1-0",
      workflowId: "exec-deadline-resume",
      executionId: "edr-1",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: t0,
      payload: { input: { n: 1 } },
    });

    const handle = await runtime.resume(
      "edr-1",
      { eventType: "EXECUTION_RECOVERED", payload: {} },
      { deadlineMs: 100 } // started 1000ms ago → already breached
    );
    await expect(handle.waitForCompletion()).rejects.toThrow(/deadline exceeded/);
    await eventually(async () => (await runtime.loadState("edr-1"))?.status === "cancelled");
    expect((await runtime.loadState("edr-1"))?.status).toBe("cancelled");
    expect(effectFn).not.toHaveBeenCalled();
  });

  it("takes the flow's declarative flow$({ deadlineMs }) when no override is given", async () => {
    const flow = makeFlow(
      "flow-deadline",
      hangStep,
      async (ctx, input) => ctx.run(hangStep, input),
      50 // FlowDefinition.deadlineMs
    );
    const { runtime } = boot({ "hang-tool": cooperativeHang() }, flow);

    const handle = await runtime.start(flow, { n: 1 }, { executionId: "fd-1" });
    await expect(handle.waitForCompletion()).rejects.toThrow(/deadline exceeded/);
    await eventually(async () => (await runtime.loadState("fd-1"))?.status === "cancelled");
    expect((await runtime.loadState("fd-1"))?.status).toBe("cancelled");
  });
});
