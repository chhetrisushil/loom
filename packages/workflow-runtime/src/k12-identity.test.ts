import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import {
  type CapabilityAuthorizer,
  type CapabilityRequest,
  EffectRuntime,
  ToolEffect,
} from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { ApprovalRejectedError } from "./types";
import type { FlowRunner, RegisteredFlow, ResumeAuthenticator } from "./types";

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const actStep = step$({ id: "act", name: "act", toolId: "act-tool", ...io });

const FLOW = "tenant-flow";

function makeFlow(gated: boolean): RegisteredFlow {
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    if (gated) await ctx.suspend({ on: "ApprovalGranted" });
    await ctx.run(actStep, {});
    return {};
  };
  const definition: FlowDefinition = {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    ...io,
    steps: [actStep],
  };
  return { definition, runner };
}

function boot(opts: {
  authorizer?: CapabilityAuthorizer;
  resumeAuthenticator?: ResumeAuthenticator;
  gated?: boolean;
  shared?: { eventStore: InMemoryAsyncEventStore; snapshotStore: InMemoryAsyncSnapshotStore };
}) {
  const effects = new EffectRuntime([], opts.authorizer ? { authorizer: opts.authorizer } : {});
  const actFn = vi.fn(async () => ({}));
  effects.register("act-tool", new ToolEffect(actFn));
  const stores = opts.shared ?? {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  const runtime = new WorkflowRuntime({
    ...stores,
    effectRuntime: effects,
    ...(opts.resumeAuthenticator && { resumeAuthenticator: opts.resumeAuthenticator }),
  });
  const flow = makeFlow(opts.gated ?? false);
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, flow, actFn, ...stores };
}

describe("K12.1 — principal chain threaded to the authorizer (carried opaquely)", () => {
  it("hands the execution's principal to the K2 authorizer per effect", async () => {
    const seen: Array<CapabilityRequest["principal"]> = [];
    const authorizer: CapabilityAuthorizer = {
      authorize: (r) => {
        seen.push(r.principal);
        // A tenant-scoped decision the KERNEL never made — the authorizer does.
        return r.principal?.tenant === "acme"
          ? { allowed: true }
          : { allowed: false, reason: "wrong tenant" };
      },
    };
    const app = boot({ authorizer });

    const handle = await app.runtime.start(
      app.flow,
      {},
      { executionId: "p-1", principal: { tenant: "acme", actor: "alice" } }
    );
    await handle.waitForCompletion();

    expect(seen[0]).toEqual({ tenant: "acme", actor: "alice" });
    expect(app.actFn).toHaveBeenCalledTimes(1);
  });

  it("a wrong-tenant principal is denied (the authorizer interprets; the kernel just carries)", async () => {
    const authorizer: CapabilityAuthorizer = {
      authorize: (r) =>
        r.principal?.tenant === "acme"
          ? { allowed: true }
          : { allowed: false, reason: "wrong tenant" },
    };
    const app = boot({ authorizer });
    const handle = await app.runtime.start(
      app.flow,
      {},
      { executionId: "p-2", principal: { tenant: "evil-corp" } }
    );
    await expect(handle.waitForCompletion()).rejects.toThrow();
    const events = await app.eventStore.read("p-2");
    expect(events.some((e) => e.eventType === "EFFECT_DENIED")).toBe(true);
    expect(app.actFn).not.toHaveBeenCalled();
  });

  it("no principal ⇒ today's behavior (undefined reaches the authorizer)", async () => {
    const seen: Array<CapabilityRequest["principal"]> = [];
    const app = boot({
      authorizer: {
        authorize: (r) => {
          seen.push(r.principal);
          return { allowed: true };
        },
      },
    });
    const handle = await app.runtime.start(app.flow, {}, { executionId: "p-3" });
    await handle.waitForCompletion();
    expect(seen[0]).toBeUndefined();
  });
});

describe("K12.2 — verified approvals (APPROVAL_GRANTED)", () => {
  // An authenticator that only trusts approvals signed by a known actor.
  const authenticator: ResumeAuthenticator = {
    verify: (event) => {
      if (event.eventType !== "ApprovalGranted") return { status: "not-applicable" };
      const p = event.payload as { approvedBy?: string; token?: string };
      if (p.token === "valid-token" && p.approvedBy !== undefined) {
        return { status: "verified", actor: p.approvedBy, verifiedBy: "sso.acme" };
      }
      return { status: "rejected", reason: "approval token invalid" };
    },
  };

  it("a verified approval records a durable APPROVAL_GRANTED fact and resumes", async () => {
    const app = boot({ resumeAuthenticator: authenticator, gated: true });
    const handle = await app.runtime.start(app.flow, {}, { executionId: "a-1" });
    await handle.waitForSuspend();

    const resumed = await app.runtime.resume("a-1", {
      eventType: "ApprovalGranted",
      payload: { approvedBy: "alice", token: "valid-token" },
    });
    await resumed.waitForCompletion();

    const events = await app.eventStore.read("a-1");
    const granted = events.find((e: EventEnvelope) => e.eventType === "APPROVAL_GRANTED");
    expect(granted?.payload).toMatchObject({
      actor: "alice",
      verifiedBy: "sso.acme",
      on: "ApprovalGranted",
    });
    // Folded as durable evidence.
    const state = await app.runtime.loadState("a-1");
    expect((state?.variables._approvals as Array<{ actor?: string }>)[0]?.actor).toBe("alice");
  });

  it("a FORGED approval (bad token) is REFUSED — the execution does not resume", async () => {
    const app = boot({ resumeAuthenticator: authenticator, gated: true });
    const handle = await app.runtime.start(app.flow, {}, { executionId: "a-2" });
    await handle.waitForSuspend();

    await expect(
      app.runtime.resume("a-2", {
        eventType: "ApprovalGranted",
        payload: { approvedBy: "mallory", token: "forged" },
      })
    ).rejects.toBeInstanceOf(ApprovalRejectedError);

    // Still suspended; no APPROVAL_GRANTED, no resume.
    const events = await app.eventStore.read("a-2");
    expect(events.some((e) => e.eventType === "APPROVAL_GRANTED")).toBe(false);
    expect(events.some((e) => e.eventType === "EXECUTION_RESUMED")).toBe(false);
    expect((await app.runtime.loadState("a-2"))?.status).toBe("suspended");
  });

  it("a resume the authenticator marks not-applicable proceeds as an ordinary resume", async () => {
    // A flow gated on a NON-approval signal; the authenticator returns
    // not-applicable for it, so no APPROVAL_GRANTED is recorded and it resumes.
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      await ctx.suspend({ on: "DataReady" });
      await ctx.run(actStep, {});
      return {};
    };
    const definition: FlowDefinition = {
      _tag: "FlowDefinition",
      id: FLOW,
      name: FLOW,
      version: "1.0.0",
      ...io,
      steps: [actStep],
    };
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const effects = new EffectRuntime();
    effects.register("act-tool", new ToolEffect(async () => ({})));
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: effects,
      resumeAuthenticator: authenticator,
    });
    runtime.registerFlow(definition, runner);

    const handle = await runtime.start({ definition, runner }, {}, { executionId: "a-4" });
    await handle.waitForSuspend();
    const resumed = await runtime.resume("a-4", { eventType: "DataReady", payload: {} });
    await resumed.waitForCompletion();

    const events = await eventStore.read("a-4");
    expect(events.some((e) => e.eventType === "APPROVAL_GRANTED")).toBe(false);
    expect(events.some((e) => e.eventType === "EXECUTION_RESUMED")).toBe(true);
    expect((await runtime.loadState("a-4"))?.status).toBe("completed");
  });
});
