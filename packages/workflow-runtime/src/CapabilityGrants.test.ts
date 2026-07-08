import { step$ } from "@loom/core";
import { EffectRuntime, GrantTable, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// K2 integration: with a capability authorizer wired into the EffectRuntime, a flow
// may invoke only its granted effects. An ungranted effect is denied at the boundary
// — the effect never runs, a durable EFFECT_DENIED audit fact is logged, and the step
// fails.

const FLOW_ID = "guarded-flow";

const allowedStep = step$({
  id: "allowed",
  name: "Allowed",
  toolId: "allowed-tool",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
});
const forbiddenStep = step$({
  id: "forbidden",
  name: "Forbidden",
  toolId: "forbidden-tool",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
});

function makeFlow(
  runner: FlowRunner<Record<string, never>, { done: boolean }>
): RegisteredFlow<Record<string, never>, { done: boolean }> {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: FLOW_ID,
      name: "Guarded Flow",
      version: "1.0.0",
      inputSchema: z.object({}),
      outputSchema: z.object({ done: z.boolean() }),
      steps: [allowedStep, forbiddenStep],
    },
    runner,
  };
}

function makeRuntime(authorized: boolean) {
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  // Grant only the allowed tool to this flow (least-privilege).
  const authorizer = new GrantTable({ [FLOW_ID]: ["allowed-tool"] });
  const effectRuntime = authorized
    ? new EffectRuntime([], { authorizer })
    : new EffectRuntime();
  const allowedBody = vi.fn(async () => ({ ok: true }));
  const forbiddenBody = vi.fn(async () => ({ ok: true }));
  effectRuntime.register("allowed-tool", new ToolEffect(allowedBody));
  effectRuntime.register("forbidden-tool", new ToolEffect(forbiddenBody));
  const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
  return { runtime, eventStore, allowedBody, forbiddenBody };
}

describe("K2 — capability grants in a durable flow", () => {
  it("denies an ungranted effect: step fails, EFFECT_DENIED logged, effect never runs", async () => {
    const { runtime, eventStore, allowedBody, forbiddenBody } = makeRuntime(true);
    const runner: FlowRunner<Record<string, never>, { done: boolean }> = async (ctx) => {
      await ctx.run(allowedStep, {});
      await ctx.run(forbiddenStep, {}); // ungranted → denied → throws
      return { done: true };
    };
    const handle = await runtime.start(makeFlow(runner), {});
    // An unauthorized effect fails the execution — waitForCompletion rejects with the
    // denial, exactly as any thrown step would.
    await expect(handle.waitForCompletion()).rejects.toThrow(/Capability denied/);
    const state = handle.getState();

    expect(state.status).toBe("failed");
    expect(state.frames.allowed?.status).toBe("completed");
    expect(state.frames.forbidden?.status).toBe("failed");

    // The granted effect ran; the forbidden one never did.
    expect(allowedBody).toHaveBeenCalledTimes(1);
    expect(forbiddenBody).not.toHaveBeenCalled();

    // Durable audit trail: a denial fact folded into _denials + an EFFECT_DENIED event.
    const denials = state.variables._denials as Array<{ toolId: string; stepId: string }>;
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ toolId: "forbidden-tool", stepId: "forbidden" });

    const events = await eventStore.read(handle.executionId);
    expect(events.some((e) => e.eventType === "EFFECT_DENIED")).toBe(true);
  });

  it("without an authorizer, both effects run (permissive, unchanged)", async () => {
    const { runtime, allowedBody, forbiddenBody } = makeRuntime(false);
    const runner: FlowRunner<Record<string, never>, { done: boolean }> = async (ctx) => {
      await ctx.run(allowedStep, {});
      await ctx.run(forbiddenStep, {});
      return { done: true };
    };
    const handle = await runtime.start(makeFlow(runner), {});
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(allowedBody).toHaveBeenCalledTimes(1);
    expect(forbiddenBody).toHaveBeenCalledTimes(1);
  });
});
