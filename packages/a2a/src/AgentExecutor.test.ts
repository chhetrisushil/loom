import { flow$, handler$, step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LoomAgentExecutor, executionStatusToA2A } from "./AgentExecutor";
import type { A2ATask } from "./types";

const echoStep = step$({
  id: "echo",
  name: "Echo",
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ reply: z.string() }),
  handler: handler$(async (input: { prompt: string }) => ({ reply: `Echo: ${input.prompt}` })),
});

// A gated flow: echo, then wait for input (the A2A "input-required" state), then finish.
const gatedRunner: FlowRunner<{ prompt: string }, { reply: string }> = async (ctx, input) => {
  const first = (await ctx.run(echoStep, { prompt: input.prompt })) as { reply: string };
  await ctx.suspend({ on: "InputProvided", correlationKey: input.prompt });
  return first;
};

const gatedFlow: RegisteredFlow = {
  definition: flow$({
    id: "gated-echo",
    name: "Gated Echo",
    version: "1.0.0",
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ reply: z.string() }),
    steps: [echoStep],
  }),
  runner: gatedRunner as FlowRunner<unknown, unknown>,
};

function makeRuntime(): WorkflowRuntime {
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  runtime.registerFlow(gatedFlow.definition, gatedFlow.runner);
  return runtime;
}

describe("LoomAgentExecutor", () => {
  it("maps status: suspended → working, completed → completed", () => {
    expect(executionStatusToA2A("suspended")).toBe("working");
    expect(executionStatusToA2A("running")).toBe("working");
    expect(executionStatusToA2A("completed")).toBe("completed");
    expect(executionStatusToA2A("failed")).toBe("failed");
  });

  it("submit → input-required → provideInput → completed (the full lifecycle)", async () => {
    const runtime = makeRuntime();
    const executor = new LoomAgentExecutor(runtime, gatedFlow);
    const task: A2ATask = {
      id: "task-1",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    };

    // The protocol is poll-based (get() reflects the durable log, not a live
    // handle) — the same statelessness a scaled server needs.
    const pollUntil = async (pred: (status: string | undefined) => boolean) => {
      for (let i = 0; i < 40; i++) {
        const s = (await runtime.loadState(task.id))?.status;
        if (pred(s)) return s;
        await new Promise((r) => setTimeout(r, 10));
      }
      return (await runtime.loadState(task.id))?.status;
    };

    const { id } = await executor.submit(task);
    expect(id).toBe("task-1"); // honors the caller's task id

    // Runs until it needs input → A2A "working" (input-required).
    await pollUntil((s) => s === "suspended");
    const working = await executor.get(id);
    expect(working?.status).toBe("working");

    // Deliver the awaited input (resume), then poll to completion.
    await executor.provideInput(id, { eventType: "InputProvided", payload: { ok: true } });
    await pollUntil((s) => s === "completed" || s === "failed");
    const done = await executor.get(id);
    expect(done?.status).toBe("completed");
    expect(done?.artifacts?.[0]?.parts[0]?.text).toContain("Echo: hello");
  });

  it("get() returns null for an unknown task (stateless — no handle map)", async () => {
    const executor = new LoomAgentExecutor(makeRuntime(), gatedFlow);
    expect(await executor.get("nope")).toBeNull();
  });
});
