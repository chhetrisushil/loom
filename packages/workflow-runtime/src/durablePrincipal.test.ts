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

  it("`parent` is recorded beside the principal and folds to _parent", async () => {
    const h = boot();
    const run = await h.runtime.start(h.flow, {}, { executionId: "kid", parentExecutionId: "mom" });
    await run.waitForCompletion();
    expect((await startedOf(h.eventStore, "kid")).payload).toMatchObject({ parent: "mom" });
    expect((await h.runtime.loadState("kid"))?.variables._parent).toBe("mom");
  });
});

describe("D2 — the effects run as the OWNER, on every entry path", () => {
  it("approval by a different actor: effects run as the owner; the approver is recorded in APPROVAL_GRANTED", async () => {
    const auth: ResumeAuthenticator = {
      verify: (_event, ctx) => ({
        status: "verified",
        actor: ctx.principal?.actor ?? "?",
        verifiedBy: "test",
      }),
    };
    const h = boot({ gated: "approval", deps: { resumeAuthenticator: auth } });
    const run = await h.runtime.start(h.flow, {}, { executionId: "ap", principal: alice });
    await run.waitForSuspend();
    // bob (another tenant!) approves. On main the approve's effect ran as bob (and was denied by tenant).
    const resumed = await h.runtime.resume(
      "ap",
      { eventType: "ApprovalGranted", payload: {} },
      { principal: { actor: "carol", tenant: "acme" } }
    );
    await resumed.waitForCompletion();
    expect(h.seen.at(-1)?.principal).toEqual({ tenant: "acme", actor: "alice" });
    const log = await h.eventStore.read("ap");
    const grant = log.find((e) => e.eventType === "APPROVAL_GRANTED");
    expect(grant?.payload).toMatchObject({ actor: "carol", verifiedBy: "test" });
  });

  it("a resume by an unrelated caller (or none) never changes whose authority the effects run under", async () => {
    const h = boot({ gated: "approval" });
    const run = await h.runtime.start(h.flow, {}, { executionId: "ap2", principal: alice });
    await run.waitForSuspend();
    const resumed = await h.runtime.resume(
      "ap2",
      { eventType: "ApprovalGranted", payload: {} },
      { principal: bob }
    );
    await resumed.waitForCompletion();
    // bob's tenant is DENIED by the authorizer; the effect still ran because it ran as alice.
    expect(h.ran).toEqual(["act"]);
    expect((await h.runtime.loadState("ap2"))?.status).toBe("completed");
  });

  it("timer wake: effects run as the owner, so a tenant DENY fires (on main: tenant '' → never fired)", async () => {
    const h = boot({ gated: "sleep" });
    const service = new TimerService(h.runtime, h.timerStore);
    const run = await h.runtime.start(h.flow, {}, { executionId: "tw", principal: bob });
    await run.waitForSuspend();
    await service.tick(Date.now() + 120_000);
    const state = await h.runtime.loadState("tw");
    expect(state?.status).toBe("failed");
    expect(h.seen.at(-1)?.principal).toEqual({ tenant: "globex", actor: "bob" });
    expect(h.ran).toEqual([]);
    expect((await h.eventStore.read("tw")).some((e) => e.eventType === "EFFECT_DENIED")).toBe(true);
  });

  it("timer wake: an allowed owner's effects run as the owner, not as nobody", async () => {
    const h = boot({ gated: "sleep" });
    const service = new TimerService(h.runtime, h.timerStore);
    const run = await h.runtime.start(h.flow, {}, { executionId: "tw2", principal: alice });
    await run.waitForSuspend();
    await service.tick(Date.now() + 120_000);
    expect((await h.runtime.loadState("tw2"))?.status).toBe("completed");
    expect(h.seen.at(-1)?.principal).toEqual({ tenant: "acme", actor: "alice" });
  });

  it("recovery (recoverAbandoned in a second process): effects run as the owner, so a tenant DENY fires", async () => {
    const a = boot({ gated: "crash", hang: true });
    void a.runtime.start(a.flow, {}, { executionId: "rec", principal: bob });
    await new Promise((r) => setTimeout(r, 20));
    expect((await a.runtime.loadState("rec"))?.status).toBe("running");

    const b = boot({ gated: "crash", shared: a });
    const summary = await recoverAbandoned(b.runtime, {
      source: b.eventStore,
      isAbandoned: () => true,
    });
    expect(summary.recovered).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(b.seen.at(-1)?.principal).toEqual({ tenant: "globex", actor: "bob" });
    expect(b.ran).toEqual([]); // denied by the tenant rule, not run as nobody
    expect((await b.runtime.loadState("rec"))?.status).toBe("failed");
  });

  it("restoreFromState reads the owner from the LOG: a doctored or stripped `_principal` in the supplied state is ignored", async () => {
    const h = boot();
    const done = await h.runtime.start(h.flow, {}, { executionId: "rs", principal: alice });
    await done.waitForCompletion();
    // The durable residue of a crash right after the start: sequence 0 only.
    const store = new InMemoryAsyncEventStore();
    const first = await startedOf(h.eventStore, "rs");
    await store.append(first);
    const folded = new ReplayVM([first], {
      executionId: "rs",
      workflowId: "owned",
      workflowVersion: "1.0.0",
    }).getState();
    expect(folded.variables._principal).toMatchObject({ identity: { actor: "alice" } });
    const forged = {
      ...folded,
      variables: {
        ...folded.variables,
        _principal: { v: 1, identity: { tenant: "globex", actor: "mallory" } },
      },
    };
    const stripped = {
      ...folded,
      variables: Object.fromEntries(
        Object.entries(folded.variables).filter(([k]) => k !== "_principal")
      ),
    };
    const shared = (s: InMemoryAsyncEventStore) => ({
      eventStore: s,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      timerStore: new InMemoryTimerStore(),
    });
    for (const state of [forged, stripped]) {
      const s2 = new InMemoryAsyncEventStore();
      await s2.append(first);
      const h2 = boot({ shared: shared(s2) });
      const handle = await h2.runtime.restoreFromState(state, undefined, { principal: bob });
      await handle.waitForCompletion();
      expect(h2.seen.at(-1)?.principal).toEqual({ tenant: "acme", actor: "alice" });
      expect(h2.ran).toEqual(["act"]);
    }
  });

  it("resumeAs: the owner is unchanged by the migration, and `_principal` is identical before and after", async () => {
    const h = boot({ gated: "approval" });
    const run = await h.runtime.start(h.flow, {}, { executionId: "ma", principal: alice });
    await run.waitForSuspend();
    const before = (await h.runtime.loadState("ma"))?.variables._principal;
    h.runtime.registerFlow(
      { ...h.flow.definition, id: "owned-v2", version: "2.0.0" },
      h.flow.runner
    );
    const handle = await h.runtime.resumeAs(
      "ma",
      "owned-v2",
      { eventType: "ApprovalGranted", payload: {} },
      { strategy: "operator-ack", principal: bob }
    );
    await handle.waitForCompletion();
    expect(h.seen.at(-1)?.principal).toEqual({ tenant: "acme", actor: "alice" });
    expect((await h.runtime.loadState("ma"))?.variables._principal).toEqual(before);
  });

  it("an old (pre-1.23) log with no principal replays identically and keeps the legacy behaviour", async () => {
    const h = boot({ gated: "approval" });
    const run = await h.runtime.start(h.flow, {}, { executionId: "old", principal: alice });
    await run.waitForSuspend();
    // Strip the record from sequence 0, as a log written before this ADR would be.
    const log = await h.eventStore.read("old");
    const legacyStore = new InMemoryAsyncEventStore();
    for (const e of log) {
      const payload = { ...(e.payload as Record<string, unknown>) };
      if (e.sequence === 0) {
        payload.principal = undefined;
        payload.principal = undefined;
        // biome-ignore lint/performance/noDelete: model an absent field exactly
        delete payload.principal;
      }
      await legacyStore.append({ ...e, payload });
    }
    const h2 = boot({
      gated: "approval",
      shared: {
        eventStore: legacyStore,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        timerStore: new InMemoryTimerStore(),
      },
    });
    const state = await h2.runtime.loadState("old");
    expect(state?.variables._principal).toBeUndefined();
    const resumed = await h2.runtime.resume(
      "old",
      { eventType: "ApprovalGranted", payload: {} },
      { principal: alice }
    );
    await resumed.waitForCompletion();
    // legacy: the resumer's principal reaches the effects, exactly as before this ADR
    expect(h2.seen.at(-1)?.principal).toEqual(alice);
  });
});

