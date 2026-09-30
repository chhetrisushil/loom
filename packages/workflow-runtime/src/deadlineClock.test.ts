import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { RegisteredFlow } from "./types";

// L26 — step `timeoutMs` and execution `deadlineMs` are anchored to journal timestamps
// written with the runtime's injectable `now`. The remaining budget must be measured with
// that SAME clock; reading raw `Date.now()` made any non-wall clock either breach every
// deadline at once (hugely negative remaining) or arm a 1ms timer (remaining > 2^31).

const io = z.object({ n: z.number() });
type Io = { n: number };

const quick = (timeoutMs?: number) =>
  step$({
    id: "quick",
    name: "quick",
    toolId: "quick-tool",
    inputSchema: io,
    outputSchema: io,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });

function boot(
  now: () => number,
  opts: { timeoutMs?: number; deadlineMs?: number; hang?: boolean }
) {
  const step = quick(opts.timeoutMs);
  const effectRuntime = new EffectRuntime();
  effectRuntime.register(
    "quick-tool",
    new ToolEffect(async (input: unknown) =>
      opts.hang === true ? new Promise<never>(() => {}) : (input as Io)
    )
  );
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime,
    now,
  });
  const definition: FlowDefinition<Io, Io> = {
    _tag: "FlowDefinition",
    id: "l26",
    name: "l26",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [step],
    ...(opts.deadlineMs !== undefined && { deadlineMs: opts.deadlineMs }),
  };
  const flow: RegisteredFlow<Io, Io> = {
    definition,
    runner: async (ctx, input) => ctx.run(step, input),
  };
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, flow, eventStore };
}

const types = (events: EventEnvelope[]) => events.map((e) => e.eventType);

// A fixed clock and clocks offset far into the past / future of the wall clock.
const clocks: Array<[string, () => number]> = [
  ["fixed", () => 1_000_000],
  ["offset far behind the wall clock", () => Date.now() - 10 * 365 * 86_400_000],
  ["offset far ahead of the wall clock", () => Date.now() + 1e12],
];

describe("L26 — deadlines use the runtime's injected clock", () => {
  for (const [label, now] of clocks) {
    it(`step timeoutMs does not fail a fast step under a ${label} clock`, async () => {
      const { runtime, flow, eventStore } = boot(now, { timeoutMs: 5000 });
      const handle = await runtime.start(flow, { n: 1 }, { executionId: "s" });
      await expect(handle.waitForCompletion()).resolves.toBeDefined();
      const log = types(await eventStore.read("s"));
      expect(log).not.toContain("STEP_FAILED");
      expect(log).toContain("STEP_COMPLETED");
    });

    it(`execution deadlineMs does not cancel at start under a ${label} clock`, async () => {
      const { runtime, flow, eventStore } = boot(now, { deadlineMs: 5000 });
      const handle = await runtime.start(flow, { n: 1 }, { executionId: "x" });
      await expect(handle.waitForCompletion()).resolves.toBeDefined();
      const log = types(await eventStore.read("x"));
      expect(log).not.toContain("EXECUTION_CANCELLED");
      expect(log).toContain("EXECUTION_COMPLETED");
    });
  }

  it("a hung step still times out after ~timeoutMs REAL ms under an offset clock that advances in real time", async () => {
    const { runtime, flow } = boot(() => Date.now() + 1e12, { timeoutMs: 80, hang: true });
    const t0 = Date.now();
    const handle = await runtime.start(flow, { n: 1 }, { executionId: "h" });
    await expect(handle.waitForCompletion()).rejects.toThrow(/exceeded its deadline/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60); // not the 1ms clamp of a > 2^31 timer
  });

  it("a hung execution is cancelled after ~deadlineMs REAL ms under an offset clock that advances in real time", async () => {
    const { runtime, flow } = boot(() => Date.now() - 1e12, { deadlineMs: 80, hang: true });
    const t0 = Date.now();
    const handle = await runtime.start(flow, { n: 1 }, { executionId: "hx" });
    await expect(handle.waitForCompletion()).rejects.toThrow(/deadline exceeded/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60);
  });
});
