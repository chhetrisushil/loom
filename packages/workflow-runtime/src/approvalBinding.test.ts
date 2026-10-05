import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { answerApproval, approvalViewDigest, viewDigest } from "./approvalBinding";
import { executionAccessPolicy } from "./executionAccessPolicy";
import { signResume, signedResumeAuthenticator } from "./signedResumeAuthenticator";
import { ApprovalRejectedError, ResumeRefusedError } from "./types";
import type { FlowRunner, ResumeEvent } from "./types";

// R13 — an approval is bound to what the approver SAW. The gate declares a digest of the
// proposal in its (durable, fold-visible) suspend condition; a resume must echo it; a stale or
// absent echo is refused BEFORE the append.

const KEY = "alice-secret-0123456789";
const io = z.object({}).passthrough();
const apply = step$({
  id: "apply",
  name: "apply",
  toolId: "t-apply",
  inputSchema: io,
  outputSchema: io,
});

function make(opts: { viewOf?: (n: number) => unknown; auth?: boolean; twice?: boolean } = {}) {
  let applied = 0;
  const effects = new EffectRuntime();
  effects.register(
    "t-apply",
    new ToolEffect(async () => {
      applied++;
      return { done: true };
    })
  );
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    ...(opts.auth && {
      resumeAuthenticator: signedResumeAuthenticator({
        gates: ["Approval"],
        keys: { alice: KEY },
      }),
    }),
  });
  const definition = {
    _tag: "FlowDefinition" as const,
    id: "f",
    name: "f",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [apply],
  };
  const runner = (async (ctx, input: { n?: number }) => {
    const view = opts.viewOf?.(input.n ?? 0);
    const gate = {
      on: "Approval",
      ...(view !== undefined && { viewDigest: viewDigest(view) }),
    };
    await ctx.suspend(gate);
    if (opts.twice === true) await ctx.suspend(gate);
    return ctx.run(apply, {});
  }) as FlowRunner<unknown, unknown>;
  runtime.registerFlow(definition, runner);
  return { runtime, flow: { definition, runner }, eventStore, applied: () => applied };
}

async function parked(h: ReturnType<typeof make>, n = 1) {
  const handle = await h.runtime.start(h.flow, { n });
  await handle.waitForSuspend();
  return { id: handle.executionId, before: await h.eventStore.read(handle.executionId) };
}

describe("viewDigest", () => {
  it("is deterministic and key-order independent; different views differ", () => {
    expect(viewDigest({ a: 1, b: 2 })).toBe(viewDigest({ b: 2, a: 1 }));
    expect(viewDigest({ a: 1 })).not.toBe(viewDigest({ a: 2 }));
    expect(approvalViewDigest("k", "drop_table", { t: "x" })).not.toBe(
      approvalViewDigest("k", "drop_table", { t: "y" })
    );
  });
});