describe("D2 — a shredded or unrestorable record denies; it never falls back to the resumer", () => {
  it("a shredded identity ($shredded placeholders) denies every effect, even for an allowed resumer", async () => {
    const h = boot({ gated: "approval" });
    const run = await h.runtime.start(h.flow, {}, { executionId: "sh", principal: alice });
    await run.waitForSuspend();
    // The log as a tolerant crypto read returns it after the subject's key was destroyed.
    const store = new InMemoryAsyncEventStore();
    for (const e of await h.eventStore.read("sh")) {
      await store.append(
        e.sequence === 0
          ? {
              ...e,
              payload: {
                ...(e.payload as object),
                principal: {
                  v: 1,
                  identity: {
                    tenant: { $shredded: true },
                    actor: { $shredded: true },
                    onBehalfOf: { $shredded: true },
                  },
                },
              },
            }
          : e
      );
    }
    const h2 = boot({
      gated: "approval",
      shared: {
        eventStore: store,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        timerStore: new InMemoryTimerStore(),
      },
    });
    const resumed = await h2.runtime.resume(
      "sh",
      { eventType: "ApprovalGranted", payload: {} },
      { principal: { actor: "carol", tenant: "acme" } }
    );
    await expect(resumed.waitForCompletion()).rejects.toThrow(/crypto-shredded/);
    expect(h2.ran).toEqual([]);
    expect((await store.read("sh")).some((e) => e.eventType === "EFFECT_DENIED")).toBe(true);
  });

  it("a recorded delegation with no restorer is denied by the KERNEL, before any authorizer (even one that allows everything)", async () => {
    const token = signDelegation("s3cret", "alice", ["act-tool"]);
    // Start under a runtime that CAN restore it, then continue on one that cannot (the 3P node).
    const restorer = { resolve: () => ({ ...alice, delegation: token }) };
    const a = boot({ gated: "approval", deps: { principalResolver: restorer } });
    const run = await a.runtime.start(
      a.flow,
      {},
      { executionId: "dl", principal: { ...alice, delegation: token } }
    );
    await run.waitForSuspend();
    const everythingAllowed: CapabilityAuthorizer = { authorize: () => ({ allowed: true }) };
    const effects = new EffectRuntime([], { authorizer: everythingAllowed });
    let ran = 0;
    effects.register(
      "act-tool",
      new ToolEffect(async () => {
        ran++;
        return { ok: true };
      })
    );
    const b = new WorkflowRuntime({
      eventStore: a.eventStore,
      snapshotStore: a.snapshotStore,
      effectRuntime: effects,
    });
    b.registerFlow(a.flow.definition, a.flow.runner);
    const resumed = await b.resume("dl", { eventType: "ApprovalGranted", payload: {} });
    await expect(resumed.waitForCompletion()).rejects.toThrow(/could not be restored/);
    expect(ran).toBe(0);
    const denied = (await a.eventStore.read("dl")).find((e) => e.eventType === "EFFECT_DENIED");
    expect(denied?.payload).toMatchObject({ toolId: "act-tool" });
  });

  it("a delegated start that crashes and is resumed under a codec gets the SAME attenuation, never base", async () => {
    const SECRET = "s3cret";
    const codec: PrincipalCodec = {
      toRef: (chain) =>
        chain.delegation !== undefined
          ? `grants:${chain.delegation.grants.join(",")}:${chain.actor}`
          : undefined,
      fromRef: (ref) => {
        const [, grants, actor] = ref.split(":");
        return {
          actor: actor as string,
          delegation: signDelegation(SECRET, actor as string, (grants as string).split(",")),
        };
      },
    };
    const authorizer = new DelegationAuthorizer({
      secret: SECRET,
      base: new GrantTable({ owned: ["*"] }),
    });
    const a = boot({ gated: "approval", authorizer, deps: { principalCodec: codec } });
    const token = signDelegation(SECRET, "child-1", ["other-tool"]); // does NOT cover act-tool
    const run = await a.runtime.start(
      a.flow,
      {},
      { executionId: "att", principal: { actor: "child-1", delegation: token } }
    );
    await run.waitForSuspend();
    const rec = ((await startedOf(a.eventStore, "att")).payload as { principal: unknown })
      .principal;
    expect(rec).toEqual({ v: 1, ref: "grants:other-tool:child-1" }); // no token, no sig
    // a different process resumes it: still attenuated (denied), not base (which grants "*")
    const b = boot({ gated: "approval", authorizer, shared: a, deps: { principalCodec: codec } });
    const resumed = await b.runtime.resume("att", { eventType: "ApprovalGranted", payload: {} });
    await expect(resumed.waitForCompletion()).rejects.toThrow(/not in the delegated grant set/);
    expect(b.ran).toEqual([]);
  });
});

