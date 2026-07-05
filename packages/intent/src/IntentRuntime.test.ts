import { CapabilityCatalog, capability$ } from "@loom/capability";
import { flow$, handler$, step$ } from "@loom/core";
import type { LlmProvider } from "@loom/llm";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IntentRuntime } from "./IntentRuntime";

const noopStep = step$({
  id: "noop",
  name: "Noop",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  handler: handler$(async () => ({ ok: true })),
});
const noopRunner: FlowRunner<{ text: string }, { ok: boolean }> = (ctx, input) =>
  ctx.run(noopStep, { text: input.text });
const makeFlow = (id: string): RegisteredFlow<{ text: string }, { ok: boolean }> => ({
  definition: flow$({
    id,
    name: id,
    version: "1.0.0",
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    steps: [noopStep],
  }),
  runner: noopRunner,
});

function makeCatalog(): CapabilityCatalog {
  return new CapabilityCatalog()
    .register(
      capability$({
        id: "investigate-incident",
        intent: "Investigate a production incident and recommend remediation",
        tags: ["incident", "sre"],
        inputSchema: z.object({ text: z.string() }),
        flow: makeFlow("investigate-incident"),
      })
    )
    .register(
      capability$({
        id: "issue-refund",
        intent: "Issue a refund to a customer for an order",
        tags: ["billing", "refund"],
        inputSchema: z.object({ text: z.string() }),
        flow: makeFlow("issue-refund"),
      })
    );
}

describe("IntentRuntime", () => {
  it("routes by keywords when no provider is configured", async () => {
    const rt = new IntentRuntime({ catalog: makeCatalog() });
    const route = await rt.route("please refund this customer's order");
    expect(route?.capability.id).toBe("issue-refund");
    expect(route?.rationale).toBe("keyword match");
  });

  it("routes with the LLM provider when supplied", async () => {
    const provider: LlmProvider = {
      complete: async () => ({ content: "investigate-incident", stopReason: "end_turn" }),
    };
    const rt = new IntentRuntime({ catalog: makeCatalog(), provider });
    const route = await rt.route("the database is on fire");
    expect(route?.capability.id).toBe("investigate-incident");
    expect(route?.rationale).toBe("model routed");
  });

  it("falls back to keywords if the model returns an unknown id", async () => {
    const provider: LlmProvider = {
      complete: async () => ({ content: "NONE", stopReason: "end_turn" }),
    };
    const rt = new IntentRuntime({ catalog: makeCatalog(), provider });
    const route = await rt.route("investigate the incident");
    expect(route?.capability.id).toBe("investigate-incident");
    expect(route?.rationale).toBe("keyword match");
  });

  it("returns null when nothing matches", async () => {
    const rt = new IntentRuntime({ catalog: makeCatalog() });
    expect(await rt.route("xyzzy plugh")).toBeNull();
  });
});
