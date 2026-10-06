import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import {
  type CapabilityAuthorizer,
  type CapabilityRequest,
  DelegationAuthorizer,
  EffectRuntime,
  GrantTable,
  type PrincipalChain,
  ToolEffect,
  signDelegation,
} from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TimerService } from "./TimerService";
import { WorkflowRuntime, type WorkflowRuntimeDeps } from "./WorkflowRuntime";
import { executionAccessPolicy } from "./executionAccessPolicy";
import { type PrincipalCodec, PrincipalUnrestorableError } from "./principal";
import { recoverAbandoned } from "./recoverAbandoned";
import type {
  ExecutionAuthorizer,
  ExecutionAuthzRequest,
  FlowRunner,
  RegisteredFlow,
  ResumeAuthenticator,
} from "./types";

// ── R3k (ADR 0111) — the execution's principal is durable ─────────────────────
//
// Two questions the kernel used to conflate: who may perform a LIFECYCLE op (the call's
// `options.principal`), and whose authority the execution's EFFECTS run under (the owner, recorded
// at sequence 0). Every test here fails on `main`, where the effect principal was whoever drove
// the last `execute()`.

const io = { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
const actStep = step$({ id: "act", name: "act", toolId: "act-tool", ...io });
const preStep = step$({ id: "pre", name: "pre", toolId: "pre-tool", ...io });

const alice: PrincipalChain = { actor: "alice", tenant: "acme" };
const bob: PrincipalChain = { actor: "bob", tenant: "globex" };

interface Seen {
  principal: PrincipalChain | undefined;
}

function boot(
  opts: {
    gated?: "approval" | "sleep" | "crash";
    /** crash scenario only: the first `pre-tool` call never returns (a SIGKILLed worker). */
    hang?: boolean;
    shared?: {
      eventStore: InMemoryAsyncEventStore;
      snapshotStore: InMemoryAsyncSnapshotStore;
      timerStore: InMemoryTimerStore;
    };
    authorizer?: CapabilityAuthorizer;
    deps?: Partial<WorkflowRuntimeDeps>;
    executionAuthorizer?: ExecutionAuthorizer;
  } = {}
) {
  const seen: Seen[] = [];
  const asked: CapabilityRequest[] = [];
  const base: CapabilityAuthorizer = {
    authorize: (req) => {
      asked.push(req);
      seen.push({ principal: req.principal });
      // A tenant DENY the kernel never made: the authorizer does. On `main` the tenant was ""
      // after a timer wake or recovery, so this rule silently did not fire.
      return req.principal?.tenant === "globex" && req.toolId === "act-tool"
        ? { allowed: false, reason: "tenant globex is denied" }
        : (opts.authorizer?.authorize(req) ?? { allowed: true });
    },
  };
  const effects = new EffectRuntime([], { authorizer: base });
  const ran: string[] = [];
  effects.register(
    "act-tool",
    new ToolEffect(async () => {
      ran.push("act");
      return { ok: true };
    })
  );
  effects.register(
    "pre-tool",
    new ToolEffect(async () => {
      if (opts.hang === true) await new Promise<void>(() => {});
      return { ok: true };
    })
  );
  const stores = opts.shared
    ? {
        eventStore: opts.shared.eventStore,
        snapshotStore: opts.shared.snapshotStore,
        timerStore: opts.shared.timerStore,
      }
    : {
        eventStore: new InMemoryAsyncEventStore(),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        timerStore: new InMemoryTimerStore(),
      };
  const runtime = new WorkflowRuntime({
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    timerStore: stores.timerStore,
    effectRuntime: effects,
    ...(opts.executionAuthorizer !== undefined && {
      executionAuthorizer: opts.executionAuthorizer,
    }),
    ...opts.deps,
  });
  const runner: FlowRunner<unknown, { ok: boolean }> = async (ctx) => {
    if (opts.gated === "approval") await ctx.suspend({ on: "ApprovalGranted" });
    if (opts.gated === "sleep") await ctx.sleep(60_000);
    if (opts.gated === "crash") await ctx.run(preStep, {});
    return ctx.run(actStep, {});
  };
  const definition: FlowDefinition = {
    _tag: "FlowDefinition",
    id: "owned",
    name: "owned",
    version: "1.0.0",
    ...io,
    steps: [preStep, actStep],
  };
  const flow: RegisteredFlow = { definition, runner: runner as FlowRunner<unknown, unknown> };
  runtime.registerFlow(definition, runner as FlowRunner<unknown, unknown>);
  return { runtime, flow, seen, asked, ran, ...stores };
}

const startedOf = async (store: InMemoryAsyncEventStore, id: string): Promise<EventEnvelope> =>
  (await store.read(id))[0]!;

describe("D1 — every 1.23 start records a principal", () => {
  it("an anonymous start records { v: 1 }; an identified one records the identity subset, never extra claims", async () => {
    const h = boot();
    const anon = await h.runtime.start(h.flow, {}, { executionId: "anon" });
    await anon.waitForCompletion();
    expect((await startedOf(h.eventStore, "anon")).payload).toMatchObject({ principal: { v: 1 } });
    expect((await startedOf(h.eventStore, "anon")).payload as { principal: unknown }).toEqual(
      expect.objectContaining({ principal: { v: 1 } })
    );

    const named = await h.runtime.start(
      h.flow,
      {},
      {
        executionId: "named",
        principal: { ...alice, onBehalfOf: "carol", roles: ["admin"], secretClaim: "x" },
      }
    );
    await named.waitForCompletion();
    const payload = (await startedOf(h.eventStore, "named")).payload as {
      principal: Record<string, unknown>;
    };
    expect(payload.principal).toEqual({
      v: 1,
      identity: { tenant: "acme", actor: "alice", onBehalfOf: "carol" },
    });
    // folded to the reserved key, and extra fields are dropped: a log is permanent.
    const state = await h.runtime.loadState("named");
    expect(state?.variables._principal).toEqual(payload.principal);
    expect(JSON.stringify(await h.eventStore.read("named"))).not.toContain("secretClaim");
  });

  it("a delegation token is never written: a digest and an expiry only", async () => {
    const token = signDelegation("s3cret", "alice", ["act-tool"], 9_999_999_999_999);
    const resolver = { resolve: () => ({ ...alice, delegation: token }) };
    const h = boot({ deps: { principalResolver: resolver } });
    const run = await h.runtime.start(
      h.flow,
      {},
      { executionId: "deleg", principal: { ...alice, delegation: token } }
    );
    await run.waitForCompletion();
    const log = JSON.stringify(await h.eventStore.read("deleg"));
    expect(log).not.toContain(token.sig);
    const rec = (
      (await startedOf(h.eventStore, "deleg")).payload as { principal: { delegation?: unknown } }
    ).principal;
    expect(rec.delegation).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{64}$/),
      exp: 9_999_999_999_999,
    });
  });

  it("a start whose principal carries a delegation with no restorer is refused with the log EMPTY (D4 rule 2)", async () => {
    const token = signDelegation("s3cret", "alice", ["act-tool"]);
    const h = boot();
    await expect(
      h.runtime.start(
        h.flow,
        {},
        { executionId: "nope", principal: { ...alice, delegation: token } }
      )
    ).rejects.toBeInstanceOf(PrincipalUnrestorableError);
    expect(await h.eventStore.read("nope")).toHaveLength(0);
  });

  it("`parent` is recorded beside the principal and folds to _parent ONLY for a system-granted start (R3k review P2-b)", async () => {
    const h = boot({
      executionAuthorizer: { authorize: () => ({ allowed: true }) },
      deps: { executionAuthz: { requirePrincipal: true } },
    });
    const run = await h.runtime.start(
      h.flow,
      {},
      { executionId: "kid", parentExecutionId: "mom", ...h.runtime.systemOptions() }
    );
    await run.waitForCompletion();
    expect((await startedOf(h.eventStore, "kid")).payload).toMatchObject({ parent: "mom" });
    expect((await h.runtime.loadState("kid"))?.variables._parent).toBe("mom");
  });

  it("a caller-supplied parentExecutionId WITHOUT the system grant is not recorded (it would pin someone else's retention)", async () => {
    const h = boot({
      executionAuthorizer: { authorize: () => ({ allowed: true }) },
      deps: { executionAuthz: { requirePrincipal: true } },
    });
    const run = await h.runtime.start(
      h.flow,
      {},
      { executionId: "kid2", parentExecutionId: "mom", principal: alice }
    );
    await run.waitForCompletion();
    expect((await startedOf(h.eventStore, "kid2")).payload).not.toHaveProperty("parent");
    expect((await h.runtime.loadState("kid2"))?.variables._parent).toBeUndefined();
  });
});

