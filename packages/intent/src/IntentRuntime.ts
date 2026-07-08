import type { CapabilityCatalog, CapabilityDefinition } from "@loom/capability";
import type { LlmProvider } from "@loom/llm";
import type { ReasoningRuntime } from "@loom/reasoning";
import { Priority } from "@loom/scheduler";
import type { Scheduler } from "@loom/scheduler";
import type { ExecutionHandle, WorkflowRuntime } from "@loom/workflow-runtime";

export interface IntentRoute {
  capability: CapabilityDefinition;
  confidence: number;
  rationale?: string;
}

export interface IntentRuntimeConfig {
  catalog: CapabilityCatalog;
  // Optional. When supplied, intent → capability routing is done by the model;
  // otherwise a deterministic keyword matcher over the catalog is used so the
  // Intent Runtime works fully offline.
  provider?: LlmProvider;
  // Optional. Preferred over `provider`: routes the LLM call through the Reasoning
  // Runtime, gaining model routing + confidence-based elevation for free. Falls
  // back to `provider`, then to the offline keyword matcher.
  reasoning?: ReasoningRuntime;
  workflowRuntime?: WorkflowRuntime;
  // Optional shared scheduler. When supplied, the routing LLM call runs at Idle
  // priority so it yields to live work under a concurrency cap. No effect on the
  // routing decision.
  scheduler?: Scheduler;
}

// The proposal's Intent Runtime: turns a natural-language goal into a concrete
// capability (intent understanding + routing), then optionally starts it.
export class IntentRuntime {
  constructor(private readonly config: IntentRuntimeConfig) {}

  async route(intentText: string): Promise<IntentRoute | null> {
    const capabilities = this.config.catalog.all();
    if (capabilities.length === 0) return null;

    if (this.config.reasoning !== undefined || this.config.provider !== undefined) {
      const llmRoute = await this.routeWithLlm(intentText, capabilities);
      if (llmRoute !== null) return llmRoute;
    }
    return this.routeWithKeywords(intentText);
  }

  // Route + start the selected capability's flow in one call.
  async run(intentText: string, input: unknown): Promise<ExecutionHandle> {
    if (this.config.workflowRuntime === undefined) {
      throw new Error("IntentRuntime.run requires a workflowRuntime in its config");
    }
    const route = await this.route(intentText);
    if (route === null) {
      throw new Error(`No capability matched intent: "${intentText}"`);
    }
    return this.config.workflowRuntime.start(route.capability.flow, input);
  }

  private routeWithKeywords(intentText: string): IntentRoute | null {
    const matches = this.config.catalog.find(intentText);
    const best = matches[0];
    if (best === undefined) return null;
    const total = matches.reduce((sum, m) => sum + m.score, 0);
    return {
      capability: best.capability,
      confidence: total > 0 ? best.score / total : 0,
      rationale: "keyword match",
    };
  }

  private async routeWithLlm(
    intentText: string,
    capabilities: CapabilityDefinition[]
  ): Promise<IntentRoute | null> {
    const menu = capabilities.map((c) => `- ${c.id}: ${c.intent}`).join("\n");
    const system =
      "You route a user's request to exactly one capability. Reply with ONLY the " +
      "capability id from the list, or the word NONE if nothing fits.";
    const userContent = `Capabilities:\n${menu}\n\nRequest: ${intentText}`;
    const content = await this.complete(system, userContent, "intent.route", "routing");

    const chosen = content.trim().split(/\s+/)[0] ?? "";
    const capability = capabilities.find((c) => c.id === chosen);
    if (capability === undefined) return null;
    return { capability, confidence: 1, rationale: "model routed" };
  }

  // Prefer the Reasoning Runtime (routing + elevation); fall back to a bare provider.
  // Either is optionally scheduled at Idle priority so it yields to live work.
  // Guarded by the reasoning/provider check at the sole call site.
  private async complete(
    system: string,
    userContent: string,
    label: string,
    strategy: string
  ): Promise<string> {
    const call: () => Promise<string> =
      this.config.reasoning !== undefined
        ? async () =>
            (
              await this.config.reasoning!.reason({
                system,
                strategy,
                messages: [{ role: "user", content: userContent }],
              })
            ).content
        : async () =>
            (
              await this.config.provider!.complete({
                system,
                messages: [{ role: "user", content: userContent }],
              })
            ).content;

    return this.config.scheduler !== undefined
      ? this.config.scheduler.schedule(() => call(), { priority: Priority.Idle, label })
      : call();
  }
}
