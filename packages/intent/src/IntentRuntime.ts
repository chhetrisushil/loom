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

/**
 * R19 - the router's fixed English prompt text, overridable. Defaults are the English text, so
 * omitting this changes nothing. A replacement `system` must still ask for ONLY a capability id (or
 * `NONE`), because the reply's first whitespace-separated word is matched against the catalog (a lone
 * capability id named elsewhere in the reply is also accepted; a `NONE` first word is final).
 */
export interface IntentRuntimePrompts {
  /** Replaces the system prompt. */
  system?: string;
  /** Builds the user message from the request and the capability menu (`- id: intent` lines). */
  user?: (args: { intentText: string; menu: string }) => string;
}

export interface IntentRuntimeConfig {
  catalog: CapabilityCatalog;
  // Optional. When supplied, intent → capability routing is done by the model, and the
  // model's answer is FINAL: NONE, an unusable reply or an ambiguous one routes nowhere
  // (`route()` returns null); there is no keyword guess after a model has answered.
  // Only when NO model is configured is a deterministic keyword matcher over the catalog
  // used, so the Intent Runtime works fully offline.
  provider?: LlmProvider;
  // Optional. Preferred over `provider`: routes the LLM call through the Reasoning
  // Runtime, gaining model routing + confidence-based elevation for free. Falls
  // back to `provider`; with neither, the offline keyword matcher is used.
  reasoning?: ReasoningRuntime;
  workflowRuntime?: WorkflowRuntime;
  // Optional shared scheduler. When supplied, the routing LLM call runs at Idle
  // priority so it yields to live work under a concurrency cap. No effect on the
  // routing decision.
  scheduler?: Scheduler;
  /** R19 - override the fixed English prompt text. */
  prompts?: IntentRuntimePrompts;
}

/** Why `routeExplained` returned what it did. */
export type IntentRouteReason =
  | "model-routed"
  | "model-none" // the model answered NONE: nothing fits (final)
  | "model-unparseable" // the reply named no capability id and was not NONE
  | "model-ambiguous" // the reply named two or more different capability ids
  | "keyword-match" // no model configured: the offline keyword matcher found a capability
  | "keyword-no-match" // no model configured: the keyword matcher found nothing
  | "empty-catalog";

export interface IntentRouteOutcome {
  route: IntentRoute | null;
  reason: IntentRouteReason;
}

const NONE_WORD = /^none$/i;
// Surrounding quotes, backticks, markdown emphasis, brackets and sentence punctuation. `-` and `_` are
// kept: capability ids contain them.
const EDGE_NOISE = /^[^\p{L}\p{N}_-]+|[^\p{L}\p{N}_-]+$/gu;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The proposal's Intent Runtime: turns a natural-language goal into a concrete
// capability (intent understanding + routing), then optionally starts it.
export class IntentRuntime {
  constructor(private readonly config: IntentRuntimeConfig) {}

  /**
   * Route an intent to a capability, or null. With a model (`reasoning` or `provider`) configured the
   * model's answer is final: NONE or an unusable reply yields null, never a keyword guess. The keyword
   * matcher runs only when no model is configured. A model/provider error propagates (fail closed; it is
   * not read as "nothing fits" and not papered over with a keyword guess).
   */
  async route(intentText: string): Promise<IntentRoute | null> {
    return (await this.routeExplained(intentText)).route;
  }

  /** `route()` plus the reason, so a caller can tell "the model said NONE" from "the reply was unusable". */
  async routeExplained(intentText: string): Promise<IntentRouteOutcome> {
    const capabilities = this.config.catalog.all();
    if (capabilities.length === 0) return { route: null, reason: "empty-catalog" };

    if (this.config.reasoning !== undefined || this.config.provider !== undefined) {
      return this.routeWithLlm(intentText, capabilities);
    }
    const route = this.routeWithKeywords(intentText);
    return { route, reason: route === null ? "keyword-no-match" : "keyword-match" };
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
  ): Promise<IntentRouteOutcome> {
    const menu = capabilities.map((c) => `- ${c.id}: ${c.intent}`).join("\n");
    const system =
      this.config.prompts?.system ??
      "You route a user's request to exactly one capability. Reply with ONLY the " +
        "capability id from the list, or the word NONE if nothing fits.";
    const userContent =
      this.config.prompts?.user?.({ intentText, menu }) ??
      `Capabilities:\n${menu}\n\nRequest: ${intentText}`;
    const content = await this.complete(system, userContent, "intent.route", "routing");

    return this.parseReply(content, capabilities);
  }

  /**
   * Parse the model's reply. In order: (1) the first whitespace token is a capability id, exactly or after
   * stripping surrounding quotes/backticks/punctuation -> that capability; (2) that stripped token is
   * `none` (any case, e.g. `NONE.`, ` none `, `None of these fit`) -> NONE, final; (3) otherwise every
   * capability id appearing in the reply as a whole token (not inside a longer id) is collected: exactly
   * one distinct id -> that capability; two or more -> ambiguous, no route; zero -> unparseable, no route.
   */
  private parseReply(content: string, capabilities: CapabilityDefinition[]): IntentRouteOutcome {
    const reply = content.trim();
    const first = reply.split(/\s+/)[0] ?? "";
    const stripped = first.replace(EDGE_NOISE, "");
    const direct =
      capabilities.find((c) => c.id === first) ?? capabilities.find((c) => c.id === stripped);
    if (direct !== undefined) return this.modelRoute(direct);
    if (NONE_WORD.test(stripped)) return { route: null, reason: "model-none" };

    const found = capabilities.filter((c) =>
      new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(c.id)}(?![\\p{L}\\p{N}_-])`, "u").test(reply)
    );
    if (found.length === 1) return this.modelRoute(found[0] as CapabilityDefinition);
    return { route: null, reason: found.length === 0 ? "model-unparseable" : "model-ambiguous" };
  }

  private modelRoute(capability: CapabilityDefinition): IntentRouteOutcome {
    return {
      route: { capability, confidence: 1, rationale: "model routed" },
      reason: "model-routed",
    };
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
