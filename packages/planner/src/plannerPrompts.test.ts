import { CapabilityCatalog, capability$ } from "@loom/capability";
import { flow$, handler$, step$ } from "@loom/core";
import { UNTRUSTED_CONTENT_SYSTEM_NOTE } from "@loom/llm";
import type { LlmRequestInput } from "@loom/llm";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_PLANNER_SYSTEM, planGoal, plannerSystemPrompt } from "./planGoal";
import { DEFAULT_PLAN_LIMITS } from "./planGraph";

const noop = step$({
  id: "noop",
  name: "Noop",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  handler: handler$(async () => ({})),
});
const flow: RegisteredFlow<unknown, unknown> = {
  definition: flow$({
    id: "f",
    name: "f",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    steps: [noop],
  }),
  runner: async () => ({}),
};
const catalog = new CapabilityCatalog().register(
  capability$({
    id: "check-invoice",
    intent: "Rechnung prüfen",
    tags: [],
    inputSchema: z.object({}),
    flow,
  })
);

describe("planner prompts override (R19)", () => {
  it("the default system prompt is the English text plus the untrusted-content note", () => {
    const sys = plannerSystemPrompt(catalog, DEFAULT_PLAN_LIMITS);
    expect(
      sys.startsWith(
        `${DEFAULT_PLANNER_SYSTEM}
${UNTRUSTED_CONTENT_SYSTEM_NOTE}
At most ${DEFAULT_PLAN_LIMITS.maxNodes} steps.

Capabilities:
- check-invoice: Rechnung prüfen
  input: `
      )
    ).toBe(true);
  });

  it("planGoal sends the overridden texts, keeps the untrusted note, and the rejection line", async () => {
    const requests: LlmRequestInput[] = [];
    const replies = ["not json", '{"nodes":[{"id":"a","capabilityId":"check-invoice","args":{}}]}'];
    const ctx = {
      decide: async (_id: string, fn: (scope: never) => Promise<unknown>) => fn({} as never),
    };
    const plan = await planGoal(ctx as never, {
      goal: "Rechnung prüfen",
      catalog,
      model: async (_scope, request) => {
        requests.push(request);
        return { content: replies.shift() as string, stopReason: "end_turn" };
      },
      prompts: {
        system: "Du bist ein Planer. Antworte nur mit JSON.",
        maxSteps: (n) => `Höchstens ${n} Schritte.`,
        capabilities: "Fähigkeiten:",
        goal: "Ziel:",
        rejected: "Dein Plan wurde abgelehnt. Antworte nur mit JSON:",
      },
    });
    expect(plan.nodes).toHaveLength(1);
    const sys = requests[0]?.system;
    if (typeof sys !== "string") throw new Error("the planner system prompt is not plain text");
    expect(sys.startsWith("Du bist ein Planer.")).toBe(true);
    expect(sys).toContain(UNTRUSTED_CONTENT_SYSTEM_NOTE);
    expect(sys).toContain("Höchstens");
    expect(sys).toContain("Fähigkeiten:\n- check-invoice");
    expect(sys).not.toContain("You are a planner");
    expect(JSON.stringify(requests[0]?.messages)).toContain("Ziel:");
    expect(JSON.stringify(requests[1]?.messages)).toContain("Dein Plan wurde abgelehnt");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("Your previous plan");
  });
});
