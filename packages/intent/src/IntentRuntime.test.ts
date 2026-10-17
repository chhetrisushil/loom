import { CapabilityCatalog, capability$ } from "@loom/capability";
import { flow$, handler$, step$ } from "@loom/core";
import type { LlmProvider } from "@loom/llm";
import { ReasoningRuntime } from "@loom/reasoning";
import type { FlowRunner, RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
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

  const replying = (content: string): LlmProvider => ({
    complete: async () => ({ content, stopReason: "end_turn" }),
  });
  // Keywords WOULD match this request ("investigate", "incident"), so any null below is the model's, not the matcher's.
  const KEYWORD_BAIT = "investigate the incident";

  it("a model NONE is final: no keyword fallback, and run() throws", async () => {
    const rt = new IntentRuntime({ catalog: makeCatalog(), provider: replying("NONE") });
    expect(await rt.route(KEYWORD_BAIT)).toBeNull();
    expect((await rt.routeExplained(KEYWORD_BAIT)).reason).toBe("model-none");
    // sanity: with no model the same request keyword-routes
    expect(
      (await new IntentRuntime({ catalog: makeCatalog() }).route(KEYWORD_BAIT))?.capability.id
    ).toBe("investigate-incident");
    const workflowRuntime = {
      start: () => {
        throw new Error("must not start");
      },
    } as unknown as WorkflowRuntime;
    const withRuntime = new IntentRuntime({
      catalog: makeCatalog(),
      provider: replying("NONE"),
      workflowRuntime,
    });
    await expect(withRuntime.run(KEYWORD_BAIT, {})).rejects.toThrow("No capability matched intent");
  });

  it.each([
    "NONE.",
    " none ",
    "None",
    "`NONE`",
    '"none"',
    "**NONE**",
    "None of these fit.",
    "none\n",
  ])("NONE variant %j is final", async (reply) => {
    const rt = new IntentRuntime({ catalog: makeCatalog(), provider: replying(reply) });
    expect(await rt.route(KEYWORD_BAIT)).toBeNull();
    expect((await rt.routeExplained(KEYWORD_BAIT)).reason).toBe("model-none");
  });

  it("NONE is final through the Reasoning Runtime too", async () => {
    const provider = replying("NONE");
    const reasoning = new ReasoningRuntime({ routes: [{ id: "primary", provider, tier: 0 }] });
    const rt = new IntentRuntime({ catalog: makeCatalog(), reasoning });
    expect(await rt.route(KEYWORD_BAIT)).toBeNull();
  });

  it("finds a lone capability id named anywhere in the reply", async () => {
    for (const reply of [
      "The best fit is issue-refund.",
      "`issue-refund`",
      '"issue-refund".',
      "issue-refund: it is a refund",
    ]) {
      const rt = new IntentRuntime({ catalog: makeCatalog(), provider: replying(reply) });
      const route = await rt.route(KEYWORD_BAIT);
      expect(route?.capability.id, reply).toBe("issue-refund");
      expect(route?.rationale).toBe("model routed");
    }
  });

  it("an id inside a longer token is not a match", async () => {
    const rt = new IntentRuntime({
      catalog: makeCatalog(),
      provider: replying("not-issue-refund-at-all"),
    });
    expect(await rt.route(KEYWORD_BAIT)).toBeNull();
  });

  it("a first-token exact id wins over later mentions", async () => {
    const rt = new IntentRuntime({
      catalog: makeCatalog(),
      provider: replying("issue-refund (not investigate-incident)"),
    });
    expect((await rt.route(KEYWORD_BAIT))?.capability.id).toBe("issue-refund");
  });

  it("a reply naming two different ids is ambiguous: no route", async () => {
    const rt = new IntentRuntime({
      catalog: makeCatalog(),
      provider: replying("It is either issue-refund or investigate-incident."),
    });
    expect(await rt.route(KEYWORD_BAIT)).toBeNull();
    expect((await rt.routeExplained(KEYWORD_BAIT)).reason).toBe("model-ambiguous");
  });

  it("a garbage reply routes nowhere, even though keywords would match", async () => {
    const rt = new IntentRuntime({
      catalog: makeCatalog(),
      provider: replying("Hmm, hard to say."),
    });
    expect(await rt.route(KEYWORD_BAIT)).toBeNull();
    expect((await rt.routeExplained(KEYWORD_BAIT)).reason).toBe("model-unparseable");
    const empty = new IntentRuntime({ catalog: makeCatalog(), provider: replying("") });
    expect(await empty.route(KEYWORD_BAIT)).toBeNull();
  });

  it("a provider error propagates (no keyword fallback)", async () => {
    const provider: LlmProvider = {
      complete: async () => {
        throw new Error("boom");
      },
    };
    const rt = new IntentRuntime({ catalog: makeCatalog(), provider });
    await expect(rt.route(KEYWORD_BAIT)).rejects.toThrow("boom");
  });

  it("routeExplained reports keyword reasons when no model is configured", async () => {
    const rt = new IntentRuntime({ catalog: makeCatalog() });
    expect((await rt.routeExplained(KEYWORD_BAIT)).reason).toBe("keyword-match");
    expect((await rt.routeExplained("xyzzy plugh")).reason).toBe("keyword-no-match");
    expect(
      (await new IntentRuntime({ catalog: new CapabilityCatalog() }).routeExplained("x")).reason
    ).toBe("empty-catalog");
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
