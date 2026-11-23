import { type EffectContext, ToolEffect } from "@loomwork/effect-runtime";
import { type GrantBroker, GrantBrokerError } from "./broker";
import {
  LeaseDimensionDroppedError,
  LeaseDurabilityError,
  LeaseExhaustedError,
  LeaseGrantInvalidError,
} from "./errors";
import { type GrantKeys, type TaskGrant, sealKeys, verifyTaskGrant } from "./grant";

/**
 * ADR 0150 D6. The bookkeeping effect behind `reserveChildLease`: it meters `lease.<n>.reserved` /
 * `lease.<n>.returned` into the PARENT's own fold. It is not a leased side effect: `taskLeaseMiddleware`
 * lets it through uncounted, and the grant's `effects` must list it when `TaskGrantAuthorizer` is wired.
 */
export const CHILD_LEASE_TOOL = "task-authority:child-lease";

type Amounts = Record<string, number>;
type Op = { op: "reserve"; lease: Amounts; child: string } | { op: "return"; child: string };

/** R33: the brand is module-private (a WeakSet, so not forgeable by naming a property); only `childLeaseEffect` sets it. */
const branded = new WeakSet<object>();
/** R33: is `e` the real effect `childLeaseEffect()` made? The lease middleware exempts only that one. */
export const isChildLeaseEffect = (e: unknown): boolean =>
  typeof e === "object" && e !== null && branded.has(e);
type Out = { taskId: string; lease?: Amounts };
const ok = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const read = (ctx: EffectContext, d: string): number => ctx.readResources?.().custom?.[d] ?? 0;

/**
 * Register as `CHILD_LEASE_TOOL`. One synchronous block reads the LIVE fold, refuses, meters and re-reads
 * (ADR 0151), so the parent's available lease, `ceiling - spent - reserved + returned`, is exact. A refusal
 * is a renewable `LeaseExhaustedError`. `return` takes NO amount from the flow: it asks the broker for the
 * one-time take of what the supervisor recorded for that child (R25). Not idempotent: a crash inside the
 * step parks it in doubt (an operator resolves it): for a RESERVE the operator adopts with output
 * `{ taskId, lease }`, and a wrong value changes the spawn ceiling the minter then checks against the fold
 * (so it cannot exceed what was metered); an in-doubt RETURN is lost, never doubled.
 * Trust line (ADR 0151 D7): `installTaskAuthority` reserves the `lease.` meter prefix, so FLOW code cannot
 * forge these counters; grants bound the model and flow code, while app-registered effects and middleware
 * (this effect, the lease middleware) are trusted.
 */
export function childLeaseEffect(o: {
  secret: GrantKeys;
  broker: Pick<GrantBroker, "takeReturn" | "reserve">;
}): ToolEffect<Op, Out> {
  const secret = sealKeys(o.secret);
  const effect = new ToolEffect<Op, Out>(
    async (input, ctx) => {
      const grant = verifyTaskGrant(secret, ctx.principal?.taskGrant as TaskGrant);
      if (grant === undefined) throw new LeaseGrantInvalidError();
      if (ctx.readResources === undefined || ctx.flush === undefined)
        throw new LeaseDurabilityError(CHILD_LEASE_TOOL);
      const reserve = input.op === "reserve";
      // R36 (I3): a flow may only name ITS OWN children, or it could squat another execution's child id
      if (
        reserve &&
        !(typeof input.child === "string" && input.child.startsWith(`${ctx.executionId}::`))
      )
        throw new GrantBrokerError("a reservation names a child of this execution");
      const want = reserve ? input.lease : await o.broker.takeReturn(input.child, grant.taskId);
      const custom: Record<string, number> = {};
      const watch: [string, number][] = [];
      for (const [n, amount] of Object.entries(want)) {
        const spec = grant.leases[n];
        if (spec === undefined) throw new GrantBrokerError(`this task has no lease ${n}`);
        if (!reserve && amount === 0) continue;
        if (!ok(amount))
          throw new GrantBrokerError(`lease ${n}: amount must be a positive integer`);
        const [spent, reserved, returned] = ["", ".reserved", ".returned"].map((s) =>
          read(ctx, `lease.${n}${s}`)
        ) as [number, number, number];
        const dim = `lease.${n}.${reserve ? "reserved" : "returned"}`;
        if (reserve) {
          const used = spent + reserved - returned;
          if (amount > spec.ceiling - used)
            throw new LeaseExhaustedError(n, spec.ceiling, used, grant.epoch, grant.taskId);
        } else if (returned + amount > reserved)
          throw new GrantBrokerError(`lease ${n}: cannot return more than was reserved`);
        custom[dim] = amount;
        watch.push([dim, read(ctx, dim) + amount]);
      }
      if (watch.length > 0) {
        ctx.emit("RESOURCE_METERED", { custom });
        for (const [d, w] of watch) if (read(ctx, d) !== w) throw new LeaseDimensionDroppedError(d);
        await ctx.flush();
      }
      // R33: the broker records it only AFTER the fold holds it, so a record never exceeds the reservation.
      // A throw here leaks the fold reservation (the safe direction: nothing is ever returned for it).
      if (input.op === "reserve") await o.broker.reserve(grant.taskId, input.child, input.lease);
      return reserve ? { taskId: grant.taskId, lease: input.lease } : { taskId: grant.taskId };
    },
    { idempotent: false }
  );
  branded.add(effect);
  return effect;
}

