import type { FlowDefinition } from "@loom/core";
import {
  CapabilityDeniedError,
  EffectRuntime,
  GrantTable,
  ToolEffect,
  signDelegation,
} from "@loom/effect-runtime";
import type {
  CapabilityAuthorizer,
  CapabilityRequest,
  EffectContext,
  EffectMiddleware,
} from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";

// L30 — a decider's transient calls run AS the deciding execution: its workflowId,
// executionId and FULL principal (actor + delegation) reach the K2 authorizer and the
// middleware chain, while the call stays transient (nothing journalled but the decision).

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;

function setup(
  flowId: string,
  runner: FlowRunner<Record<string, unknown>, Record<string, unknown>>,
  opts: { authorizer?: CapabilityAuthorizer; middleware?: EffectMiddleware[] } = {}
) {
  const eventStore = new InMemoryAsyncEventStore();
  let calls = 0;
  const effects = new EffectRuntime(opts.middleware ?? [], {
    ...(opts.authorizer !== undefined && { authorizer: opts.authorizer }),
  });
  effects.register(
    "plan",
    new ToolEffect(async () => {
      calls++;
      return { ok: true };
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: () => {},
  });
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: flowId,
    name: flowId,
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [],
  };
  runtime.registerFlow(definition, runner);
  const types = async (id: string) => (await eventStore.read(id)).map((e) => e.eventType);
  return { runtime, eventStore, definition, types, calls: () => calls };
}

const decidingRunner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (
  ctx
) => {
  const r = await ctx.decide("pick", (scope) => scope.invokeTransient("plan", {}));
  return { r };
};

describe("ctx.decide hands the decider an invoker stamped with the deciding execution (L30)", () => {
  it("flow-scoped grants apply: the authorizer sees the deciding flow, not 'transient'", async () => {
    const seen: CapabilityRequest[] = [];
    const grants = new GrantTable({ "granted-flow": ["plan"] });
    const authorizer: CapabilityAuthorizer = {
      authorize: (req) => {
        seen.push(req);
        return grants.authorize(req);
      },
    };
    const { runtime, definition, types, calls } = setup("granted-flow", decidingRunner, {
      authorizer,
    });
    const h = await runtime.start(definition, {}, { executionId: "e1" });
    await h.waitForCompletion();
    expect(calls()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ workflowId: "granted-flow", executionId: "e1" });
    // Transient: the only thing the decider's call added to the log is the decision itself.
    const t = await types("e1");
    expect(t.filter((x) => x === "DECISION_RECORDED")).toHaveLength(1);
    expect(t).not.toContain("STEP_STARTED");
    expect(t).not.toContain("EFFECT_DENIED");
  });

  it("NEGATIVE: a flow lacking the grant is DENIED, the effect never runs, no decision recorded", async () => {
    const grants = new GrantTable({ "granted-flow": ["plan"] });
    const { runtime, definition, types, calls } = setup("other-flow", decidingRunner, {
      authorizer: grants,
    });
    const h = await runtime.start(definition, {}, { executionId: "e2" });
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(calls()).toBe(0);
    expect(await types("e2")).not.toContain("DECISION_RECORDED");
  });

  it("the full principal (actor + delegation token) reaches the authorizer and middleware", async () => {
    const token = signDelegation("s3cret", "alice", ["plan"]);
    const principal = { tenant: "t1", actor: "alice", delegation: token };
    const seen: CapabilityRequest[] = [];
    const ctxs: EffectContext[] = [];
    const mw: EffectMiddleware = (ctx, input, next) => {
      ctxs.push(ctx);
      return next(input);
    };
    const { runtime, definition } = setup("any-flow", decidingRunner, {
      authorizer: {
        authorize: (req) => {
          seen.push(req);
          return { allowed: true };
        },
      },
      middleware: [mw],
    });
    const h = await runtime.start(definition, {}, { executionId: "e3", principal });
    await h.waitForCompletion();
    expect(seen[0]?.principal).toEqual(principal);
    expect(seen[0]?.principal?.delegation).toEqual(token);
    expect(ctxs[0]).toMatchObject({
      workflowId: "any-flow",
      executionId: "e3",
      stepId: "decide:pick",
      principal,
    });
  });

  it("a delegation that does not cover the effect DENIES the decider's call", async () => {
    const token = signDelegation("s3cret", "alice", ["something-else"]);
    const { DelegationAuthorizer } = await import("@loom/effect-runtime");
    const authorizer = new DelegationAuthorizer({
      secret: "s3cret",
      base: new GrantTable({ "any-flow": ["*"] }),
    });
    const { runtime, definition, calls } = setup("any-flow", decidingRunner, { authorizer });
    const h = await runtime.start(
      definition,
      {},
      { executionId: "e4", principal: { actor: "alice", delegation: token } }
    );
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(calls()).toBe(0);
  });

  it("replay serves the recorded decision: the decider and its transient call do NOT run again", async () => {
    let deciderRuns = 0;
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      const r = await ctx.decide("pick", (scope) => {
        deciderRuns++;
        return scope.invokeTransient("plan", {});
      });
      await ctx.suspend({ on: "go" });
      return { r };
    };
    const { runtime, definition, calls } = setup("f", runner);
    const h = await runtime.start(definition, {}, { executionId: "e5" });
    await h.waitForSuspend();
    expect([deciderRuns, calls()]).toEqual([1, 1]);
    await (await runtime.resume("e5", { eventType: "go", payload: {} })).waitForCompletion();
    expect([deciderRuns, calls()]).toEqual([1, 1]);
  });

  it("the scope is closed once the decider settles", async () => {
    let leaked: { invokeTransient: (t: string, i: unknown) => Promise<unknown> } | undefined;
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      await ctx.decide("pick", (scope) => {
        leaked = scope;
        return 1;
      });
      return {};
    };
    const { runtime, definition, calls } = setup("f", runner);
    await (await runtime.start(definition, {}, { executionId: "e6" })).waitForCompletion();
    await expect(leaked?.invokeTransient("plan", {})).rejects.toThrow(/scope is closed/);
    expect(calls()).toBe(0);
  });
});