describe("R3k review P2-a — a live execution's owner is known before sequence 0 is durable", () => {
  it("start (minted id) then an immediate cancel by the owner is NOT denied while the journal write lags", async () => {
    const inner = new InMemoryAsyncEventStore();
    const slow = new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        if (typeof prop === "string" && prop.startsWith("append")) {
          return async (...args: unknown[]) => {
            await new Promise((r) => setTimeout(r, 30));
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return v.bind(target);
      },
    });
    const h = boot({
      gated: "approval",
      executionAuthorizer: executionAccessPolicy(),
      shared: {
        eventStore: slow as InMemoryAsyncEventStore,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        timerStore: new InMemoryTimerStore(),
      },
    });
    const run = await h.runtime.start(h.flow, {}, { principal: alice });
    await expect(h.runtime.cancel(run.executionId, "stop", { principal: alice })).resolves.toBe(
      true
    );
  });
});

describe("D5 — the authorizer is handed the owner, read from the log", () => {
  it("owner is supplied for an execution started before a 'restart' (a second runtime over the same stores)", async () => {
    const requests: ExecutionAuthzRequest[] = [];
    const policy = executionAccessPolicy();
    const spy: ExecutionAuthorizer = {
      authorize: (r) => {
        requests.push(r);
        return policy.authorize(r);
      },
    };
    const a = boot({ gated: "approval", executionAuthorizer: spy });
    const run = await a.runtime.start(a.flow, {}, { executionId: "ow", principal: alice });
    await run.waitForSuspend();
    const b = boot({ gated: "approval", shared: a, executionAuthorizer: spy });
    requests.length = 0;
    await b.runtime.loadState("ow", { principal: { actor: "carol", tenant: "acme" } });
    expect(requests.at(-1)).toMatchObject({
      op: "query",
      owner: { tenant: "acme", actor: "alice" },
    });
    // and the durable owner is enforced by the reference policy with no in-process table
    await expect(
      b.runtime.loadState("ow", { principal: { actor: "eve", tenant: "other" } })
    ).rejects.toThrow(/another tenant/);
  });
});

