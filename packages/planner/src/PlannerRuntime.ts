import type { CapabilityCatalog } from "@loom/capability";
import type { LlmProvider } from "@loom/llm";
import type { ReasoningRuntime } from "@loom/reasoning";
import { Priority } from "@loom/scheduler";
import type { Scheduler } from "@loom/scheduler";
import type { ExecutionContext } from "@loom/workflow-runtime";
import { PlanFailedError, type PlanGoalInput, planGoal } from "./planGoal";
import type { PlanGraph } from "./planGraph";

export interface PlanStep {
  capabilityId: string;
  rationale?: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
}

export interface PlannerRuntimeConfig {
  catalog: CapabilityCatalog;
  // When supplied, the model composes an ordered plan from the catalog;
  // otherwise a deterministic heuristic (keyword-ranked capabilities) is used so
  // the Planner Runtime works fully offline.
  provider?: LlmProvider;
  // Preferred over `provider`: routes planning through the Reasoning Runtime for
  // model routing + confidence-based elevation. Falls back to `provider`, then the
  // offline heuristic.
  reasoning?: ReasoningRuntime;
  maxSteps?: number;
  // Optional shared scheduler. When supplied, the planning LLM call runs at Idle
  // priority so it yields to live agent/workflow work under a concurrency cap.
  // No effect on output — planning is offline-safe and order-independent.
  scheduler?: Scheduler;
  /**
   * R16 — fail closed instead of falling back. Default `false` (the original behaviour: an
   * unparseable or empty model answer silently becomes the keyword heuristic's plan). With
   * `strict: true`, `plan()` throws {@link PlanFailedError} when a configured model yields no
   * usable steps — the fallback is then never taken. Prefer {@link PlannerRuntime.planGraph},
   * which is journaled and has no silent fallback at all.
   */
  strict?: boolean;
}

// The proposal's Planner Runtime: given a goal, selects and orders the
// capabilities needed to achieve it. The resulting Plan is a list of capability
// invocations the Workflow Runtime can execute in sequence.
export class PlannerRuntime {
  constructor(private readonly config: PlannerRuntimeConfig) {}

  /**
   * The original flat plan: an ordered list of capability ids. NOT journaled, no arguments, no edges.
   * Kept unchanged for existing callers (`dispatchPlan`); new code should use {@link planGraph}.
   */
  async plan(goal: string): Promise<Plan> {
    const maxSteps = this.config.maxSteps ?? 5;

    if (this.config.reasoning !== undefined || this.config.provider !== undefined) {
      const llmPlan = await this.planWithLlm(goal, maxSteps);
      if (llmPlan.steps.length > 0) return llmPlan;
      if (this.config.strict === true) {
        throw new PlanFailedError("unparseable", 1, [], "the model returned no usable steps");
      }
    }
    return this.planWithHeuristic(goal, maxSteps);
  }

  /**
   * R16 — plan a goal as a validated DAG with arguments and `$from` bindings, journaled through
   * `ctx.decide` (one model call, served on replay; typed failure, no silent fallback). Execute it
   * with `executePlan`. Uses this runtime's catalog.
   */
  planGraph(
    ctx: Pick<ExecutionContext, "decide">,
    input: Omit<PlanGoalInput, "catalog">
  ): Promise<PlanGraph> {
    return planGoal(ctx, { ...input, catalog: this.config.catalog });
  }

  private planWithHeuristic(goal: string, maxSteps: number): Plan {
    const matches = this.config.catalog.find(goal).slice(0, maxSteps);
    return {
      goal,
      steps: matches.map((m) => ({
        capabilityId: m.capability.id,
        rationale: `matched goal (score ${m.score})`,
      })),
    };
  }

  private async planWithLlm(goal: string, maxSteps: number): Promise<Plan> {
    const menu = this.config.catalog
      .all()
      .map((c) => `- ${c.id}: ${c.intent}`)
      .join("\n");

    const system =
      "You are a planner. Given a goal and a list of capabilities, output an " +
      'ordered plan as a JSON array of objects { "capabilityId": string, ' +
      '"rationale": string }. Use only ids from the list. Output JSON only.';
    const userContent = `Goal: ${goal}\n\nCapabilities:\n${menu}`;
    const content = await this.complete(system, userContent);

    const steps = this.parseSteps(content).slice(0, maxSteps);
    return { goal, steps };
  }

  // Prefer the Reasoning Runtime (routing + elevation); fall back to a bare provider.
  // Guarded by the reasoning/provider check at the sole call site.
  private async complete(system: string, userContent: string): Promise<string> {
    const call: () => Promise<string> =
      this.config.reasoning !== undefined
        ? async () =>
            (
              await this.config.reasoning!.reason({
                system,
                strategy: "planning",
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
      ? this.config.scheduler.schedule(() => call(), {
          priority: Priority.Idle,
          label: "planner.plan",
        })
      : call();
  }

  private parseSteps(content: string): PlanStep[] {
    const validIds = new Set(this.config.catalog.ids());
    try {
      const start = content.indexOf("[");
      const end = content.lastIndexOf("]");
      if (start === -1 || end === -1) return [];
      const parsed = JSON.parse(content.slice(start, end + 1)) as Array<{
        capabilityId?: unknown;
        rationale?: unknown;
      }>;
      const steps: PlanStep[] = [];
      for (const item of parsed) {
        const id = typeof item.capabilityId === "string" ? item.capabilityId : undefined;
        if (id !== undefined && validIds.has(id)) {
          steps.push({
            capabilityId: id,
            ...(typeof item.rationale === "string" && { rationale: item.rationale }),
          });
        }
      }
      return steps;
    } catch {
      return [];
    }
  }
}
