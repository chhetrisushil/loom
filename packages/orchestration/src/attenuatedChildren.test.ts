import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import {
  DelegationAuthorizer,
  EffectRuntime,
  GrantTable,
  ToolEffect,
  signDelegation,
} from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ChildSupervisor,
  awaitChild,
  childIdFor,
  orchestrationPrincipalCodec,
  superviseChildren,
} from "./orchestration";

// ── R5 — a spawned child should not inherit unattenuated authority ────────────
//
// The evaluation doc said `awaitChild` "starts a child execution carrying the
// principal it is given", and that a sub-agent "runs with the full authority of
// its parent". Neither was true: the supervisor started children with
// `{ executionId }` and NO principal at all, so the parent's identity never
// reached the child and `DelegationAuthorizer` — which exists precisely to check
// an attenuated token at the callee — had nothing to check. A child was
// authorized by its own flow's static grants, independent of who spawned it.
//
// The fix keeps credentials OUT of the log. The parent records the capability
// SUBSET it confers (plain effect ids); the supervisor mints the signed
// `DelegatedGrant` at start time, bound to the child's own execution id as
// holder. A re-mint after recovery is identical because both inputs come from
// the log.

const SECRET = "test-delegation-secret";
const EMPTY = z.object({});

const PARENT = "P";
const CHILD_KEY = "worker";
const CHILD = childIdFor(PARENT, CHILD_KEY);

/** The child calls whichever tool it was told to; the ring decides if it may. */
type ChildIn = { tool: string; park?: boolean };
const childRunner: FlowRunner<ChildIn, { ok: boolean }> = async (ctx, input) => {
  // R3k — a child that PARKS first, so a "crash" between the park and the effect can be driven.
  if ((input as { park?: boolean }).park === true) await ctx.suspend({ on: "GO" });
  await ctx.execute(
    { _tag: "TaskDefinition", kind: "tool", id: "call", toolId: input.tool } as never,
    {}
  );
  return { ok: true };
};

const childFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "child",
    name: "child",
    version: "1.0.0",
    inputSchema: z.object({ tool: z.string(), park: z.boolean().optional() }),
    outputSchema: z.object({ ok: z.boolean() }),
    steps: [],
  } satisfies FlowDefinition<ChildIn, { ok: boolean }>,
  runner: childRunner,
} as RegisteredFlow<ChildIn, { ok: boolean }>;

function parentFlowFor(grants: readonly string[] | undefined, tool: string, park = false) {
  const runner: FlowRunner<unknown, { done: boolean }> = async (ctx) => {
    await awaitChild(ctx, {
      key: CHILD_KEY,
      flowId: "child",
      input: { tool, ...(park && { park }) },
      ...(grants !== undefined && { grants }),
    });
    return { done: true };
  };
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "parent",
      name: "parent",
      version: "1.0.0",
      inputSchema: EMPTY,
      outputSchema: z.object({ done: z.boolean() }),
      steps: [],
    } satisfies FlowDefinition<unknown, { done: boolean }>,
    runner,
  } as RegisteredFlow<unknown, { done: boolean }>;
}

/**
 * The child flow's OWN authority is broad — both tools. So anything the child is
 * stopped from doing was stopped by the delegation, not by its base grants.
 */
