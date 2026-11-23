import type { WorkflowRuntime } from "@loomwork/workflow-runtime";
import { type ReachEdges, reachFromFlows } from "./reachCore";
import { type VerifyAdapterInputs, resolveVerifyInput } from "./verifyAdapter";

export interface ReachOfOptions extends ReachEdges {
  /** The same inputs `resolveVerifyInput` takes (runner-body reach, declared reach). */
  readonly inputs?: VerifyAdapterInputs;
}

/**
 * The effect tool ids a flow can reach (ADR 0150 D9, S-R5): its steps, `reachableTools`, runner-body
 * and declared reach (via `resolveVerifyInput`), the reach of every child flow, and the reach of every
 * declared `agentLoop$`. Sorted and de-duplicated. An unknown flow id reaches nothing.
 */
export function reachOf(
  runtime: WorkflowRuntime,
  flowId: string,
  options: ReachOfOptions = {}
): string[] {
  return reachFromFlows(resolveVerifyInput(runtime, options.inputs).flows, flowId, options);
}
