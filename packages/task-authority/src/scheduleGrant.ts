import { createHash } from "node:crypto";
import { z } from "zod";
import { type GrantBroker, GrantBrokerError, type MintRequest } from "./broker";
import { ScheduleDeniedError } from "./errors";
import type { TaskGrant } from "./grant";

/** The typed resume gate of a schedule-approval run (ADR 0150 D12, ADR 0077). `viewDigest` is the ADR 0117 echo. */
export const SCHEDULE_GATE = "task-authority:schedule";
export const scheduleResumeSchema = z.discriminatedUnion("approved", [
  z.object({ approved: z.literal(true), viewDigest: z.string().optional() }),
  z.object({
    approved: z.literal(false),
    reason: z.string().optional(),
    viewDigest: z.string().optional(),
  }),
]);

/**
 * What a human approves for a schedule (ADR 0150 D12): the schedule grant a `MintRequest` describes, minus the
 * fields the broker owns. `scheduleId` becomes the grant's `taskId` (and each tick's `<scheduleId>@<occurrence>`
 * child grant derives from it). Its `leases` are the TOTAL budget across every tick; `ttlMs` is the schedule's life.
 */
export type ScheduleGrantSpec = Omit<MintRequest, "taskId" | "parent" | "parentReserved"> & {
  scheduleId: string;
};

const decisionId = (scheduleId: string) => `task-authority:schedule:${scheduleId}`;
export const scheduleViewDigest = (key: string, spec: ScheduleGrantSpec): string =>
  createHash("sha256")
    .update(JSON.stringify({ gate: SCHEDULE_GATE, key, spec }))
    .digest("hex");

/** The flow-context slice `requestScheduleApproval` needs (structural: no kernel dependency). */
export interface ScheduleApprovalContext {
  readonly executionId: string;
  suspend(c: { on: string; correlationKey: string; viewDigest: string }): Promise<unknown>;
  decide<T = unknown>(id: string, decider: () => T | Promise<T>): Promise<T>;
}

/**
 * ADR 0150 D12, the ONE-OFF APPROVAL RUN (a schedule has no park of its own). Call it from a flow: it records
 * the proposed `spec` as a decision, parks on `SCHEDULE_GATE` with a `viewDigest` over it, and returns once
 * a human approved; a refusal throws `ScheduleDeniedError`. It mints nothing: `answerScheduleApproval`
 * mints, AFTER the runtime accepted the (authenticated) approval, so flow code cannot mint.
 */
export async function requestScheduleApproval(
  ctx: ScheduleApprovalContext,
  spec: ScheduleGrantSpec
): Promise<void> {
  const proposed = await ctx.decide(decisionId(spec.scheduleId), () => spec);
  const key = `${ctx.executionId}#schedule:${proposed.scheduleId}`;
  const v = scheduleResumeSchema.safeParse(
    await ctx.suspend({
      on: SCHEDULE_GATE,
      correlationKey: key,
      viewDigest: scheduleViewDigest(key, proposed),
    })
  );
  if (!v.success) throw new ScheduleDeniedError("malformed schedule approval");
  if (!v.data.approved) throw new ScheduleDeniedError(v.data.reason ?? "not approved");
}

/** Mint the schedule (root) grant for `spec`. Idempotent: the same spec returns the existing grant, a different one is refused. */
export async function mintScheduleGrant(
  broker: Pick<GrantBroker, "mint" | "current">,
  spec: ScheduleGrantSpec
): Promise<TaskGrant> {
  const { scheduleId: taskId, ...rest } = spec;
  const same = (g: TaskGrant) =>
    g.issuedTo === rest.issuedTo &&
    JSON.stringify([g.effects, g.leases]) === JSON.stringify([rest.effects, rest.leases]);
  const have = await broker.current(taskId);
  if (have !== undefined) {
    if (same(have)) return have;
    throw new GrantBrokerError(`schedule ${taskId} already has a different grant`);
  }
  try {
    return await broker.mint({ taskId, ...rest });
  } catch (e) {
    const raced = await broker.current(taskId); // a concurrent answer won the mint
    if (raced !== undefined && same(raced)) return raced;
    throw e;
  }
}

/** Structural slice of `WorkflowRuntime` that `answerScheduleApproval` drives. */
export interface ScheduleApprovalRuntime {
  loadState(id: string): Promise<
    | {
        suspendedOn?: { on: string; correlationKey?: string; viewDigest?: string };
        variables: Record<string, unknown>;
      }
    | null
    | undefined
  >;
  resume(
    id: string,
    event: { eventType: string; payload: unknown },
    opts?: unknown
  ): Promise<unknown>;
}

/**
 * Operator helper: reads the pending `ScheduleGrantSpec` of the execution parked on `SCHEDULE_GATE`, resumes it
 * with the decision plus the `viewDigest` echo (ADR 0117), and ONLY THEN, if approved, mints the schedule grant.
 * A resume the runtime refuses (an unverified approver under `resumeAuthenticator`, a stale digest) throws before
 * any mint; the recorded `APPROVAL_GRANTED { actor, verifiedBy }` of that run is who answers for every tick.
 * `resumeOpts` (e.g. a principal) pass through. Returns the grant, or `undefined` for a refusal.
 */
export async function answerScheduleApproval(
  runtime: ScheduleApprovalRuntime,
  broker: Pick<GrantBroker, "mint" | "current">,
  executionId: string,
  decision: { approved: boolean; reason?: string },
  resumeOpts?: unknown
): Promise<TaskGrant | undefined> {
  const state = await runtime.loadState(executionId);
  const gate = state?.suspendedOn;
  const key = gate?.correlationKey ?? "";
  const head = `${executionId}#schedule:`;
  if (gate?.on !== SCHEDULE_GATE || !key.startsWith(head))
    throw new Error(`execution "${executionId}" is not parked on ${SCHEDULE_GATE}`);
  const decisions = (state?.variables._decisions ?? {}) as Record<
    string,
    { choice?: ScheduleGrantSpec }
  >;
  const spec = decisions[decisionId(key.slice(head.length))]?.choice;
  if (spec === undefined) throw new Error(`no schedule proposal recorded for "${key}"`);
  if (gate.viewDigest !== scheduleViewDigest(key, spec))
    throw new Error(`the recorded schedule proposal for "${key}" does not match the parked digest`);
  await runtime.resume(
    executionId,
    { eventType: SCHEDULE_GATE, payload: { ...decision, viewDigest: gate.viewDigest } },
    resumeOpts
  );
  return decision.approved ? mintScheduleGrant(broker, spec) : undefined;
}
