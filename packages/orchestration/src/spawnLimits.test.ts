import type { ExecutionState, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ChildResult,
  SpawnLimitExceededError,
  type SpawnLimits,
  awaitAll,
  awaitChild,
  awaitChildren,
  boundOrchestration,
  superviseChildren,
} from "./orchestration";

// R9 — the autonomy envelope for child spawning. Depth and breadth caps, enforced at the
// supervisor (the backstop a parent cannot bypass) and at the parent call site.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const def = (id: string) =>
  ({ _tag: "FlowDefinition", id, name: id, version: "1.0.0", ...io, steps: [] }) as FlowDefinition<
    unknown,
    unknown
  >;
const reg = (id: string, runner: FlowRunner<never, unknown>): RegisteredFlow =>
  ({ definition: def(id), runner }) as unknown as RegisteredFlow;

describe("spawn limits (R9)", () => {
  function build(limits: SpawnLimits | undefined, flows: Record<string, RegisteredFlow>) {
    const errors: unknown[] = [];
    const holder: { sup?: ReturnType<typeof superviseChildren> } = {};
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      onEvent: (e) => holder.sup?.onEvent(e),
    });
    for (const f of Object.values(flows)) {
      runtime.registerFlow(f.definition, f.runner as FlowRunner<unknown, unknown>);
    }
    holder.sup = superviseChildren({
      runtime,
      flows,
      onError: (e) => errors.push(e),
      ...(limits !== undefined && { limits }),
    });
    return { runtime, errors };
  }

  async function waitTerminal(rt: WorkflowRuntime, id: string): Promise<ExecutionState> {
    for (let i = 0; i < 400; i++) {
      const s = await rt.loadState(id).catch(() => undefined);
      if (s?.status === "completed" || s?.status === "failed") return s;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timeout waiting for ${id}`);
  }
  const out = (s: ExecutionState) => s.variables._output;

  // A self-recursing flow: spawns itself until `stopAt`, returning the depth it reached.
  const recurFlow = (id: string, stopAt: number) =>
    reg(id, async (ctx, input: { depth: number }) => {
      if (input.depth >= stopAt) return { depth: input.depth };
      return awaitChild(ctx, { key: "r", flowId: id, input: { depth: input.depth + 1 } });
    });

  it("under the depth cap a recursive spawn completes", async () => {
    const { runtime, errors } = build({ maxDepth: 3 }, { rec: recurFlow("rec", 3) });
    await runtime.start("rec", { depth: 0 }, { executionId: "R" });
    const s = await waitTerminal(runtime, "R");
    expect(s.status).toBe("completed");
    expect(out(s)).toEqual({ depth: 3 });
    expect(errors).toEqual([]);
  }, 20000);

  it("over the depth cap the child is NEVER started and the parent fails instead of hanging", async () => {
    // Unbounded recursion: only the envelope can stop it.
    const { runtime, errors } = build({ maxDepth: 2 }, { rec: recurFlow("rec", 1000) });
    await runtime.start("rec", { depth: 0 }, { executionId: "R" });
    const s = await waitTerminal(runtime, "R");
    expect(s.status).toBe("failed");
    // depth 1 and 2 ran; the depth-3 child was refused before it started.
    expect(await runtime.loadState("R::r::r")).toBeTruthy();
    expect(await runtime.loadState("R::r::r::r")).toBeFalsy();
    const refusal = errors.find((e) => e instanceof SpawnLimitExceededError) as
      | SpawnLimitExceededError
      | undefined;
    expect(refusal).toMatchObject({
      name: "SpawnLimitExceededError",
      limit: "maxDepth",
      max: 2,
      actual: 3,
      retryable: false,
    });
  }, 20000);

  it("with no limits configured, behaviour is unchanged (the same recursion runs to its natural end)", async () => {
    const { runtime, errors } = build(undefined, { rec: recurFlow("rec", 4) });
    await runtime.start("rec", { depth: 0 }, { executionId: "R" });
    const s = await waitTerminal(runtime, "R");
    expect(out(s)).toEqual({ depth: 4 });
    expect(errors).toEqual([]);
  }, 20000);

  const leaf = () => reg("leaf", async (_ctx, input: { n: number }) => ({ n: input.n }));
  const fanFlow = (size: number) =>
    reg("fan", async (ctx) =>
      awaitChildren<{ n: number }>(ctx, {
        key: "g",
        children: Array.from({ length: size }, (_, n) => ({ flowId: "leaf", input: { n } })),
      })
    );

  it("under the breadth cap a fan-out works", async () => {
    const { runtime, errors } = build({ maxFanOut: 3 }, { fan: fanFlow(3), leaf: leaf() });
    await runtime.start("fan", {}, { executionId: "F" });
    const s = await waitTerminal(runtime, "F");
    expect(s.status).toBe("completed");
    expect((out(s) as ChildResult[]).map((r) => r.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(errors).toEqual([]);
  }, 20000);

  it("over the breadth cap NO member starts and every slot is a failed ChildResult", async () => {
    const { runtime, errors } = build({ maxFanOut: 3 }, { fan: fanFlow(5), leaf: leaf() });
    await runtime.start("fan", {}, { executionId: "F" });
    const s = await waitTerminal(runtime, "F");
    expect(s.status).toBe("completed"); // awaitChildren hands partial failure to the parent as data
    const settled = out(s) as ChildResult[];
    expect(settled).toHaveLength(5);
    for (const r of settled) {
      expect(r.status).toBe("failed");
      expect((r as { error: string }).error).toMatch(/SpawnLimitExceededError.*maxFanOut/);
    }
    for (let i = 0; i < 5; i++) expect(await runtime.loadState(`F::g#${i}`)).toBeFalsy();
    expect(errors[0]).toMatchObject({ name: "SpawnLimitExceededError", limit: "maxFanOut" });
  }, 20000);

  it("awaitAll over the cap throws childFailed in the parent (all-or-nothing)", async () => {
    const all = reg("all", async (ctx) =>
      awaitAll(ctx, {
        key: "g",
        children: Array.from({ length: 4 }, (_, n) => ({ flowId: "leaf", input: { n } })),
      })
    );
    const { runtime } = build({ maxFanOut: 2 }, { all, leaf: leaf() });
    await runtime.start("all", {}, { executionId: "A" });
    expect((await waitTerminal(runtime, "A")).status).toBe("failed");
  }, 20000);

  describe("boundOrchestration — the parent-side default", () => {
    it("refuses BEFORE the spawn decision is recorded (typed, no child, no durable spawn)", async () => {
      const bound = boundOrchestration({ maxDepth: 0, maxFanOut: 2 });
      const parent = reg("parent", async (ctx) => {
        try {
          await bound.awaitChild(ctx, { key: "c", flowId: "leaf", input: { n: 1 } });
          return { refused: "none" };
        } catch (err) {
          if (!(err instanceof SpawnLimitExceededError)) throw err; // SuspendError is control flow
          return { refused: (err as Error).name, limit: (err as SpawnLimitExceededError).limit };
        }
      });
      // NO supervisor limits: only the parent-side bound can be responsible for the refusal.
      const { runtime } = build(undefined, { parent, leaf: leaf() });
      await runtime.start("parent", {}, { executionId: "P" });
      const s = await waitTerminal(runtime, "P");
      expect(out(s)).toEqual({ refused: "SpawnLimitExceededError", limit: "maxDepth" });
      expect(await runtime.loadState("P::c")).toBeFalsy();
    }, 20000);

    it("refuses an over-wide group, passes an in-bounds one", async () => {
      const bound = boundOrchestration({ maxFanOut: 2 });
      const mk = (size: number) =>
        reg("p", async (ctx) => {
          try {
            const r = await bound.awaitAll<{ n: number }>(ctx, {
              key: "g",
              children: Array.from({ length: size }, (_, n) => ({ flowId: "leaf", input: { n } })),
            });
            return { ok: r.length };
          } catch (err) {
            if (!(err instanceof SpawnLimitExceededError)) throw err; // SuspendError is control flow
            return { refused: (err as Error).name };
          }
        });
      const wide = build(undefined, { p: mk(3), leaf: leaf() });
      await wide.runtime.start("p", {}, { executionId: "W" });
      expect(out(await waitTerminal(wide.runtime, "W"))).toEqual({
        refused: "SpawnLimitExceededError",
      });
      expect(await wide.runtime.loadState("W::g#0")).toBeFalsy();

      const narrow = build(undefined, { p: mk(2), leaf: leaf() });
      await narrow.runtime.start("p", {}, { executionId: "N" });
      expect(out(await waitTerminal(narrow.runtime, "N"))).toEqual({ ok: 2 });
    }, 20000);
  });
});
