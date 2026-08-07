import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import { MCP_INVOKE_TOOL_ID } from "./mcpInvoke$";

// ── ADR 0073 — the tools that must STAY undeclared ───────────────────────────
//
// "Declare modes on the remaining tools" is a trap if read as "fill in every
// blank". `mcp.invoke` is dual-seam BY DOCUMENTED DESIGN: the transient-interpreter
// pattern (docs/transient-interpreter.md, ADR 0066 + the DE-2 verdict) hydrates a
// read path with `invokeTransient("mcp.invoke", …)` and then starts a DURABLE
// repair run that calls the same effect through `ctx.run(mcpInvoke$(…))`.
//
// Pinning it to either seam would break one of those two paths — and it would
// break them at the seam check, loudly, at runtime, in whichever deployment
// happened to use the other half. This test exists so a later well-meaning sweep
// has to argue with a failing assertion rather than a silent comment.

describe("mcp.invoke stays dual-seam (ADR 0073)", () => {
  it("is registered without a mode", () => {
    const runtime = new EffectRuntime();
    // Stand-in with the same registration shape `registerMcpInvoke` uses; the
    // assertion is about the SEAM contract, not the dispatch body.
    runtime.register(MCP_INVOKE_TOOL_ID, new ToolEffect(async () => ({ ok: true })));

    const effect = (
      runtime as unknown as { registry: Map<string, { mode?: string }> }
    ).registry.get(MCP_INVOKE_TOOL_ID);
    expect(effect?.mode).toBeUndefined();
  });

  it("works on BOTH seams — the transient hydrate and the durable repair run", async () => {
    const runtime = new EffectRuntime();
    runtime.register(MCP_INVOKE_TOOL_ID, new ToolEffect(async () => ({ rows: 3 })));

    // Hot path: plain code over an immutable plan, zero events.
    await expect(runtime.invokeTransient(MCP_INVOKE_TOOL_ID, {})).resolves.toEqual({ rows: 3 });

    // Repair path: the same effect inside a durable execution.
    await expect(
      runtime.execute(
        MCP_INVOKE_TOOL_ID,
        {},
        { executionId: "e1", stepId: "s1", workflowId: "w1", attempt: 1, emit: () => {} }
      )
    ).resolves.toEqual({ rows: 3 });
  });
});

// Third-party MCP tools discovered via `tools/list` are mapped into effects by
// `McpClient.mapTool`. We cannot know whether someone else's tool is a read or a
// mutation, so declaring a seam for it would be a guess with teeth.
describe("discovered MCP tools stay undeclared", () => {
  it("maps a remote tool without inventing a seam for it", async () => {
    const { McpClient } = await import("./McpClient");
    const client = new McpClient({ transport: "http", url: "http://unused.example" });
    const mapped = (
      client as unknown as {
        mapTool(t: { name: string; inputSchema: Record<string, unknown> }): {
          effect: { mode?: string };
          definition: { mode?: string };
        };
      }
    ).mapTool({ name: "search", inputSchema: {} });

    expect(mapped.effect.mode).toBeUndefined();
    expect(mapped.definition.mode).toBeUndefined();
  });
});
