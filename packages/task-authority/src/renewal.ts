import { createHash } from "node:crypto";
import { z } from "zod";
import { parseExpiredReason } from "./authorizer";
import type { RenewalRequest, RenewalVerdict } from "./broker";
import { RenewalDeniedError } from "./errors";

/** The typed resume gate a renewable authority error parks on (ADR 0150 D5, ADR 0077). */
export const RENEWAL_GATE = "task-authority:renew";

/** `flow$({ resumeSchemas: { [RENEWAL_GATE]: renewalResumeSchema } })`. `viewDigest` is the ADR 0117 echo. */
export const renewalResumeSchema = z.discriminatedUnion("granted", [
  z.object({
    granted: z.literal(true),
    epoch: z.number().int().nonnegative(),
    digest: z.string(),
    viewDigest: z.string().optional(),
  }),
  z.object({ granted: z.literal(false), reason: z.string(), viewDigest: z.string().optional() }),
]);

const MAX_DEPTH = 8;
const EXPIRED = /^task-grant:expired/;
const find = (err: unknown): Record<string, unknown> | undefined => {
  let e = err;
  for (let i = 0; i < MAX_DEPTH && typeof e === "object" && e !== null; i++) {
    const o = e as Record<string, unknown>;
    if (o.renewable === true) return o;
    if (
      o.name === "CapabilityDeniedError" &&
      typeof o.reason === "string" &&
      EXPIRED.test(o.reason)
    )
      return o;
    e = o.cause;
  }
  return undefined;
};

/** True for a `renewable: true` error, or an effect-runtime `task-grant:expired` denial, anywhere on the cause chain (depth 8). */
export const isRenewable = (err: unknown): boolean => find(err) !== undefined;

/** The broker's input, from the renewable error alone (the flow context carries no principal). Fails closed. */
function requestOf(err: unknown, n: number, fallbackTaskId?: string): RenewalRequest {
  const e = find(err) ?? {};
  const parsed = typeof e.reason === "string" ? parseExpiredReason(e.reason) : undefined;
  const taskId = typeof e.taskId === "string" ? e.taskId : (parsed?.taskId ?? fallbackTaskId);
  const epoch = typeof e.epoch === "number" ? e.epoch : parsed?.epoch;
  if (taskId === undefined || epoch === undefined)
    throw new RenewalDeniedError("the error names no task or epoch and none was given");
  const spent =
    typeof e.lease === "string" && typeof e.spent === "number" ? { [e.lease]: e.spent } : {};
  return { taskId, epoch, spent, renewals: n };
}

/** The flow-context slice `withRenewal` needs (structural: no kernel dependency). */
export interface RenewalContext {
  readonly executionId: string;
  suspend(c: { on: string; correlationKey: string; viewDigest: string }): Promise<unknown>;
  decide<T = unknown>(id: string, decider: () => T | Promise<T>): Promise<T>;
}

export const renewalDecisionId = (id: string, n: number): string =>
  `task-authority:attempt:${id}:${n}`;
export const renewalViewDigest = (gate: string, req: RenewalRequest): string =>
  createHash("sha256").update(JSON.stringify({ gate, req })).digest("hex");

type Attempt = { ok: true } | { request: RenewalRequest };

/**
 * ADR 0150 D5. Runs `fn(attemptId)`, EVERY attempt's outcome recorded as a decision
 * (`renewalDecisionId`: `{ ok: true }` or `{ request }`, readable from `_decisions`). A renewable failure
 * parks on `RENEWAL_GATE`, keyed `<executionId>#<id>#<n>`, with a `viewDigest` over the request (ADR 0117).
 * A granted resume retries under `${id}:r<n>`; refusal, a malformed verdict, or more than `maxRenewals`
 * throws `RenewalDeniedError`. A non-renewable error propagates untouched, recording nothing.
 * - `fn` MUST be replay-pure: only durable `ctx` calls, so that a second call returns the same value from
 *   the log (after an `{ ok: true }` outcome `fn` is called once more, outside the decision, to get it).
 * - `fn` runs inside the decision, so it must not park (no `ctx.suspend`, human step, `receive`).
 * - Steps whose ids derive from the attempt id re-run after a renewal; steps with stable ids replay.
 * - `id` MUST be unique per call site per execution: reusing it (e.g. in a loop) serves a stale outcome.
 */
