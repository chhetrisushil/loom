import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { InputValidationError } from "./types";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── ADR 0051 D7 — opt-in inputSchema enforcement at start() ───────────────────

const inputSchema = z.object({ n: z.number(), mode: z.string().default("scan") });
const outputSchema = z.object({ echoed: z.unknown() });
type In = { n: number; mode?: string };
type Out = { echoed: unknown };

function echoFlow(marker: { sawInput?: unknown }): RegisteredFlow<In, Out> {
  const runner: FlowRunner<In, Out> = async (_ctx, input) => {
    marker.sawInput = input;
    return { echoed: input };
  };
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: "echo",
    name: "echo",
    version: "1.0.0",
    inputSchema: inputSchema as z.ZodSchema<In>,
    outputSchema: outputSchema as z.ZodSchema<Out>,
    steps: [],
  };
  return { definition, runner };
}

function boot(validateInput?: boolean) {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    ...(validateInput !== undefined && { validateInput }),
  });
  const marker = {} as { sawInput?: unknown };
  const flow = echoFlow(marker);
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, eventStore, flow, marker };
}

describe("start() input validation (ADR 0051 D7)", () => {
  it("off (default): invalid input starts unchanged — declaration-only metadata (G2)", async () => {
    const { runtime, flow, marker } = boot();
    const handle = await runtime.start(flow, { n: "nope" } as unknown as In, {
      executionId: "v-off",
    });
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(marker.sawInput).toEqual({ n: "nope" }); // passed through verbatim
  });

  it("on: invalid input refuses with InputValidationError and appends NOTHING", async () => {
    const { runtime, eventStore, flow } = boot(true);
    const err = await runtime
      .start(flow, { n: "nope" } as unknown as In, { executionId: "v-bad" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputValidationError);
    expect((err as InputValidationError).workflowId).toBe("echo");
    expect((err as Error).message).toMatch(/n:/);
    expect(await eventStore.read("v-bad")).toEqual([]); // no execution exists
  });

  it("on: the PARSED value runs and is recorded (defaults/transforms apply)", async () => {
    const { runtime, eventStore, flow, marker } = boot(true);
    const handle = await runtime.start(flow, { n: 3 }, { executionId: "v-ok" });
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(marker.sawInput).toEqual({ n: 3, mode: "scan" }); // default applied

    const started = (await eventStore.read("v-ok")).find(
      (e) => e.eventType === "EXECUTION_STARTED"
    );
    expect((started?.payload as { input: unknown }).input).toEqual({ n: 3, mode: "scan" });
  });
});
