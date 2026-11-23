import type { PrincipalChain } from "@loomwork/effect-runtime";
import { type GrantBroker, GrantBrokerError } from "./broker";
import { childGrantMinter } from "./childLease";
import { ScheduleGrantError } from "./errors";

/** What each tick may hold: `lease` amounts (per lease name, carved from the schedule grant), and optional narrowing. */
export interface SchedulePrincipalOptions {
  lease: Record<string, number>;
  /** Lifetime of a tick's grant (also capped at the schedule grant's expiry). Default 5 minutes. */
  ttlMs?: number;
  /** Narrow a tick's effects (default: the schedule grant's). The broker refuses a widening. */
  effects?: string[];
  now?: () => number;
}

/**
 * ADR 0150 D12 + ADR 0152 D2 - the `TimerService` `principalFor` hook for a schedule with an approved schedule grant.
 * Each occurrence runs under its OWN child grant of the schedule grant, taskId `<scheduleId>@<occurrence>` (= the
 * execution id, so the codec's claim binds it to exactly that run), its lease carved per tick (ceilings = `lease`).
 * The tick grant inherits the schedule grant's `reads` and `sandbox` (a child may only narrow them) and each lease's
 * `effects` are the schedule's, intersected with `o.effects`. Idempotent (R25): the hook RESERVES the tick's lease at the
 * broker (`reserve`, idempotent) and mints exactly ONE grant per (schedule, occurrence); a second call (a retry poll, a
 * racing node) returns the same grant, a lost mint race re-reads the winner. A re-read grant that has EXPIRED is an
 * error, not a principal. A tick that minted but never started is released by `reclaimScheduledTick`.
 * A missing, expired, revoked or exhausted schedule grant, an aborted `signal` or a broker failure THROWS a
 * `ScheduleGrantError` (the occurrence is skipped and reported as `SchedulePrincipalError`): never an anonymous run.
 * Wire it: `new TimerService(rt, timers, { principalFor: schedulePrincipalFor(broker, { lease }) })`.
 */
export function schedulePrincipalFor(
  broker: Pick<GrantBroker, "mint" | "current" | "reserve">,
  o: SchedulePrincipalOptions
): (
  schedule: { id: string },
  occurrence: number,
  ctx: { signal: AbortSignal }
) => Promise<PrincipalChain> {
  const now = o.now ?? Date.now;
  return async (schedule, occurrence, { signal }) => {
    const tickId = `${schedule.id}@${occurrence}`;
    const fail = (why: string, cause?: unknown): never => {
      throw new ScheduleGrantError(schedule.id, why, cause);
    };
    const live = () => signal.aborted && fail("the principal hook was aborted");
    let g = await broker.current(tickId);
    if (g === undefined) {
      const root = await broker.current(schedule.id);
      live();
      if (root === undefined)
        return fail("no approved schedule grant (never approved, or revoked)");
      if (!(root.exp > now())) return fail("the schedule grant has expired");
      const only = (xs: readonly string[]) =>
        o.effects ? xs.filter((x) => o.effects?.includes(x)) : xs;
      const leases = Object.fromEntries(
        Object.entries(o.lease).map(([n, ceiling]) => [
          n,
          { ceiling, effects: only(root.leases[n]?.effects ?? []) },
        ])
      );
      try {
        await broker.reserve(schedule.id, tickId, o.lease);
        g = await broker.mint({
          taskId: tickId,
          issuedTo: root.issuedTo,
          effects: o.effects ?? root.effects,
          leases,
          ttlMs: o.ttlMs ?? 300_000,
          parent: { taskId: schedule.id },
          ...(root.reads !== undefined && { reads: root.reads }),
          ...(root.sandbox !== undefined && { sandbox: root.sandbox }),
        });
      } catch (e) {
        g = await broker.current(tickId); // a concurrent call won the mint: take its grant
        if (g === undefined)
          return fail(
            e instanceof GrantBrokerError ? e.message : "the broker refused the tick grant",
            e
          );
      }
    }
    live();
    if (!(g.exp > now())) return fail(`the tick grant ${tickId} has expired`);
    if (g.parentId !== schedule.id)
      return fail(`grant ${tickId} is not a child of the schedule grant`);
    return {
      actor: g.issuedTo,
      taskGrant: g,
      ...(g.tenant !== undefined && { tenant: g.tenant }),
      ...(g.onBehalfOf !== undefined && { onBehalfOf: g.onBehalfOf }),
    };
  };
}

/** The runtime slice `settleScheduledTick` reads. */
export interface TickRuntime {
  loadState(
    id: string,
    opts?: unknown
  ): Promise<{ status?: string; variables: Record<string, unknown> } | null | undefined>;
  systemOptions(): object;
}

/**
 * ADR 0150 D6/D12 - after a tick COMPLETED, settle it at the broker (`settleChild`, net of its `lease.<n>` meters).
 * The schedule grant has no fold, so the broker REFUNDS the unused lease to its headroom, once (R25); `takeReturn`
 * then yields nothing. A tick that has not completed records nothing (R7). Returns whether it settled. Call it
 * from the host when a tick is done.
 */
export async function settleScheduledTick(
  runtime: TickRuntime,
  broker: GrantBroker,
  scheduleId: string,
  occurrence: number
): Promise<boolean> {
  const id = `${scheduleId}@${occurrence}`;
  const st = await runtime.loadState(id, runtime.systemOptions());
  if (st?.status !== "completed") return false;
  const custom =
    (st.variables._resources as { custom?: Record<string, number> } | undefined)?.custom ?? {};
  await childGrantMinter(broker, { ttlMs: 1 }).settleChild(id, custom);
  return true;
}

/** After a tick's grant has expired, wait this long before treating an unclaimed one as never started (covers clock skew and a start in flight). */
export const RECLAIM_MARGIN_MS = 60_000;

/**
 * R25 (I4) - release a tick that MINTED a grant but never started (a skip after the mint, a crash, a lost race). Once the
 * tick's grant is unclaimed (`holder` undefined) and expired by `marginMs` (default `RECLAIM_MARGIN_MS`), call
 * `settleUnstarted(tickId, scheduleId)`: the grant is revoked and its reservation returns to the schedule grant's
 * headroom. A claimed (started) tick is never reclaimed (settle it with `settleScheduledTick`), and a grant that has
 * not expired is left alone (another node may still start it). Returns `reclaimed`, `started`, `pending` or `none`.
 * Run it from a periodic sweep over the occurrences you skipped.
 */
export async function reclaimScheduledTick(
  broker: Pick<GrantBroker, "current" | "holder" | "settleUnstarted">,
  scheduleId: string,
  occurrence: number,
  o: { marginMs?: number; now?: () => number } = {}
): Promise<"reclaimed" | "started" | "pending" | "none"> {
  const id = `${scheduleId}@${occurrence}`;
  const g = await broker.current(id);
  if (g === undefined) return "none";
  if ((await broker.holder(id)) !== undefined) return "started";
  if ((o.now ?? Date.now)() < g.exp + (o.marginMs ?? RECLAIM_MARGIN_MS)) return "pending";
  await broker.settleUnstarted(id, scheduleId);
  return "reclaimed";
}
