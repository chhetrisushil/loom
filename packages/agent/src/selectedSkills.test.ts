import type { EventEnvelope, FlowDefinition, SkillDefinition } from "@loom/core";
import { agent$, instructions$, skill$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmRequest, LlmResponse } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SkillRegistry } from "./SkillRegistry";
import { type AgentLoopConfig, agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";
import { selectedSkillsOf } from "./selectedSkills";

// F4: the supported reader for "which skills did the loop run with". Driven by a REAL agentLoop$ run so
// that a change to the internal decision ids breaks this test instead of silently emptying the reader.

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "ask",
  name: "ask",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};
const mkSkill = (id: string): SkillDefinition =>
  skill$({
    id,
    name: id,
    description: `${id} skill`,
    instructions: instructions$(`${id.toUpperCase()}-RULES`),
  });

async function run(config: Partial<AgentLoopConfig>, activate: string[]): Promise<EventEnvelope[]> {
  const effects = new EffectRuntime([], {});
  effects.register(
    "model",
    createAgentModelEffect({
      async complete(request: LlmRequest): Promise<LlmResponse> {
        const n = request.messages.filter((m) => m.role === "assistant").length;
        const name = activate[n];
        return name === undefined
          ? { content: "done", stopReason: "end_turn" }
          : {
              content: "",
              toolCalls: [{ id: `a${n}`, name: "activate_skill", input: { name } }],
              stopReason: "tool_use",
            };
      },
    })
  );
  const store = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail",
    scopes: true,
  });
  const registry = new SkillRegistry();
  for (const id of ["alpha", "billing", "zeta"]) registry.register(mkSkill(id));
  runtime.registerFlow(flowDef, async (ctx) =>
    agentLoop$(
      ctx,
      {
        definition: agent$({ id: "dba", name: "DBA", tools: [] }),
        modelToolId: "model",
        systemPrompt: "BASE",
        maxIterations: 8,
        skills: registry,
        skillSelector: { select: async () => ["alpha"] },
        skillActivation: {},
        ...config,
      },
      { prompt: "go" }
    )
  );
  await (await runtime.start(flowDef, {}, { executionId: "e1" })).waitForCompletion();
  return store.read("e1");
}

describe("selectedSkillsOf", () => {
  it("separates the up-front selection from mid-loop activations, in order", async () => {
    const events = await run({}, ["zeta", "billing"]);
    const r = selectedSkillsOf(events);
    expect(r.upfront).toEqual(["alpha"]);
    expect(r.activated).toEqual(["zeta", "billing"]);
    expect(r.byLoop).toEqual({ dba: { upfront: ["alpha"], activated: ["zeta", "billing"] } });
  });

  it("a run with no activation has an empty `activated`; an unknown skill name records nothing", async () => {
    const r = selectedSkillsOf(await run({}, ["nope"]));
    expect(r).toMatchObject({ upfront: ["alpha"], activated: [] });
  });

  it("filters by loopId (and a custom loopId is honoured)", async () => {
    const events = await run({ loopId: "custom" }, ["billing"]);
    expect(selectedSkillsOf(events, { loopId: "custom" })).toMatchObject({
      upfront: ["alpha"],
      activated: ["billing"],
    });
    const other = selectedSkillsOf(events, { loopId: "dba" });
    expect(other).toMatchObject({ upfront: [], activated: [], byLoop: {} });
  });

  it("is pure over events: it reads the same from a copy and ignores unrelated and malformed events", async () => {
    const events = await run({}, ["billing"]);
    const junk = [
      { eventType: "DECISION_RECORDED", payload: null },
      { eventType: "DECISION_RECORDED", payload: { decisionId: 7 } },
      { eventType: "DECISION_RECORDED", payload: { decisionId: "x#skills", choice: "nope" } },
      { eventType: "STEP_COMPLETED", payload: { decisionId: "y#skills", choice: ["evil"] } },
      // a refused activation is a recorded verdict, not an activation
      {
        eventType: "DECISION_RECORDED",
        payload: {
          decisionId: "dba#turn:3:tool:0:skill",
          source: "agent-skill-activation",
          choice: { skill: "zeta", refused: "instructions_refused" },
        },
      },
    ] as unknown as EventEnvelope[];
    expect(selectedSkillsOf([...junk, ...structuredClone(events)])).toMatchObject({
      upfront: ["alpha"],
      activated: ["billing"],
    });
  });
});
