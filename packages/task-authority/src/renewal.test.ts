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
  WorkflowRuntime,
} from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TaskGrantAuthorizer } from "./authorizer";
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
  authorizer?: CapabilityAuthorizer;
  body?: (n: number) => void;
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
      o.body?.(ran.n);
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
    resumeSchemas: { [RENEWAL_GATE]: renewalResumeSchema },
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
        if (revoke) throw new GrantRevokedError("t1");
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
    expect(decisions).toHaveLength(2); // only the failed attempts are recorded
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
