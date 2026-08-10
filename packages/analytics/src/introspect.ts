import type { EventEnvelope } from "@loom/core";
import { type DecisionGraph, decisionGraph } from "./decisions";

// ── Runtime introspection facade (ADR 0031) ──────────────────────────────────
//
// ONE read-only API over the graphs the runtime already yields. Every graph here
// is folded from existing sources — the durable log (executions / tasks / decisions
// / resources) plus, when the caller supplies them, static app projections
// (placement targets, flow→tool dependencies). No new state, no durable events; it
// observes, it never steers. ("Fiber graph" from the requirements is the task graph
// — fibers were rejected.) Reuses `decisionGraph` (ADR 0030) verbatim.

export type ExecutionStatus = "running" | "completed" | "failed" | "cancelled" | "suspended";

export interface ExecutionNode {
  executionId: string;
  workflowId: string;
  status: ExecutionStatus;
  steps: number;
  startedAt?: number;
  completedAt?: number;
}

export interface TaskNode {
  id: string;
  status: string;
  attempts: number;
  startMs?: number;
  endMs?: number;
  /** True when the step ran inside a PARALLEL_STARTED window. */
  parallel: boolean;
}

/** Execution-order edge. Frames are flat (no data-dependency pointers), so edges are order. */
export interface TaskEdge {
  from: string;
  to: string;
  kind: "next";
}

export interface TaskGraph {
  executionId: string;
  nodes: TaskNode[];
  edges: TaskEdge[];
}

export interface ResourceNode {
  stepId: string;
  tokens: number;
  costUsd: number;
  ms: number;
}

export interface ResourceGraph {
  executionId: string;
  total: { tokens: number; costUsd: number; ms: number };
  byStep: ResourceNode[];
}

export interface PlacementGraph {
  targets: string[];
}

export interface DependencyEdge {
  from: string;
  to: string;
  kind: "invokes" | "grants";
}

export interface DependencyGraph {
  nodes: string[];
  edges: DependencyEdge[];
}

export interface IntrospectOptions {
  /** Registered placement targets (e.g. `PlacementDispatcher.targetNames`). */
  targets?: readonly string[];
  /** flowId → tool/effect ids it invokes (e.g. from `FlowDefinition` steps). */
  flowTools?: Record<string, readonly string[]>;
  /** principal → granted effect ids or `"*"` (e.g. `GrantTable.view()`). */
  grants?: Record<string, readonly string[] | "*">;
}

export interface RuntimeIntrospection {
  executions: ExecutionNode[];
  tasks: TaskGraph;
  decisions: DecisionGraph;
  resources: ResourceGraph;
  placement?: PlacementGraph;
  dependencies?: DependencyGraph;
}

const TERMINAL: Record<string, ExecutionStatus> = {
  EXECUTION_COMPLETED: "completed",
  EXECUTION_FAILED: "failed",
  EXECUTION_CANCELLED: "cancelled",
};
const TERMINAL_STEP: Record<string, string> = {
  STEP_COMPLETED: "completed",
  STEP_FAILED: "failed",
  STEP_CANCELLED: "cancelled",
};

function scope(
  events: EventEnvelope[],
  executionId?: string
): { id: string; scoped: EventEnvelope[] } {
  const id = executionId ?? events[0]?.executionId ?? "(none)";
  const scoped = events.filter((e) => e.executionId === id).sort((a, b) => a.sequence - b.sequence);
  return { id, scoped };
}

