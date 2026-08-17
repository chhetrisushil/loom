import { agent$, tool$ } from "@loom/core";
import { CapabilityDeniedError, EffectRuntime, GrantTable, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentRunner } from "./AgentRunner";

// ── R4 — a capability denial is not a tool error ──────────────────────────────
//
// `runToolCall` swallowed EVERY throw into `{ error: String(err) }` and handed it
// back to the model. For an ordinary tool failure that is right: the model can
// retry, or explain, or route around it. For an AUTHORITY error it is exactly
// wrong — the model reads "not authorized", reformulates, and probes a
// neighbouring tool, which turns one denial into a search over the grant table.
//
// `EFFECT_DENIED` was always logged, so the behaviour was auditable after the
// fact. Auditable is not the same as stopped.

function makeEffectContext(): EffectContext {
  return {
    executionId: "exec-1",
    stepId: "agent-step",
    workflowId: "wf-1",
    attempt: 1,
    emit: vi.fn(),
  };
}

const readRows = tool$({
  id: "read-rows",
  name: "Read Rows",
  description: "Reads rows",
  kind: "tool",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});

const deleteTable = tool$({
  id: "delete-table",
  name: "Delete Table",
  description: "Drops a table",
  kind: "tool",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});

/** A model that calls `toolName`, then would happily keep going. */
function providerCalling(toolName: string): { provider: LlmProvider; turns: () => number } {
  let call = 0;
  const responses: LlmResponse[] = [
    {
      content: "(tool calls)",
      toolCalls: [{ id: "c1", name: toolName, input: {} }],
      stopReason: "tool_use",
    },
    {
      content: "(tool calls)",
      toolCalls: [{ id: "c2", name: "read-rows", input: {} }],
      stopReason: "tool_use",
    },
    { content: "done", stopReason: "end_turn" },
  ];
  return {
    turns: () => call,
    provider: {
      async complete() {
        const res = responses[Math.min(call, responses.length - 1)] as LlmResponse;
        call++;
        return res;
      },
    },
  };
}

function runnerWith(provider: LlmProvider, parallelTools: boolean): AgentRunner {
  // Only `read-rows` is granted; the agent's menu also holds `delete-table`.
  const effectRuntime = new EffectRuntime([], {
    authorizer: new GrantTable({ "wf-1": ["read-rows"] }),
  });
  effectRuntime.register("read-rows", new ToolEffect(async () => ({ rows: 0 })));
  effectRuntime.register("delete-table", new ToolEffect(async () => ({ dropped: true })));
  return new AgentRunner({
    definition: agent$({ id: "dba", name: "DBA", tools: [readRows, deleteTable] }),
    provider,
    effectRuntime,
    parallelTools,
  });
}

describe("a capability denial is terminal for the turn (R4)", () => {
  it("propagates the denial instead of feeding it back to the model", async () => {
    const { provider, turns } = providerCalling("delete-table");
    const runner = runnerWith(provider, false);

    await expect(runner.run({ prompt: "clean up" }, makeEffectContext())).rejects.toThrow(
      CapabilityDeniedError
    );

    // The model got ONE turn. Previously it got the denial as a tool result and
    // went round again — the probe this exists to stop.
    expect(turns()).toBe(1);
  });

  it("is terminal in parallel-tool mode too", async () => {
    const { provider } = providerCalling("delete-table");
    const runner = runnerWith(provider, true);
    await expect(runner.run({ prompt: "clean up" }, makeEffectContext())).rejects.toThrow(
      CapabilityDeniedError
    );
  });

  it("still hands an ORDINARY tool failure back to the model", async () => {
    // The blanket catch is correct for tool errors and wrong only for authority
    // errors; this is the half that must not change.
    const { provider, turns } = providerCalling("read-rows");
    const effectRuntime = new EffectRuntime();
    effectRuntime.register(
      "read-rows",
      new ToolEffect(async () => {
        throw new Error("upstream timeout");
      })
    );
    const runner = new AgentRunner({
      definition: agent$({ id: "dba", name: "DBA", tools: [readRows] }),
      provider,
      effectRuntime,
    });

    const out = await runner.run({ prompt: "read" }, makeEffectContext());

    expect(turns()).toBeGreaterThan(1); // the loop continued
    expect(JSON.stringify(out.toolCallLog)).toContain("upstream timeout");
  });
});
