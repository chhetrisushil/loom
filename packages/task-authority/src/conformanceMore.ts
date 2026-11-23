import { SuspendError } from "@loomwork/core";
import { awaitChild } from "@loomwork/orchestration";
import type { WorkflowRuntime } from "@loomwork/workflow-runtime";
import type { GrantBroker } from "./broker";
import { reserveChildLease } from "./childLease";
import {
  type Check,
  type ConformanceSubject,
  SECRET,
  clock,
  mintReq,
  mk,
  must,
  task,
  until,
} from "./conformanceKit";
import { type Runner, acts, rig } from "./conformanceRuntime";
import { RENEWAL_GATE, answerRenewal, withRenewal } from "./renewal";

export const done = async (rt: WorkflowRuntime, id: string) => {
  let s: Awaited<ReturnType<WorkflowRuntime["loadState"]>> = null;
  await until(async () => {
    s = await rt.loadState(id);
    return s?.status === "completed" || s?.status === "failed";
  }, `${id} to finish`);
  return s as unknown as { status: string; variables: Record<string, unknown> };
};
/** A run that parks for a renewal after `k` acts and finishes after one renewal; `k + 1` acts in all. */
const parkRun = async (
  subject: ConformanceSubject,
  wrap: (b: GrantBroker) => GrantBroker,
  k: number
) => {
  const c = clock();
  const real = subject.makeBroker({
    secret: SECRET,
    now: c.now,
    policy: () => ({ leases: { w: k + 1 } }),
  });
  const broker = wrap(real);
  const g = await broker.mint(mintReq("t", k));
  const runner: Runner = async (ctx) => {
    for (let i = 0; i <= k; i++)
      await withRenewal(ctx as never, `c${i}`, async (a) => ctx.run(task(a), {}));
    return "ok";
  };
  const h1 = rig(broker, c, { f: runner });
  await (await h1.start("f", "e", g)).waitForSuspend();
  const parked = await h1.runtime.loadState("e");
  const h2 = rig(broker, c, { f: runner }, { stores: h1.stores }); // a fresh runtime over the same logs
  const resumed = await answerRenewal(h2.runtime, broker, "e");
  const completion = resumed.waitForCompletion();
  const parkedAgain = resumed.waitForSuspend().then(() => true);
  const finished = await Promise.any([completion.then(() => true), parkedAgain.then(() => false)]);
  must(finished, "a granted renewal did not resume the run to completion: it parked again");
  const end = await completion;
  return { h1, h2, parked, end, broker };
};

export const MORE_CHECKS: Record<string, Check> = {
  "carve.total-spend": async (s) => {
    const c = clock();
    const b = mk(s, undefined, c);
    const g = await b.mint(mintReq("P", 6));
    const parent: Runner = async (ctx) => {
      const res = await reserveChildLease(ctx, "k", { w: 4 });
      await awaitChild(ctx, { key: "k", flowId: "child", input: {}, ...res.spawn });
      await res.settle();
      return acts(ctx, 10);
    };
    const child: Runner = (ctx) => acts(ctx, 10);
    const a = rig(b, c, { parent, child }, { hangMint: true }); // "crash" after the spawn decision, before the child exists
    await (await a.start("parent", "P", g)).waitForSuspend();
    const r = rig(b, c, { parent, child }, { stores: a.stores });
    must((await r.sup.recover()).started === 1, "recovery did not start the child");
    const end = await done(r.runtime, "P");
    const total = a.ran.act + r.ran.act;
    must(end.status === "completed", `parent ended ${end.status}`);
    must(
      total > 0 && total <= 6,
      `children and parent ran ${total} effects, over the parent's ceiling of 6`
    );
    must(
      (await b.current("P::k"))?.leases.w?.ceiling === 4,
      "the child's grant is not the reserved 4"
    );
    // A spawn larger than the reservation (R25): the broker must refuse it, so the child never exists.
    const b2 = mk(s, undefined, c);
    const g2 = await b2.mint(mintReq("P", 6));
    const forged: Runner = async (ctx) => {
      await reserveChildLease(ctx, "k", { w: 2 });
      try {
        await awaitChild(ctx, {
          key: "k",
          flowId: "child",
          input: {},
          lease: { w: 6 },
          leaseParent: "P",
        });
      } catch (e) {
        if (e instanceof SuspendError) throw e;
      }
      return acts(ctx, 10);
    };
    const f = rig(b2, c, { parent: forged, child });
    await f.start("parent", "P", g2);
    await done(f.runtime, "P");
    must(
      (await f.runtime.loadState("P::k")) === null && f.ran.act <= 6,
      `a child was minted beyond the parent's reservation (${f.ran.act} effects ran)`
    );
  },
  "pause-renew": async (s) => {
    const { h1, h2, parked, end } = await parkRun(s, (b) => b, 3);
    must(
      (parked?.suspendedOn as { on?: string } | undefined)?.on === RENEWAL_GATE,
      "exhaustion did not park on the renewal gate"
    );
    must(h1.ran.act === 3, `ran ${h1.ran.act} effects before the park, the grant allows 3`);
    must(end.status === "completed", "the renewed run did not complete");
    must(
      h1.ran.act + h2.ran.act === 4,
      `${h1.ran.act + h2.ran.act} effects ran in all, the renewed grant allows 4`
    );
  },
  replay: async (s) => {
    let calls = 0;
    const count = (b: GrantBroker): GrantBroker =>
      new Proxy(b, {
        get: (t, p) => {
          const v = Reflect.get(t, p) as unknown;
          return typeof v === "function"
            ? (...a: unknown[]) => {
                calls++;
                return (v as (...x: unknown[]) => unknown).apply(t, a);
              }
            : v;
        },
      });
    // Resuming a parked run replays every recorded effect on a fresh runtime. Principal resolution and the
    // renewal answer cost a fixed number of broker calls; a replayed effect must add none, so a run replaying
    // 1 effect and a run replaying 8 make the same number of calls (a literal zero is impossible: even a refused restart resolves its principal).
    const total = async (k: number) => {
      calls = 0;
      await parkRun(s, count, k).catch(() => undefined); // a failed run still makes a countable number of calls
      return calls;
    };
    const one = await total(1);
    const eight = await total(8);
    must(one > 0, "the counting proxy saw no broker calls");
    must(
      one === eight,
      `replaying 8 effects made ${eight} broker calls, replaying 1 made ${one}: a replayed effect called the broker`
    );
  },
};