/** One summary node per execution present in the log. */
export function executionNodes(events: EventEnvelope[]): ExecutionNode[] {
  const byExec = new Map<string, EventEnvelope[]>();
  for (const e of events) {
    const list = byExec.get(e.executionId) ?? [];
    list.push(e);
    byExec.set(e.executionId, list);
  }
  const nodes: ExecutionNode[] = [];
  for (const [executionId, list] of byExec) {
    const ordered = [...list].sort((a, b) => a.sequence - b.sequence);
    let status: ExecutionStatus = "running";
    let steps = 0;
    let startedAt: number | undefined;
    let completedAt: number | undefined;
    for (const e of ordered) {
      if (e.eventType === "EXECUTION_STARTED") startedAt = e.timestamp;
      if (e.eventType === "STEP_STARTED") steps += 1;
      // Own-key lookup: `eventType` is caller-controlled (a resume carries the caller's own
      // event type into the log), and `TERMINAL["__proto__"]` resolves up the prototype chain
      // to `Object.prototype` — not `undefined`, so the guard below would admit it and report
      // the execution as terminal with an object for a status. The sibling `TERMINAL_STEP`
      // reads are inside a `switch` on known types and cannot be reached this way.
      const terminal = Object.hasOwn(TERMINAL, e.eventType) ? TERMINAL[e.eventType] : undefined;
      if (terminal !== undefined) {
        status = terminal;
        completedAt = e.timestamp;
      } else if (e.eventType === "EXECUTION_SUSPENDED") {
        status = "suspended";
      } else if (e.eventType === "EXECUTION_RESUMED" && status === "suspended") {
        status = "running";
      }
    }
    nodes.push({
      executionId,
      workflowId: ordered[0]?.workflowId ?? "",
      status,
      steps,
      ...(startedAt !== undefined && { startedAt }),
      ...(completedAt !== undefined && { completedAt }),
    });
  }
  return nodes;
}

/** The step DAG for one execution (nodes = steps, edges = execution order). */
export function taskGraph(events: EventEnvelope[], executionId?: string): TaskGraph {
  const { id, scoped } = scope(events, executionId);
  const nodes = new Map<string, TaskNode>();
  let openParallel: Set<string> | undefined;

  for (const e of scoped) {
    const p = e.payload as { stepId?: string; stepIds?: string[] };
    switch (e.eventType) {
      case "PARALLEL_STARTED":
        openParallel = new Set(p.stepIds ?? []);
        break;
      case "PARALLEL_COMPLETED":
        openParallel = undefined;
        break;
      case "STEP_STARTED": {
        if (p.stepId === undefined) break;
        const prev = nodes.get(p.stepId);
        if (prev === undefined) {
          nodes.set(p.stepId, {
            id: p.stepId,
            status: "running",
            attempts: 1,
            startMs: e.timestamp,
            parallel: openParallel?.has(p.stepId) ?? false,
          });
        } else {
          prev.attempts += 1;
        }
        break;
      }
      case "STEP_COMPLETED":
      case "STEP_FAILED":
      case "STEP_CANCELLED": {
        if (p.stepId === undefined) break;
        const node = nodes.get(p.stepId);
        if (node !== undefined) {
          node.endMs = e.timestamp;
          node.status = TERMINAL_STEP[e.eventType] ?? node.status;
        }
        break;
      }
    }
  }

  const list = [...nodes.values()].sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  const edges: TaskEdge[] = [];
  for (let i = 1; i < list.length; i++) {
    edges.push({ from: list[i - 1]!.id, to: list[i]!.id, kind: "next" });
  }
  return { executionId: id, nodes: list, edges };
}

/**
 * Resource usage attributed to the step that was running when each RESOURCE_METERED
 * event landed (the log doesn't carry a stepId on the meter event, so we attribute to
 * the most recent STEP_STARTED — steps with no active step go to "(execution)").
 */
export function resourceGraph(events: EventEnvelope[], executionId?: string): ResourceGraph {
  const { id, scoped } = scope(events, executionId);
  const total = { tokens: 0, costUsd: 0, ms: 0 };
  const byStep = new Map<string, ResourceNode>();
  let currentStep = "(execution)";

  for (const e of scoped) {
    if (e.eventType === "STEP_STARTED") {
      const p = e.payload as { stepId?: string };
      if (p.stepId !== undefined) currentStep = p.stepId;
    } else if (
      e.eventType === "STEP_COMPLETED" ||
      e.eventType === "STEP_FAILED" ||
      e.eventType === "STEP_CANCELLED"
    ) {
      currentStep = "(execution)";
    } else if (e.eventType === "RESOURCE_METERED") {
      const p = e.payload as { tokens?: number; costUsd?: number; ms?: number };
      const node = byStep.get(currentStep) ?? { stepId: currentStep, tokens: 0, costUsd: 0, ms: 0 };
      node.tokens += p.tokens ?? 0;
      node.costUsd += p.costUsd ?? 0;
      node.ms += p.ms ?? 0;
      byStep.set(currentStep, node);
      total.tokens += p.tokens ?? 0;
      total.costUsd += p.costUsd ?? 0;
      total.ms += p.ms ?? 0;
    }
  }
  return { executionId: id, total, byStep: [...byStep.values()] };
}

