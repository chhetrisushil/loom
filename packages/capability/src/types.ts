import type { ZodSchema } from "zod";
import type { RegisteredFlow } from "@loom/workflow-runtime";

// A capability is the proposal's unit of application composition: a runnable
// flow wrapped with intent-facing metadata so it can be exposed uniformly as an
// API, a UI action, an A2A endpoint, or a workflow node. Examples:
// "investigate-incident", "scale-cluster", "issue-refund".
export interface CapabilityDefinition<TIn = unknown, TOut = unknown> {
  readonly _tag: "CapabilityDefinition";
  id: string;
  name: string;
  // Natural-language description of the goal this capability fulfils. Used by
  // the Intent and Planner runtimes to match user intent to a capability.
  intent: string;
  tags: string[];
  inputSchema: ZodSchema<TIn>;
  flow: RegisteredFlow<TIn, TOut>;
}
