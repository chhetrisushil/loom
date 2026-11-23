import { createHash } from "node:crypto";
import { z } from "zod";
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

/** The broker's input, from the renewable error alone (the flow context carries no principal). */
function requestOf(err: unknown, n: number, fallbackTaskId?: string): RenewalRequest {
  const e = find(err) ?? {};
  const m = /task "([^"]+)" epoch (\d+)/.exec(typeof e.reason === "string" ? e.reason : "");
  const taskId = typeof e.taskId === "string" ? e.taskId : (m?.[1] ?? fallbackTaskId);
  if (taskId === undefined)
    throw new RenewalDeniedError("the error names no task and none was given");
  const epoch = typeof e.epoch === "number" ? e.epoch : m ? Number(m[2]) : 0;
  const spent =
    typeof e.lease === "string" && typeof e.spent === "number" ? { [e.lease]: e.spent } : {};
  return { taskId, epoch, spent, renewals: n };
}

/** The flow-context slice `withRenewal` needs (structural: no kernel dependency). */
export interface RenewalContext {
  readonly executionId: string;
  suspend<T = never>(c: { on: string; correlationKey: string; viewDigest: string }): Promise<T>;
  decide<T = unknown>(id: string, decider: () => T | Promise<T>): Promise<T>;
}

const STOP = Symbol("ok");
export const renewalDecisionId = (id: string, n: number): string =>
  `task-authority:attempt:${id}:${n}`;
export const renewalViewDigest = (gate: string, req: RenewalRequest): string =>
  createHash("sha256").update(JSON.stringify({ gate, req })).digest("hex");

/**
 * ADR 0150 D5. Runs `fn(attemptId)`; a renewable failure is recorded as a decision (`renewalDecisionId`:
 * `{ request }`, readable from the execution's `_decisions`) and the run parks on `RENEWAL_GATE`,
 * keyed `<executionId>#<id>#<n>` with a `viewDigest` over that request (ADR 0117). A granted resume retries
 * under `${id}:r<n>`; refusal or more than `maxRenewals` throws `RenewalDeniedError`. Replay serves the
 * failed attempt from its decision without re-running `fn`. `fn`'s results must not depend on a wall clock.
 */
export async function withRenewal<T>(
  ctx: RenewalContext,
  id: string,
  fn: (attemptId: string) => Promise<T>,
  opts: { maxRenewals?: number; taskId?: string } = {}
): Promise<T> {
  const max = opts.maxRenewals ?? 8;
  for (let n = 0; ; n++) {
    let ok: { v: T } | undefined;
    const rec = await ctx
      .decide(renewalDecisionId(id, n), async () => {
        try {
          ok = { v: await fn(n === 0 ? id : `${id}:r${n}`) };
        } catch (e) {
          if (!isRenewable(e)) throw e;
          if (n >= max) throw new RenewalDeniedError(`more than ${max} renewals`);
          return { request: requestOf(e, n, opts.taskId) };
        }
        throw STOP; // a decider that throws records nothing: only failures are recorded
      })
      .catch((e: unknown) => {
        if (e === STOP && ok) return undefined;
        throw e;
      });
    if (rec === undefined) return (ok as { v: T }).v;
    const key = `${ctx.executionId}#${id}#${n}`;
    const verdict = await ctx.suspend<z.infer<typeof renewalResumeSchema>>({
      on: RENEWAL_GATE,
      correlationKey: key,
      viewDigest: renewalViewDigest(key, rec.request),
    });
    if (!verdict.granted) throw new RenewalDeniedError(verdict.reason);
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
  broker: { renew(r: RenewalRequest): Promise<RenewalVerdict> },
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
  const verdict = await broker.renew(rec.choice.request);
  const payload = {
    ...verdict,
    ...(gate.viewDigest !== undefined && { viewDigest: gate.viewDigest }),
  };
  return runtime.resume(executionId, { eventType: RENEWAL_GATE, payload }, resumeOpts);
}
