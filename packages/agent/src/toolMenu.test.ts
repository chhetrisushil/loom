import { agent$, tool$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentRunner } from "./AgentRunner";
import { agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";
import { toolInputJsonSchema } from "./toolSchema";

// ── R4 — the tool menu is a gate, and its schemas reach the model ─────────────
//
// The loop ran `ctx.execute({ toolId: toolCall.name })` for WHATEVER name the
// model returned, validated nothing, and told the model every tool took `{}`.

const readRows = tool$({
  id: "read-rows",
  name: "Read Rows",
  description: "Reads rows",
  kind: "tool",
  inputSchema: z.object({ table: z.string().min(1), limit: z.number().int().optional() }),
  outputSchema: z.object({}),
});
const dba = agent$({ id: "dba", name: "DBA", tools: [readRows] });

/** Scripted model: plays `calls[turn]`, then answers; records every request. */
function scripted(calls: Array<{ name: string; input: unknown }>) {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    async complete(request) {
      requests.push(request);
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      const c = calls[turn];
      return (
        c
          ? {
              content: "calling",
              toolCalls: [{ id: `c${turn}`, name: c.name, input: c.input }],
              stopReason: "tool_use",
            }
          : { content: "done", stopReason: "end_turn" }
      ) as LlmResponse;
    },
  };
  return { provider, requests };
}

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "ask",
  name: "ask",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  steps: [],
};

function bootLoop(calls: Array<{ name: string; input: unknown }>, store?: InMemoryAsyncEventStore) {
  const { provider, requests } = scripted(calls);
  const ran: Array<{ tool: string; input: unknown }> = [];
  const effects = new EffectRuntime();
  effects.register("model", createAgentModelEffect(provider));
  effects.register(
    "read-rows",
    new ToolEffect(async (input) => {
      ran.push({ tool: "read-rows", input });
      return { rows: 1 };
    })
  );
  // Registered, NOT on the agent's menu: reachable by name, must stay unreachable.
  effects.register(
    "drop-table",
    new ToolEffect(async (input) => {
      ran.push({ tool: "drop-table", input });
      return { dropped: true };
    })
  );
  const eventStore = store ?? new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  let result: Awaited<ReturnType<typeof agentLoop$>> | undefined;
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    result = await agentLoop$(ctx, { definition: dba, modelToolId: "model" }, { prompt: "go" });
    return {};
  };
  runtime.registerFlow(flowDef, runner);
  return { runtime, ran, requests, eventStore, result: () => result };
}

const stepIds = async (store: InMemoryAsyncEventStore) =>
  (await store.read("e1"))
    .filter((e) => e.eventType === "STEP_STARTED")
    .map((e) => (e.payload as { stepId: string }).stepId);