export async function withRenewal<T>(
  ctx: RenewalContext,
  id: string,
  fn: (attemptId: string) => Promise<T>,
  opts: { maxRenewals?: number; taskId?: string } = {}
): Promise<T> {
  const max = opts.maxRenewals ?? 8;
  for (let n = 0; ; n++) {
    const attempt = n === 0 ? id : `${id}:r${n}`;
    const out = await ctx.decide<Attempt>(renewalDecisionId(id, n), async () => {
      try {
        await fn(attempt);
        return { ok: true };
      } catch (e) {
        if (!isRenewable(e)) throw e;
        if (n >= max) throw new RenewalDeniedError(`more than ${max} renewals`);
        return { request: requestOf(e, n, opts.taskId) };
      }
    });
    if ("ok" in out) return fn(attempt); // served from the completed frames: no second side effect
    const key = `${ctx.executionId}#${id}#${n}`;
    const raw = await ctx.suspend({
      on: RENEWAL_GATE,
      correlationKey: key,
      viewDigest: renewalViewDigest(key, out.request),
    });
    const v = renewalResumeSchema.safeParse(raw);
    if (!v.success) throw new RenewalDeniedError("malformed renewal verdict");
    if (!v.data.granted) throw new RenewalDeniedError(v.data.reason);
  }
}

/** Structural slice of `WorkflowRuntime` that `answerRenewal` drives. */
export interface RenewalRuntime<H> {
  loadState(id: string): Promise<
    | {
        suspendedOn?: { on: string; correlationKey?: string; viewDigest?: string };
        variables: Record<string, unknown>;
      }
    | null
    | undefined
  >;
  resume(id: string, event: { eventType: string; payload: unknown }, opts?: unknown): Promise<H>;
}

/**
 * Operator helper: reads the pending `RenewalRequest` of the execution parked on `RENEWAL_GATE`, asks
 * `broker.renew`, and resumes it with the verdict plus the `viewDigest` echo (ADR 0117). `resumeOpts`
 * (e.g. a principal) pass through to `runtime.resume`. Throws when the execution is not parked there.
 */
export async function answerRenewal<H>(
  runtime: RenewalRuntime<H>,
  broker: {
    renew(r: RenewalRequest): Promise<RenewalVerdict>;
    current?(taskId: string): Promise<{ epoch: number } | undefined>;
  },
  executionId: string,
  resumeOpts?: unknown
): Promise<H> {
  const state = await runtime.loadState(executionId);
  const gate = state?.suspendedOn;
  const key = gate?.correlationKey ?? "";
  const cut = key.lastIndexOf("#");
  const head = `${executionId}#`;
  if (gate?.on !== RENEWAL_GATE || !key.startsWith(head) || cut < head.length)
    throw new Error(`execution "${executionId}" is not parked on ${RENEWAL_GATE}`);
  const decisions = (state?.variables._decisions ?? {}) as Record<
    string,
    { choice?: { request?: RenewalRequest } }
  >;
  const rec = decisions[renewalDecisionId(key.slice(head.length, cut), Number(key.slice(cut + 1)))];
  if (rec?.choice?.request === undefined)
    throw new Error(`no renewal request recorded for "${key}"`);
  const request = rec.choice.request;
  if (gate.viewDigest !== renewalViewDigest(key, request))
    throw new Error(`the recorded renewal request for "${key}" does not match the parked digest`);
  const epoch = (await broker.current?.(request.taskId))?.epoch; // renewed since the park: not stale
  const verdict = await broker.renew(epoch === undefined ? request : { ...request, epoch });
  const payload = {
    ...verdict,
    ...(gate.viewDigest !== undefined && { viewDigest: gate.viewDigest }),
  };
  return runtime.resume(executionId, { eventType: RENEWAL_GATE, payload }, resumeOpts);
}
