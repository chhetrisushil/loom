import type { CapabilityCatalog } from "@loom/capability";
import {
  type Effect,
  type EffectContext,
  type PrincipalChain,
  ToolEffect,
} from "@loom/effect-runtime";
import type { ExecutionContext } from "@loom/workflow-runtime";
import { type ExecutePlanConfig, type PlanRun, executePlan } from "./executePlan";
import {
  type CreateGoalInput,
  type Goal,
  GoalAccessDeniedError,
  type GoalFilter,
  type GoalStore,
  GoalTransitionError,
  type SetStatusInput,
} from "./goals";
import { PlanFailedError, type PlanGoalInput, planGoal } from "./planGoal";

// ── R16 (ADR 0123) — the goal store as journaled effects, owned by the principal ────────────────

export const GOAL_TOOL_IDS = {
  create: "goals.create",
  get: "goals.get",
  list: "goals.list",
  setStatus: "goals.setStatus",
  rollup: "goals.rollup",
} as const;

/**
 * The goal owner of an execution: its authenticated principal (ADR 0111), tenant-qualified.
 * Fails closed — no actor, no owner; a delegation the kernel could not restore is refused too.
 */
export function ownerOfPrincipal(p: PrincipalChain | undefined): string {
  if (p === undefined || typeof p.actor !== "string" || p.actor.length === 0) {
    throw new GoalAccessDeniedError("the execution has no authenticated principal");
  }
  if (p.delegationUnresolved !== undefined) {
    throw new GoalAccessDeniedError("the principal's delegation could not be restored");
  }
  return JSON.stringify([p.tenant ?? "", p.actor]);
}

export interface GoalEffectsOptions {
  /**
   * Override how the owner is derived from the effect context (e.g. a service that owns its goals).
   * Default {@link ownerOfPrincipal}. It must NOT read the effect's input.
   */
  ownerOf?: (ctx: EffectContext) => string;
}

/**
 * The goal operations as effects, keyed {@link GOAL_TOOL_IDS}. Register them on the EffectRuntime so a
 * flow's goal reads/writes are authorized (K2), journaled, and served from the log on replay. The
 * owner is taken from the effect context's principal — there is no `owner` field in any input.
 */
export function goalEffects(
  store: GoalStore,
  options: GoalEffectsOptions = {}
): Record<(typeof GOAL_TOOL_IDS)[keyof typeof GOAL_TOOL_IDS], Effect> {
  const owner = options.ownerOf ?? ((c: EffectContext) => ownerOfPrincipal(c.principal));
  return {
    [GOAL_TOOL_IDS.create]: new ToolEffect((i: CreateGoalInput, c) => store.create(owner(c), i), {
      idempotent: false,
    }),
    [GOAL_TOOL_IDS.get]: new ToolEffect((i: { id: string }, c) => store.get(owner(c), i.id)),
    [GOAL_TOOL_IDS.list]: new ToolEffect((i: GoalFilter | undefined, c) => store.list(owner(c), i)),
    [GOAL_TOOL_IDS.setStatus]: new ToolEffect(
      (i: SetStatusInput, c) => store.setStatus(owner(c), i),
      { idempotent: false }
    ),
    [GOAL_TOOL_IDS.rollup]: new ToolEffect((i: { id: string }, c) => store.rollup(owner(c), i.id), {
      idempotent: false,
    }),
  } as never;
}

/** Register {@link goalEffects} on anything with `register(toolId, effect)`. */
export function registerGoalEffects(
  registry: { register(toolId: string, effect: Effect): void },
  store: GoalStore,
  options?: GoalEffectsOptions
): void {
  for (const [id, effect] of Object.entries(goalEffects(store, options)))
    registry.register(id, effect);
}

export interface GoalsClient {
  create(input: CreateGoalInput): Promise<Goal>;
  get(id: string): Promise<Goal>;
  list(filter?: GoalFilter): Promise<Goal[]>;
  setStatus(input: SetStatusInput): Promise<Goal>;
  rollup(id: string): Promise<Goal>;
}

/**
 * Flow-side handle to the goal effects. Each call is a durable step `<prefix>:<op>:<n>`; `n` counts
 * calls on THIS client, so build one client per run and call it in a fixed order (as any flow code).
 */
export function goalsClient(
  ctx: Pick<ExecutionContext, "execute">,
  options: { prefix?: string } = {}
): GoalsClient {
  const prefix = options.prefix ?? "goals";
  let n = 0;
  const call = <T>(op: keyof typeof GOAL_TOOL_IDS, input: unknown): Promise<T> =>
    ctx.execute(
      {
        _tag: "TaskDefinition",
        kind: "tool",
        id: `${prefix}:${op}:${n++}`,
        toolId: GOAL_TOOL_IDS[op],
      } as never,
      input
    ) as Promise<T>;
  return {
    create: (i) => call("create", i),
    get: (id) => call("get", { id }),
    list: (f) => call("list", f ?? {}),
    setStatus: (i) => call("setStatus", i),
    rollup: (id) => call("rollup", { id }),
  };
}

export interface RunGoalConfig {
  catalog: CapabilityCatalog;
  /** Planning options (model, limits, fallback, …). `goal` and `planId` are set from the goal. */
  plan: Omit<PlanGoalInput, "goal" | "planId" | "catalog">;
  execute?: Omit<ExecutePlanConfig, "catalog" | "planId">;
}

export interface RunGoalResult {
  run?: PlanRun;
  goal: Goal;
}

/**
 * Pursue a stored goal: mark it active, plan for its title, execute, and write the outcome back
 * (done / failed, or open again if a reflection stopped the run), rolling the parent up. A planning
 * failure marks the goal failed (with the reason) and is re-thrown. `done` and `abandoned` goals are
 * refused. Plan and step ids are namespaced `goal-<id>-r<revision>` so a retried goal never collides
 * with its earlier recorded attempt.
 */
export async function runGoal(
  ctx: ExecutionContext,
  goals: GoalsClient,
  goalId: string,
  config: RunGoalConfig
): Promise<RunGoalResult> {
  let goal = await goals.get(goalId);
  if (goal.status === "done" || goal.status === "abandoned") {
    throw new GoalTransitionError(goal.status, "active");
  }
  if (goal.status !== "active") {
    goal = await goals.setStatus({ id: goalId, status: "active", expectedRevision: goal.revision });
  }
  const planId = `goal-${goalId}-r${goal.revision}`;
  const finish = async (input: Omit<SetStatusInput, "id">): Promise<Goal> => {
    const g = await goals.setStatus({ id: goalId, ...input });
    return goal.parentId !== undefined ? goals.rollup(goalId) : g;
  };
  let run: PlanRun;
  try {
    const plan = await planGoal(ctx, {
      ...config.plan,
      catalog: config.catalog,
      goal: goal.title,
      planId,
    });
    run = await executePlan(ctx, plan, { ...config.execute, catalog: config.catalog, planId });
  } catch (e) {
    if (e instanceof PlanFailedError) {
      await finish({ status: "failed", note: e.message });
    }
    throw e;
  }
  const status = run.status === "completed" ? "done" : run.status === "stopped" ? "open" : "failed";
  const updated = await finish({
    status,
    ...(run.reason !== undefined && { note: run.reason }),
    lastRun: { status: run.status, replans: run.replans },
  });
  return { run, goal: updated };
}
