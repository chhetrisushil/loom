import type { GrantBroker, MintRequest, RenewalRequest } from "./broker";
import { CHILD_LEASE_TOOL } from "./childLease";
import type { GrantKeys } from "./grant";
import type { RenewalPolicy } from "./renew";

/** What the kit needs from you: a broker. Honour `secret` (grant signing), `now` (every clock read) and `policy` (renewals). */
export interface ConformanceSubject {
  makeBroker(o: { secret: GrantKeys; now: () => number; policy?: RenewalPolicy }): GrantBroker;
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
export const mustRefuse = async (p: Promise<unknown>, msg: string): Promise<void> => {
  const threw = await p.then(
    () => false,
    () => true
  );
  must(threw, msg);
};
export const req = (taskId: string, epoch: number, renewals: number): RenewalRequest => ({
  taskId,
  epoch,
  spent: {},
  renewals,
});
export const task = (id: string, toolId = "act") =>
  ({ _tag: "TaskDefinition", kind: "tool", id, toolId }) as never;
export async function until(cond: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await cond())) {
    must(Date.now() < deadline, `timed out on ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
export const mk = (s: ConformanceSubject, policy?: RenewalPolicy, c = clock()) =>
  s.makeBroker({ secret: SECRET, now: c.now, ...(policy && { policy }) });