/** The flow-context slice the helpers need (structural: no kernel dependency). */
export interface ChildLeaseContext {
  readonly executionId: string;
  run(task: never, input: never): Promise<unknown>;
}

const step = (kind: string, key: string, attempt: string | undefined) =>
  ({
    _tag: "TaskDefinition",
    kind: "tool",
    id: `task-authority:${kind}:${key}${attempt === undefined ? "" : `:${attempt}`}`,
    toolId: CHILD_LEASE_TOOL,
  }) as never;

/**
 * ADR 0150 D6, parent side. Reserves `lease` for the child `childKey` (the key you give `awaitChild`; one
 * reservation per child key, the step id is derived from it, so reusing a key serves the FIRST reservation)
 * as one RECORDED step: a recovery re-run serves it from the log instead of metering again. Throws a
 * renewable `LeaseExhaustedError` when the parent's live available lease is short (pass `withRenewal`'s
 * `attemptId` as `attempt`). Spread `spawn` (the lease comes from the RECORDED step, not from your argument
 * of a later call) into `awaitChild` / a group member. Whatever the flow passes, the supervisor's minter
 * refuses a child the parent's fold did not reserve (R25). After a COMPLETED child, `settle()` takes the
 * unused amount the supervisor recorded at the broker and meters it as `returned`; a failed or cancelled
 * child records nothing, so there is nothing to take (R7); a child that NEVER STARTED (mint refused, supervisor
 * gave up) returns its WHOLE reservation through the same `settle()` (R33). Concurrent reservations are exact (the check and
 * the meter are one synchronous block); never reuse a child key.
 */
export async function reserveChildLease(
  ctx: ChildLeaseContext,
  childKey: string,
  lease: Amounts,
  opts: { attempt?: string } = {}
): Promise<{ spawn: { lease: Amounts; leaseParent: string }; settle(): Promise<void> }> {
  // the child id scheme of `childIdFor` (orchestration): `<parentExecutionId>::<key>`
  const child = `${ctx.executionId}::${childKey}`;
  const r = (await ctx.run(step("reserve", childKey, opts.attempt), {
    op: "reserve",
    lease,
    child,
  } as never)) as Required<Out>;
  return {
    spawn: { lease: r.lease, leaseParent: r.taskId },
    async settle() {
      await ctx.run(step("return", childKey, opts.attempt), { op: "return", child } as never);
    },
  };
}