describe("R13 view binding at the resume gate", () => {
  it("records the digest durably in the suspend condition", async () => {
    const h = make({ viewOf: (n) => ({ proposal: n }) });
    const { id } = await parked(h, 1);
    const state = await h.runtime.loadState(id);
    expect(state?.suspendedOn?.viewDigest).toBe(viewDigest({ proposal: 1 }));
  });

  it("refuses a STALE approval (digest of an older proposal) and the log is untouched", async () => {
    const h = make({ viewOf: (n) => ({ proposal: n }) });
    const old = await parked(h, 1);
    const cur = await parked(h, 2);
    const err = await h.runtime
      .resume(cur.id, {
        eventType: "Approval",
        payload: { approved: true, viewDigest: viewDigest({ proposal: 1 }) },
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(ResumeRefusedError);
    expect((err as ResumeRefusedError).reason).toBe("view-digest-mismatch");
    expect(await h.eventStore.read(cur.id)).toEqual(cur.before);
    expect(await h.eventStore.read(old.id)).toEqual(old.before);
    expect(h.applied()).toBe(0);
  });

  it("refuses an approval that echoes no digest (absent, null, or non-object payload)", async () => {
    const h = make({ viewOf: () => ({ p: 1 }) });
    const { id, before } = await parked(h);
    for (const payload of [{ approved: true }, null, "yes", { viewDigest: 42 }]) {
      const err = await h.runtime.resume(id, { eventType: "Approval", payload }).then(
        () => undefined,
        (e: unknown) => e
      );
      expect((err as ResumeRefusedError).reason).toBe("view-digest-mismatch");
      expect(await h.eventStore.read(id)).toEqual(before);
    }
  });

  it("a matching approval proceeds", async () => {
    const h = make({ viewOf: () => ({ p: 1 }) });
    const { id } = await parked(h);
    const state0 = await h.runtime.loadState(id);
    const handle = await h.runtime.resume(id, answerApproval(state0!, { approved: true }));
    await handle.waitForCompletion();
    expect(h.applied()).toBe(1);
  });

  it("a gate that declares no view is unaffected (backward compatible)", async () => {
    const h = make();
    const { id } = await parked(h);
    const handle = await h.runtime.resume(id, {
      eventType: "Approval",
      payload: { approved: true },
    });
    await handle.waitForCompletion();
    expect(h.applied()).toBe(1);
  });

  it("replay of an approved execution is unchanged (loadState folds the same)", async () => {
    const h = make({ viewOf: () => ({ p: 1 }) });
    const { id } = await parked(h);
    const s0 = await h.runtime.loadState(id);
    await (await h.runtime.resume(id, answerApproval(s0!, { approved: true }))).waitForCompletion();
    const a = await h.runtime.loadState(id);
    const b = await h.runtime.loadState(id);
    expect(a).toEqual(b);
    expect(a?.status).toBe("completed");
    expect(a?.suspendedOn).toBeUndefined();
  });
});

const bindOf = async (h: ReturnType<typeof make>, id: string) => ({
  executionId: id,
  parkedAtSequence: (await h.runtime.parkedAtSequence(id))!,
  exp: Date.now() + 60_000,
});
const sign = async (h: ReturnType<typeof make>, id: string, event: ResumeEvent) =>
  signResume(event, { actor: "alice", secret: KEY, ...(await bindOf(h, id)) });
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );

describe("R13 — signed approval end to end", () => {
  it("records the verified actor; an unsigned or forged resume is refused with the log untouched", async () => {
    const h = make({ viewOf: () => ({ p: 1 }), auth: true });
    const { id, before } = await parked(h);
    const state = (await h.runtime.loadState(id))!;
    const answer = answerApproval(state, { approved: true });

    for (const event of [
      answer,
      signResume(answer, {
        actor: "alice",
        secret: "wrong-wrong-wrong-wrong",
        ...(await bindOf(h, id)),
      }),
    ]) {
      const err = await refusal(h.runtime.resume(id, event));
      expect(err).toBeInstanceOf(ApprovalRejectedError);
      expect(await h.eventStore.read(id)).toEqual(before);
    }

    await (await h.runtime.resume(id, await sign(h, id, answer))).waitForCompletion();
    const log = await h.eventStore.read(id);
    const granted = log.find((e) => e.eventType === "APPROVAL_GRANTED");
    expect(granted?.payload).toMatchObject({ actor: "alice", verifiedBy: "hmac-sha256" });
  });

  it("a validly signed STALE approval is still refused (identity does not imply freshness)", async () => {
    const h = make({ viewOf: (n) => ({ p: n }), auth: true });
    const { id, before } = await parked(h, 2);
    const stale = await sign(h, id, {
      eventType: "Approval",
      payload: { approved: true, viewDigest: viewDigest({ p: 1 }) },
    });
    const err = await refusal(h.runtime.resume(id, stale));
    expect((err as ResumeRefusedError).reason).toBe("view-digest-mismatch");
    expect(await h.eventStore.read(id)).toEqual(before);
  });

  // P1-a (review round 1): Alice's event lifted out of execution A's log and resumed at a NEW
  // execution B was ACCEPTED, the tool ran twice, and B recorded APPROVAL_GRANTED for alice.
  it("probe: an approval taken from execution A's log is refused at execution B", async () => {
    const h = make({ viewOf: () => ({ p: 1 }), auth: true });
    const a = await parked(h);
    const b = await parked(h);
    const answerA = await sign(
      h,
      a.id,
      answerApproval((await h.runtime.loadState(a.id))!, { approved: true })
    );
    await (await h.runtime.resume(a.id, answerA)).waitForCompletion();
    // what the log of A now holds, verbatim
    const inLog = (await h.eventStore.read(a.id)).find(
      (e) => e.eventType === "Approval" || JSON.stringify(e.payload).includes('"proof"')
    );
    expect(inLog).toBeDefined();
    const err = await refusal(h.runtime.resume(b.id, answerA));
    expect(err).toBeInstanceOf(ApprovalRejectedError);
    expect(await h.eventStore.read(b.id)).toEqual(b.before);
    expect(h.applied()).toBe(1);
  });

  it("probe: an approval for the first park of a gate does not approve a LATER park of it (a loop)", async () => {
    const h = make({ viewOf: () => ({ p: 1 }), auth: true, twice: true });
    const { id } = await parked(h);
    const answer1 = await sign(
      h,
      id,
      answerApproval((await h.runtime.loadState(id))!, { approved: true })
    );
    const handle = await h.runtime.resume(id, answer1);
    await handle.waitForSuspend(); // parked again, same gate, same digest
    const mid = await h.eventStore.read(id);
    const err = await refusal(h.runtime.resume(id, answer1));
    expect(err).toBeInstanceOf(ApprovalRejectedError);
    expect(await h.eventStore.read(id)).toEqual(mid);
    expect(h.applied()).toBe(0);
    // a fresh signature for THIS park goes through
    const answer2 = await sign(
      h,
      id,
      answerApproval((await h.runtime.loadState(id))!, { approved: true })
    );
    await (await h.runtime.resume(id, answer2)).waitForCompletion();
    expect(h.applied()).toBe(1);
  });

  it("probe: the parent's approval does not approve a FORK (it copies the parent's park)", async () => {
    const h = make({ viewOf: () => ({ p: 1 }), auth: true });
    const { id } = await parked(h);
    const tip = (await h.eventStore.read(id)).length - 1;
    const { executionId: childId } = await h.runtime.fork(id, tip, { executionId: "child" });
    const forAParent = await sign(
      h,
      id,
      answerApproval((await h.runtime.loadState(id))!, { approved: true })
    );
    const childBefore = await h.eventStore.read(childId);
    const err = await refusal(h.runtime.resume(childId, forAParent));
    expect(err).toBeInstanceOf(ApprovalRejectedError);
    expect(await h.eventStore.read(childId)).toEqual(childBefore);
    expect(h.applied()).toBe(0);
  });

  it("the signing actor must be the calling principal", async () => {
    const h = make({ viewOf: () => ({ p: 1 }), auth: true });
    const { id, before } = await parked(h);
    const event = await sign(
      h,
      id,
      answerApproval((await h.runtime.loadState(id))!, { approved: true })
    );
    const err = await refusal(h.runtime.resume(id, event, { principal: { actor: "mallory" } }));
    expect(err).toBeInstanceOf(ApprovalRejectedError);
    expect(await h.eventStore.read(id)).toEqual(before);
    await (
      await h.runtime.resume(id, event, { principal: { actor: "alice" } })
    ).waitForCompletion();
  });
});

describe("R13 round 1 — the digest", () => {
  it("is SHA-256 under v2: (64 hex), not the 64-bit FNV it started as", () => {
    expect(viewDigest({ a: 1 })).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  it("an execution parked with a v1: digest (pre-fix) is still resumable by echoing it", async () => {
    const h = make({ viewOf: () => ({ p: 1 }) });
    // park by hand with a legacy digest: a flow whose gate carries a literal v1 value
    const legacy = "v1:00ff00ff00ff00ff";
    const runner = (async (ctx) => {
      await ctx.suspend({ on: "Approval", viewDigest: legacy });
      return {};
    }) as FlowRunner<unknown, unknown>;
    const def = { ...h.flow.definition, id: "legacy-f" };
    h.runtime.registerFlow(def, runner);
    const handle = await h.runtime.start({ definition: def, runner }, {});
    await handle.waitForSuspend();
    const state = (await h.runtime.loadState(handle.executionId))!;
    expect(state.suspendedOn?.viewDigest).toBe(legacy);
    const err = await refusal(
      h.runtime.resume(handle.executionId, { eventType: "Approval", payload: { approved: true } })
    );
    expect((err as ResumeRefusedError).reason).toBe("view-digest-mismatch");
    await (
      await h.runtime.resume(handle.executionId, answerApproval(state, { approved: true }))
    ).waitForCompletion();
  });
});

// P1-b (review round 1): suspend({ on: "Approval", timeout, viewDigest }) was answered by a
// caller-supplied TIMER_FIRED { approved: true } — digest exempt, authenticator not-applicable,
// and the flow received { approved: true }.
describe("R13 round 1 — TIMER_FIRED is the kernel's wake, not a caller's approval", () => {
  function timedGate(strict: boolean) {
    let applied = 0;
    const effects = new EffectRuntime();
    effects.register(
      "t-apply",
      new ToolEffect(async () => {
        applied++;
        return { done: true };
      })
    );
    const eventStore = new InMemoryAsyncEventStore();
    const timerStore = new InMemoryTimerStore();
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
      timerStore,
      ...(strict && {
        executionAuthorizer: executionAccessPolicy({
          rules: { start: "any", resume: "any", cancel: "any", query: "any" },
        }),
        executionAuthz: { requirePrincipal: true },
      }),
    });
    const definition = {
      _tag: "FlowDefinition" as const,
      id: "tg",
      name: "tg",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [apply],
    };
    const seen: unknown[] = [];
    const runner = (async (ctx) => {
      const r = await ctx.suspend({
        on: "Approval",
        timeout: 60_000,
        viewDigest: viewDigest({ p: 1 }),
      });
      seen.push(r);
      if ((r as { approved?: boolean } | null)?.approved === true) await ctx.run(apply, {});
      return {};
    }) as FlowRunner<unknown, unknown>;
    runtime.registerFlow(definition, runner);
    return {
      runtime,
      flow: { definition, runner },
      eventStore,
      timerStore,
      seen,
      applied: () => applied,
    };
  }

  it("non-strict: a caller TIMER_FIRED { approved: true } reaches the flow as exactly { wakeAt }", async () => {
    const h = timedGate(false);
    const handle = await h.runtime.start(h.flow, {});
    const state = await handle.waitForSuspend();
    const wakeAt = state.suspendedOn?.wakeAt;
    expect(wakeAt).toBeDefined();
    await (
      await h.runtime.resume(handle.executionId, {
        eventType: "TIMER_FIRED",
        payload: { approved: true, wakeAt: 1 },
      })
    ).waitForCompletion();
    expect(h.applied()).toBe(0);
    expect(h.seen).toEqual([{ wakeAt }]);
    const fired = (await h.eventStore.read(handle.executionId)).find(
      (e) => e.eventType === "TIMER_FIRED"
    );
    expect(fired?.payload).toEqual({ wakeAt });
  });

  it("strict: a caller without the system grant is refused before the append; the TimerService's wake still fires", async () => {
    const h = timedGate(true);
    const principal = { actor: "alice" };
    const handle = await h.runtime.start(h.flow, {}, { principal });
    await handle.waitForSuspend();
    const before = await h.eventStore.read(handle.executionId);
    const err = await refusal(
      h.runtime.resume(
        handle.executionId,
        { eventType: "TIMER_FIRED", payload: { approved: true } },
        { principal }
      )
    );
    expect(err).toBeInstanceOf(ResumeRefusedError);
    expect((err as ResumeRefusedError).reason).toBe("timer-wake-not-system");
    expect(await h.eventStore.read(handle.executionId)).toEqual(before);
    expect(h.applied()).toBe(0);

    // the legitimate timer path (TimerService passes systemOptions()) still wakes it
    const service = new TimerService(h.runtime, h.timerStore);
    await service.tick(Date.now() + 120_000);
    expect((await h.runtime.loadState(handle.executionId, h.runtime.systemOptions()))?.status).toBe(
      "completed"
    );
    expect(h.seen).toHaveLength(1);
    expect((h.seen[0] as { approved?: boolean }).approved).toBeUndefined();
    expect(h.applied()).toBe(0);
  });
});
