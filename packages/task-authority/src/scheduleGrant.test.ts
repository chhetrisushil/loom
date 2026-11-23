import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { type FlowRunner, WorkflowRuntime } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GrantBrokerError } from "./broker";
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
const park = async (app: ReturnType<typeof boot>, id: string) => {
  const h = await app.runtime.start(
    app.runtime.getFlow("approve-schedule") as never,
    {},
    { executionId: id }
  );
  await h.waitForSuspend();
};

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
    const a = await mintScheduleGrant(app.broker, spec);
    expect(await mintScheduleGrant(app.broker, spec)).toEqual(a);
    await expect(
      mintScheduleGrant(app.broker, { ...spec, issuedTo: "mallory" })
    ).rejects.toBeInstanceOf(GrantBrokerError); // a different holder is not the approved schedule
    await expect(
      mintScheduleGrant(app.broker, {
        ...spec,
        leases: { calls: { ceiling: 9999, effects: ["act"] } },
      })
    ).rejects.toBeInstanceOf(GrantBrokerError);
  });
});
