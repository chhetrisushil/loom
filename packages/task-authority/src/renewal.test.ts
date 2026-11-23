import type { FlowDefinition } from "@loomwork/core";
import {
  type CapabilityAuthorizer,
  CapabilityDeniedError,
  EffectRuntime,
  type PrincipalChain,
  ToolEffect,
} from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  type ExecutionContext,
  type FlowRunner,
  type ResumeAuthenticator,
  ResumeRefusedError,
  WorkflowRuntime,
  recoverAbandoned,
} from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TaskGrantAuthorizer, formatExpiredReason, parseExpiredReason } from "./authorizer";
import {
  GrantRevokedError,
  LeaseDimensionDroppedError,
  LeaseExhaustedError,
  RenewalDeniedError,
} from "./errors";
import type { TaskGrant } from "./grant";
import { installTaskAuthority } from "./install";
import { taskLeaseMiddleware } from "./lease";
import { InMemoryGrantBroker, type RenewalPolicy } from "./renew";
import {
  RENEWAL_GATE,
  answerRenewal,
  isRenewable,
  renewalResumeSchema,
  withRenewal,
} from "./renewal";

const SECRET = "renewal-secret";
const clock = { t: 1_000_000 };
const task = (id: string, toolId = "act") =>
  ({ _tag: "TaskDefinition", kind: "tool", id, toolId }) as never;
const verified: ResumeAuthenticator = {
  verify: () => ({ status: "verified", actor: "ops", verifiedBy: "test" }),
};
// +2 ceiling per renewal the task has had (renewals so far + this one)
const grow: RenewalPolicy = (_r, h) => ({ leases: { w: 2 + 2 * (h.renewals + 1) } });

function mkBroker(policy?: RenewalPolicy) {
  return new InMemoryGrantBroker({ secret: SECRET, now: () => clock.t, ...(policy && { policy }) });
}
const mint = (b: InMemoryGrantBroker, ceiling: number) =>
  b.mint({
    taskId: "t1",
    issuedTo: "agent-a",
    effects: ["act"],
    leases: { w: { ceiling, effects: ["act"] } },
    ttlMs: 60_000,
  });
const chainOf = (g: TaskGrant): PrincipalChain => ({ actor: g.issuedTo, taskGrant: g });

interface Stores {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
}
const freshStores = (): Stores => ({
  eventStore: new InMemoryAsyncEventStore(),
  snapshotStore: new InMemoryAsyncSnapshotStore(),
});

function boot(o: {
  broker: InMemoryGrantBroker;
  runner: FlowRunner<unknown, unknown>;
  stores?: Stores;
  noSchemas?: boolean;
  authorizer?: CapabilityAuthorizer;
  body?: (n: number) => void | Promise<void>;
}) {
  const ran = { n: 0 };
  const effects = new EffectRuntime(
    [taskLeaseMiddleware({ secret: SECRET, source: o.broker, now: () => clock.t })],
    o.authorizer ? { authorizer: o.authorizer } : {}
  );
  effects.register(
    "act",
    new ToolEffect(async () => {
      ran.n++;
      await o.body?.(ran.n);
      return { ok: true };
    })
  );
  const stores = o.stores ?? freshStores();
  const runtime = new WorkflowRuntime({
    ...stores,
    effectRuntime: effects,
    resumeAuthenticator: verified,
    onWarn: () => {},
  });
  const definition = {
    _tag: "FlowDefinition",
    id: "renew-flow",
    name: "renew-flow",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    steps: [],
    ...(!o.noSchemas && { resumeSchemas: { [RENEWAL_GATE]: renewalResumeSchema } }),
  } as unknown as FlowDefinition;
  runtime.registerFlow(definition, o.runner);
  installTaskAuthority(runtime, { source: o.broker, secret: SECRET, now: () => clock.t });
  const flow = { definition, runner: o.runner } as never;
  const start = (id: string, g: TaskGrant) =>
    runtime.start(flow, {}, { executionId: id, principal: chainOf(g) });
  return { runtime, ran, stores, start };
}

// Five calls, each under its own withRenewal id: with ceiling 2 and +2 per renewal, c2 and c4 each park.
const five: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) => {
  const out: string[] = [];
  for (let i = 0; i < 5; i++) {
    out.push(
      await withRenewal(
        ctx as never,
        `c${i}`,
        async (a) => await ctx.run(task(a), {}).then(() => a)
      )
    );
  }
  return out;
};
const parkedOn = async (h: ReturnType<typeof boot>, id: string) =>
  (await h.runtime.loadState(id))?.suspendedOn;

