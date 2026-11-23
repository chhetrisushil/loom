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

const DECISION_PREFIX = "task-authority:schedule:";
const decisionId = (scheduleId: string) => `${DECISION_PREFIX}${scheduleId}`;
/** Written ONLY after the suspend returned an approval (R26): crash recovery requires it. */
const MARKER_PREFIX = "task-authority:schedule-approved:";
const markerId = (scheduleId: string) => `${MARKER_PREFIX}${scheduleId}`;
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
  await ctx.decide(markerId(proposed.scheduleId), () => ({
    approved: true,
    digest: scheduleViewDigest(key, proposed),
  }));
}

const sorted = (a?: readonly string[]) => (a === undefined ? null : [...a].sort());
/** Every signed field of the spec, canonical (sets sorted, absent = null), for an equality check against a minted grant. */
const specKey = (g: {
  issuedTo: string;
  effects: readonly string[];
  leases: Record<string, { ceiling: number; effects: readonly string[] }>;
  tenant?: string | undefined;
  onBehalfOf?: string | undefined;
  reads?: readonly string[] | undefined;
  sandbox?: string | undefined;
}): string =>
  JSON.stringify([
    g.issuedTo,
    sorted(g.effects),
    Object.keys(g.leases)
      .sort()
      .map((n) => [n, g.leases[n]?.ceiling, sorted(g.leases[n]?.effects)]),
    g.tenant ?? null,
    g.onBehalfOf ?? null,
    sorted(g.reads),
    g.sandbox ?? null,
  ]);

/** How long after minting an idempotent re-answer (a crash between the resume and the mint) may still find the grant. Default 10 minutes. */
export const SCHEDULE_RECOVERY_MS = 600_000;

/**
 * Mint the schedule (root) grant for `spec`. Idempotent: an existing grant is returned only if EVERY signed field
 * equals the spec's (`issuedTo`, `effects`, `leases`, `tenant`, `onBehalfOf`, `reads`, `sandbox`) and its expiry fits
 * the spec's `ttlMs` (minted at most `recoveryMs` ago, and expiring no later than `now + ttlMs`, so it never outlives the
 * ttl approved now; the ttl check is a TOLERANCE: a re-approval with a ttl up to `recoveryMs` (10 minutes) LONGER is served the
 * shorter existing grant, never a longer one);
 * a different or EXPIRED one is refused (re-approve under a new schedule id). `o.now` must be the broker's clock.
 */