/** The shape `SupervisorDeps.taskAuthority` takes (structural: orchestration is not a dependency). */
export interface ChildGrantMinter {
  settleChild(childId: string, resources: Record<string, number>): Promise<void>;
  /** R33: the child will never start; its whole reservation becomes takeable (see `GrantBroker.settleUnstarted`). */
  settleUnstarted?(childId: string, parentTaskId: string): Promise<void>;
  mintChildGrant(
    parent: { executionId: string; taskId?: string; resources: Record<string, number> },
    spec: {
      childId: string;
      lease: Amounts;
      grants?: readonly string[];
      expiresAt?: number;
    }
  ): Promise<{ actor: string; taskGrant: TaskGrant; tenant?: string; onBehalfOf?: string }>;
}

// R30/R34: the chain must carry the grant's signed identity, or the codec's toRef refuses it.
const chainOf = (g: TaskGrant) => ({
  actor: g.issuedTo,
  taskGrant: g,
  ...(g.tenant !== undefined && { tenant: g.tenant }),
  ...(g.onBehalfOf !== undefined && { onBehalfOf: g.onBehalfOf }),
});

/**
 * ADR 0150 D6, supervisor side: `superviseChildren({ taskAuthority: childGrantMinter(broker, { ttlMs }) })`.
 * Mints the child's grant (`taskId` = the child id) from the parent's: ceilings = the reserved amounts, same
 * lease effects, scope = `grants` or the parent's. The broker enforces the subset rule and that the sum of
 * children's ceilings stays within the parent's. Idempotent (a recovery re-start returns the minted grant).
 * The parent task must be HELD by `parent.executionId` (`holder`, side-effect free; never `claim`), and
 * `parent.resources` (the parent's fold) must show the reservation (`parentReserved`), else a flow could
 * carve another task's lease or more than it reserved. `settleChild` records what a completed child left
 * unused (net `lease.<n> + reserved - returned`); the parent takes it once through `reserveChildLease().settle`.
 */
export function childGrantMinter(
  broker: GrantBroker,
  o: { ttlMs: number; now?: () => number }
): ChildGrantMinter {
  return {
    async settleChild(childId, c) {
      const spend: Amounts = {};
      for (const k of Object.keys(c)) {
        if (!k.startsWith("lease.") || k.endsWith(".reserved") || k.endsWith(".returned")) continue;
        const n = k.slice(6);
        spend[n] = (c[k] ?? 0) + (c[`${k}.reserved`] ?? 0) - (c[`${k}.returned`] ?? 0);
      }
      await broker.settleChild(childId, spend);
    },
    settleUnstarted: (childId, parentTaskId) => broker.settleUnstarted(childId, parentTaskId),
    async mintChildGrant(parent, spec) {
      const pid = parent.taskId;
      if (pid === undefined) throw new GrantBrokerError("the spawn names no parent task");
      if ((await broker.holder(pid)) !== parent.executionId)
        throw new GrantBrokerError(`task ${pid} is not held by ${parent.executionId}`);
      const taskId = spec.childId;
      const held = await broker.current(taskId);
      if (held !== undefined && held.issuedTo === spec.childId && held.parentId === pid)
        return chainOf(held);
      const pg = await broker.current(pid);
      if (pg === undefined) throw new GrantBrokerError(`parent task ${pid} is unknown or revoked`);
      const leases: TaskGrant["leases"] = {};
      for (const [n, ceiling] of Object.entries(spec.lease)) {
        const ps = pg.leases[n];
        if (ps === undefined) throw new GrantBrokerError(`parent has no lease ${n}`);
        leases[n] = { ceiling, effects: ps.effects };
      }
      const ttlMs = spec.expiresAt === undefined ? o.ttlMs : spec.expiresAt - (o.now ?? Date.now)();
      const taskGrant = await broker.mint({
        taskId,
        issuedTo: spec.childId,
        effects: spec.grants === undefined ? pg.effects : [...spec.grants],
        leases,
        ttlMs,
        parent: { taskId: pid },
        // S-R4: a child inherits the parent's read scope and isolation (the broker refuses a widening)
        ...(pg.reads !== undefined && { reads: pg.reads }),
        ...(pg.sandbox !== undefined && { sandbox: pg.sandbox }),
        parentReserved: Object.fromEntries(
          Object.keys(leases).map((n) => [n, parent.resources[`lease.${n}.reserved`] ?? 0])
        ),
      });
      return chainOf(taskGrant);
    },
  };
}