describe("withRenewal", () => {
  it("parks on the renewal gate when a lease is exhausted, then completes after a broker renewal", async () => {
    const broker = mkBroker(grow);
    const g = await mint(broker, 2);
    const h = boot({ broker, runner: five });
    const run = await h.start("e1", g);
    await run.waitForSuspend();
    const gate = await parkedOn(h, "e1");
    // fail-proof: a bare retry loop never reaches this status
    expect(gate).toMatchObject({ on: RENEWAL_GATE, correlationKey: "e1#c2#0" });
    expect(gate?.viewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(h.ran.n).toBe(2);
    const state = await h.runtime.loadState("e1");
    expect(
      (state?.variables._decisions as Record<string, unknown>)["task-authority:attempt:c2:0"]
    ).toMatchObject({
      choice: { request: { taskId: "t1", epoch: 0, spent: { w: 2 }, renewals: 0 } },
    });

    const r2 = await answerRenewal(h.runtime, broker, "e1");
    await r2.waitForSuspend(); // c4 exhausts the first renewal's ceiling (4)
    expect((await parkedOn(h, "e1"))?.correlationKey).toBe("e1#c4#0");
    const r3 = await answerRenewal(h.runtime, broker, "e1");
    expect((await r3.waitForCompletion()).variables._output).toEqual([
      "c0",
      "c1",
      "c2:r1",
      "c3",
      "c4:r1",
    ]);
    expect(h.ran.n).toBe(5); // tranches 2 + 2 + 1
  });

  it("survives a crash between park and resume: a fresh runtime resumes and completes", async () => {
    const broker = mkBroker(grow);
    const g = await mint(broker, 2);
    const h1 = boot({ broker, runner: five });
    await (await h1.start("e2", g)).waitForSuspend();
    const h2 = boot({ broker, runner: five, stores: h1.stores });
    const r = await answerRenewal(h2.runtime, broker, "e2");
    await r.waitForSuspend();
    const done = (await (await answerRenewal(h2.runtime, broker, "e2")).waitForCompletion())
      .variables._output;
    expect(done).toEqual(["c0", "c1", "c2:r1", "c3", "c4:r1"]);
    expect(h1.ran.n + h2.ran.n).toBe(5);
  });

  it("a denied renewal fails the run with RenewalDeniedError", async () => {
    const broker = mkBroker(() => false);
    const g = await mint(broker, 2);
    const h = boot({ broker, runner: five });
    await (await h.start("e3", g)).waitForSuspend();
    const r = await answerRenewal(h.runtime, broker, "e3");
    await expect(r.waitForCompletion()).rejects.toThrow(/renewal denied: policy denied/);
    const events = await h.stores.eventStore.read("e3");
    expect(events.map((e) => e.eventType)).toContain("EXECUTION_FAILED");
    expect(new RenewalDeniedError("x").renewable).toBe(false);
  });

  it("passes a non-renewable error through untouched and parks nothing", async () => {
    const broker = mkBroker();
    const seen: unknown[] = [];
    const errs = [new LeaseDimensionDroppedError("w"), new Error("plain")];
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      for (const e of errs) {
        try {
          await withRenewal(ctx as never, `x${seen.length}`, async () => {
            throw e;
          });
        } catch (caught) {
          seen.push(caught);
        }
      }
      return "done";
    };
    const g = await mint(broker, 2);
    const h = boot({ broker, runner });
    expect((await (await h.start("e4", g)).waitForCompletion()).variables._output).toBe("done");
    expect(seen[0]).toBe(errs[0]);
    expect(seen[1]).toBe(errs[1]);
    expect((await h.stores.eventStore.read("e4")).map((e) => e.eventType)).not.toContain(
      "EXECUTION_SUSPENDED"
    );
  });

  it("parks on an expired grant (task-grant:expired) and runs after a renewal with a new exp", async () => {
    const broker = mkBroker(() => ({}));
    const g = await mint(broker, 10);
    const authorizer = new TaskGrantAuthorizer({
      secret: SECRET,
      base: { authorize: () => ({ allowed: true }) },
      now: () => clock.t,
    });
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      await ctx.run(task("first"), {});
      return withRenewal(
        ctx as never,
        "second",
        async (a) => await ctx.run(task(a), {}).then(() => a)
      );
    };
    const h = boot({
      broker,
      runner,
      authorizer,
      body: (n) => {
        if (n === 1) clock.t = g.exp + 1;
      },
    });
    await (await h.start("e5", g)).waitForSuspend();
    expect(await parkedOn(h, "e5")).toMatchObject({
      on: RENEWAL_GATE,
      correlationKey: "e5#second#0",
    });
    expect(h.ran.n).toBe(1);
    const r = await answerRenewal(h.runtime, broker, "e5");
    expect((await r.waitForCompletion()).variables._output).toBe("second:r1");
    expect(h.ran.n).toBe(2);
    expect((await broker.current("t1"))?.exp).toBeGreaterThan(g.exp);
  });

  it("a revoked grant parks, the broker cannot renew a revoked task, and the run fails", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 10);
    let revoke = true;
    const runner: FlowRunner<unknown, unknown> = async (ctx) =>
      withRenewal(ctx as never, "only", async (a) => {
        if (revoke) throw new GrantRevokedError("t1", "t1", 0);
        return a;
      });
    const h = boot({ broker, runner });
    await (await h.start("e6", g)).waitForSuspend();
    expect((await h.runtime.loadState("e6"))?.variables._decisions).toMatchObject({
      "task-authority:attempt:only:0": { choice: { request: { taskId: "t1" } } },
    });
    await broker.revoke("t1", "operator");
    revoke = false;
    const r = await answerRenewal(h.runtime, broker, "e6");
    await expect(r.waitForCompletion()).rejects.toThrow(/unknown or revoked task/);
  });

  it("enforces maxRenewals", async () => {
    const broker = mkBroker(() => ({}));
    const g = await mint(broker, 10);
    let calls = 0;
    const runner: FlowRunner<unknown, unknown> = async (ctx) =>
      withRenewal(
        ctx as never,
        "loop",
        async () => {
          calls++;
          throw new LeaseExhaustedError("w", 1, 1, calls - 1, "t1");
        },
        { maxRenewals: 2 }
      );
    const h = boot({ broker, runner });
    await (await h.start("e7", g)).waitForSuspend();
    // two renewals are allowed; the third failure fails the run instead of parking
    let r = await answerRenewal(h.runtime, broker, "e7");
    await r.waitForSuspend();
    r = await answerRenewal(h.runtime, broker, "e7");
    await expect(r.waitForCompletion()).rejects.toThrow(/more than 2 renewals/);
    expect(calls).toBe(3);
  });

  it("replays a run that renewed twice to the same output with zero broker calls", async () => {
    const broker = mkBroker(grow);
    let renews = 0;
    const real = broker.renew.bind(broker);
    broker.renew = async (r) => {
      renews++;
      return real(r);
    };
    const g = await mint(broker, 2);
    const h = boot({ broker, runner: five });
    await (await h.start("e8", g)).waitForSuspend();
    await (await answerRenewal(h.runtime, broker, "e8")).waitForSuspend();
    // the final resume is itself a replay of c0..c3 and c2's recorded failure, on a fresh runtime
    const h2 = boot({ broker, runner: five, stores: h.stores });
    const done = await (await answerRenewal(h2.runtime, broker, "e8")).waitForCompletion();
    expect(done.variables._output).toEqual(["c0", "c1", "c2:r1", "c3", "c4:r1"]);
    expect(renews).toBe(2); // one per park; the replays asked the broker nothing
    expect(h.ran.n + h2.ran.n).toBe(5); // and re-ran no effect
    const decisions = (await h.stores.eventStore.read("e8")).filter(
      (e) =>
        e.eventType === "DECISION_RECORDED" &&
        String(JSON.stringify(e.payload)).includes("task-authority:attempt")
    );
    expect(decisions).toHaveLength(7); // every attempt: c0 c1 c2:0 c2:1 c3 c4:0 c4:1
  });
});