export async function mintScheduleGrant(
  broker: Pick<GrantBroker, "mint" | "current">,
  spec: ScheduleGrantSpec,
  o: { now?: () => number; recoveryMs?: number } = {}
): Promise<TaskGrant> {
  const { scheduleId: taskId, ...rest } = spec;
  const now = (o.now ?? Date.now)();
  const fits = (g: TaskGrant) =>
    g.exp > now &&
    g.exp <= now + rest.ttlMs &&
    g.exp - rest.ttlMs >= now - (o.recoveryMs ?? SCHEDULE_RECOVERY_MS);
  const same = (g: TaskGrant) => specKey(g) === specKey(rest as never) && fits(g);
  const have = await broker.current(taskId);
  if (have !== undefined) {
    if (same(have)) return have;
    throw new GrantBrokerError(
      `schedule ${taskId} already has a different, or an expired, grant; approve it under a new schedule id`
    );
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
        status?: string;
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

/** What the operator vouches the schedule is for (R25 I3): checked against the spec in addition to the approval run's recorded principal. */
export interface ScheduleExpect {
  tenant?: string;
  onBehalfOf?: string;
  issuedTo?: string;
}
export interface AnswerScheduleOptions {
  expect?: ScheduleExpect;
  /** The broker's clock (see `mintScheduleGrant`). */
  now?: () => number;
  /**
   * Set it when the runtime has a `resumeAuthenticator` (R26): crash recovery then also requires the kernel-written
   * `APPROVAL_GRANTED` for this gate in the run's `_approvals`, which flow code cannot forge (a hand-written
   * decision or marker cannot).
   */
  requireVerifiedApproval?: boolean;
  /** Persist the audit link from the schedule grant to the approval run (the grant has no field for it). */
  onMinted?: (grant: TaskGrant, approvalExecutionId: string) => void | Promise<void>;
}

/**
 * R25 I3 / R26: the operator MUST vouch for the holder (`expect.issuedTo`: an approver is not the service it approves),
 * and the spec's `tenant` / `onBehalfOf` must equal `expect`'s AND, when the approval run's recorded principal exposes its
 * identity, that principal's. A codec-encoded principal hides its identity, so there `expect` is the only binding.
 */
function bindSpec(
  spec: ScheduleGrantSpec,
  principal: unknown,
  expect: ScheduleExpect | undefined
): void {
  if (expect?.issuedTo === undefined)
    throw new ScheduleDeniedError("the operator must vouch for the holder: pass expect.issuedTo");
  if (spec.issuedTo !== expect.issuedTo)
    throw new ScheduleDeniedError("the proposed issuedTo does not match what the operator expects");
  const rec = principal as
    | { identity?: { tenant?: string; onBehalfOf?: string }; ref?: string }
    | undefined;
  const readable = rec?.ref === undefined; // an anonymous record `{ v: 1 }` has neither identity nor ref
  for (const k of ["tenant", "onBehalfOf"] as const) {
    if (readable && rec?.identity !== undefined && spec[k] !== rec.identity[k])
      throw new ScheduleDeniedError(`the proposed ${k} is not the approval run's principal's`);
    if (spec[k] !== expect[k])
      throw new ScheduleDeniedError(`the proposed ${k} does not match what the operator expects`);
  }
}

/**
 * Operator helper: reads the pending `ScheduleGrantSpec` of the execution parked on `SCHEDULE_GATE`, refuses it unless
 * its `issuedTo` is `o.expect.issuedTo` (REQUIRED, R26: an approver is not the service it approves) and its `tenant` /
 * `onBehalfOf` equal `o.expect`'s and the approval run's recorded principal's (R25 I3: a cross-tenant mint is refused BEFORE the resume), resumes it with the decision plus the
 * `viewDigest` echo (ADR 0117), and ONLY THEN, if approved, mints the schedule grant. A resume the runtime refuses
 * (an unverified approver under `resumeAuthenticator`, a stale digest) throws before any mint; the recorded
 * `APPROVAL_GRANTED { actor, verifiedBy }` of that run is who answers for every tick. If the run already COMPLETED
 * (a crash between the resume and the mint) an approved answer mints from the recorded proposal. `resumeOpts` (e.g. a
 * principal) pass through. Returns the grant, or `undefined` for a refusal.
 */
export async function answerScheduleApproval(
  runtime: ScheduleApprovalRuntime,
  broker: Pick<GrantBroker, "mint" | "current">,
  executionId: string,
  decision: { approved: boolean; reason?: string },
  resumeOpts?: unknown,
  o: AnswerScheduleOptions = {}
): Promise<TaskGrant | undefined> {
  const state = await runtime.loadState(executionId);
  const gate = state?.suspendedOn;
  const key = gate?.correlationKey ?? "";
  const head = `${executionId}#schedule:`;
  const decisions = (state?.variables._decisions ?? {}) as Record<
    string,
    { choice?: ScheduleGrantSpec }
  >;
  const mint = async (spec: ScheduleGrantSpec) => {
    const g = await mintScheduleGrant(broker, spec, o.now === undefined ? {} : { now: o.now });
    await o.onMinted?.(g, executionId);
    return g;
  };
  if (state?.status === "completed" && decision.approved) {
    const spec = Object.entries(decisions).find(([k]) => k.startsWith(DECISION_PREFIX))?.[1]
      ?.choice;
    if (spec === undefined) throw new Error(`no schedule proposal recorded for "${executionId}"`);
    // R26: only a run that PARKED and got an approval wrote the marker; a denied-then-caught run or a hand-written decision did not
    const marker = (
      decisions[markerId(spec.scheduleId)] as { choice?: { approved?: boolean; digest?: string } }
    )?.choice;
    const key = `${head}${spec.scheduleId}`;
    if (marker?.approved !== true || marker.digest !== scheduleViewDigest(key, spec))
      throw new Error(`execution "${executionId}" recorded no approval of this schedule`);
    const evidence = (state.variables._approvals ?? []) as { on?: string }[];
    if (o.requireVerifiedApproval === true && !evidence.some((e) => e.on === SCHEDULE_GATE))
      throw new Error(
        `execution "${executionId}" has no verified APPROVAL_GRANTED for the schedule gate`
      );
    bindSpec(spec, state.variables._principal, o.expect);
    return mint(spec);
  }
  if (gate?.on !== SCHEDULE_GATE || !key.startsWith(head))
    throw new Error(`execution "${executionId}" is not parked on ${SCHEDULE_GATE}`);
  const spec = decisions[decisionId(key.slice(head.length))]?.choice;
  if (spec === undefined) throw new Error(`no schedule proposal recorded for "${key}"`);
  if (gate.viewDigest !== scheduleViewDigest(key, spec))
    throw new Error(`the recorded schedule proposal for "${key}" does not match the parked digest`);
  if (decision.approved) bindSpec(spec, state?.variables._principal, o.expect);
  await runtime.resume(
    executionId,
    { eventType: SCHEDULE_GATE, payload: { ...decision, viewDigest: gate.viewDigest } },
    resumeOpts
  );
  return decision.approved ? mint(spec) : undefined;
}
