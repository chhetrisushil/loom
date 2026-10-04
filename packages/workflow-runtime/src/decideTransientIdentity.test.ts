import type { FlowDefinition } from "@loom/core";
import { step$ } from "@loom/core";
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
import {
  InMemorySecretResolver,
  meteringMiddleware,
  redactOutputFrom,
  redactionMiddleware,
} from "@loom/middleware";
import { QuotaExceededError } from "@loom/middleware";
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
      stepId: "plan", // = toolId, exactly what a bare invokeTransient stamps (stepId-keyed config matches)
      callKey: "decide:pick:0",
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

// ── Fix round 1 ───────────────────────────────────────────────────────────────

const spendStep = step$({
  id: "spend",
  name: "spend",
  toolId: "spend-tool",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
});

function bootWith(
  flowId: string,
  runner: FlowRunner<Record<string, unknown>, Record<string, unknown>>,
  effects: EffectRuntime
) {
  const eventStore = new InMemoryAsyncEventStore();
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
    steps: [spendStep],
  };
  runtime.registerFlow(definition, runner);
  return { runtime, eventStore, definition };
}

const hang = (seen?: { signal?: AbortSignal }) =>
  new ToolEffect(
    (_i: unknown, ctx: EffectContext) =>
      new Promise((_res, rej) => {
        if (seen !== undefined) seen.signal = ctx.signal;
        ctx.signal?.addEventListener("abort", () => rej(new Error("aborted-by-signal")), {
          once: true,
        });
      })
  );

describe("P1 — secret redaction applies to scope calls exactly like the bare call", () => {
  const mkRuntime = () => {
    const resolver = new InMemorySecretResolver();
    const effects = new EffectRuntime([
      redactionMiddleware({
        resolver,
        redactOutput: redactOutputFrom(new Map([["creds", ["token"]]])),
      }),
    ]);
    effects.register("creds", new ToolEffect(async () => ({ token: "PLAINTEXT-SECRET" })));
    return effects;
  };

  it("control: the bare invokeTransient yields a reference, not the plaintext", async () => {
    const out = await mkRuntime().invokeTransient<unknown, { token: unknown }>("creds", {});
    expect(JSON.stringify(out)).not.toContain("PLAINTEXT-SECRET");
  });

  it("the DECISION_RECORDED payload of a scope call holds no plaintext", async () => {
    const { runtime, eventStore, definition } = bootWith(
      "f",
      async (ctx) => ({ r: await ctx.decide("d", (s) => s.invokeTransient("creds", {})) }),
      mkRuntime()
    );
    await (await runtime.start(definition, {}, { executionId: "p1" })).waitForCompletion();
    const log = JSON.stringify(await eventStore.read("p1"));
    expect(log).not.toContain("PLAINTEXT-SECRET");
    expect(log).toContain("__loomSecret");
  });

  it("two calls to the same secret tool in one decider keep DISTINCT secret refs", async () => {
    const resolver = new InMemorySecretResolver();
    const effects = new EffectRuntime([
      redactionMiddleware({
        resolver,
        redactOutput: redactOutputFrom(new Map([["creds", ["token"]]])),
      }),
    ]);
    let n = 0;
    effects.register("creds", new ToolEffect(async () => ({ token: `secret-${++n}` })));
    const { runtime, eventStore, definition } = bootWith(
      "f",
      async (ctx) => {
        const r = await ctx.decide("d", async (s) => [
          await s.invokeTransient<unknown, { token: { __loomSecret: string } }>("creds", {}),
          await s.invokeTransient<unknown, { token: { __loomSecret: string } }>("creds", {}),
        ]);
        return { r };
      },
      effects
    );
    const h = await runtime.start(definition, {}, { executionId: "p1b" });
    await h.waitForCompletion();
    const ev = (await eventStore.read("p1b")).find((e) => e.eventType === "DECISION_RECORDED");
    const choice = (ev?.payload as { choice: { token: { __loomSecret: string } }[] }).choice;
    expect(choice[0]?.token.__loomSecret).toBeDefined();
    expect(choice[0]?.token.__loomSecret).not.toBe(choice[1]?.token.__loomSecret);
  });
});