const until = async (cond: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};
const AFTER = "AFTER_RENEWAL";
const emits = async (st: Stores, id: string) =>
  (await st.eventStore.read(id)).filter((e) => e.eventType === AFTER).length;

describe("withRenewal contract (R23-R24)", () => {
  // stable-id step + nested decide before the failing attempt-id step, then a flow-level emit and a gate
  const mixed: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) => {
    const v = await withRenewal(ctx as never, "w", async (a) => {
      await ctx.run(task("stable"), {});
      const inner = await ctx.decide("inner", () => 7);
      await ctx.run(task(a), {});
      return `${a}:${inner}`;
    });
    ctx.emit(AFTER, { v });
    await ctx.suspend({ on: "GO" });
    return v;
  };

  it("replays stable steps and nested decisions, re-runs attempt-id steps, and emits after it exactly once", async () => {
    const broker = mkBroker(grow);
    const g = await mint(broker, 1);
    const h1 = boot({ broker, runner: mixed });
    await (await h1.start("m1", g)).waitForSuspend();
    expect((await parkedOn(h1, "m1"))?.on).toBe(RENEWAL_GATE);
    const h2 = boot({ broker, runner: mixed, stores: h1.stores });
    await (await answerRenewal(h2.runtime, broker, "m1")).waitForSuspend(); // now parked on GO
    expect((await parkedOn(h2, "m1"))?.on).toBe("GO");
    const h3 = boot({ broker, runner: mixed, stores: h1.stores });
    const done = await (
      await h3.runtime.resume("m1", { eventType: "GO", payload: {} })
    ).waitForCompletion();
    expect(done.variables._output).toBe("w:r1:7");
    expect(h1.ran.n + h2.ran.n + h3.ran.n).toBe(2); // stable once, w:r1 once; nothing re-ran on replay
    expect(await emits(h1.stores, "m1")).toBe(1); // F1: two resumes, one append
  });

  it("a crash during the retried attempt: a fresh runtime recovers and completes under the new grant", async () => {
    const broker = mkBroker(grow);
    const g = await mint(broker, 1);
    const runner: FlowRunner<unknown, unknown> = async (ctx: ExecutionContext) =>
      withRenewal(ctx as never, "w", async (a) => {
        await ctx.run(task(a), {});
        await ctx.run(task(`${a}:b`), {});
        return a;
      });
    const h1 = boot({ broker, runner });
    await (await h1.start("m2", g)).waitForSuspend();
    const hang = () => new Promise<void>(() => {});
    const h2 = boot({ broker, runner, stores: h1.stores, body: hang });
    void answerRenewal(h2.runtime, broker, "m2");
    await until(() => h2.ran.n === 1, "the retried attempt to start, then 'crash'");
    const h3 = boot({ broker, runner, stores: h1.stores });
    await recoverAbandoned(h3.runtime, { source: h1.stores.eventStore, isAbandoned: () => true });
    await until(async () => (await h3.runtime.loadState("m2"))?.status === "completed", "recovery");
    expect((await h3.runtime.loadState("m2"))?.variables._output).toBe("w:r1");
  });

  it("treats a payload that is not a valid grant as denied, with no resumeSchemas declared", async () => {
    for (const payload of [{ granted: "no" }, { granted: true }]) {
      const broker = mkBroker(grow);
      const g = await mint(broker, 2);
      const h = boot({ broker, runner: five, noSchemas: true });
      await (await h.start("v1", g)).waitForSuspend();
      const gate = await parkedOn(h, "v1");
      const r = await h.runtime.resume("v1", {
        eventType: RENEWAL_GATE,
        payload: { ...payload, viewDigest: gate?.viewDigest },
      });
      await expect(r.waitForCompletion()).rejects.toThrow(/malformed renewal verdict/);
    }
  });

  it("refuses a resume with a wrong or missing viewDigest", async () => {
    const broker = mkBroker(grow);
    const g = await mint(broker, 2);
    const h = boot({ broker, runner: five });
    await (await h.start("v2", g)).waitForSuspend();
    const verdict = { granted: true, epoch: 1, digest: "d" };
    for (const payload of [verdict, { ...verdict, viewDigest: "0".repeat(64) }]) {
      const err = await h.runtime.resume("v2", { eventType: RENEWAL_GATE, payload }).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ResumeRefusedError);
    }
    expect((await parkedOn(h, "v2"))?.on).toBe(RENEWAL_GATE);
  });

  it("answerRenewal throws for a run parked elsewhere, a completed run, and a tampered record", async () => {
    const broker = mkBroker(grow);
    const g = await mint(broker, 5);
    const other: FlowRunner<unknown, unknown> = async (ctx) => ctx.suspend({ on: "ELSEWHERE" });
    const h = boot({ broker, runner: other });
    await (await h.start("a1", g)).waitForSuspend();
    await expect(answerRenewal(h.runtime, broker, "a1")).rejects.toThrow(/not parked on/);
    await (
      await h.runtime.resume("a1", { eventType: "ELSEWHERE", payload: 1 })
    ).waitForCompletion();
    await expect(answerRenewal(h.runtime, broker, "a1")).rejects.toThrow(/not parked on/);

    const b2 = mkBroker(grow);
    const g2 = await mint(b2, 2);
    const h2 = boot({ broker: b2, runner: five });
    await (await h2.start("a2", g2)).waitForSuspend();
    const state = await h2.runtime.loadState("a2");
    const rec = (
      state?.variables._decisions as Record<string, { choice: { request: { spent: object } } }>
    )["task-authority:attempt:c2:0"];
    (rec as { choice: { request: { spent: object } } }).choice.request.spent = { w: 0 };
    const tampered = {
      ...h2.runtime,
      loadState: async () => state,
    } as unknown as typeof h2.runtime;
    await expect(answerRenewal(tampered, b2, "a2")).rejects.toThrow(
      /does not match the parked digest/
    );
  });

  it("answerRenewal uses the grant's current epoch when it was renewed between park and answer", async () => {
    const broker = mkBroker(grow);
    const g = await mint(broker, 2);
    const h = boot({ broker, runner: five });
    await (await h.start("s1", g)).waitForSuspend();
    expect(await broker.renew({ taskId: "t1", epoch: 0, spent: {}, renewals: 0 })).toMatchObject({
      granted: true,
      epoch: 1,
    });
    // the recorded request says epoch 0, now stale; the helper reads epoch 1 from the broker
    // a stale epoch 0 would be refused ("stale epoch") and fail the run; epoch 2 grants and it completes
    const r = await answerRenewal(h.runtime, broker, "s1");
    expect((await r.waitForCompletion()).variables._output).toEqual([
      "c0",
      "c1",
      "c2:r1",
      "c3",
      "c4",
    ]);
  });

  it("serves a stale recorded outcome when an id is reused (ids must be unique per call site)", async () => {
    const broker = mkBroker();
    const g = await mint(broker, 2);
    const seen: unknown[] = [];
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      await withRenewal(ctx as never, "dup", async () => "first");
      try {
        await withRenewal(ctx as never, "dup", async () => {
          throw new LeaseExhaustedError("w", 1, 1, 0, "t1");
        });
      } catch (e) {
        seen.push(e);
      }
      return "done";
    };
    const h = boot({ broker, runner });
    expect((await (await h.start("d1", g)).waitForCompletion()).variables._output).toBe("done");
    expect(seen[0]).toBeInstanceOf(LeaseExhaustedError); // not parked: the recorded { ok: true } was served
  });
});

