import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { type FlowRunner, WorkflowRuntime } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GrantBrokerError } from "./broker";
import { ScheduleDeniedError } from "./errors";
import { InMemoryGrantBroker } from "./renew";
import {
  SCHEDULE_GATE,
  type ScheduleGrantSpec,
  answerScheduleApproval,
  mintScheduleGrant,
  requestScheduleApproval,
  scheduleViewDigest,
} from "./scheduleGrant";

const SECRET = "sched-secret";
const NOW = 1_000_000;
const spec: ScheduleGrantSpec = {
  scheduleId: "nightly",
  issuedTo: "svc-reports",
  effects: ["act"],
  leases: { calls: { ceiling: 100, effects: ["act"] } },
  ttlMs: 30 * 24 * 3_600_000,
  tenant: "acme",
};

function boot(o: { auth?: boolean } = {}) {
  const broker = new InMemoryGrantBroker({ secret: SECRET, now: () => NOW });
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onWarn: () => {},
    ...(o.auth && {
      resumeAuthenticator: {
        verify: (e: { eventType: string; payload: unknown }) =>
          e.eventType === SCHEDULE_GATE
            ? { status: "verified" as const, actor: "approver", verifiedBy: "sso" }
            : { status: "not-applicable" as const },
      },
    }),
  });
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    await requestScheduleApproval(ctx as never, spec);
    return { approved: true };
  };
  const definition: FlowDefinition = {
    _tag: "FlowDefinition",
    id: "approve-schedule",
    name: "approve-schedule",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    steps: [],
  };
  runtime.registerFlow(definition, runner);
  const reg = (id: string, r: FlowRunner<unknown, unknown>) =>
    runtime.registerFlow({ ...definition, id, name: id }, r);
  // a flow that CATCHES the refusal and completes; one that forges the proposal; one that forges the marker too
  reg("catches", async (ctx) => {
    try {
      await requestScheduleApproval(ctx as never, spec);
    } catch (e) {
      if (!(e instanceof ScheduleDeniedError)) throw e; // a park (SuspendError) must still propagate
    }
    return { approved: false };
  });
  reg("forges", async (ctx) => {
    await (ctx as never as { decide: (i: string, f: () => unknown) => Promise<unknown> }).decide(
      "task-authority:schedule:nightly",
      () => spec
    );
    return {};
  });
  reg("forges-marker", async (ctx) => {
    const c = ctx as never as {
      executionId: string;
      decide: (i: string, f: () => unknown) => Promise<unknown>;
    };
    await c.decide("task-authority:schedule:nightly", () => spec);
    await c.decide("task-authority:schedule-approved:nightly", () => ({
      approved: true,
      digest: scheduleViewDigest(`${c.executionId}#schedule:nightly`, spec),
    }));
    return {};
  });
  reg("forges-badmarker", async (ctx) => {
    const c = ctx as never as { decide: (i: string, f: () => unknown) => Promise<unknown> };
    await c.decide("task-authority:schedule:nightly", () => spec);
    await c.decide("task-authority:schedule-approved:nightly", () => ({
      approved: true,
      digest: "not-the-digest",
    }));
    return {};
  });
  return { broker, runtime };
}
const OPS = { actor: "ops", tenant: "acme" };
const park = async (
  app: ReturnType<typeof boot>,
  id: string,
  principal: object | null = OPS,
  flow = "approve-schedule"
) => {
  const h = await app.runtime.start(app.runtime.getFlow(flow) as never, {}, {
    executionId: id,
    ...(principal !== null && { principal }),
  } as never);
  await h.waitForSuspend();
};
const NOWOPT = { now: () => NOW };
const done = async (app: ReturnType<typeof boot>, id: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while ((await app.runtime.loadState(id))?.status !== "completed") {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${id} to complete`);
    await new Promise((r) => setTimeout(r, 2));
  }
};
const answer = (
  app: ReturnType<typeof boot>,
  id: string,
  d: { approved: boolean; reason?: string },
  o: object = {}
) =>
  answerScheduleApproval(app.runtime as never, app.broker, id, d, undefined, {
    ...NOWOPT,
    expect: { issuedTo: "svc-reports", tenant: "acme" },
    ...o,
  });

describe("schedule grant: the one-off approval run (ADR 0150 D12, S10b)", () => {
  it("an approved schedule mints the root grant the human saw", async () => {
    // Kills: not minting after approval, or minting a grant that differs from the proposal (ceilings, expiry, identity).
    const app = boot();
    await park(app, "appr-1");
    const g = await answer(app, "appr-1", { approved: true });
    expect(g).toMatchObject({
      taskId: "nightly",
      rootId: "nightly",
      issuedTo: "svc-reports",
      tenant: "acme",
      leases: { calls: { ceiling: 100 } },
      exp: NOW + spec.ttlMs,
    });
    expect(await app.broker.current("nightly")).toEqual(g);
    expect((await app.runtime.loadState("appr-1"))?.status).toBe("completed");
  });

  it("an unapproved schedule mints nothing and the approval run fails", async () => {
    // Kills: minting on any resume (ignoring the verdict), or a refusal that leaves the run parked.
    const app = boot();
    await park(app, "appr-2");
    expect(await answer(app, "appr-2", { approved: false, reason: "no" })).toBeUndefined();
    expect(await app.broker.current("nightly")).toBeUndefined();
    expect((await app.runtime.loadState("appr-2"))?.status).toBe("failed");
  });

  it("a resume that the runtime refuses mints nothing", async () => {
    // Kills: minting BEFORE the resume (an approval the runtime then refuses would leave a live, unapproved grant).
    const app = boot();
    await park(app, "appr-3");
    const refusing = {
      loadState: (id: string) => app.runtime.loadState(id),
      resume: async () => {
        throw new Error("approval rejected");
      },
    };
    await expect(
      answerScheduleApproval(
        refusing as never,
        app.broker,
        "appr-3",
        { approved: true },
        undefined,
        {
          ...NOWOPT,
          expect: { issuedTo: "svc-reports", tenant: "acme" },
        }
      )
    ).rejects.toThrow("approval rejected");
    expect(await app.broker.current("nightly")).toBeUndefined();
  });

  it("answering an execution that is not parked on the gate throws before anything is minted", async () => {
    // Kills: resuming/minting for an arbitrary execution id.
    const app = boot();
    await expect(answer(app, "nope", { approved: true })).rejects.toThrow(SCHEDULE_GATE);
    expect(await app.broker.current("nightly")).toBeUndefined();
  });

  it("minting is idempotent for the same spec and refuses a different one", async () => {
    // Kills: a retry after a crash between the resume and the mint throwing "duplicate taskId" (the grant never reaches the caller),
    // or silently returning a grant that is NOT the one approved.
    const app = boot();
    const a = await mintScheduleGrant(app.broker, spec, NOWOPT);
    expect(await mintScheduleGrant(app.broker, spec, NOWOPT)).toEqual(a);
    await expect(
      mintScheduleGrant(app.broker, { ...spec, issuedTo: "mallory" }, NOWOPT)
    ).rejects.toBeInstanceOf(GrantBrokerError); // a different holder is not the approved schedule
    await expect(
      mintScheduleGrant(
        app.broker,
        { ...spec, leases: { calls: { ceiling: 9999, effects: ["act"] } } },
        NOWOPT
      )
    ).rejects.toBeInstanceOf(GrantBrokerError);
  });

  it("idempotence compares EVERY signed field, the ttl, and refuses an expired grant (R25 I2)", async () => {
    // Kills: serving the old grant to a re-approval that differs in tenant / onBehalfOf / reads / sandbox / ttl, or returning an expired one.
    const app = boot();
    await mintScheduleGrant(app.broker, { ...spec, onBehalfOf: "u1", reads: ["a:*"] }, NOWOPT);
    const base = { ...spec, onBehalfOf: "u1", reads: ["a:*"] };
    await expect(mintScheduleGrant(app.broker, base, NOWOPT)).resolves.toBeDefined(); // identical: served
    for (const diff of [
      { tenant: "other" },
      { onBehalfOf: "u2" },
      { reads: ["a:*", "b:*"] },
      { reads: undefined },
      { sandbox: "isolated" as const },
      { ttlMs: spec.ttlMs * 2 },
      { effects: ["act", "more"] },
    ])
      await expect(
        mintScheduleGrant(app.broker, { ...base, ...diff } as ScheduleGrantSpec, NOWOPT)
      ).rejects.toBeInstanceOf(GrantBrokerError);
    await expect(
      mintScheduleGrant(app.broker, base, { now: () => NOW + spec.ttlMs + 1 })
    ).rejects.toThrow(/expired/);
    // a SHORT-lived schedule inside the recovery window: expiry alone refuses it
    const short = { ...spec, scheduleId: "short", ttlMs: 60_000 };
    await mintScheduleGrant(app.broker, short, NOWOPT);
    await expect(
      mintScheduleGrant(app.broker, short, { now: () => NOW + 120_000 })
    ).rejects.toThrow(/expired/);
    // a grant minted in the FUTURE of the spec's clock is not this approval's
    await expect(
      mintScheduleGrant(app.broker, short, { now: () => NOW - 120_000 })
    ).rejects.toThrow(/different/);
  });

  it("refuses a spec whose tenant / onBehalfOf / issuedTo the approval run does not own (R25 I3)", async () => {
    // Kills: minting a grant for another tenant (a cross-tenant mint), or for a holder the operator did not vouch for; and a refusal that consumed the park.
    const app = boot();
    await park(app, "x-1", { actor: "mallory", tenant: "evil" }); // spec says tenant acme
    await expect(answer(app, "x-1", { approved: true })).rejects.toBeInstanceOf(
      ScheduleDeniedError
    );
    await park(app, "x-2", null); // anonymous run, spec names a tenant
    await expect(
      answer(app, "x-2", { approved: true }, { expect: { issuedTo: "svc-reports" } })
    ).rejects.toBeInstanceOf(ScheduleDeniedError); // the operator vouches for no tenant
    await expect(answer(app, "x-2", { approved: true }, { expect: undefined })).rejects.toThrow(
      /vouch/
    ); // and with no expect at all the holder is unvouched (R26)
    await park(app, "x-3");
    await expect(
      answer(
        app,
        "x-3",
        { approved: true },
        { expect: { tenant: "acme", issuedTo: "someone-else" } }
      )
    ).rejects.toBeInstanceOf(ScheduleDeniedError);
    await expect(
      answer(
        app,
        "x-3",
        { approved: true },
        { expect: { tenant: "beta", issuedTo: "svc-reports" } }
      )
    ).rejects.toBeInstanceOf(ScheduleDeniedError);
    expect(await app.broker.current("nightly")).toBeUndefined();
    expect((await app.runtime.loadState("x-3"))?.status).toBe("suspended"); // still parked: a corrected answer works
    const g = await answer(
      app,
      "x-3",
      { approved: true },
      { expect: { tenant: "acme", issuedTo: "svc-reports" } }
    );
    expect(g?.tenant).toBe("acme");
  });

  it("a crash between the resume and the mint recovers the grant from the recorded proposal, and links the run", async () => {
    // Kills: an approved, completed run that can never get its grant (the answer throws "not parked"), and a lost audit link.
    const app = boot();
    await park(app, "c-1");
    const real = app.broker.mint.bind(app.broker);
    let boom = true;
    app.broker.mint = async (r) => {
      if (boom) {
        boom = false;
        throw new Error("crash after the resume");
      }
      return real(r);
    };
    await expect(answer(app, "c-1", { approved: true })).rejects.toThrow("crash after");
    await done(app, "c-1");
    expect(await app.broker.current("nightly")).toBeUndefined();
    const links: string[] = [];
    const g = await answer(
      app,
      "c-1",
      { approved: true },
      { onMinted: (_g: unknown, id: string) => void links.push(id) }
    );
    expect(g?.taskId).toBe("nightly");
    expect(links).toEqual(["c-1"]);
    // the recovery path binds the spec to the operator's expectation too
    await expect(
      answer(
        app,
        "c-1",
        { approved: true },
        { expect: { tenant: "beta", issuedTo: "svc-reports" } }
      )
    ).rejects.toBeInstanceOf(ScheduleDeniedError);
  });

  it("guards: a tampered proposal, another gate, a foreign key head, a malformed verdict, a raced mint", async () => {
    // Kills: each guard removed in turn (digest compare, gate compare, `key.startsWith(head)`, verdict parse, the raced re-read).
    const app = boot();
    await park(app, "g-1");
    const st = (await app.runtime.loadState("g-1")) as never as {
      suspendedOn: { on: string; correlationKey: string; viewDigest: string };
      variables: { _decisions: Record<string, { choice: ScheduleGrantSpec }> };
    };
    const via = (patch: (s: typeof st) => typeof st) => ({
      loadState: async () => patch(structuredClone(st)),
      resume: async () => {
        throw new Error("must not resume");
      },
    });
    const run = (rt: object) =>
      answerScheduleApproval(rt as never, app.broker, "g-1", { approved: true }, undefined, {
        ...NOWOPT,
        expect: { issuedTo: "svc-reports", tenant: "acme" },
      });
    const tamper = (s: typeof st) => {
      const d = s.variables._decisions["task-authority:schedule:nightly"] as { choice: object };
      d.choice = { ...spec, leases: {} };
      return s;
    };
    const otherGate = (s: typeof st) => {
      s.suspendedOn.on = "OTHER";
      return s;
    };
    const foreignHead = (s: typeof st) => {
      s.suspendedOn.correlationKey = "other#schedule:nightly";
      return s;
    };
    await expect(run(via(tamper))).rejects.toThrow(/digest/);
    await expect(run(via(otherGate))).rejects.toThrow(/not parked/);
    await expect(run(via(foreignHead))).rejects.toThrow(/not parked/);
    expect(await app.broker.current("nightly")).toBeUndefined();
    // malformed verdict through the real runtime: the run fails, nothing is minted
    await app.runtime
      .resume("g-1", {
        eventType: SCHEDULE_GATE,
        payload: { approved: "yes", viewDigest: st.suspendedOn.viewDigest },
      })
      .catch(() => undefined);
    expect((await app.runtime.loadState("g-1"))?.status).toBe("failed");
    expect(await app.broker.current("nightly")).toBeUndefined();
    // raced re-read: current() misses, mint loses, the winner's identical grant is served
    const winner = await mintScheduleGrant(app.broker, spec, NOWOPT);
    let first = true;
    const raced = {
      current: async (id: string) => {
        if (!first) return app.broker.current(id);
        first = false;
        return undefined;
      },
      mint: async () => {
        throw new GrantBrokerError("duplicate taskId");
      },
    };
    expect(await mintScheduleGrant(raced as never, spec, NOWOPT)).toEqual(winner);
  });

  it("recovery needs proof the run PARKED and was approved (R26)", async () => {
    // Kills: minting from any `task-authority:schedule:*` decision of a completed run (a denied-then-caught run, a hand-written decision),
    // a forged marker with no kernel-written APPROVAL_GRANTED when verification is required, and a recovery that ignores the digest.
    const app = boot({ auth: true });
    await park(app, "d-1", OPS, "catches"); // refused, caught, completed
    await answer(app, "d-1", { approved: false, reason: "no" });
    await done(app, "d-1");
    await expect(answer(app, "d-1", { approved: true })).rejects.toThrow(/recorded no approval/);
    await (
      await app.runtime.start(app.runtime.getFlow("forges") as never, {}, {
        executionId: "d-2",
        principal: OPS,
      } as never)
    ).waitForCompletion();
    await expect(answer(app, "d-2", { approved: true })).rejects.toThrow(/recorded no approval/);
    await (
      await app.runtime.start(app.runtime.getFlow("forges-marker") as never, {}, {
        executionId: "d-3",
        principal: OPS,
      } as never)
    ).waitForCompletion();
    await (
      await app.runtime.start(app.runtime.getFlow("forges-badmarker") as never, {}, {
        executionId: "d-5",
        principal: OPS,
      } as never)
    ).waitForCompletion();
    await expect(answer(app, "d-5", { approved: true })).rejects.toThrow(/recorded no approval/);
    // with no verification requirement the hand-written marker works (flow code is the trust root there) ...
    await expect(
      answer(app, "d-3", { approved: true }, { requireVerifiedApproval: true })
    ).rejects.toThrow(/no verified APPROVAL_GRANTED/);
    expect(await app.broker.current("nightly")).toBeUndefined();
    // ... and a real approval run (the runtime wrote APPROVAL_GRANTED) recovers with it required
    await park(app, "d-4");
    const real = app.broker.mint.bind(app.broker);
    let boom = true;
    app.broker.mint = async (r) => {
      if (boom) {
        boom = false;
        throw new Error("crash after the resume");
      }
      return real(r);
    };
    await expect(answer(app, "d-4", { approved: true })).rejects.toThrow("crash after");
    await done(app, "d-4");
    const g = await answer(app, "d-4", { approved: true }, { requireVerifiedApproval: true });
    expect(g?.taskId).toBe("nightly");
  });
});
