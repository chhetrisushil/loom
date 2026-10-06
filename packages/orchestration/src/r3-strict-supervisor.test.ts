import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  type FlowRunner,
  type RegisteredFlow,
  WorkflowRuntime,
  executionAccessPolicy,
} from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { awaitChild, superviseChildren } from "./orchestration";

// R3 — under a fail-closed execution authorizer the supervisor's child start and parent
// resume are the kernel acting, not an anonymous caller: they present the system grant.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const def = (id: string) =>
  ({ _tag: "FlowDefinition", id, name: id, version: "1.0.0", ...io, steps: [] }) as FlowDefinition<
    unknown,
    unknown
  >;
const reg = (id: string, runner: FlowRunner<never, unknown>): RegisteredFlow =>
  ({ definition: def(id), runner }) as unknown as RegisteredFlow;

describe("R3 — child supervisor under strict execution authz", () => {
  it("spawns the child and resumes the parent; an anonymous app call on the same runtime is refused", async () => {
    const errors: unknown[] = [];
    const policy = executionAccessPolicy();
    const seen = new Set<string>();
    const holder: { sup?: ReturnType<typeof superviseChildren> } = {};
    const flows = {
      child: reg("child", async () => ({ v: 42 })),
      parent: reg("parent", async (ctx) =>
        awaitChild(ctx, { key: "k", flowId: "child", input: {} })
      ),
    };
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      executionAuthorizer: policy,
      executionAuthz: { requirePrincipal: true },
      onEvent: (e) => {
        seen.add(e.executionId);
        holder.sup?.onEvent(e);
      },
    });
    for (const f of Object.values(flows)) {
      runtime.registerFlow(f.definition, f.runner as FlowRunner<unknown, unknown>);
    }
    holder.sup = superviseChildren({ runtime, flows, onError: (e) => errors.push(e) });

    await runtime.start(
      "parent",
      {},
      { executionId: "P", principal: { actor: "alice", tenant: "t" } }
    );
    let state: Awaited<ReturnType<typeof runtime.loadState>> = null;
    for (let i = 0; i < 400 && state?.status !== "completed"; i++) {
      state = await runtime.loadState("P", runtime.systemOptions());
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(errors).toEqual([]);
    expect(state?.status).toBe("completed");
    expect(state?.variables._output).toEqual({ v: 42 });
    await expect(runtime.loadState("P")).rejects.toMatchObject({ name: "ExecutionDeniedError" });
    // R3k (ADR 0111 D5) — the owner is the principal recorded on the child's own sequence 0, and
    // a supervisor child started with no principal has none: "owner unknown" applies (it no longer
    // inherits its parent's owner from an in-process table). Kernel-internal readers still reach it.
    const alice = { actor: "alice", tenant: "t" };
    const childId = [...seen].find((i) => i !== "P");
    expect(childId).toBeDefined();
    await expect(runtime.loadState(childId as string, { principal: alice })).rejects.toMatchObject({
      name: "ExecutionDeniedError",
    });
    expect((await runtime.loadState(childId as string, runtime.systemOptions()))?.status).toBe(
      "completed"
    );
    // the child records its lineage (ADR 0111 D1): `parent` is on sequence 0 and folds to `_parent`
    expect(
      (await runtime.loadState(childId as string, runtime.systemOptions()))?.variables._parent
    ).toBe("P");
  }, 20000);
});
