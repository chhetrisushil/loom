import type { AgentLoopConfig } from "@loomwork/agent";
import type { FlowSpec } from "@loomwork/verify";

/**
 * The slice of an `agentLoop$` config that decides which tools the loop can call. Wide on purpose
 * (ADR 0150 D9, S-R5): the model chooses at run time, so the static bound is the whole menu.
 */
export type AgentLoopReachConfig = Pick<
  AgentLoopConfig,
  | "definition"
  | "skills"
  | "toolSearch"
  | "modelToolId"
  | "reasoning"
  | "reasoningToolId"
  | "recall"
  | "writeBack"
  | "compaction"
>;

/**
 * The tool ids an `agentLoop$` can reach: its own tools, EVERY skill's tools, the `toolSearch` catalog,
 * and the ring-routed effects the loop itself calls (model, reasoning routes, recall, write-back,
 * compaction), without which a grant derived from this reach would deny the loop's own model call.
 */
export function agentLoopReach(config: AgentLoopReachConfig): string[] {
  const ids = new Set<string>(config.definition.tools.map((t) => t.id));
  for (const skill of config.skills?.all() ?? []) for (const t of skill.tools ?? []) ids.add(t.id);
  for (const t of config.toolSearch?.catalog ?? []) ids.add(t.id);
  const ring = (id: string | undefined): void => {
    if (id !== undefined) ids.add(id);
  };
  ring(config.modelToolId);
  const rid = config.reasoningToolId;
  if (typeof rid === "string") ring(rid);
  else if (rid !== undefined)
    for (const r of config.reasoning?.availableRoutes ?? []) ring(rid(r.id));
  ring(config.recall?.toolId);
  if (typeof config.writeBack === "object") ring((config.writeBack as { toolId?: string }).toolId);
  ring(config.compaction?.toolId);
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
  return reachDetailed(flows, flowId, edges).tools;
}

/** {@link reachFromFlows} plus the declared child flow ids that are not registered (a typo reads as no reach). */
export function reachDetailed(
  flows: readonly FlowSpec[],
  flowId: string,
  edges: ReachEdges = {}
): { tools: string[]; unknownChildren: string[] } {
  const byFlow = new Map(flows.map((f) => [f.id, f] as const));
  const tools = new Set<string>();
  const seen = new Set<string>();
  const unknown = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const e of byFlow.get(id)?.effects ?? []) tools.add(e.toolId);
    for (const cfg of own(edges.agentLoops, id) ?? [])
      for (const t of agentLoopReach(cfg)) tools.add(t);
    for (const child of own(edges.children, id) ?? []) {
      if (!byFlow.has(child)) unknown.add(child);
      walk(child);
    }
  };
  walk(flowId);
  return { tools: [...tools].sort(), unknownChildren: [...unknown].sort() };
}
