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
 * Idempotent: a second call (a retry poll, a racing node) finds the minted grant and returns the same one;
 * a lost mint race re-reads the winner. It does NOT mint a second grant, so nothing is double-reserved.
 * A missing, expired, revoked or exhausted schedule grant, an aborted `signal` or a broker failure THROWS a
 * `ScheduleGrantError` (the occurrence is skipped and reported as `SchedulePrincipalError`): never an anonymous run.
 * Wire it: `new TimerService(rt, timers, { principalFor: schedulePrincipalFor(broker, { lease }) })`.
 */
export function schedulePrincipalFor(
  broker: Pick<GrantBroker, "mint" | "current">,
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
      const leases = Object.fromEntries(
        Object.entries(o.lease).map(([n, ceiling]) => [
          n,
          { ceiling, effects: root.leases[n]?.effects ?? [] },
        ])
      );
      try {
        g = await broker.mint({
          taskId: tickId,
          issuedTo: root.issuedTo,
          effects: o.effects ?? root.effects,
          leases,
          ttlMs: o.ttlMs ?? 300_000,
          parent: { taskId: schedule.id },
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
 * ADR 0150 D6/D12 - after a tick COMPLETED, record what it left unused at the broker (`settleChild`, net of its
 * `lease.<n>` meters), so the schedule's owner can take it once (`broker.takeReturn(tickId, scheduleId)`). A tick that
 * has not completed records nothing (R7). Returns whether it settled. Call it from the host when a tick is done.
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
