import type { DispatchMetadata, ExecutionDispatcher } from "@loom/dispatcher";
import type { BranchRegistry } from "@loom/event-runtime";
import { parallelLimit } from "@loom/scheduler";
import type { ExecutionPackage, ExecutionResult } from "@loom/worker-runtime";

/** One node of the execution graph — an independent sub-execution. */
export interface GraphNode {
  /** Logical id within the graph (e.g. "metrics", "logs", "queries"). */
  id: string;
  /** The flow this node runs (resolved by id on whatever instance serves it). */
  flowId: string;
  input?: unknown;
  /** Placement hints for this node's dispatch (sizing, lane, …). */
  metadata?: DispatchMetadata;
}

export interface ExecuteGraphOptions {
  /**
   * The graph's root execution. When set (with `branchRegistry`), each node is
   * recorded as a lineage child of it, so the parent can enumerate its branches
   * via `branchRegistry.children(parentExecutionId)` — the join surface.
   */
  parentExecutionId?: string;
  /** Max branches in flight at once. Defaults to all (full fan-out). */
  limit?: number;
  /** Records parent→child lineage for the join. */
  branchRegistry?: BranchRegistry;
  /** Derive a node's executionId. Default: `${parent ?? "graph"}:${node.id}`. */
  executionIdFor?: (node: GraphNode) => string;
}

export interface GraphNodeResult {
  id: string;
  executionId: string;
  result: ExecutionResult;
}

export interface GraphExecution {
  nodes: GraphNodeResult[];
  byId: Record<string, ExecutionResult>;
  /** True when every node reached a `completed` outcome. */
  completed: boolean;
}

/**
 * Run an execution graph as a fan-out of independent sub-executions and join.
 *
 * Each node becomes its OWN execution (distinct executionId) dispatched through
 * the {@link ExecutionDispatcher}, so placement is free (in-process, or one Cloud
 * Run instance per node) and — critically — every execution has exactly one
 * writer. This is the deliberate alternative to multi-writing a single
 * execution's event log, which would break the ExecutionJournal single-allocator
 * invariant. The "graph" relationship lives in the BranchRegistry (lineage), not
 * in a shared, concurrently-written log.
 *
 * The join is the barrier: results are returned only once all branches settle.
 */
export async function executeGraph(
  dispatcher: ExecutionDispatcher,
  nodes: GraphNode[],
  options: ExecuteGraphOptions = {}
): Promise<GraphExecution> {
  const parent = options.parentExecutionId;
  const idFor = options.executionIdFor ?? ((n: GraphNode) => `${parent ?? "graph"}:${n.id}`);

  const nodeResults = await parallelLimit(
    nodes.map((node) => async (): Promise<GraphNodeResult> => {
      const executionId = idFor(node);
      if (options.branchRegistry && parent) {
        // forkSequence 0 = spawned at the graph root (these are independent
        // sub-executions, not speculative same-flow forks, but the lineage DAG
        // gives us the parent→children join for free).
        await options.branchRegistry.recordLineage({
          executionId,
          parentExecutionId: parent,
          forkSequence: 0,
        });
      }
      const pkg: ExecutionPackage = {
        executionId,
        workflowId: node.flowId,
        flowId: node.flowId,
        ...(node.input !== undefined && { input: node.input }),
        ...(node.metadata !== undefined && { metadata: node.metadata as Record<string, unknown> }),
      };
      const result = await dispatcher.dispatch(pkg, node.metadata);
      return { id: node.id, executionId, result };
    }),
    { limit: options.limit ?? nodes.length }
  );

  const byId: Record<string, ExecutionResult> = {};
  for (const n of nodeResults) {
    byId[n.id] = n.result;
  }
  return {
    nodes: nodeResults,
    byId,
    completed: nodeResults.every((n) => n.result.status === "completed"),
  };
}
