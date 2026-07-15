import type { ExecutableTask } from "@loom/core";
import type { Effect, EffectContext } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryDurableStateStore } from "./InMemoryDurableStateStore";
import { durableState } from "./durableState";
import { RevisionConflictError } from "./errors";
import { sentinelState } from "./sentinel";
import type { DurableStateStore, TaskExecutor } from "./types";

const schemaV3 = z.object({ baseline: z.number(), openFindings: z.array(z.string()) });
type StateV3 = z.infer<typeof schemaV3>;

const effectCtx: EffectContext = {
  executionId: "exec-1",
  stepId: "step-1",
  workflowId: "wf-1",
  attempt: 1,
  emit: () => {},
};

/**
 * Minimal TaskExecutor: resolves the task's toolId against a registry and runs
 * the effect — the recorded-replay half is the kernel's job (WorkflowContext),
 * exercised by its own tests; here we prove the handle wires tasks → effects.
 */
function fakeCtx(registry: Map<string, Effect>): TaskExecutor {
  return {
    async execute<TIn, TOut>(task: ExecutableTask<TIn, TOut>, input: TIn): Promise<TOut> {
      const toolId = task.toolId ?? task.id;
      const effect = registry.get(toolId);
      if (effect === undefined) throw new Error(`no effect registered for "${toolId}"`);
      return (await effect.execute(input, effectCtx)) as TOut;
    },
  };
}

function makeHandle(store: DurableStateStore = new InMemoryDurableStateStore()) {
  const handle = durableState<StateV3>({
    id: "sentinel-state",
    version: 3,
    schema: schemaV3,
    migrations: {
      // v1 { baseline } → v2 { baseline, findings }
      1: (old) => ({ ...(old as { baseline: number }), findings: [] as string[] }),
      // v2 { baseline, findings } → v3 { baseline, openFindings }
      2: (old) => {
        const { findings, ...rest } = old as { baseline: number; findings: string[] };
        return { ...rest, openFindings: findings };
      },
    },
    store,
  });
  const registry = new Map<string, Effect>();
  handle.register({ register: (id, effect) => registry.set(id, effect) });
  return { handle, store, ctx: fakeCtx(registry), registry };
}

