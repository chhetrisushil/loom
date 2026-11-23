import type { AgentLoopConfig } from "@loomwork/agent";
import type { WorkflowRuntime } from "@loomwork/workflow-runtime";
import { type VerifyAdapterInputs, resolveVerifyInput } from "./verifyAdapter";

/**
 * The slice of an `agentLoop$` config that decides which tools the loop can call. Wide on purpose
 * (ADR 0150 D9, S-R5): the model chooses at run time, so the static bound is the whole menu.
 */
export type AgentLoopReachConfig = Pick<AgentLoopConfig, "definition" | "skills" | "toolSearch">;

/** The tool ids an `agentLoop$` can reach: its own tools, EVERY skill's tools, and the `toolSearch` catalog. */
export function agentLoopReach(config: AgentLoopReachConfig): string[] {
  const ids = new Set<string>(config.definition.tools.map((t) => t.id));
  for (const skill of config.skills?.all() ?? []) for (const t of skill.tools ?? []) ids.add(t.id);
  for (const t of config.toolSearch?.catalog ?? []) ids.add(t.id);
  return [...ids].sort();
}

export interface ReachOfOptions {
  /** The same inputs `resolveVerifyInput` takes (runner-body reach, declared reach). */
  readonly inputs?: VerifyAdapterInputs;
  /**
   * flow id -> the flow ids it spawns as children. A child is started by id at run time, so the
   * definition does not name it; the app declares the edges. Followed transitively (cycles are fine).
   */
  readonly children?: Readonly<Record<string, readonly string[]>>;
  /** flow id -> the `agentLoop$` configs its runner body calls. Each contributes {@link agentLoopReach}. */
  readonly agentLoops?: Readonly<Record<string, readonly AgentLoopReachConfig[]>>;
}

const own = <T>(rec: Readonly<Record<string, T>> | undefined, k: string): T | undefined =>
  rec !== undefined && Object.hasOwn(rec, k) ? rec[k] : undefined;

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
  const byFlow = new Map(
    resolveVerifyInput(runtime, options.inputs).flows.map((f) => [f.id, f] as const)
  );
  const tools = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const e of byFlow.get(id)?.effects ?? []) tools.add(e.toolId);
    for (const cfg of own(options.agentLoops, id) ?? [])
      for (const t of agentLoopReach(cfg)) tools.add(t);
    for (const child of own(options.children, id) ?? []) walk(child);
  };
  walk(flowId);
  return [...tools].sort();
}
