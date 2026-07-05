import type { ExecutionHandle, WorkflowRuntime } from "@loom/workflow-runtime";
import type { CapabilityDefinition } from "./types";

export interface CapabilityMatch {
  capability: CapabilityDefinition;
  score: number;
}

// The "catalog/" of the proposal: a registry of capabilities that can be listed,
// keyword-searched (a deterministic fallback for intent matching), registered
// into a WorkflowRuntime, and invoked by id.
export class CapabilityCatalog {
  private readonly capabilities = new Map<string, CapabilityDefinition>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(capability: CapabilityDefinition<any, any>): this {
    this.capabilities.set(capability.id, capability as CapabilityDefinition);
    return this;
  }

  get(id: string): CapabilityDefinition | undefined {
    return this.capabilities.get(id);
  }

  all(): CapabilityDefinition[] {
    return [...this.capabilities.values()];
  }

  ids(): string[] {
    return [...this.capabilities.keys()];
  }

  // Deterministic keyword scoring over id/name/intent/tags. Used as the offline
  // fallback for intent routing and planning when no LLM provider is supplied.
  find(query: string): CapabilityMatch[] {
    const terms = query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2);
    const matches: CapabilityMatch[] = [];
    for (const capability of this.capabilities.values()) {
      const haystack = [capability.id, capability.name, capability.intent, ...capability.tags]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score++;
      }
      if (score > 0) matches.push({ capability, score });
    }
    return matches.sort((a, b) => b.score - a.score);
  }

  // Register every capability's flow into a WorkflowRuntime so they can run.
  registerInto(workflowRuntime: WorkflowRuntime): void {
    for (const capability of this.capabilities.values()) {
      workflowRuntime.registerFlow(capability.flow.definition, capability.flow.runner);
    }
  }

  // Invoke a capability by id — capability-as-API / capability-as-workflow-node.
  async invoke<TIn = unknown>(
    workflowRuntime: WorkflowRuntime,
    capabilityId: string,
    input: TIn
  ): Promise<ExecutionHandle> {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      throw new Error(`No capability registered with id "${capabilityId}"`);
    }
    return workflowRuntime.start(capability.flow, input);
  }
}
