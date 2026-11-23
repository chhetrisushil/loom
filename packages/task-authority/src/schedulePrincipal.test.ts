import { schedule$ } from "@loomwork/core";
import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  type ExecutionAuthzRequest,
  type FlowRunner,
  SchedulePrincipalError,
  TimerService,
  WorkflowRuntime,
} from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ScheduleGrantError } from "./errors";
import type { TaskGrant } from "./grant";
import { installTaskAuthority } from "./install";
import { taskLeaseMiddleware } from "./lease";
import { InMemoryGrantBroker } from "./renew";
import { mintScheduleGrant } from "./scheduleGrant";
import { schedulePrincipalFor, settleScheduledTick } from "./schedulePrincipal";

const SECRET = "tick-secret";
const MINUTE = 60_000;
const T0 = 28_333_334 * MINUTE + MINUTE / 2;
const first = (Math.floor(T0 / MINUTE) + 1) * MINUTE;
const every = schedule$<Record<string, never>>({
  id: "nightly",
  cron: "* * * * *",
  flowId: "tick-flow",
  input: {},
});
const task = (id: string) => ({ _tag: "TaskDefinition", kind: "tool", id, toolId: "act" }) as never;

function boot(o: { ttlMs?: number; ceiling?: number; tick?: number; fail?: boolean } = {}) {
  const clock = { t: T0 };
  const broker = new InMemoryGrantBroker({ secret: SECRET, now: () => clock.t });
  const seen: (PrincipalChain | undefined)[] = [];
  const committed: ExecutionAuthzRequest[] = [];
  const effects: EffectRuntime = new EffectRuntime([
    taskLeaseMiddleware({ secret: SECRET, source: broker, effects: () => effects }),
  ]);
  effects.register(
    "act",
    new ToolEffect(async (_a, ctx) => {
      seen.push((ctx as { principal?: PrincipalChain }).principal);
      if (o.fail === true) throw new Error("boom");
      return { ok: true };
    })
  );
  const timerStore = new InMemoryTimerStore();
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    timerStore,
    executionAuthorizer: {
      authorize: () => ({ allowed: true }),
      committed: (r) => void committed.push(r),
    },
    executionAuthz: { requirePrincipal: true },
    onWarn: () => {},
  });
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    await ctx.execute(task("one"), {});
    await ctx.execute(task("two"), {});
    return { ok: true };
  };
  const definition: FlowDefinition = {
    _tag: "FlowDefinition",
    id: "tick-flow",
    name: "tick-flow",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    steps: [],
  };
  runtime.registerFlow(definition, runner);
  installTaskAuthority(runtime, { source: broker, secret: SECRET, now: () => clock.t });
  const hook = schedulePrincipalFor(broker, { lease: { calls: o.tick ?? 50 }, now: () => clock.t });
  const errors: unknown[] = [];
  const service = new TimerService(runtime, timerStore, {
    schedules: [every],
    now: () => clock.t,
    principalFor: hook,
    onError: (_id, e) => void errors.push(e),
  });
  const approve = (): Promise<TaskGrant> =>
    mintScheduleGrant(broker, {
      scheduleId: "nightly",
      issuedTo: "svc-reports",
      effects: ["act"],
      leases: { calls: { ceiling: o.ceiling ?? 100, effects: ["act"] } },
      ttlMs: o.ttlMs ?? 30 * MINUTE,
      tenant: "acme",
    });
  const tickAt = async (t: number) => {
    clock.t = t;
    await service.tick(t);
  };
  return {
    tickAt,
    clock,
    broker,
    seen,
    committed,
    runtime,
    eventStore,
    hook,
    service,
    errors,
    approve,
  };
}
const sig = () => ({ signal: new AbortController().signal });
const occ = (n: number) => first + n * MINUTE;

