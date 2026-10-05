import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { answerApproval, approvalViewDigest, viewDigest } from "./approvalBinding";
import { signResume, signedResumeAuthenticator } from "./signedResumeAuthenticator";
import { ApprovalRejectedError, ResumeRefusedError } from "./types";
import type { FlowRunner } from "./types";

// R13 — an approval is bound to what the approver SAW. The gate declares a digest of the
// proposal in its (durable, fold-visible) suspend condition; a resume must echo it; a stale or
// absent echo is refused BEFORE the append.

const io = z.object({}).passthrough();
const apply = step$({
  id: "apply",
  name: "apply",
  toolId: "t-apply",
  inputSchema: io,
  outputSchema: io,
});

function make(opts: { viewOf?: (n: number) => unknown; auth?: boolean } = {}) {
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
        keys: { alice: "k" },
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
    await ctx.suspend({
      on: "Approval",
      ...(view !== undefined && { viewDigest: viewDigest(view) }),
    });
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

describe("R13 — signed approval end to end", () => {
  it("records the verified actor; an unsigned or forged resume is refused with the log untouched", async () => {
    const h = make({ viewOf: () => ({ p: 1 }), auth: true });
    const { id, before } = await parked(h);
    const state = (await h.runtime.loadState(id))!;
    const answer = answerApproval(state, { approved: true });

    for (const event of [answer, signResume(answer, { actor: "alice", secret: "wrong" })]) {
      const err = await h.runtime.resume(id, event).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ApprovalRejectedError);
      expect(await h.eventStore.read(id)).toEqual(before);
    }

    const ok = signResume(answer, { actor: "alice", secret: "k" });
    await (await h.runtime.resume(id, ok)).waitForCompletion();
    const log = await h.eventStore.read(id);
    const granted = log.find((e) => e.eventType === "APPROVAL_GRANTED");
    expect(granted?.payload).toMatchObject({ actor: "alice", verifiedBy: "hmac-sha256" });
  });

  it("a validly signed STALE approval is still refused (identity does not imply freshness)", async () => {
    const h = make({ viewOf: (n) => ({ p: n }), auth: true });
    const { id, before } = await parked(h, 2);
    const stale = signResume(
      { eventType: "Approval", payload: { approved: true, viewDigest: viewDigest({ p: 1 }) } },
      { actor: "alice", secret: "k" }
    );
    const err = await h.runtime.resume(id, stale).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as ResumeRefusedError).reason).toBe("view-digest-mismatch");
    expect(await h.eventStore.read(id)).toEqual(before);
  });
});