describe("expired-reason codec", () => {
  it("round-trips any taskId, including quotes", () => {
    for (const id of ["t1", 'a"b', 'x" epoch 9 expired at 1 "y']) {
      const reason = `task-grant:expired: ${formatExpiredReason(id, 3, 99)}`;
      expect(parseExpiredReason(reason)).toEqual({ taskId: id, epoch: 3 });
    }
    expect(parseExpiredReason("task-grant:scope: no")).toBeUndefined();
  });

  it("fails closed when an expired denial cannot be parsed and no taskId is given", async () => {
    const runner: FlowRunner<unknown, unknown> = async (ctx) =>
      withRenewal(ctx as never, "p", async () => {
        throw new CapabilityDeniedError("act", "task-grant:expired: garbled");
      });
    const broker = mkBroker();
    const h = boot({ broker, runner });
    await expect((await h.start("p1", await mint(broker, 2))).waitForCompletion()).rejects.toThrow(
      /names no task or epoch/
    );
  });
});

describe("isRenewable", () => {
  it("walks the cause chain (bounded) and matches an expired denial by name and reason prefix", () => {
    expect(isRenewable(new GrantRevokedError("t"))).toBe(true);
    expect(isRenewable(new Error("x", { cause: new GrantRevokedError("t") }))).toBe(true);
    expect(isRenewable(new CapabilityDeniedError("act", "task-grant:expired: old"))).toBe(true);
    expect(isRenewable(new CapabilityDeniedError("act", "task-grant:scope: no"))).toBe(false);
    expect(isRenewable({ name: "CapabilityDeniedError", reason: "task-grant:expired" })).toBe(true);
    let deep: unknown = new GrantRevokedError("t");
    for (let i = 0; i < 9; i++) deep = new Error("w", { cause: deep });
    expect(isRenewable(deep)).toBe(false);
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(isRenewable(loop)).toBe(false);
    expect(isRenewable(undefined)).toBe(false);
  });
});
