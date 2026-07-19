import type { EventEnvelope } from "@loom/core";
import { fail } from "@loom/core";
import type { ExecutionContext, RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";

// ── Cross-execution orchestration (child workflows) ───────────────────────────
//
// Spawn a child workflow from a parent and durably await its result — WITHOUT a new
// syscall. The primitive is composed from ones that already exist:
//   • `ctx.decide` durably (and replay-safely) fixes the child's id + spec;
//   • `ctx.suspend({ on: CHILD_DONE, correlationKey: childId })` parks the parent;
//   • a supervisor starts the child, and on the child's completion `resume`s the parent
//     with the child's output.
// Because `_resumePayload` is a single slot, this builds on ONE suspend/resume cycle
// per parent: spawn a child, suspend once, resume once with its result. (Fan-out over
// many children in one suspend is a documented follow-up.)
//
// No new event type: CHILD_DONE is a resume SIGNAL name (like TIMER_FIRED delivery),
// and the spec rides in the DECISION_RECORDED the supervisor already sees via onEvent.

/** The resume signal a completed child delivers to its waiting parent. */
export const CHILD_DONE = "CHILD_DONE";

const SEP = "::";

/** Deterministic child execution id — `<parentId>::<key>` (stable across replay). */
export function childIdFor(parentId: string, key: string): string {
  // The key must not contain the separator, or `parentOf` (which peels the LAST
  // separator) would resolve the wrong parent and a child completion could resume a
  // different execution. (parentId itself MAY contain the separator — that is exactly
  // how nested children work: parentOf yields the immediate parent.)
  if (key.includes(SEP)) {
    throw new Error(`orchestration: child key must not contain "${SEP}" (got "${key}")`);
  }
  return `${parentId}${SEP}${key}`;
}

/** The parent id embedded in a child id, or undefined if it is not a child id. */
export function parentOf(childId: string): string | undefined {
  const i = childId.lastIndexOf(SEP);
  return i < 0 ? undefined : childId.slice(0, i);
}

/**
 * Orchestration depth of an execution id: 0 for a root, +1 per `::` nesting
 * level. Derived purely from the deterministic child-id scheme, so the depth
 * guard replays identically.
 */
export function depthOf(executionId: string): number {
  let depth = 0;
  for (let i = executionId.indexOf(SEP); i >= 0; i = executionId.indexOf(SEP, i + SEP.length)) {
    depth++;
  }
  return depth;
}

/** Marker + spec recorded by `awaitChild` and read by the supervisor. */
interface SpawnChoice {
  __orchestration: true;
  childId: string;
  flowId: string;
  input: unknown;
}

function asSpawnChoice(value: unknown): SpawnChoice | undefined {
  const c = value as Partial<SpawnChoice> | null;
  return c !== null &&
    c.__orchestration === true &&
    typeof c.childId === "string" &&
    typeof c.flowId === "string"
    ? (c as SpawnChoice)
    : undefined;
}

/**
 * From inside a parent flow: spawn `flowId(input)` as a child execution and suspend
 * until it completes, returning its output. Replay-safe — the spawn is fixed by
 * `ctx.decide`, so a resume/recovery re-run never starts a second child.
 *
 * `maxDepth` (ADR 0061 D5) bounds recursive re-entry — a self-invoking flow
 * (e.g. a drift-repair loop re-entering its interpreter) must not recurse
 * unboundedly on persistent failure. Exceeding it throws a typed
 * `depthExceeded` failure (ADR 0060) BEFORE anything durable happens, so the
 * calling flow can catch it and settle; uncaught, the run fails loudly.
 */
export async function awaitChild<TOut = unknown>(
  ctx: Pick<ExecutionContext, "executionId" | "decide" | "suspend">,
  spec: { key: string; flowId: string; input: unknown; maxDepth?: number }
): Promise<TOut> {
  const childId = childIdFor(ctx.executionId, spec.key);
  if (spec.maxDepth !== undefined) {
    const depth = depthOf(childId);
    if (depth > spec.maxDepth) {
      fail("depthExceeded", { childId, depth, maxDepth: spec.maxDepth });
    }
  }
  await ctx.decide(`orchestration:spawn:${spec.key}`, () => ({
    __orchestration: true as const,
    childId,
    flowId: spec.flowId,
    input: spec.input,
  }));
  const resumed = (await ctx.suspend({ on: CHILD_DONE, correlationKey: childId })) as unknown as {
    output: TOut;
  };
  return resumed.output;
}

export interface SupervisorDeps {
  runtime: WorkflowRuntime;
  /** Child flows by id, so the supervisor can start them by the recorded flowId. */
  flows: Record<string, RegisteredFlow>;
  /** Fired on a supervision failure (start/resume rejection). */
  onError?: (err: unknown) => void;
}

export interface ChildSupervisor {
  /** Wire this into `WorkflowRuntimeDeps.onEvent` (it sees every execution's events). */
  onEvent(event: EventEnvelope): void;
}

/**
 * The supervisor that turns spawn intents into running children and their completions
 * into parent resumes. It correlates purely from the events it observes via `onEvent`
 * (no store read → no read-after-commit race): the spawn spec comes from the parent's
 * `DECISION_RECORDED`, and the child id embeds the parent id.
 */
export function superviseChildren(deps: SupervisorDeps): ChildSupervisor {
  // childId → spec, learned from DECISION_RECORDED before the parent's suspend lands.
  const specs = new Map<string, { flowId: string; input: unknown }>();
  // childIds already started this process (idempotency within the runtime).
  const started = new Set<string>();

  const fail = (err: unknown): void => deps.onError?.(err);

  return {
    onEvent(event: EventEnvelope): void {
      if (event.eventType === "DECISION_RECORDED") {
        const choice = asSpawnChoice((event.payload as { choice?: unknown }).choice);
        if (choice !== undefined)
          specs.set(choice.childId, { flowId: choice.flowId, input: choice.input });
        return;
      }

      if (event.eventType === "EXECUTION_SUSPENDED") {
        const condition = (
          event.payload as { condition?: { on?: string; correlationKey?: string } }
        ).condition;
        if (condition?.on !== CHILD_DONE) return;
        const childId = condition.correlationKey;
        if (childId === undefined || started.has(childId)) return;
        const spec = specs.get(childId);
        if (spec === undefined) return;
        const flow = deps.flows[spec.flowId];
        if (flow === undefined) {
          fail(new Error(`orchestration: no flow registered for "${spec.flowId}"`));
          return;
        }
        started.add(childId);
        void deps.runtime.start(flow, spec.input, { executionId: childId }).catch(fail);
        return;
      }

      if (
        event.eventType === "EXECUTION_COMPLETED" ||
        event.eventType === "EXECUTION_FAILED" ||
        event.eventType === "EXECUTION_CANCELLED"
      ) {
        const childId = event.executionId;
        if (!started.has(childId)) return;
        const parentId = parentOf(childId);
        if (event.eventType === "EXECUTION_COMPLETED" && parentId !== undefined) {
          const output = (event.payload as { output?: unknown }).output;
          void deps.runtime
            .resume(parentId, { eventType: CHILD_DONE, payload: { output } })
            .catch(fail);
        }
        // Bound the supervisor's maps: once a child is terminal it needs no more
        // bookkeeping. (A failed/cancelled child leaves its parent suspended — failure
        // propagation is a documented follow-up — but the maps are still reclaimed.)
        specs.delete(childId);
        started.delete(childId);
      }
    },
  };
}
