import { agentLoop$, createAgentModelEffect } from "@loom/agent";
import { tainted } from "@loom/classify";
import type { FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SUMMARIZER_TEXT_TRUNCATED, summarizerText } from "./summarizerText";

const mk = (id: string) =>
  tool$({
    id,
    name: id,
    description: "x",
    kind: "tool",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.any(),
  });

describe("summarizerText over an agentLoop$ compaction fold", () => {
  it("one summarizer effect survives a fold holding a failed tool call and an MCP-style tainted result", async () => {
    const provider: LlmProvider = {
      async complete(request) {
        const turn = request.messages.filter((m) => m.role === "assistant").length;
        const names = ["bad", "mcp", "bad", "mcp"];
        return turn < 4
          ? {
              content: `t${turn}`,
              toolCalls: [{ id: `c${turn}`, name: names[turn] as string, input: { i: turn } }],
              stopReason: "tool_use",
            }
          : { content: "final", stopReason: "end_turn" };
      },
    };
    const seenText: string[] = [];
    const effects = new EffectRuntime();
    effects.register("model", createAgentModelEffect(provider));
    effects.register(
      "bad",
      new ToolEffect(async () => {
        throw new Error("BOOM-FAILURE");
      })
    );
    effects.register(
      "mcp",
      new ToolEffect(async () => tainted({ rows: ["MCP-PAYLOAD"] }, "mcp:srv/mcp"))
    );
    effects.register(
      "summarize",
      new ToolEffect(async (input: unknown) => {
        const text = (input as { messages: { content: unknown }[] }).messages
          .map((m) => summarizerText(m.content))
          .join("|");
        seenText.push(text);
        return { summary: "S" };
      })
    );
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
    });
    const def: FlowDefinition = {
      _tag: "FlowDefinition",
      id: "ask",
      name: "ask",
      version: "1.0.0",
      inputSchema: z.object({}),
      outputSchema: z.any(),
      steps: [],
    };
    runtime.registerFlow(def, async (ctx) =>
      agentLoop$(
        ctx,
        {
          definition: agent$({ id: "a", name: "A", tools: [mk("bad"), mk("mcp")] }),
          modelToolId: "model",
          maxIterations: 8,
          compaction: { toolId: "summarize", afterMessages: 4, keepRecent: 2 },
        },
        { prompt: "go" }
      )
    );
    const handle = await runtime.start(def, {}, { executionId: "e" });
    await handle.waitForCompletion();
    const joined = seenText.join("\n");
    expect(seenText.length).toBeGreaterThan(0);
    expect(joined).toContain("BOOM-FAILURE");
    expect(joined).toContain("MCP-PAYLOAD");
    expect(joined).not.toContain("[object Object]");
    expect(joined).not.toContain("__loomTainted");
  });

  it("unwraps a wrapper at every level and never returns [object Object]", () => {
    const fold = [
      { type: "text", text: tainted("a", "x") },
      { type: "tool_result", toolUseId: "1", content: tainted("b", "x") },
      {
        type: "tool_result",
        toolUseId: "2",
        content: [{ type: "text", text: tainted("c", "x") }],
      },
      { type: "tool_use", id: "3", name: "n", input: {} },
    ];
    expect(summarizerText(tainted(fold, "y"))).toBe("abc");
    expect(summarizerText(tainted(tainted("deep", "a"), "b"))).toBe("deep");
    expect(summarizerText(undefined)).toBe("");
  });

  it("an off-type wrapper used as a part is unwrapped; content past the depth cap is marked, never dropped", () => {
    expect(summarizerText([tainted({ type: "text", text: "w" }, "x")])).toBe("w");
    // 20 levels of tool_result nesting around a text part: past the 16-level cap
    let deep: unknown = [{ type: "text", text: "HIDDEN" }];
    for (let i = 0; i < 20; i++) deep = [{ type: "tool_result", toolUseId: `${i}`, content: deep }];
    expect(summarizerText(deep)).toBe(SUMMARIZER_TEXT_TRUNCATED);
    // tainted() does not double-wrap, so a long wrapper chain collapses to one: still read
    let chain: unknown = "seen";
    for (let i = 0; i < 20; i++) chain = tainted(chain, "x");
    expect(summarizerText(chain)).toBe("seen");
    // under the cap, nested content is read
    let shallow: unknown = [{ type: "text", text: "ok" }];
    for (let i = 0; i < 5; i++)
      shallow = [{ type: "tool_result", toolUseId: `${i}`, content: shallow }];
    expect(summarizerText(shallow)).toBe("ok");
  });
});