function build(opts: {
  grants?: readonly string[];
  tool: string;
  wireDelegation?: boolean;
  park?: boolean;
  /** R3k — boot over the stores of an earlier "process" (a crash/restart). */
  shared?: { eventStore: InMemoryAsyncEventStore; snapshotStore: InMemoryAsyncSnapshotStore };
  /** R3k — false: a runtime with NO supervisor, so nothing composes the delegation codec. */
  supervise?: boolean;
  /** R3k review P1 — a principalResolver written for identity records (answers undefined otherwise). */
  identityOnlyResolver?: boolean;
}) {
  const attempted: string[] = [];
  const effects = new EffectRuntime([], {
    authorizer: new DelegationAuthorizer({
      secret: SECRET,
      base: new GrantTable({ child: ["read-rows", "delete-table"], parent: ["*"] }),
    }),
  });
  for (const id of ["read-rows", "delete-table"]) {
    effects.register(
      id,
      new ToolEffect(async () => {
        attempted.push(id);
        return {};
      })
    );
  }

  const events: EventEnvelope[] = [];
  const holder: { supervisor?: ChildSupervisor } = {};
  const stores = opts.shared ?? {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  const runtime = new WorkflowRuntime({
    ...stores,
    effectRuntime: effects,
    ...(opts.identityOnlyResolver === true && {
      principalResolver: {
        resolve: (record: { identity?: { actor?: string } }) =>
          record.identity !== undefined ? { ...record.identity } : undefined,
      },
    }),
    onEvent: (e) => {
      events.push(e);
      holder.supervisor?.onEvent(e);
    },
  });

  const parent = parentFlowFor(opts.grants, opts.tool, opts.park === true);
  runtime.registerFlow(childFlow.definition, childRunner);
  runtime.registerFlow(parent.definition, parent.runner);
  if (opts.supervise !== false)
    holder.supervisor = superviseChildren({
      runtime,
      flows: { child: childFlow as RegisteredFlow },
      ...(opts.wireDelegation !== false && { delegation: { secret: SECRET } }),
    });

  return { runtime, parent, events, attempted, stores };
}

/**
 * Wait for an execution to reach a terminal state — the shape `childFailure` /
 * `parallelChildren` / `orchestration` already use in this package.
 *
 * This suite used to synchronise on a fixed 30ms sleep instead, which is a bet on how
 * fast a machine is rather than a synchronisation point: under CI load the child had not
 * finished when the assertions ran. It failed as a flake in only ONE of the five tests,
 * because the others assert what `attempted` DOES contain — while the denial test's first
 * assertion, `expect(attempted).not.toContain("delete-table")`, passes vacuously when
 * nothing has run yet, leaving the `EFFECT_DENIED` assertion to fail alone and read as an
 * authorization regression.
 *
 * Terminal covers `failed` as well as `completed` because a denied effect is exactly how
 * the child is expected to end in the deny case.
 */
async function waitTerminal(rt: WorkflowRuntime, id: string, tries = 400): Promise<ExecutionState> {
  for (let i = 0; i < tries; i++) {
    const s = await rt.loadState(id);
    if (s?.status === "completed" || s?.status === "failed") return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout waiting for ${id} (last=${(await rt.loadState(id))?.status})`);
}

describe("attenuated authority for spawned children (R5)", () => {
  it("lets the child use a capability the parent conferred", async () => {
    const { runtime, parent, attempted } = build({ grants: ["read-rows"], tool: "read-rows" });
    await runtime.start(parent as RegisteredFlow, {}, { executionId: PARENT });
    await waitTerminal(runtime, CHILD);
    expect(attempted).toEqual(["read-rows"]);
  });

  it("denies one the parent withheld, though the child flow itself holds it", async () => {
    const { runtime, parent, events, attempted } = build({
      grants: ["read-rows"],
      tool: "delete-table",
    });
    await runtime.start(parent as RegisteredFlow, {}, { executionId: PARENT });
    await waitTerminal(runtime, CHILD);

    expect(attempted).not.toContain("delete-table");
    expect(events.some((e) => e.eventType === "EFFECT_DENIED")).toBe(true);
  });

  it("records the conferred subset, never the signed token", async () => {
    // An append-only, archived, retained log is the wrong place for a bearer
    // credential — one written there cannot be rotated out of the copies. So the
    // log gets a DESCRIPTION of authority; the means of exercising it is minted at
    // start and never persisted.
    const { runtime, parent, events } = build({ grants: ["read-rows"], tool: "read-rows" });
    await runtime.start(parent as RegisteredFlow, {}, { executionId: PARENT });
    await waitTerminal(runtime, CHILD);

    const spawn = events.find(
      (e) =>
        e.eventType === "DECISION_RECORDED" && JSON.stringify(e.payload).includes("__orchestration")
    );
    expect(JSON.stringify(spawn?.payload)).toContain("read-rows");
    expect(JSON.stringify(spawn?.payload)).not.toContain('"sig"');
    // Nor anywhere else in the log.
    expect(JSON.stringify(events)).not.toContain('"sig"');
  });

  it("confers nothing when the spawn names no subset (G2)", async () => {
    // Unwired: no `grants` ⇒ no token ⇒ the child starts exactly as before and the
    // authorizer falls through to its own base authority, which allows the call.
    const { runtime, parent, attempted } = build({ tool: "delete-table" });
    await runtime.start(parent as RegisteredFlow, {}, { executionId: PARENT });
    await waitTerminal(runtime, CHILD);
    expect(attempted).toEqual(["delete-table"]);
  });

  it("confers nothing when the supervisor holds no secret (G2)", async () => {
    const { runtime, parent, attempted } = build({
      grants: ["read-rows"],
      tool: "delete-table",
      wireDelegation: false,
    });
    await runtime.start(parent as RegisteredFlow, {}, { executionId: PARENT });
    await waitTerminal(runtime, CHILD);
    // No minting configured, so the subset in the log is inert — the child runs on
    // its base grants. A supervisor that cannot mint must not silently half-enforce.
    expect(attempted).toEqual(["delete-table"]);
  });

  // ── R3k (ADR 0111 D4) — the attenuation survives a crash ─────────────────────────────────────
  //
  // Before: the supervisor minted the token in memory and never recorded it, so a child that
  // parked and was resumed by ANOTHER process lost it and fell through to `base` (which grants
  // the child flow "delete-table"): a privilege escalation across a crash.

  it("a child that parks and is resumed by a restarted process is STILL attenuated (never base)", async () => {
    const a = build({ grants: ["read-rows"], tool: "delete-table", park: true });
    await a.runtime.start(a.parent as RegisteredFlow, {}, { executionId: PARENT });
    for (let i = 0; i < 400 && (await a.runtime.loadState(CHILD))?.status !== "suspended"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await a.runtime.loadState(CHILD))?.status).toBe("suspended");
    // the log holds a description of the authority, not the means of exercising it
    const rec = (await a.stores.eventStore.read(CHILD))[0]?.payload as {
      principal: { v: number; ref: string };
    };
    expect(JSON.stringify(rec.principal)).not.toContain("sig");
    const body = JSON.parse(
      Buffer.from(
        rec.principal.ref.replace("loom:orch:v2:", "").split(".")[0]!,
        "base64url"
      ).toString("utf8")
    );
    expect(body).toEqual({ a: CHILD, g: ["read-rows"] });

    // "Process restart": a fresh runtime, effects and supervisor over the same durable stores.
    const b = build({
      grants: ["read-rows"],
      tool: "delete-table",
      park: true,
      shared: a.stores,
    });
    const handle = await b.runtime.resume(CHILD, { eventType: "GO", payload: {} });
    await expect(handle.waitForCompletion()).rejects.toThrow(/not in the delegated grant set/);
    expect(b.attempted).not.toContain("delete-table");
  });

  it("the same restart restores a conferred capability the child IS allowed to use", async () => {
    const a = build({ grants: ["read-rows"], tool: "read-rows", park: true });
    await a.runtime.start(a.parent as RegisteredFlow, {}, { executionId: PARENT });
    for (let i = 0; i < 400 && (await a.runtime.loadState(CHILD))?.status !== "suspended"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const b = build({ grants: ["read-rows"], tool: "read-rows", park: true, shared: a.stores });
    const handle = await b.runtime.resume(CHILD, { eventType: "GO", payload: {} });
    await handle.waitForCompletion();
    expect(b.attempted).toEqual(["read-rows"]);
  });

  it("a restarted runtime with NOTHING able to restore the delegation DENIES the child; it never falls back to base", async () => {
    const a = build({ grants: ["read-rows"], tool: "read-rows", park: true });
    await a.runtime.start(a.parent as RegisteredFlow, {}, { executionId: PARENT });
    for (let i = 0; i < 400 && (await a.runtime.loadState(CHILD))?.status !== "suspended"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // No supervisor on this runtime, so nothing composes the codec. base would allow read-rows.
    const b = build({
      grants: ["read-rows"],
      tool: "read-rows",
      park: true,
      shared: a.stores,
      supervise: false,
    });
    const handle = await b.runtime.resume(CHILD, { eventType: "GO", payload: {} });
    await expect(handle.waitForCompletion()).rejects.toThrow(/could not be restored/);
    expect(b.attempted).toEqual([]);
  });

  it("the child records its lineage: `parent` on sequence 0", async () => {
    const { runtime, parent, stores } = build({ grants: ["read-rows"], tool: "read-rows" });
    await runtime.start(parent as RegisteredFlow, {}, { executionId: PARENT });
    await waitTerminal(runtime, CHILD);
    expect((await stores.eventStore.read(CHILD))[0]?.payload).toMatchObject({ parent: PARENT });
  });

  // ── R3k review round 1 ───────────────────────────────────────────────────────────────────────

  it("P1: a principalResolver written for identity records does NOT widen a delegated child to base (ref records go to the codec first)", async () => {
    const { runtime, parent, attempted } = build({
      grants: ["read-rows"],
      tool: "delete-table",
      identityOnlyResolver: true,
    });
    await runtime.start(parent as RegisteredFlow, {}, { executionId: PARENT });
    const state = await waitTerminal(runtime, CHILD);
    expect(state.status).toBe("failed");
    expect(attempted).not.toContain("delete-table");
  });

  it("P1: with a resolver configured, a delegated child still runs what the parent conferred", async () => {
    const { runtime, parent, attempted } = build({
      grants: ["read-rows"],
      tool: "read-rows",
      identityOnlyResolver: true,
    });
    await runtime.start(parent as RegisteredFlow, {}, { executionId: PARENT });
    await waitTerminal(runtime, CHILD);
    expect(attempted).toEqual(["read-rows"]);
  });

  it("P3-1: the ref is MACed; a tampered, unsigned or foreign-secret ref is refused (fail closed)", () => {
    const codec = orchestrationPrincipalCodec(SECRET);
    const token = signDelegation(SECRET, "kid", ["read-rows"]);
    const ref = codec.toRef({ actor: "kid", delegation: token }) as string;
    expect(typeof ref).toBe("string");
    const ctx = { executionId: "kid" };
    expect(codec.fromRef(ref, ctx)).toBeTruthy();
    // escalate the grant set inside the body, keep the MAC
    const [head, mac] = ref.split(".") as [string, string];
    const prefix = "loom:orch:v2:";
    const body = JSON.parse(Buffer.from(head.slice(prefix.length), "base64url").toString("utf8"));
    body.g = ["read-rows", "delete-table"];
    const forged = `${prefix}${Buffer.from(JSON.stringify(body)).toString("base64url")}.${mac}`;
    expect(codec.fromRef(forged, ctx)).toBeUndefined();
    // unsigned (the pre-MAC shape) and a missing MAC
    const legacy = `loom:orch:v1:${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
    expect(codec.fromRef(legacy, ctx)).toBeUndefined();
    expect(codec.fromRef(head, ctx)).toBeUndefined();
    // another supervisor's secret
    expect(orchestrationPrincipalCodec("other-secret").fromRef(ref, ctx)).toBeUndefined();
  });

  it("P3-1: the MAC key is derived, so a ref MAC is never a valid delegation signature", () => {
    const codec = orchestrationPrincipalCodec(SECRET);
    const token = signDelegation(SECRET, "kid", ["read-rows"]);
    const ref = codec.toRef({ actor: "kid", delegation: token }) as string;
    const mac = ref.split(".")[1]!;
    expect(mac).not.toBe(token.sig);
  });
});
