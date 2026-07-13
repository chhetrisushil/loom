import { step$ } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestApp } from "./createTestApp";
import { emptyCassette, hashRequest, recordingProvider, replayingProvider } from "./vcr";
import { captureGolden, resumeWith, waitFor } from "./wait";

// ── fixtures ──────────────────────────────────────────────────────────────────
const incident = z.object({ incidentId: z.string() });
const metricsStep = step$({
  id: "metrics",
  name: "Metrics",
  toolId: "metrics-tool",
  inputSchema: incident,
  outputSchema: z.object({ cpu: z.number() }),
});
const gated: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
  ctx: WorkflowContext,
  input
) => {
  await ctx.run(metricsStep, { incidentId: input.incidentId });
  await ctx.suspend({ on: "ApprovalGranted", correlationKey: input.incidentId });
  return { resolved: true };
};
const gatedFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "gated",
    name: "Gated",
    version: "1.0.0",
    inputSchema: incident,
    outputSchema: z.object({ resolved: z.boolean() }),
    steps: [metricsStep],
  },
  runner: gated,
} as RegisteredFlow;

describe("createTestApp", () => {
  it("defaults to in-memory storage and runs a flow to suspend, then resume", async () => {
    const app = createTestApp({ flows: [gatedFlow] });
    app.effectRuntime.register("metrics-tool", new ToolEffect(async () => ({ cpu: 87 })));

    const handle = await app.runtime.start(gatedFlow, { incidentId: "i1" });
    const suspended = await handle.waitForSuspend();
    expect(suspended.status).toBe("suspended");

    const resumed = await resumeWith(app.runtime, handle.executionId);
    const final = await resumed.waitForCompletion();
    expect(final.status).toBe("completed");

    // captureGolden reads the durable log for use as an eval fixture.
    const log = await captureGolden(app.stores.eventStore, handle.executionId);
    expect(log.some((e) => e.eventType === "EXECUTION_COMPLETED")).toBe(true);
    await app.close();
  });
});

describe("waitFor", () => {
  it("resolves once the predicate turns true", async () => {
    let flag = false;
    setTimeout(() => {
      flag = true;
    }, 20);
    await expect(waitFor(() => flag, { timeoutMs: 500, intervalMs: 5 })).resolves.toBeUndefined();
  });

  it("throws on timeout", async () => {
    await expect(waitFor(() => false, { timeoutMs: 30, intervalMs: 5 })).rejects.toThrow(/not met/);
  });
});

describe("VCR llm provider", () => {
  const response: LlmResponse = { content: "hi", stopReason: "end_turn" };
  const req = { messages: [{ role: "user" as const, content: "hello" }] };

  it("hashRequest is deterministic and ignores the abort signal", () => {
    const a = hashRequest(req);
    const b = hashRequest({ ...req, signal: new AbortController().signal });
    expect(a).toBe(b);
    expect(hashRequest({ messages: [{ role: "user", content: "other" }] })).not.toBe(a);
  });

  it("records a live call once, then replays from the cassette", async () => {
    const live = vi.fn(async () => response);
    const real: LlmProvider = { complete: live };
    const cassette = emptyCassette();

    const rec = recordingProvider(real, cassette);
    expect((await rec.complete(req)).content).toBe("hi");
    expect((await rec.complete(req)).content).toBe("hi"); // cache hit
    expect(live).toHaveBeenCalledTimes(1); // recorded once
    expect(cassette.entries).toHaveLength(1);

    const replay = replayingProvider(cassette);
    expect((await replay.complete(req)).content).toBe("hi");
  });

  it("replay throws on a request with no recorded entry", async () => {
    const replay = replayingProvider(emptyCassette());
    await expect(replay.complete(req)).rejects.toThrow(/no cassette entry/);
  });
});
