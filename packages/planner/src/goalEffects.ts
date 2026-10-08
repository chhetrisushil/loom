import type { CapabilityCatalog } from "@loom/capability";
import { tainted } from "@loom/classify";
import {
  type Effect,
  type EffectContext,
  type PrincipalChain,
  ToolEffect,
  principalBlocked,
  principalIdentityKey,
} from "@loom/effect-runtime";
import type { ExecutionContext } from "@loom/workflow-runtime";
import { claimId } from "./claim";
import { type ExecutePlanConfig, type PlanRun, executePlan } from "./executePlan";
import {
  type CreateGoalInput,
  type Goal,
  GoalAccessDeniedError,
  GoalConflictError,
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
 * The goal owner of an execution: its authenticated principal's identity key (`[tenant, actor,
 * onBehalfOf]` - the SAME key a conversation's owner uses, so a delegate acting `onBehalfOf` someone is
 * a different owner from that someone). Fails closed: no actor, or a principal the kernel marked
 * unusable (shredded, delegation or record unresolved), has no owner.
 */
export function ownerOfPrincipal(p: PrincipalChain | undefined): string {
  const blocked = principalBlocked(p);
  if (blocked !== undefined) throw new GoalAccessDeniedError(blocked);
  const key = principalIdentityKey(p);
  if (key === undefined) {
    throw new GoalAccessDeniedError("the execution has no authenticated principal");
  }
  return key;
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
  // Idempotent on the effect's idempotencyKey: a crash between the write and its record re-drives the
  // effect with the same key and the store returns the original result instead of parking the
  // execution at EFFECT_INDOUBT or applying the write twice.
  const w = (c: EffectContext) => ({
    ...(c.idempotencyKey !== undefined && { idempotencyKey: c.idempotencyKey }),
  });
  return {
    [GOAL_TOOL_IDS.create]: new ToolEffect(
      (i: CreateGoalInput, c) => store.create(owner(c), i, w(c)),
      { idempotent: true }
    ),
    [GOAL_TOOL_IDS.get]: new ToolEffect((i: { id: string }, c) => store.get(owner(c), i.id)),
    [GOAL_TOOL_IDS.list]: new ToolEffect((i: GoalFilter | undefined, c) => store.list(owner(c), i)),
    [GOAL_TOOL_IDS.setStatus]: new ToolEffect(
      (i: SetStatusInput, c) => store.setStatus(owner(c), i, w(c)),
      { idempotent: true }
    ),
    [GOAL_TOOL_IDS.rollup]: new ToolEffect(
      (i: { id: string }, c) => store.rollup(owner(c), i.id, w(c)),
      { idempotent: true }
    ),
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
  // Step ids are `<prefix>:<op>:<n>` with `n` counted per client: two clients on one prefix would mint
  // the same ids and the second would be served the first's recorded result (a lost write).
  claimId(ctx, "goals-client", prefix);
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
  /**
   * Host liveness probe for the execution recorded as a goal's `holder`. A goal found `active` is
   * taken over ONLY when it names a holder (other than this execution) and this resolves `false`.
   * Absent, throwing, or `true` ⇒ the pursuit is someone else's and `GoalConflictError` is raised.
   * Called inside `ctx.decide`, so the answer is recorded and a replay does not re-ask.
   */
  isExecutionLive?: (executionId: string) => boolean | Promise<boolean>;
}

export interface RunGoalResult {
  run?: PlanRun;
  goal: Goal;
}

/**
 * Pursue a stored goal: mark it active, plan for its title, execute, and write the outcome back
 * (`done` / `failed`, or `open` again if a reflection stopped the run), then roll the PARENT up (the
 * goal's own result is what this returns; it is never recomputed from its children).
 *
 * - One pursuer at a time: the `active` transition is a compare-and-set on the revision read, and a
 *   goal that is already `active` is refused (`GoalConflictError`) - whoever set it owns the pursuit.
 *   The pursuing execution is recorded as `holder`. A goal stranded `active` by a holder that died is
 *   taken over only when the host's `isExecutionLive(holder)` says it is gone (a throwing or absent
 *   probe never takes over); otherwise `setStatus(open)` releases it by hand.
 * - Never stuck `active`: a planning failure marks the goal `failed` with the reason; any other
 *   error that ends the pursuit (a denial, a cancellation, a divergence) puts it back to `open` with
 *   `lastRun.error` (best effort - the write may itself be refused) and is re-thrown. A PARK
 *   (`SuspendError`) leaves it `active`: the execution resumes and carries on.
 * - `done` and `abandoned` goals are refused. Plan and step ids are `goal-<id>-r<revision>`, so a
 *   retried goal never collides with its earlier recorded attempt. The title is untrusted text: it
 *   reaches the planner as a tainted goal.
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
  if (goal.status === "active") {
    const holder = goal.holder;
    const probe = config.isExecutionLive;
    const dead =
      holder !== undefined &&
      holder !== ctx.executionId &&
      probe !== undefined &&
      !(await ctx.decide<boolean>(
        `goal-takeover-${goalId}-r${goal.revision}`,
        async () => {
          try {
            return await probe(holder);
          } catch {
            return true; // cannot tell ⇒ assume live: never steal a pursuit on a failed lookup
          }
        },
        { source: "planner.goal" }
      ));
    if (!dead) {
      throw new GoalConflictError(
        `goal "${goalId}" is already being pursued${holder !== undefined ? ` by execution "${holder}"` : ""}`
      );
    }
  }
  goal = await goals.setStatus({
    id: goalId,
    status: "active",
    expectedRevision: goal.revision,
    holder: ctx.executionId,
  });
  const planId = `goal-${goalId}-r${goal.revision}`;
  const parentId = goal.parentId;
  const finish = async (input: Omit<SetStatusInput, "id">): Promise<Goal> => {
    const g = await goals.setStatus({ id: goalId, ...input });
    if (parentId !== undefined) await goals.rollup(parentId);
    return g;
  };
  let run: PlanRun;
  try {
    const plan = await planGoal(ctx, {
      ...config.plan,
      catalog: config.catalog,
      goal: tainted(goal.title, "goal:title"),
      planId,
    });
    run = await executePlan(ctx, plan, { ...config.execute, catalog: config.catalog, planId });
  } catch (e) {
    if (e instanceof PlanFailedError) {
      await finish({ status: "failed", note: e.message });
    } else if ((e as Error)?.name !== "SuspendError") {
      try {
        await finish({
          status: "open",
          note: "pursuit ended by an error",
          lastRun: {
            status: "failed",
            replans: 0,
            error: `${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? ""}`.slice(0, 300),
          },
        });
      } catch {
        // The execution is ending; if the write is refused too, the goal stays as it was.
      }
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