describe("durableState", () => {
  it("rejects invalid config loudly", () => {
    const store = new InMemoryDurableStateStore();
    expect(() => durableState({ id: "", version: 1, schema: schemaV3, store })).toThrow(TypeError);
    expect(() => durableState({ id: "x", version: 0, schema: schemaV3, store })).toThrow(TypeError);
    expect(() => durableState({ id: "x", version: 1.5, schema: schemaV3, store })).toThrow(
      TypeError
    );
  });

  it("load on a missing key returns found:false with revision 0 (create token)", async () => {
    const { handle, ctx } = makeHandle();
    const result = await handle.load(ctx, "k");
    expect(result).toEqual({
      found: false,
      value: null,
      revision: 0,
      contractVersion: 3,
      migrated: null,
    });
  });

  it("save creates at revision 1 and load round-trips the validated value", async () => {
    const { handle, ctx } = makeHandle();
    const value: StateV3 = { baseline: 42, openFindings: ["f-1"] };
    const saved = await handle.save(ctx, "k", value, 0);
    expect(saved).toEqual({ revision: 1 });
    const loaded = await handle.load(ctx, "k");
    expect(loaded).toEqual({
      found: true,
      value,
      revision: 1,
      contractVersion: 3,
      migrated: null,
    });
  });

  it("save validates before writing (DS-2): invalid value never lands", async () => {
    const { handle, ctx, store } = makeHandle();
    await handle.save(ctx, "k", { baseline: 1, openFindings: [] }, 0);
    await expect(
      handle.save(ctx, "k", { baseline: "nope" } as unknown as StateV3, 1)
    ).rejects.toMatchObject({ name: "StateContractMismatchError", reason: "validation-failed" });
    expect((await store.load("k"))?.revision).toBe(1); // unchanged
  });

  it("migrates an older envelope through the chain and reports it (DS-3)", async () => {
    const { handle, ctx, store } = makeHandle();
    await store.save("k", { contractVersion: 1, payload: { baseline: 7 } }, 0);
    const loaded = await handle.load(ctx, "k");
    expect(loaded.value).toEqual({ baseline: 7, openFindings: [] });
    expect(loaded.migrated).toEqual({ from: 1, to: 3 });
    // The stored envelope upgrades on the NEXT save, not on load:
    expect((await store.load("k"))?.contractVersion).toBe(1);
    await handle.save(ctx, "k", { baseline: 8, openFindings: [] }, loaded.revision);
    expect((await store.load("k"))?.contractVersion).toBe(3);
  });

  it("stalls loudly when a migration step is missing (DS-3)", async () => {
    const store = new InMemoryDurableStateStore();
    const handle = durableState<StateV3>({
      id: "gappy",
      version: 3,
      schema: schemaV3,
      migrations: { 2: (old) => old }, // no 1 → 2
      store,
    });
    const registry = new Map<string, Effect>();
    handle.register({ register: (id, effect) => registry.set(id, effect) });
    await store.save("k", { contractVersion: 1, payload: { baseline: 7 } }, 0);
    await expect(handle.load(fakeCtx(registry), "k")).rejects.toMatchObject({
      name: "StateContractMismatchError",
      reason: "no-migration-path",
      storedVersion: 1,
      expectedVersion: 3,
    });
  });

  it("stalls loudly on a future-version envelope (rollback deploy)", async () => {
    const { handle, ctx, store } = makeHandle();
    await store.save("k", { contractVersion: 9, payload: {} }, 0);
    await expect(handle.load(ctx, "k")).rejects.toMatchObject({
      name: "StateContractMismatchError",
      reason: "future-version",
    });
  });

  it("wraps a throwing migration as migration-failed", async () => {
    const store = new InMemoryDurableStateStore();
    const handle = durableState<StateV3>({
      id: "boom",
      version: 2,
      schema: z.object({ baseline: z.number(), openFindings: z.array(z.string()) }),
      migrations: {
        1: () => {
          throw new Error("bad data");
        },
      },
      store,
    });
    const registry = new Map<string, Effect>();
    handle.register({ register: (id, effect) => registry.set(id, effect) });
    await store.save("k", { contractVersion: 1, payload: { baseline: 1 } }, 0);
    await expect(handle.load(fakeCtx(registry), "k")).rejects.toMatchObject({
      name: "StateContractMismatchError",
      reason: "migration-failed",
    });
  });

  it("reports validation-failed when the migrated payload misses the current contract", async () => {
    const store = new InMemoryDurableStateStore();
    const handle = durableState<StateV3>({
      id: "drifty",
      version: 2,
      schema: schemaV3,
      migrations: { 1: (old) => old }, // "migration" that fixes nothing
      store,
    });
    const registry = new Map<string, Effect>();
    handle.register({ register: (id, effect) => registry.set(id, effect) });
    await store.save("k", { contractVersion: 1, payload: { wrong: true } }, 0);
    await expect(handle.load(fakeCtx(registry), "k")).rejects.toMatchObject({
      name: "StateContractMismatchError",
      reason: "validation-failed",
    });
  });

  it("CAS: a stale expectedRevision conflicts loudly (DS-4)", async () => {
    const { handle, ctx } = makeHandle();
    await handle.save(ctx, "k", { baseline: 1, openFindings: [] }, 0);
    await handle.save(ctx, "k", { baseline: 2, openFindings: [] }, 1);
    await expect(
      handle.save(ctx, "k", { baseline: 99, openFindings: [] }, 1)
    ).rejects.toMatchObject({
      name: "RevisionConflictError",
      expectedRevision: 1,
      actualRevision: 2,
    });
  });

  it("adopts its own committed write on a crash-recovery re-run (K9 idempotency)", async () => {
    const { handle, ctx } = makeHandle();
    const value: StateV3 = { openFindings: ["f"], baseline: 5 }; // key order differs on purpose
    await handle.save(ctx, "k", value, 0);
    // Same logical attempt re-runs after a crash between effect and STEP_COMPLETED:
    const rerun = await handle.save(ctx, "k", { baseline: 5, openFindings: ["f"] }, 0);
    expect(rerun).toEqual({ revision: 1 });
    // ...but a DIFFERENT payload at the same expectedRevision is a real conflict:
    await expect(
      handle.save(ctx, "k", { baseline: 6, openFindings: [] }, 0)
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it("clear removes the key and is idempotent; create works again after", async () => {
    const { handle, ctx } = makeHandle();
    await handle.save(ctx, "k", { baseline: 1, openFindings: [] }, 0);
    expect(await handle.clear(ctx, "k")).toEqual({ cleared: true });
    expect(await handle.clear(ctx, "k")).toEqual({ cleared: true });
    expect((await handle.load(ctx, "k")).found).toBe(false);
    await handle.save(ctx, "k", { baseline: 2, openFindings: [] }, 0);
  });

  it("register wires the three tool ids; tasks default their step ids and accept overrides", async () => {
    const { handle, registry, ctx } = makeHandle();
    expect([...registry.keys()].sort()).toEqual([
      "sentinel-state.clear",
      "sentinel-state.load",
      "sentinel-state.save",
    ]);
    expect(handle.tasks.load.id).toBe("sentinel-state.load");
    expect(handle.tasks.load.kind).toBe("memory");
    // stepId override changes the task identity but resolves the same toolId:
    const result = await handle.load(ctx, "k", { stepId: "load-again" });
    expect(result.found).toBe(false);
  });
});

describe("sentinelState", () => {
  it("derives contract id and key from the schedule and round-trips (DS-5)", async () => {
    const store = new InMemoryDurableStateStore();
    const sentinel = sentinelState({
      schedule: { id: "pg-sentinel" },
      schema: schemaV3,
      store,
    });
    const registry = new Map<string, Effect>();
    sentinel.register({ register: (id, effect) => registry.set(id, effect) });
    const ctx = fakeCtx(registry);

    expect(sentinel.key).toBe("sentinel:pg-sentinel");
    expect(sentinel.state.id).toBe("pg-sentinel.state");
    expect(sentinel.state.version).toBe(1);

    const first = await sentinel.load(ctx);
    expect(first.found).toBe(false);
    await sentinel.save(ctx, { baseline: 1, openFindings: [] }, first.revision);
    const second = await sentinel.load(ctx);
    expect(second.value).toEqual({ baseline: 1, openFindings: [] });
    expect(second.revision).toBe(1);
    expect((await store.load("sentinel:pg-sentinel"))?.revision).toBe(1);
  });
});