describe("D7 — a fork acts as the FORKER; acting as the owner is a separate default-deny op", () => {
  it("the fork's remaining effects run as the forker, and the owner's tenant grant is not inherited", async () => {
    const policy = executionAccessPolicy({ rules: { query: "any", start: "any" } });
    const h = boot({ gated: "approval", executionAuthorizer: policy });
    const run = await h.runtime.start(h.flow, {}, { executionId: "fp", principal: alice });
    await run.waitForSuspend();
    const parentSeq = (await h.runtime.loadState("fp"))!.sequence;
    const forkerChain: PrincipalChain = { actor: "dave", tenant: "initech" };
    const f = await h.runtime.fork("fp", parentSeq, { executionId: "fk", principal: forkerChain });
    // forkedBy rides sequence 0's metadata, and the fold prefers it
    expect((await startedOf(h.eventStore, "fk")).metadata?.forkedBy).toEqual({
      v: 1,
      identity: { tenant: "initech", actor: "dave" },
    });
    expect(f.state.variables._principal).toEqual({
      v: 1,
      identity: { tenant: "initech", actor: "dave" },
    });
    const handle = await h.runtime.resume(
      f.executionId,
      { eventType: "ApprovalGranted", payload: {} },
      { principal: forkerChain }
    );
    await handle.waitForCompletion();
    expect(h.seen.at(-1)?.principal).toEqual({ tenant: "initech", actor: "dave" });
    // the parent is untouched and still the owner's
    const parentResume = await h.runtime.resume(
      "fp",
      { eventType: "ApprovalGranted", payload: {} },
      { principal: { actor: "carol", tenant: "acme" } }
    );
    await parentResume.waitForCompletion();
    expect(h.seen.at(-1)?.principal).toEqual({ tenant: "acme", actor: "alice" });
  });

  it("actAs: 'owner' is refused by default (op actAsOwner), writes nothing, and is allowed once opened", async () => {
    const closed = executionAccessPolicy({ rules: { query: "any", start: "any" } });
    const h = boot({ gated: "approval", executionAuthorizer: closed });
    const run = await h.runtime.start(h.flow, {}, { executionId: "ao", principal: alice });
    await run.waitForSuspend();
    const seq = (await h.runtime.loadState("ao"))!.sequence;
    const dave: PrincipalChain = { actor: "dave", tenant: "acme" };
    await expect(
      h.runtime.fork("ao", seq, { executionId: "ao-fk", principal: dave, actAs: "owner" })
    ).rejects.toThrow(/actAsOwner/);
    expect(await h.eventStore.read("ao-fk")).toHaveLength(0);

    const open = executionAccessPolicy({
      rules: { query: "any", start: "any", actAsOwner: "tenant" },
    });
    const h2 = boot({ gated: "approval", executionAuthorizer: open, shared: h });
    const f = await h2.runtime.fork("ao", seq, {
      executionId: "ao-fk2",
      principal: dave,
      actAs: "owner",
    });
    const meta = (await startedOf(h.eventStore, "ao-fk2")).metadata;
    expect(meta?.forkActAs).toBe("owner");
    expect(meta?.forkedBy).toBeUndefined();
    const handle = await h2.runtime.resume(
      f.executionId,
      { eventType: "ApprovalGranted", payload: {} },
      { principal: dave }
    );
    await handle.waitForCompletion();
    expect(h2.seen.at(-1)?.principal).toEqual({ tenant: "acme", actor: "alice" });
  });
});
