import type { FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  ResumeRefusedError,
  WorkflowRuntime,
  answerApproval,
  approvalViewDigest,
} from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ── R1 — mid-loop HITL, the thing a step handler structurally cannot do ──────
//
// `StepHandlerContext` has no `suspend`, so approval had to be hoisted OUT of the
// agent — which is precisely the design the feature exists to avoid. From a
// runner body the gate sits where the decision is: immediately before the
// destructive call, with the agent's full context still live.

const dropTable = tool$({
  id: "drop-table",
  name: "Drop Table",
  description: "Drops a table",
  kind: "tool",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});

const dbAgent = agent$({ id: "dba", name: "DBA", tools: [dropTable] });

const responses: LlmResponse[] = [
  {
    content: "dropping",
    toolCalls: [{ id: "c1", name: "drop-table", input: { t: "users" } }],
    stopReason: "tool_use",
  },
  { content: "done", stopReason: "end_turn" },
];

const provider: LlmProvider = {
  async complete(request) {
    const turn = request.messages.filter((m) => m.role === "assistant").length;
    return responses[Math.min(turn, responses.length - 1)] as LlmResponse;
  },
};

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "gated",
  name: "gated",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({ content: z.string() }),
  steps: [],
};

function boot(opts: { toolInput?: unknown; second?: boolean } = {}) {
  const dropped: unknown[] = [];
  const requests: string[] = [];
  const prov: LlmProvider = {
    async complete(request) {
      requests.push(JSON.stringify(request.messages).slice(-2000));
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      const r = responses[Math.min(turn, responses.length - 1)] as LlmResponse;
      return opts.toolInput === undefined || r.toolCalls === undefined
        ? r
        : { ...r, toolCalls: [{ id: "c1", name: "drop-table", input: opts.toolInput }] };
    },
  };
  const effects = new EffectRuntime();
  effects.register("model", createAgentModelEffect(prov));
  effects.register(
    "drop-table",
    new ToolEffect(async (input) => {
      dropped.push(input);
      return { ok: true };
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const runner: FlowRunner<unknown, { content: string }> = async (ctx) => {
    const out = await agentLoop$(
      ctx,
      {
        definition: dbAgent,
        modelToolId: "model",
        // Anything destructive stops for a human.
        needsApproval: (call) => call.name === "drop-table",
      },
      { prompt: "clean up" }
    );
    if (opts.second === true) {
      // A second loop in the SAME flow: its first call sits at the same `#turn:0:tool:0`.
      await agentLoop$(
        ctx,
        {
          definition: agent$({ id: "dbb", name: "DBB", tools: [dropTable] }),
          modelToolId: "model",
          needsApproval: (call) => call.name === "drop-table",
        },
        { prompt: "clean up again" }
      );
    }
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  const flow: RegisteredFlow = { definition: flowDef, runner: runner as FlowRunner };
  return { runtime, flowDef, dropped, requests };
}

describe("agentLoop$ can stop mid-loop for approval (R1)", () => {
  it("parks BEFORE the tool runs, and runs it once approved", async () => {
    const { runtime, flowDef, dropped } = boot();
    const handle = await runtime.start(flowDef, {});
    const suspended = await handle.waitForSuspend();

    expect(suspended.status).toBe("suspended");
    // The gate is before the effect, which is the point of asking: nothing
    // destructive has happened while a human decides.
    expect(dropped).toEqual([]);

    const state = (await runtime.loadState(handle.executionId))!;
    const resumed = await runtime.resume(
      handle.executionId,
      answerApproval(state, { approved: true })
    );
    await resumed.waitForCompletion();
    expect(dropped).toEqual([{ t: "users" }]);
  });

  it("R13 — the approval is bound to the tool call the approver saw", async () => {
    const { runtime, flowDef, dropped } = boot();
    const handle = await runtime.start(flowDef, {});
    await handle.waitForSuspend();
    const state = (await runtime.loadState(handle.executionId))!;
    // The digest names tool + args + this gate position (so it cannot be replayed elsewhere).
    expect(state.suspendedOn?.viewDigest).toBe(
      approvalViewDigest(`${handle.executionId}#dba#turn:0:tool:0`, "drop-table", { t: "users" })
    );

    // A bare approval — or one for a DIFFERENT proposal — is refused and nothing is recorded.
    const before = await runtime.loadState(handle.executionId);
    for (const payload of [
      { approved: true },
      { approved: true, viewDigest: approvalViewDigest("x", "drop-table", { t: "other" }) },
    ]) {
      const err = await runtime
        .resume(handle.executionId, { eventType: "AgentToolApproval", payload })
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(err).toBeInstanceOf(ResumeRefusedError);
    }
    expect(await runtime.loadState(handle.executionId)).toEqual(before);
    expect(dropped).toEqual([]);
  });

  it("feeds a refusal back to the model instead of running the tool", async () => {
    const { runtime, flowDef, dropped } = boot();
    const handle = await runtime.start(flowDef, {});
    await handle.waitForSuspend();

    const state0 = (await runtime.loadState(handle.executionId))!;
    const resumed = await runtime.resume(
      handle.executionId,
      answerApproval(state0, { approved: false, reason: "not during business hours" })
    );
    const state = await resumed.waitForCompletion();

    expect(state.status).toBe("completed");
    // Refused, not failed: the agent learns the call was declined and settles.
    // A human saying no is information, not an error.
    expect(dropped).toEqual([]);
  });

  it("R13 — two loops in one flow do not share a gate key (idPrefix is in it)", async () => {
    const { runtime, flowDef } = boot({ second: true });
    const handle = await runtime.start(flowDef, {});
    await handle.waitForSuspend();
    const first = (await runtime.loadState(handle.executionId))!;
    await (
      await runtime.resume(handle.executionId, answerApproval(first, { approved: true }))
    ).waitForSuspend();
    const second = (await runtime.loadState(handle.executionId))!;
    expect(first.suspendedOn?.correlationKey).toBe(`${handle.executionId}#dba#turn:0:tool:0`);
    expect(second.suspendedOn?.correlationKey).toBe(`${handle.executionId}#dbb#turn:0:tool:0`);
    expect(second.suspendedOn?.viewDigest).not.toBe(first.suspendedOn?.viewDigest);
    // The first loop's approval cannot answer the second loop's gate.
    const err = await runtime
      .resume(handle.executionId, answerApproval(first, { approved: true }))
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(ResumeRefusedError);
  });

  it("R13 — a tool input too deep to digest is refused to the model, not a run failure", async () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 1100; i++) deep = { n: deep };
    const { runtime, flowDef, dropped, requests } = boot({ toolInput: deep });
    const handle = await runtime.start(flowDef, {});
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(dropped).toEqual([]);
    // The model was told, in the next turn's transcript — as it is for any refused call.
    expect(requests.at(-1)).toContain("could not be put in front of an approver");
  });
});
