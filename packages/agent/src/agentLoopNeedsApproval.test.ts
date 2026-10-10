import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, answerApproval, approvalViewDigest } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentLoopConfigError, agentLoop$, resetRequireApprovalWarning } from "./agentLoop$";
import type { AgentLoopConfig } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ── needsApproval (ADR 0121 amendment, 2026-10-10) ───────────────────────────
// `requireApproval` is an auto-approve policy (`false` parks) and reads backwards. `needsApproval`
// is the same gate with the polarity its name says. These pin: the new spelling's both branches,
// the alias's old polarity + once-only warning, both-given is a config error, and that the same
// effective decision records the IDENTICAL log.

const mk = (id: string) =>
  tool$({
    id,
    name: id,
    description: id,
    kind: "tool",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
  });
const x = mk("x");
const y = mk("y");
const agent = agent$({ id: "na", name: "NA", tools: [x, y] });

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "na-flow",
  name: "na-flow",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({ content: z.string() }),
  steps: [],
};

const responses: LlmResponse[] = [
  {
    content: "go",
    toolCalls: [
      { id: "c1", name: "x", input: {} },
      { id: "c2", name: "y", input: {} },
    ],
    stopReason: "tool_use",
  },
  { content: "done", stopReason: "end_turn" },
];

function boot(policy: Partial<AgentLoopConfig>) {
  const ran: string[] = [];
  const provider: LlmProvider = {
    async complete(request) {
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      return responses[Math.min(turn, responses.length - 1)] as LlmResponse;
    },
  };
  const effects = new EffectRuntime();
  effects.register("model", createAgentModelEffect(provider));
  for (const id of ["x", "y"]) {
    effects.register(
      id,
      new ToolEffect(async () => {
        ran.push(id);
        return { ok: true };
      })
    );
  }
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const runner: FlowRunner<unknown, { content: string }> = async (ctx) => {
    const out = await agentLoop$(
      ctx,
      { definition: agent, modelToolId: "model", ...policy },
      { prompt: "p" }
    );
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);
  return { runtime, eventStore, ran };
}

/** Run to the end, approving every parked call; return the executed tools and the whole log. */
async function drive(policy: Partial<AgentLoopConfig>) {
  const { runtime, eventStore, ran } = boot(policy);
  const handle = await runtime.start(flowDef, {});
  let parks = 0;
  const gates: string[] = [];
  let status = (await Promise.race([handle.waitForSuspend(), handle.waitForCompletion()])).status;
  while (status === "suspended") {
    parks++;
    const state = (await runtime.loadState(handle.executionId))!;
    gates.push(String(state.suspendedOn?.correlationKey).split("#").slice(-2).join("#"));
    const resumed = await runtime.resume(
      handle.executionId,
      answerApproval(state, { approved: true })
    );
    status = (await Promise.race([resumed.waitForSuspend(), resumed.waitForCompletion()])).status;
  }
  const events = await eventStore.read(handle.executionId);
  return { ran, parks, gates, events, executionId: handle.executionId };
}

/** The log with run-specific ids/timestamps normalised, so two runs can be compared. */
const shape = (events: EventEnvelope[], executionId: string) =>
  JSON.parse(
    JSON.stringify(
      events.map((e) => ({ type: e.eventType, payload: e.payload })),
      (_k, v) => v
    )
      .replaceAll(executionId, "EXEC")
      // the approval digest hashes the (per-run) gate key, so it is checked separately below
      .replace(/v2:[0-9a-f]{64}/g, "DIGEST")
  ) as unknown[];

describe("agentLoop$ needsApproval", () => {
  beforeEach(() => resetRequireApprovalWarning());

  it("true PARKS the call before it runs; false runs it", async () => {
    const { runtime, ran } = boot({ needsApproval: (c) => c.name === "x" });
    const handle = await runtime.start(flowDef, {});
    const suspended = await handle.waitForSuspend();
    expect(suspended.status).toBe("suspended");
    expect(ran).toEqual([]); // x is flagged and sits first: nothing ran while a human decides
    const state = (await runtime.loadState(handle.executionId))!;
    const resumed = await runtime.resume(
      handle.executionId,
      answerApproval(state, { approved: true })
    );
    await resumed.waitForCompletion();
    expect(ran).toEqual(["x", "y"]); // y was never flagged: it ran without a second park
  });

  it("false for every call never parks", async () => {
    const r = await drive({ needsApproval: () => false });
    expect(r.parks).toBe(0);
    expect(r.ran).toEqual(["x", "y"]);
  });

  it("a policy that returns nothing fails closed (parks)", async () => {
    const r = await drive({ needsApproval: (() => undefined) as never });
    expect(r.parks).toBe(2);
  });

  it("requireApproval keeps its OLD polarity (false parks) and warns exactly once", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const r = await drive({ requireApproval: (c) => c.name !== "x" });
      expect(r.gates).toEqual(["na#turn:0:tool:0"]); // x (false) parked; y (true) proceeded
      expect(r.ran).toEqual(["x", "y"]);
      await drive({ requireApproval: (c) => c.name !== "x" });
      const calls = spy.mock.calls.filter(
        (c) =>
          (c[1] as { code?: string } | undefined)?.code === "LOOM_AGENT_REQUIRE_APPROVAL_DEPRECATED"
      );
      expect(calls).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("needsApproval alone does not warn", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      await drive({ needsApproval: () => false });
      expect(spy.mock.calls.filter((c) => String(c[0]).includes("requireApproval"))).toHaveLength(
        0
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("supplying both is an AgentLoopConfigError", async () => {
    const { runtime } = boot({ needsApproval: () => true, requireApproval: () => true });
    const handle = await runtime.start(flowDef, {});
    await expect(handle.waitForCompletion()).rejects.toBeInstanceOf(AgentLoopConfigError);
  });

  it("the same effective decision records the IDENTICAL log under either spelling", async () => {
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const old = await drive({ requireApproval: (c) => c.name !== "x" });
      const next = await drive({ needsApproval: (c) => c.name === "x" });
      expect(old.gates).toEqual(["na#turn:0:tool:0"]);
      expect(next.gates).toEqual(["na#turn:0:tool:0"]);
      expect(next.events.length).toBe(old.events.length);
      expect(shape(next.events, next.executionId)).toEqual(shape(old.events, old.executionId));
      // …and the digest is the same function of (gate key, tool, input) under both.
      for (const r of [old, next]) {
        const gate = `${r.executionId}#na#turn:0:tool:0`;
        expect(JSON.stringify(r.events)).toContain(approvalViewDigest(gate, "x", {}));
      }
    } finally {
      spy.mockRestore();
    }
  });
});
