import { selectedSkillsOf } from "@loom/agent";
import { SkillRegistry } from "@loom/agent";
import { agent$, instructions$, skill$, tool$ } from "@loom/core";
import { GrantTable, ToolEffect } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgentOnce } from "./runAgentOnce";

// F4: a one-off script runs agentLoop$ without hand-building a flow + app, and loses no protection by it.

const lookup = tool$({
  id: "lookup",
  name: "lookup",
  description: "look a thing up",
  kind: "tool",
  inputSchema: z.object({ q: z.string() }),
  outputSchema: z.object({}).passthrough(),
});
const agent = agent$({ id: "scripted", name: "Scripted", tools: [lookup] });

// first turn: call the tool; second: answer
const provider = {
  async complete(request: { messages: { role: string }[] }) {
    const n = request.messages.filter((m) => m.role === "assistant").length;
    return n === 0
      ? {
          content: "",
          toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
          stopReason: "tool_use" as const,
        }
      : { content: "the answer", stopReason: "end_turn" as const };
  },
};

describe("runAgentOnce", () => {
  it("runs a scripted agent end to end and returns the output and the events", async () => {
    const seen: unknown[] = [];
    const r = await runAgentOnce({
      agent,
      provider: provider as never,
      registerEffects: (fx) =>
        fx.register(
          "lookup",
          new ToolEffect(async (input) => {
            seen.push(input);
            return { found: true };
          })
        ),
      input: "find x",
      config: { observability: { onWarn: () => {} } },
      loop: { systemPrompt: "BASE" },
    });
    expect(r.status).toBe("completed");
    expect(r.output?.content).toBe("the answer");
    expect(r.output?.toolCallLog).toHaveLength(1);
    expect(seen).toEqual([{ q: "x" }]);
    expect(r.events.some((e) => e.eventType === "EXECUTION_COMPLETED")).toBe(true);
    expect(
      r.events.every((e) => e.executionId === undefined || e.executionId === r.executionId)
    ).toBe(true);
  });

  it("the events feed selectedSkillsOf (the two helpers compose)", async () => {
    const registry = new SkillRegistry();
    registry.register(
      skill$({ id: "sql", name: "sql", description: "sql", instructions: instructions$("CTEs") })
    );
    const r = await runAgentOnce({
      agent,
      provider: provider as never,
      registerEffects: (fx) => fx.register("lookup", new ToolEffect(async () => ({}))),
      input: "go",
      loop: { skills: registry, skillSelector: { select: async () => ["sql"] } },
    });
    expect(selectedSkillsOf(r.events)).toMatchObject({ upfront: ["sql"], activated: [] });
  });

  it("refuses a config agentLoop$ would refuse, with agentLoop$'s own error and no model call", async () => {
    let calls = 0;
    const counting = {
      async complete() {
        calls++;
        return { content: "x", stopReason: "end_turn" as const };
      },
    };
    await expect(
      runAgentOnce({
        agent,
        provider: counting as never,
        input: "go",
        // a selector that calls its provider directly bypasses the ring: requireEffectRing refuses it
        loop: {
          requireEffectRing: true,
          skills: new SkillRegistry(),
          skillSelector: { select: async () => [] },
        },
      })
    ).rejects.toThrow(/requireEffectRing: this `skillSelector`/);
    expect(calls).toBe(0);
  });

  it("does not bypass the ring: a denying authorizer stops the model call", async () => {
    let calls = 0;
    const counting = {
      async complete() {
        calls++;
        return { content: "x", stopReason: "end_turn" as const };
      },
    };
    await expect(
      runAgentOnce({
        agent,
        provider: counting as never,
        input: "go",
        config: {
          security: {
            authorizer: { authorize: () => ({ allowed: false, reason: "no" }) },
          } as never,
          observability: { onWarn: () => {} },
        },
      })
    ).rejects.toThrow(/Capability denied: effect "model"/);
    expect(calls).toBe(0);
  });

  it("needs a model source", async () => {
    await expect(runAgentOnce({ agent, input: "go" })).rejects.toThrow(/provider/);
  });

  it("`principal` reaches the effect ring: a GrantTable keyed by actor allows one caller and denies another", async () => {
    const run = (actor: string) =>
      runAgentOnce({
        agent,
        provider: provider as never,
        registerEffects: (fx) =>
          fx.register("lookup", new ToolEffect(async () => ({ found: true }))),
        input: "find x",
        principal: { actor, tenant: "t1" },
        config: {
          security: {
            authorizer: new GrantTable(
              { alice: ["model", "lookup"], bob: ["model"] },
              { principal: (req) => req.principal?.actor ?? "" }
            ),
          } as never,
          observability: { onWarn: () => {} },
        },
      });
    const ok = await run("alice");
    expect(ok.output?.content).toBe("the answer");
    expect(ok.output?.toolCallLog).toHaveLength(1);
    // bob may call the model but not the tool: the denial is of the TOOL, so the principal was seen
    await expect(run("bob")).rejects.toThrow(
      /Capability denied: effect "lookup" — effect "lookup" not granted to "bob"/
    );
  });

  it("refuses a config where `provider` and `registerEffects` both register the model effect", async () => {
    await expect(
      runAgentOnce({
        agent,
        provider: provider as never,
        registerEffects: (fx) =>
          fx.register("model", new ToolEffect(async () => ({ content: "shadow" }))),
        input: "go",
        config: { observability: { onWarn: () => {} } },
      })
    ).rejects.toThrow(/both `provider` and `registerEffects` register the model effect "model"/);
  });
});
