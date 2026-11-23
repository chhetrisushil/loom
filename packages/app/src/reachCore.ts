import type { AgentLoopConfig } from "@loomwork/agent";
import type { FlowSpec } from "@loomwork/verify";

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

/** The app-declared edges `reachOf` follows beyond a flow's own definition. */
export interface ReachEdges {
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

/** Sorted, de-duplicated effect tool ids reachable from `flowId` over already-resolved flow specs. */
export function reachFromFlows(
  flows: readonly FlowSpec[],
  flowId: string,
  edges: ReachEdges = {}
): string[] {
  const byFlow = new Map(flows.map((f) => [f.id, f] as const));
  const tools = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const e of byFlow.get(id)?.effects ?? []) tools.add(e.toolId);
    for (const cfg of own(edges.agentLoops, id) ?? [])
      for (const t of agentLoopReach(cfg)) tools.add(t);
    for (const child of own(edges.children, id) ?? []) walk(child);
  };
  walk(flowId);
  return [...tools].sort();
}