describe("P1 — stepId-keyed middleware matches the scope path; calls get distinct callKeys", () => {
  it("stepId === toolId, callKey differs per call and per decision", async () => {
    const ctxs: EffectContext[] = [];
    const { runtime, definition } = setup(
      "f",
      async (ctx) => {
        await ctx.decide("a", async (s) => {
          await s.invokeTransient("plan", {});
          await s.invokeTransient("plan", {});
          return 1;
        });
        await ctx.decide("b", (s) => s.invokeTransient("plan", {}));
        return {};
      },
      {
        middleware: [
          (c, i, next) => {
            ctxs.push(c);
            return next(i);
          },
        ],
      }
    );
    await (await runtime.start(definition, {}, { executionId: "k1" })).waitForCompletion();
    expect(ctxs.map((c) => c.stepId)).toEqual(["plan", "plan", "plan"]);
    expect(ctxs.map((c) => c.callKey)).toEqual(["decide:a:0", "decide:a:1", "decide:b:0"]);
  });

  it("two scope calls to a2a-style id minting do not collide (executionId:stepId:callKey unique)", async () => {
    const ids = new Set<string>();
    const { runtime, definition } = setup(
      "f",
      async (ctx) => {
        await ctx.decide("a", async (s) => {
          await s.invokeTransient("plan", {});
          return s.invokeTransient("plan", {});
        });
        return {};
      },
      {
        middleware: [
          (c, i, next) => {
            ids.add(`${c.executionId}:${c.stepId}:${c.callKey}`);
            return next(i);
          },
        ],
      }
    );
    await (await runtime.start(definition, {}, { executionId: "k2" })).waitForCompletion();
    expect(ids.size).toBe(2);
  });

  it("a journaled effect is still refused through the scope (callFunction can never mint a transient callId)", async () => {
    const effects = new EffectRuntime();
    effects.register("j", { ...new ToolEffect(async () => 1), mode: "journaled" } as never);
    const { runtime, definition } = bootWith(
      "f",
      async (ctx) => ({ r: await ctx.decide("d", (s) => s.invokeTransient("j", {})) }),
      effects
    );
    const h = await runtime.start(definition, {}, { executionId: "k3" });
    await expect(h.waitForCompletion()).rejects.toThrow(/journaled|mode/i);
  });
});

describe("P2 — the execution's cancellation reaches scope calls", () => {
  const cancelCase = async (id: string, withOwnSignal: boolean) => {
    const seen: { signal?: AbortSignal } = {};
    const effects = new EffectRuntime();
    effects.register("hang", hang(seen));
    const { runtime, definition } = bootWith(
      "f",
      async (ctx) => ({
        r: await ctx.decide("d", (s) =>
          s.invokeTransient(
            "hang",
            {},
            withOwnSignal ? { signal: new AbortController().signal } : undefined
          )
        ),
      }),
      effects
    );
    const h = await runtime.start(definition, {}, { executionId: id });
    const done = h.waitForCompletion();
    done.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.signal?.aborted).toBe(false);
    await runtime.cancel(id, "stop");
    await expect(done).rejects.toThrow();
    expect(seen.signal?.aborted).toBe(true);
  };
  it("default: execution cancel aborts a scope call", () => cancelCase("c1", false));
  it("a decider-supplied signal does NOT drop the execution's cancellation", () =>
    cancelCase("c2", true));

  it("a decider-supplied signal still aborts the call too", async () => {
    const effects = new EffectRuntime();
    effects.register("hang", hang());
    const own = new AbortController();
    const { runtime, definition } = bootWith(
      "f",
      async (ctx) => ({
        r: await ctx.decide("d", (s) => s.invokeTransient("hang", {}, { signal: own.signal })),
      }),
      effects
    );
    const h = await runtime.start(definition, {}, { executionId: "c3" });
    const done = h.waitForCompletion();
    done.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    own.abort();
    await expect(done).rejects.toThrow(/aborted-by-signal/);
  });
});

describe("P3 — budget admission, unawaited calls", () => {
  it("an over-budget execution's scope call is REFUSED by metering admission", async () => {
    const effects = new EffectRuntime([
      meteringMiddleware({
        pricing: () => ({ costUsd: 1 }),
        budget: { maxCostUsd: 1 },
        clock: () => 0,
      }),
    ]);
    effects.register("spend-tool", new ToolEffect(async () => ({ ok: true })));
    let planRan = 0;
    effects.register("plan", new ToolEffect(async () => ++planRan));
    const { runtime, definition } = bootWith(
      "f",
      async (ctx) => {
        await ctx.run(spendStep, {}); // spends the whole $1
        return { r: await ctx.decide("d", (s) => s.invokeTransient("plan", {})) };
      },
      effects
    );
    const h = await runtime.start(definition, {}, { executionId: "b1" });
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(QuotaExceededError);
    expect(planRan).toBe(0);
  });

  it("a call started and NOT awaited is aborted once the decider returns", async () => {
    const seen: { signal?: AbortSignal } = {};
    const effects = new EffectRuntime();
    effects.register("hang", hang(seen));
    let leaked: Promise<unknown> | undefined;
    const { runtime, definition } = bootWith(
      "f",
      async (ctx) => {
        await ctx.decide("d", (s) => {
          leaked = s.invokeTransient("hang", {});
          leaked.catch(() => {});
          return 1;
        });
        return {};
      },
      effects
    );
    await (await runtime.start(definition, {}, { executionId: "u1" })).waitForCompletion();
    expect(seen.signal?.aborted).toBe(true);
    await expect(leaked).rejects.toThrow(/aborted-by-signal/);
  });
});
