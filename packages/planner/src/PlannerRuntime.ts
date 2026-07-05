import type { CapabilityCatalog } from "@loom/capability";
import type { LlmProvider } from "@loom/llm";
import { Priority } from "@loom/scheduler";
import type { Scheduler } from "@loom/scheduler";

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
  maxSteps?: number;
  // Optional shared scheduler. When supplied, the planning LLM call runs at Idle
  // priority so it yields to live agent/workflow work under a concurrency cap.
  // No effect on output — planning is offline-safe and order-independent.
  scheduler?: Scheduler;
}

// The proposal's Planner Runtime: given a goal, selects and orders the
// capabilities needed to achieve it. The resulting Plan is a list of capability
// invocations the Workflow Runtime can execute in sequence.
export class PlannerRuntime {
  constructor(private readonly config: PlannerRuntimeConfig) {}

  async plan(goal: string): Promise<Plan> {
    const maxSteps = this.config.maxSteps ?? 5;

    if (this.config.provider !== undefined) {
      const llmPlan = await this.planWithLlm(goal, maxSteps);
      if (llmPlan.steps.length > 0) return llmPlan;
    }
    return this.planWithHeuristic(goal, maxSteps);
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

    // Guarded by the `provider !== undefined` check at the sole call site.
    const complete = () =>
      this.config.provider!.complete({
        system:
          "You are a planner. Given a goal and a list of capabilities, output an " +
          'ordered plan as a JSON array of objects { "capabilityId": string, ' +
          '"rationale": string }. Use only ids from the list. Output JSON only.',
        messages: [{ role: "user", content: `Goal: ${goal}\n\nCapabilities:\n${menu}` }],
      });

    const response =
      this.config.scheduler !== undefined
        ? await this.config.scheduler.schedule(() => complete(), {
            priority: Priority.Idle,
            label: "planner.plan",
          })
        : await complete();

    const steps = this.parseSteps(response.content).slice(0, maxSteps);
    return { goal, steps };
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
