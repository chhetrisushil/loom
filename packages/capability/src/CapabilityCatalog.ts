import type { ExecutionHandle, WorkflowRuntime } from "@loom/workflow-runtime";
import {
  type CapabilityDefinition,
  type CapabilityInvokeAuthorizer,
  CapabilityInvokeDeniedError,
} from "./types";

export interface CapabilityMatch {
  capability: CapabilityDefinition;
  score: number;
}

export interface CapabilityCatalogOptions {
  /** Optional invoke authorization (M7). When set, `invoke` denies unauthorized calls. */
  authorizer?: CapabilityInvokeAuthorizer;
}

// The "catalog/" of the proposal: a registry of capabilities that can be listed,
// keyword-searched (a deterministic fallback for intent matching), registered
// into a WorkflowRuntime, and invoked by id.
export class CapabilityCatalog {
  private readonly capabilities = new Map<string, CapabilityDefinition>();
  private readonly authorizer: CapabilityInvokeAuthorizer | undefined;

  constructor(options: CapabilityCatalogOptions = {}) {
    this.authorizer = options.authorizer;
  }

  // biome-ignore lint/suspicious/noExplicitAny: capabilities have heterogeneous in/out types; the registry stores them type-erased and re-narrows on lookup
  register(capability: CapabilityDefinition<any, any>): this {
    this.capabilities.set(capability.id, capability as CapabilityDefinition);
    return this;
  }

  /**
   * Resolve a capability's transitive dependencies (M7) into dependency-first
   * (topological) order, with the capability itself last. Throws on a missing
   * dependency or a dependency cycle.
   */
  resolve(id: string): CapabilityDefinition[] {
    const order: CapabilityDefinition[] = [];
    const done = new Set<string>();
    const stack = new Set<string>();
    const visit = (cid: string, path: string[]): void => {
      if (done.has(cid)) return;
      if (stack.has(cid)) {
        throw new Error(`Capability dependency cycle: ${[...path, cid].join(" -> ")}`);
      }
      const cap = this.capabilities.get(cid);
      if (cap === undefined) {
        const via = path.length > 0 ? ` (needed by "${path[path.length - 1]}")` : "";
        throw new Error(`Missing capability dependency: "${cid}"${via}`);
      }
      stack.add(cid);
      for (const dep of cap.dependencies ?? []) visit(dep, [...path, cid]);
      stack.delete(cid);
      done.add(cid);
      order.push(cap);
    };
    visit(id, []);
    return order;
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
  // When an authorizer is configured (M7), an unauthorized invoke is denied.
  async invoke<TIn = unknown>(
    workflowRuntime: WorkflowRuntime,
    capabilityId: string,
    input: TIn,
    opts?: { principal?: string }
  ): Promise<ExecutionHandle> {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      throw new Error(`No capability registered with id "${capabilityId}"`);
    }
    if (this.authorizer !== undefined) {
      const decision = this.authorizer.authorize({
        capabilityId,
        ...(opts?.principal !== undefined && { principal: opts.principal }),
        input,
      });
      if (!decision.allowed) {
        throw new CapabilityInvokeDeniedError(capabilityId, decision.reason ?? "not authorized");
      }
    }
    return workflowRuntime.start(capability.flow, input);
  }
}