describe("D3 — ref mode writes no actor into the log", () => {
  it("records { v: 1, ref } only, and rehydrates through fromRef", async () => {
    const codec: PrincipalCodec = {
      toRef: (c) => (c.actor === "alice" ? "ref:r-1" : undefined),
      fromRef: (ref) => (ref === "ref:r-1" ? { ...alice } : undefined),
    };
    const h = boot({
      gated: "approval",
      deps: { principalCodec: codec, principalIdentity: "ref" },
    });
    const run = await h.runtime.start(h.flow, {}, { executionId: "rf", principal: alice });
    await run.waitForSuspend();
    expect((await startedOf(h.eventStore, "rf")).payload).toMatchObject({
      principal: { v: 1, ref: "ref:r-1" },
    });
    expect(JSON.stringify(await h.eventStore.read("rf"))).not.toContain("alice");
    const resumed = await h.runtime.resume("rf", { eventType: "ApprovalGranted", payload: {} });
    await resumed.waitForCompletion();
    expect(h.seen.at(-1)?.principal).toEqual(alice);
  });

  it("ref-only mode refuses a principal no codec handles, with the log empty", async () => {
    const codec: PrincipalCodec = { toRef: () => undefined, fromRef: () => undefined };
    const h = boot({ deps: { principalCodec: codec, principalIdentity: "ref" } });
    await expect(
      h.runtime.start(h.flow, {}, { executionId: "rf2", principal: alice })
    ).rejects.toBeInstanceOf(PrincipalUnrestorableError);
    expect(await h.eventStore.read("rf2")).toHaveLength(0);
  });

  it("a ref with no codec to restore it fails closed (denied), not anonymous", async () => {
    const codec: PrincipalCodec = { toRef: () => "ref:x", fromRef: () => alice };
    const a = boot({ gated: "approval", deps: { principalCodec: codec } });
    const run = await a.runtime.start(a.flow, {}, { executionId: "rf3", principal: alice });
    await run.waitForSuspend();
    const b = boot({ gated: "approval", shared: a }); // the codec is gone
    const resumed = await b.runtime.resume("rf3", { eventType: "ApprovalGranted", payload: {} });
    await expect(resumed.waitForCompletion()).rejects.toThrow(/could not be restored/);
    expect(b.ran).toEqual([]);
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