/** Static flow→tool (invokes) + principal→tool (grants) dependency graph, from app projections. */
export function dependencyGraph(opts: IntrospectOptions): DependencyGraph {
  const nodes = new Set<string>();
  const edges: DependencyEdge[] = [];
  for (const [flowId, tools] of Object.entries(opts.flowTools ?? {})) {
    nodes.add(flowId);
    for (const tool of tools) {
      nodes.add(tool);
      edges.push({ from: flowId, to: tool, kind: "invokes" });
    }
  }
  for (const [principal, granted] of Object.entries(opts.grants ?? {})) {
    nodes.add(principal);
    if (granted === "*") {
      edges.push({ from: principal, to: "*", kind: "grants" });
      nodes.add("*");
      continue;
    }
    for (const tool of granted) {
      nodes.add(tool);
      edges.push({ from: principal, to: tool, kind: "grants" });
    }
  }
  return { nodes: [...nodes], edges };
}

/**
 * The unified facade. Log-derived graphs (executions / tasks / decisions / resources)
 * come straight from `events`; placement and dependency graphs are added when the
 * caller supplies the static app projections in `opts` (e.g. from `@loom/app`'s
 * `resolveVerifyInput` sources — `PlacementDispatcher.targetNames`, `GrantTable.view()`).
 */
export function introspect(
  events: EventEnvelope[],
  executionId?: string,
  opts?: IntrospectOptions
): RuntimeIntrospection {
  const hasDeps = opts?.flowTools !== undefined || opts?.grants !== undefined;
  return {
    executions: executionNodes(events),
    tasks: taskGraph(events, executionId),
    decisions: decisionGraph(
      executionId ? events.filter((e) => e.executionId === executionId) : events
    ),
    resources: resourceGraph(events, executionId),
    ...(opts?.targets !== undefined && { placement: { targets: [...opts.targets] } }),
    ...(hasDeps && { dependencies: dependencyGraph(opts ?? {}) }),
  };
}

const GRAPHS = ["executions", "tasks", "decisions", "resources"] as const;
export type GraphName = (typeof GRAPHS)[number];

function isGraphName(name: string): name is GraphName {
  return (GRAPHS as readonly string[]).includes(name);
}

/** Render one graph (or a summary of all) for `loom introspect`. */
export function formatIntrospection(x: RuntimeIntrospection, graph?: string): string {
  if (graph !== undefined && !isGraphName(graph)) {
    return `unknown graph "${graph}" — choose one of: ${GRAPHS.join(", ")}`;
  }
  const lines: string[] = [];
  const wantAll = graph === undefined;

  if (wantAll || graph === "executions") {
    lines.push("executions:");
    for (const n of x.executions) {
      lines.push(`  ${n.executionId} [${n.workflowId}] ${n.status} · ${n.steps} step(s)`);
    }
  }
  if (wantAll || graph === "tasks") {
    lines.push("tasks:");
    for (const n of x.tasks.nodes) {
      const par = n.parallel ? " ∥" : "";
      lines.push(`  ${n.id} — ${n.status}${n.attempts > 1 ? ` ×${n.attempts}` : ""}${par}`);
    }
    if (x.tasks.edges.length > 0) {
      lines.push(`  order: ${x.tasks.edges.map((e) => `${e.from}→${e.to}`).join(", ")}`);
    }
  }
  if (wantAll || graph === "decisions") {
    lines.push("decisions:");
    for (const n of x.decisions.nodes) {
      lines.push(
        `  ${n.decisionId} = ${JSON.stringify(n.choice)}${n.source ? ` (${n.source})` : ""}`
      );
    }
    if (x.decisions.edges.length > 0) {
      lines.push(
        `  edges: ${x.decisions.edges.map((e) => `${e.from}→${e.to}[${e.kind}]`).join(", ")}`
      );
    }
  }
  if (wantAll || graph === "resources") {
    const r = x.resources;
    lines.push("resources:");
    lines.push(`  total: ${r.total.tokens} tok · $${r.total.costUsd} · ${r.total.ms}ms`);
    for (const n of r.byStep) {
      lines.push(`  ${n.stepId}: ${n.tokens} tok · $${n.costUsd} · ${n.ms}ms`);
    }
  }
  return lines.join("\n");
}
