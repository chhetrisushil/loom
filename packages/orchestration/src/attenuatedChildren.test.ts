import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import { DelegationAuthorizer, EffectRuntime, GrantTable, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ChildSupervisor, awaitChild, childIdFor, superviseChildren } from "./orchestration";

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
type ChildIn = { tool: string };
const childRunner: FlowRunner<ChildIn, { ok: boolean }> = async (ctx, input) => {
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
    inputSchema: z.object({ tool: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    steps: [],
  } satisfies FlowDefinition<ChildIn, { ok: boolean }>,
  runner: childRunner,
} as RegisteredFlow<ChildIn, { ok: boolean }>;

function parentFlowFor(grants: readonly string[] | undefined, tool: string) {
  const runner: FlowRunner<unknown, { done: boolean }> = async (ctx) => {
    await awaitChild(ctx, {
      key: CHILD_KEY,
      flowId: "child",
      input: { tool },
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
function build(opts: { grants?: readonly string[]; tool: string; wireDelegation?: boolean }) {
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
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onEvent: (e) => {
      events.push(e);
      holder.supervisor?.onEvent(e);
    },
  });

  const parent = parentFlowFor(opts.grants, opts.tool);
  runtime.registerFlow(childFlow.definition, childRunner);
  runtime.registerFlow(parent.definition, parent.runner);
  holder.supervisor = superviseChildren({
    runtime,
    flows: { child: childFlow as RegisteredFlow },
    ...(opts.wireDelegation !== false && { delegation: { secret: SECRET } }),
  });

  return { runtime, parent, events, attempted };
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
});