describe("agentLoop$ tool menu", () => {
  it("never executes an off-menu tool; the model gets a structured error and the run continues", async () => {
    const t = bootLoop([{ name: "drop-table", input: { table: "users" } }]);
    const h = await t.runtime.start(flowDef, {}, { executionId: "e1" });
    expect((await h.waitForCompletion()).status).toBe("completed");

    expect(t.ran).toEqual([]); // the handler never ran
    expect(await stepIds(t.eventStore)).toEqual(["dba#turn:0", "dba#turn:1"]); // no tool STEP
    const log = t.result()?.toolCallLog ?? [];
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0]?.toolOutput)).toContain("tool_not_on_menu");
    // The model saw the refusal on its next turn and could recover.
    expect(JSON.stringify(t.requests[1]?.messages)).toContain("tool_not_on_menu");
  });

  it("replays an off-menu refusal to the identical log", async () => {
    const first = bootLoop([{ name: "drop-table", input: {} }]);
    await (await first.runtime.start(flowDef, {}, { executionId: "e1" })).waitForCompletion();
    const full = await first.eventStore.read("e1");
    const cut = full.findIndex((e) => (e.payload as { stepId?: string }).stepId === "dba#turn:1");
    const crashed = new InMemoryAsyncEventStore();
    for (const e of full.slice(0, cut)) await crashed.append(e);
    const folded = new ReplayVM(full.slice(0, cut), {
      executionId: "e1",
      workflowId: "ask",
      workflowVersion: "1.0.0",
    }).getState();

    const second = bootLoop([{ name: "drop-table", input: {} }], crashed);
    const rec = await second.runtime.restoreFromState(folded);
    expect((await rec.waitForCompletion()).status).toBe("completed");

    expect(first.ran).toEqual([]);
    expect(second.ran).toEqual([]);
    expect(await stepIds(crashed)).toEqual(await stepIds(first.eventStore));
    expect(second.result()?.toolCallLog).toEqual(first.result()?.toolCallLog);
  });

  it("refuses invalid input with the issue, and does not run the tool", async () => {
    const t = bootLoop([{ name: "read-rows", input: { table: 42 } }]);
    const h = await t.runtime.start(flowDef, {}, { executionId: "e1" });
    expect((await h.waitForCompletion()).status).toBe("completed");

    expect(t.ran).toEqual([]);
    const out = JSON.stringify(t.result()?.toolCallLog[0]?.toolOutput);
    expect(out).toContain("invalid_tool_input");
    expect(out).toContain("table");
  });

  it("runs the tool on valid input", async () => {
    const t = bootLoop([{ name: "read-rows", input: { table: "users", limit: 3 } }]);
    const h = await t.runtime.start(flowDef, {}, { executionId: "e1" });
    await h.waitForCompletion();
    expect(t.ran).toEqual([{ tool: "read-rows", input: { table: "users", limit: 3 } }]);
  });

  it("sends the tool's JSON Schema to the provider, not {}", async () => {
    const t = bootLoop([]);
    await (await t.runtime.start(flowDef, {}, { executionId: "e1" })).waitForCompletion();
    const spec = t.requests[0]?.tools?.[0];
    expect(spec?.inputSchema).toMatchObject({
      type: "object",
      properties: { table: { type: "string", minLength: 1 }, limit: { type: "integer" } },
      required: ["table"],
    });
  });
});

describe("AgentRunner tool menu", () => {
  function runner(calls: Array<{ name: string; input: unknown }>) {
    const { provider, requests } = scripted(calls);
    const ran: unknown[] = [];
    const effectRuntime = new EffectRuntime();
    effectRuntime.register(
      "read-rows",
      new ToolEffect(async (i) => {
        ran.push(i);
        return { rows: 1 };
      })
    );
    effectRuntime.register(
      "drop-table",
      new ToolEffect(async (i) => {
        ran.push(["DROP", i]);
        return {};
      })
    );
    const ctx: EffectContext = {
      executionId: "x",
      stepId: "s",
      workflowId: "w",
      attempt: 1,
      emit: vi.fn(),
    };
    return { r: new AgentRunner({ definition: dba, provider, effectRuntime }), ran, requests, ctx };
  }

  it("refuses an off-menu tool and a bad input; runs a valid one; sends schemas", async () => {
    const t = runner([
      { name: "drop-table", input: {} },
      { name: "read-rows", input: { table: 1 } },
      { name: "read-rows", input: { table: "u" } },
    ]);
    const out = await t.r.run({ prompt: "go" }, t.ctx);
    expect(t.ran).toEqual([{ table: "u" }]);
    expect(JSON.stringify(out.toolCallLog[0]?.toolOutput)).toContain("tool_not_on_menu");
    expect(JSON.stringify(out.toolCallLog[1]?.toolOutput)).toContain("invalid_tool_input");
    expect(t.requests[0]?.tools?.[0]?.inputSchema).toMatchObject({
      properties: { table: { type: "string" } },
      required: ["table"],
    });
  });
});

describe("toolInputJsonSchema", () => {
  it("covers enums, arrays, nullable, defaults, strict and descriptions", () => {
    const s = z
      .object({
        mode: z.enum(["a", "b"]).describe("which"),
        tags: z.array(z.string()).max(3),
        note: z.string().nullable(),
        n: z.number().min(1).default(5),
      })
      .strict();
    expect(toolInputJsonSchema(s)).toEqual({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["a", "b"], description: "which" },
        tags: { type: "array", items: { type: "string" }, maxItems: 3 },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        n: { type: "number", minimum: 1, default: 5 },
      },
      required: ["mode", "tags", "note"],
      additionalProperties: false,
    });
  });
  it("degrades to the permissive schema rather than throwing", () => {
    expect(toolInputJsonSchema(z.unknown())).toEqual({});
    expect(toolInputJsonSchema(undefined)).toEqual({ type: "object" });
  });
});
