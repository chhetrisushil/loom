import { createHash } from "node:crypto";
import { isTerminalLayer } from "./toolFailure";

/**
 * ADR 0150 D5, the agent half. `@loomwork/agent` does NOT depend on `@loomwork/task-authority`, so this
 * file restates the few pure rules `withRenewal` / `answerRenewal` share, structurally. They MUST stay equal
 * to `task-authority/src/renewal.ts`: `authorityRenewal.test.ts` pins the digest, the decision id, the
 * terminal-name list and the detection against the real exports, so one operator helper answers both.
 */
export const DEFAULT_RENEWAL_GATE = "task-authority:renew";

/** The request an operator's broker is asked to renew (same shape as task-authority's `RenewalRequest`). */
export interface AuthorityRenewalRequest {
  taskId: string;
  epoch: number;
  spent: Record<string, number>;
  renewals: number;
}

/** The park was refused, or the request cannot be made (fails closed). Terminal for the loop. */
export class AuthorityRenewalDeniedError extends Error {
  readonly retryable = false;
  constructor(reason: string) {
    super(`authority renewal denied: ${reason}`);
    this.name = "AuthorityRenewalDeniedError";
  }
}

const EXPIRED = /^task-grant:expired: grant for task "(.*)" epoch (\d+) expired at /s;
/**
 * Walks the cause chain (depth 8) and stops at the FIRST terminal layer (`isTerminalLayer`): a kill switch,
 * safety or divergence error wrapping a renewable one never parks. A layer that is itself renewable (or an
 * expired-grant denial, a `CapabilityDeniedError` and so terminal by name) is checked first.
 */
const find = (err: unknown): Record<string, unknown> | undefined => {
  let e = err;
  for (let i = 0; i < 8 && typeof e === "object" && e !== null; i++) {
    const o = e as Record<string, unknown>;
    if (o.renewable === true) return o;
    if (
      o.name === "CapabilityDeniedError" &&
      typeof o.reason === "string" &&
      EXPIRED.test(o.reason)
    )
      return o;
    if (isTerminalLayer(e)) return undefined;
    e = o.cause;
  }
  return undefined;
};

/** A `renewable: true` error, or a `task-grant:expired` denial, anywhere on the cause chain (depth 8). */
export const isRenewable = (err: unknown): boolean => find(err) !== undefined;

/** The broker's input from the renewable error alone; throws (fails closed) when it names no task or epoch. */
export function renewalRequestOf(err: unknown, n: number): AuthorityRenewalRequest {
  const e = find(err) ?? {};
  const m = typeof e.reason === "string" ? EXPIRED.exec(e.reason) : null;
  const taskId = typeof e.taskId === "string" ? e.taskId : m?.[1];
  const epoch = typeof e.epoch === "number" ? e.epoch : m ? Number(m[2]) : undefined;
  if (taskId === undefined || epoch === undefined)
    throw new AuthorityRenewalDeniedError("the error names no task or epoch");
  const spent =
    typeof e.lease === "string" && typeof e.spent === "number" ? { [e.lease]: e.spent } : {};
  return { taskId, epoch, spent, renewals: n };
}

export const renewalDecisionId = (id: string, n: number): string =>
  `task-authority:attempt:${id}:${n}`;
export const renewalViewDigest = (key: string, req: AuthorityRenewalRequest): string =>
  createHash("sha256")
    .update(JSON.stringify({ gate: key, req }))
    .digest("hex");

/** Throws `AuthorityRenewalDeniedError` unless the resume payload is a well-formed grant. */
export function requireGranted(raw: unknown): void {
  const v = (raw ?? {}) as Record<string, unknown>;
  if (v.granted === true && Number.isInteger(v.epoch) && typeof v.digest === "string") return;
  throw new AuthorityRenewalDeniedError(
    v.granted === false && typeof v.reason === "string" ? v.reason : "malformed renewal verdict"
  );
}
