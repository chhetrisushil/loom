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

function boot() {
  const broker = new InMemoryGrantBroker({ secret: SECRET, now: () => NOW });
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onWarn: () => {},
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
  return { broker, runtime };
}
const OPS = { actor: "ops", tenant: "acme" };
const park = async (app: ReturnType<typeof boot>, id: string, principal: object | null = OPS) => {
  const h = await app.runtime.start(app.runtime.getFlow("approve-schedule") as never, {}, {
    executionId: id,
    ...(principal !== null && { principal }),
  } as never);
  await h.waitForSuspend();
};
const NOWOPT = { now: () => NOW };
const answer = (
  app: ReturnType<typeof boot>,
  id: string,
  d: { approved: boolean; reason?: string },
  o: object = {}
) =>
  answerScheduleApproval(app.runtime as never, app.broker, id, d, undefined, { ...NOWOPT, ...o });

describe("schedule grant: the one-off approval run (ADR 0150 D12, S10b)", () => {
  it("an approved schedule mints the root grant the human saw", async () => {
    // Kills: not minting after approval, or minting a grant that differs from the proposal (ceilings, expiry, identity).
    const app = boot();
    await park(app, "appr-1");
    const g = await answerScheduleApproval(app.runtime as never, app.broker, "appr-1", {
      approved: true,
    });
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
    expect(
      await answerScheduleApproval(app.runtime as never, app.broker, "appr-2", {
        approved: false,
        reason: "no",
      })
    ).toBeUndefined();
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
      answerScheduleApproval(refusing as never, app.broker, "appr-3", { approved: true })
    ).rejects.toThrow("approval rejected");
    expect(await app.broker.current("nightly")).toBeUndefined();
  });

  it("answering an execution that is not parked on the gate throws before anything is minted", async () => {
    // Kills: resuming/minting for an arbitrary execution id.
    const app = boot();
    await expect(
      answerScheduleApproval(app.runtime as never, app.broker, "nope", { approved: true })
    ).rejects.toThrow(SCHEDULE_GATE);
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
    await expect(answer(app, "x-2", { approved: true })).rejects.toBeInstanceOf(
      ScheduleDeniedError
    );
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
      answer(app, "x-3", { approved: true }, { expect: { tenant: "beta" } })
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
      answer(app, "c-1", { approved: true }, { expect: { tenant: "beta" } })
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
      answerScheduleApproval(rt as never, app.broker, "g-1", { approved: true }, undefined, NOWOPT);
    await expect(
      run(
        via(
          (s) => (
            ((
              s.variables._decisions["task-authority:schedule:nightly"] as never as {
                choice: object;
              }
            ).choice = { ...spec, leases: {} }),
            s
          )
        )
      )
    ).rejects.toThrow(/digest/);
    await expect(run(via((s) => ((s.suspendedOn.on = "OTHER"), s)))).rejects.toThrow(/not parked/);
    await expect(
      run(via((s) => ((s.suspendedOn.correlationKey = `other#schedule:nightly`), s)))
    ).rejects.toThrow(/not parked/);
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
      current: async (id: string) =>
        first ? ((first = false), undefined) : app.broker.current(id),
      mint: async () => {
        throw new GrantBrokerError("duplicate taskId");
      },
    };
    expect(await mintScheduleGrant(raced as never, spec, NOWOPT)).toEqual(winner);
  });
});
