import type { GrantBroker, MintRequest } from "./broker";
import { CHILD_LEASE_TOOL } from "./childLease";
import type { RenewalPolicy } from "./renew";

/** What the kit needs from you: a broker. Honour `secret` (grant signing), `now` (every clock read) and `policy` (renewals). */
export interface ConformanceSubject {
  makeBroker(o: { secret: string; now: () => number; policy?: RenewalPolicy }): GrantBroker;
}
export type CheckStatus = "passed" | "failed" | "skipped";
export interface ConformanceResult {
  id: string;
  status: CheckStatus;
  /** Why it failed or was skipped. */
  message?: string;
}
export interface ConformanceReport {
  ok: boolean;
  results: ConformanceResult[];
}

// A check returns nothing (passed) or `skipped:<reason>`.
// biome-ignore lint/suspicious/noConfusingVoidType: most checks return nothing
export type Check = (s: ConformanceSubject) => Promise<string | void>;

export const SECRET = "conformance-secret";
export const TTL = 60_000;
export const clock = () => {
  const c = { t: 1_000_000, now: () => c.t };
  return c;
};
export const must = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
export const lease = (ceiling: number) => ({ w: { ceiling, effects: ["act"] } });
export const mintReq = (taskId: string, ceiling: number, parent?: string): MintRequest => ({
  taskId,
  issuedTo: taskId,
  effects: ["act", CHILD_LEASE_TOOL],
  leases: lease(ceiling),
  ttlMs: TTL,
  ...(parent !== undefined && { parent: { taskId: parent } }),
});
export const refused = (p: Promise<unknown>) =>
  p.then(
    () => false,
    () => true
  );
export const mk = (s: ConformanceSubject, policy?: RenewalPolicy, c = clock()) =>
  s.makeBroker({ secret: SECRET, now: c.now, ...(policy && { policy }) });
