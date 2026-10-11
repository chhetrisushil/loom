import { CapabilityCatalog, capability$ } from "@loom/capability";
import { flow$, handler$, step$ } from "@loom/core";
import type { LlmProvider } from "@loom/llm";
import { ReasoningRuntime } from "@loom/reasoning";
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

  it("routes through the Reasoning Runtime when supplied", async () => {
    const provider: LlmProvider = {
      complete: async () => ({ content: "issue-refund", stopReason: "end_turn" }),
    };
    const reasoning = new ReasoningRuntime({ routes: [{ id: "primary", provider, tier: 0 }] });
    const rt = new IntentRuntime({ catalog: makeCatalog(), reasoning });
    const route = await rt.route("refund this order please");
    expect(route?.capability.id).toBe("issue-refund");
    expect(route?.rationale).toBe("model routed");
  });

  it("elevates inside reasoning when the cheap model is low-confidence", async () => {
    // Cheap model truncates (low confidence) → reasoning elevates to the stronger
    // model, whose answer is a valid capability id.
    const weak: LlmProvider = {
      complete: async () => ({ content: "unsure…", stopReason: "max_tokens" }),
    };
    const strong: LlmProvider = {
      complete: async () => ({ content: "investigate-incident", stopReason: "end_turn" }),
    };
    const reasoning = new ReasoningRuntime({
      routes: [
        { id: "gemma", provider: weak, tier: 0 },
        { id: "opus", provider: strong, tier: 1 },
      ],
    });
    const rt = new IntentRuntime({ catalog: makeCatalog(), reasoning });
    const route = await rt.route("we have a production incident");
    expect(route?.capability.id).toBe("investigate-incident");
    expect(route?.rationale).toBe("model routed");
  });

  it("uses the prompts override (R19) and the English default otherwise", async () => {
    const seen: { system?: string; user?: string }[] = [];
    const provider: LlmProvider = {
      complete: async (req) => {
        seen.push({
          ...(req.system !== undefined && { system: req.system }),
          user: String(req.messages[0]?.content),
        });
        return { content: "issue-refund", stopReason: "end_turn" };
      },
    };
    await new IntentRuntime({ catalog: makeCatalog(), provider }).route("Rechnung erstatten");
    expect(seen[0]?.system).toContain("You route a user's request");
    expect(seen[0]?.user).toContain("Request: Rechnung erstatten");

    const rt = new IntentRuntime({
      catalog: makeCatalog(),
      provider,
      prompts: {
        system:
          "Leite die Anfrage an genau eine Fähigkeit weiter. Antworte NUR mit der ID oder NONE.",
        user: ({ intentText, menu }) => `Fähigkeiten:\n${menu}\n\nAnfrage: ${intentText}`,
      },
    });
    const route = await rt.route("Rechnung erstatten");
    expect(route?.capability.id).toBe("issue-refund");
    expect(seen[1]?.system).toContain("Leite die Anfrage");
    expect(seen[1]?.user).toContain("Anfrage: Rechnung erstatten");
    expect(seen[1]?.user).toContain("- issue-refund:");
  });
});