describe("per-tick child grants (ADR 0150 D12, S10c)", () => {
  it("each occurrence runs under its own child grant of the schedule grant", async () => {
    // Kills: ticks sharing ONE grant (one ceiling for all), an anonymous start, or a child whose root is not the schedule grant.
    const app = boot();
    const root = await app.approve();
    await app.tickAt(first);
    await app.tickAt(occ(1));
    expect(app.errors).toEqual([]);
    expect(app.seen).toHaveLength(4);
    const ids = [...new Set(app.seen.map((p) => (p?.taskGrant as TaskGrant).taskId))];
    expect(ids).toEqual([`nightly@${first}`, `nightly@${occ(1)}`]);
    for (const p of app.seen) {
      expect(p?.taskGrant).toMatchObject({
        rootId: root.rootId,
        parentId: "nightly",
        issuedTo: "svc-reports",
        tenant: "acme",
      });
      expect((p?.taskGrant as TaskGrant).leases.calls?.ceiling).toBe(50);
    }
    expect(
      app.committed.map((c) => (c.principal?.taskGrant as TaskGrant | undefined)?.taskId)
    ).toEqual(ids);
  });

  it("a re-called or concurrent hook for one occurrence returns the same grant and reserves once", async () => {
    // Kills: re-minting per call (duplicate throws), or reserving per call (two 50s would exhaust 100 before occurrence 3 is asked).
    const app = boot();
    await app.approve();
    const a = await Promise.all([1, 2, 3].map(() => app.hook(every, first, sig())));
    const b = await Promise.all([1, 2, 3].map(() => app.hook(every, occ(1), sig())));
    const digests = (xs: PrincipalChain[]) => new Set(xs.map((x) => JSON.stringify(x.taskGrant)));
    expect(digests(a).size).toBe(1);
    expect(digests(b).size).toBe(1);
    await expect(app.hook(every, occ(2), sig())).rejects.toBeInstanceOf(ScheduleGrantError); // 50 + 50 + 50 > 100
  });

  it("an exhausted schedule ceiling skips the occurrence: SchedulePrincipalError, nothing runs, nothing anonymous", async () => {
    // Kills: falling back to an anonymous/system run when the schedule budget is spent.
    const app = boot();
    await app.approve();
    for (let i = 0; i < 3; i++) {
      await app.tickAt(occ(i));
    }
    expect(app.errors).toHaveLength(1);
    expect(app.errors[0]).toBeInstanceOf(SchedulePrincipalError);
    expect(String(((app.errors[0] as SchedulePrincipalError).cause as Error).message)).toContain(
      "headroom"
    );
    expect((await app.eventStore.read(`nightly@${occ(2)}`)).length).toBe(0);
    expect(app.seen).toHaveLength(4);
  });

  it("an expired schedule grant skips the occurrence", async () => {
    // Kills: ticks continuing past the human-approved expiry (a child clamps to the parent's exp, but a hook that ignored it would run on a dead root).
    const app = boot({ ttlMs: MINUTE });
    await app.approve(); // exp = first + 1 minute
    await app.tickAt(first);
    await app.tickAt(occ(1));
    expect(app.errors).toHaveLength(1);
    expect(String(((app.errors[0] as SchedulePrincipalError).cause as Error).message)).toContain(
      "expired"
    );
    expect((await app.eventStore.read(`nightly@${occ(1)}`)).length).toBe(0);
  });

  it("an unapproved schedule has no grant and no runs", async () => {
    // Kills: running a schedule nobody approved (the hook naming a default principal).
    const app = boot();
    await app.tickAt(first);
    expect(app.errors).toHaveLength(1);
    expect(String(((app.errors[0] as SchedulePrincipalError).cause as Error).message)).toContain(
      "no approved schedule grant"
    );
    expect(await app.broker.current("nightly")).toBeUndefined();
    expect(app.seen).toHaveLength(0);
    expect((await app.eventStore.read(`nightly@${first}`)).length).toBe(0);
  });

  it("a revoked schedule grant stops later ticks", async () => {
    // Kills: ticks outliving a revoke (children of a revoked root must not be minted).
    const app = boot();
    await app.approve();
    await app.broker.revoke("nightly", "stop");
    await expect(app.hook(every, first, sig())).rejects.toBeInstanceOf(ScheduleGrantError);
  });

  it("an aborted hook mints nothing", async () => {
    // Kills: minting after the TimerService timed the hook out (a late wake would leak a reservation for a skipped tick).
    const app = boot();
    await app.approve();
    const c = new AbortController();
    c.abort();
    await expect(app.hook(every, first, { signal: c.signal })).rejects.toBeInstanceOf(
      ScheduleGrantError
    );
    expect(await app.broker.current(`nightly@${first}`)).toBeUndefined();
  });

  it("a completed tick's unspent lease settles back once; a tick that never ran records nothing", async () => {
    // Kills: settling the gross ceiling (over-returning), settling a tick that did not complete (R7), or settling twice.
    const app = boot({ tick: 5 });
    await app.approve();
    await app.tickAt(first);
    expect(await settleScheduledTick(app.runtime as never, app.broker, "nightly", first)).toBe(
      true
    );
    expect(await app.broker.takeReturn(`nightly@${first}`, "nightly")).toEqual({ calls: 3 }); // 5 reserved, 2 used
    expect(await app.broker.takeReturn(`nightly@${first}`, "nightly")).toEqual({});
    expect(await settleScheduledTick(app.runtime as never, app.broker, "nightly", occ(9))).toBe(
      false
    ); // never ran
  });

  it("a FAILED tick records nothing (R7)", async () => {
    // Kills: settling a tick that did not complete (its unused lease would be handed back although the work may have half-run).
    const app = boot({ tick: 5, fail: true });
    await app.approve();
    await app.tickAt(first);
    expect(await settleScheduledTick(app.runtime as never, app.broker, "nightly", first)).toBe(
      false
    );
    expect(await app.broker.takeReturn(`nightly@${first}`, "nightly")).toEqual({});
  });
});
