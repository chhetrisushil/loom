import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageWriteError, step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import {
  type EventStore,
  InMemoryAsyncEventStore,
  TenantScopedEventStore,
} from "@loom/event-runtime";
import { SqliteEventStore } from "@loom/plugin-sqlite";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { ExecutionAlreadyExistsError } from "./types";
import type { FlowRunner } from "./types";

// ADR 0103 — a `start()` with a caller-chosen execution id makes its bootstrap event DURABLE
// before the body runs, so a duplicate start is refused with a typed error before any effect
// runs and before `onEvent` sees anything. The default (ulid) path is unchanged.

const io = z.object({}).passthrough();
const augment = step$({
  id: "augment",
  name: "Augment",
  toolId: "model",
  inputSchema: io,
  outputSchema: io,
});
const FLOW = "aug";
const definition: FlowDefinition<unknown, unknown> = {
  _tag: "FlowDefinition",
  id: FLOW,
  name: FLOW,
  version: "1.0.0",
  inputSchema: io,
  outputSchema: io,
  steps: [augment],
};
const runner: FlowRunner<unknown, unknown> = async (ctx) => ctx.run(augment, {});

/**
 * A pass-through store that records when each append was ISSUED, in one trace shared with
 * `onEvent`, so a test can see the order of "durable write" vs "live projection".
 */
function traced(inner: EventStore, trace: string[]): EventStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "append") {
        return async (e: EventEnvelope) => {
          trace.push(`append:${e.eventType}@${e.sequence}`);
          return target.append(e);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

function boot(eventStore: EventStore, opts?: { now?: () => number; trace?: string[] }) {
  const model = vi.fn(async () => ({ ok: true }));
  const effects = new EffectRuntime();
  effects.register("model", new ToolEffect(model));
  const seen: EventEnvelope[] = [];
  const store = opts?.trace ? traced(eventStore, opts.trace) : eventStore;
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onEvent: (e) => {
      seen.push(e);
      opts?.trace?.push(`onEvent:${e.eventType}@${e.sequence}`);
    },
    ...(opts?.now !== undefined && { now: opts.now }),
  });
  runtime.registerFlow(definition, runner);
  return { runtime, model, seen, store };
}

/** The probe (`dupstart.mjs`): start the same deterministic id twice. */
async function probe(eventStore: EventStore) {
  const app = boot(eventStore);
  const id = "aug:m1:h1";
  const first = await app.runtime.start(FLOW, {}, { executionId: id });
  expect((await first.waitForCompletion()).status).toBe("completed");
  const logBefore = await app.store.read(id);
  const seenBefore = app.seen.length;

  const second = app.runtime.start(FLOW, {}, { executionId: id });
  await expect(second).rejects.toBeInstanceOf(ExecutionAlreadyExistsError);
  await expect(second).rejects.toMatchObject({
    name: "ExecutionAlreadyExistsError",
    executionId: id,
  });

  // The paid effect ran once — the duplicate never reached the body.
  expect(app.model).toHaveBeenCalledTimes(1);
  // `onEvent` saw exactly the first run: no second EXECUTION_STARTED, nothing after it.
  expect(app.seen.length).toBe(seenBefore);
  expect(app.seen.filter((e) => e.eventType === "EXECUTION_STARTED")).toHaveLength(1);
  // And the log is untouched.
  expect(await app.store.read(id)).toEqual(logBefore);
}

describe("ADR 0103 — a duplicate caller-chosen-id start is refused before any effect runs", () => {
  it("in-memory store: the second start rejects with ExecutionAlreadyExistsError", async () => {
    await probe(new InMemoryAsyncEventStore());
  });

  describe("SQLite", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "loom-dupstart-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("the store's unique-constraint conflict becomes the typed refusal", async () => {
      const store = new SqliteEventStore(join(dir, "loom.db"));
      try {
        await probe(store);
      } finally {
        await store.close();
      }
    });
  });

  it("TenantScopedEventStore propagates the typed conflict through the decorator", async () => {
    await probe(new TenantScopedEventStore(new InMemoryAsyncEventStore(), "tenant-a"));
  });

  it("two concurrent starts with the same id: exactly one runs", async () => {
    const app = boot(new InMemoryAsyncEventStore());
    const id = "aug:race";
    const results = await Promise.allSettled([
      app.runtime.start(FLOW, {}, { executionId: id }),
      app.runtime.start(FLOW, {}, { executionId: id }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ExecutionAlreadyExistsError);

    const handle = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof app.runtime.start>>>)
      .value;
    expect((await handle.waitForCompletion()).status).toBe("completed");
    expect(app.model).toHaveBeenCalledTimes(1);
    const log = await app.store.read(id);
    expect(log.map((e) => e.eventType)).toEqual([
      "EXECUTION_STARTED",
      "STEP_STARTED",
      "STEP_COMPLETED",
      "EXECUTION_COMPLETED",
    ]);
    expect(app.seen.filter((e) => e.eventType === "EXECUTION_STARTED")).toHaveLength(1);
  });

  it("a non-conflict write failure at the bootstrap refuses the start with StorageWriteError, body unrun", async () => {
    const inner = new InMemoryAsyncEventStore();
    const failing = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "append") return async () => Promise.reject(new Error("disk full"));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const onStorageError = vi.fn();
    const model = vi.fn(async () => ({ ok: true }));
    const effects = new EffectRuntime();
    effects.register("model", new ToolEffect(model));
    const seen: EventEnvelope[] = [];
    const runtime = new WorkflowRuntime({
      eventStore: failing,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
      onEvent: (e) => seen.push(e),
      onStorageError,
    });
    runtime.registerFlow(definition, runner);

    const start = runtime.start(FLOW, {}, { executionId: "aug:disk" });
    await expect(start).rejects.toBeInstanceOf(StorageWriteError);
    expect(model).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    expect(onStorageError).toHaveBeenCalledTimes(1);
    expect(onStorageError.mock.calls[0]![0]).toBe("aug:disk");
  });
});

describe("ADR 0103 — the barrier's ordering, and the ulid path's byte-identity", () => {
  const T0 = 1_700_000_000_000;
  const fixedClock = () => {
    let t = T0;
    return () => t++;
  };

  it("caller-chosen id: sequence 0 is durable BEFORE onEvent sees it and before the body runs", async () => {
    const trace: string[] = [];
    const app = boot(new InMemoryAsyncEventStore(), { trace });
    const handle = await app.runtime.start(FLOW, {}, { executionId: "aug:ordered" });
    await handle.waitForCompletion();
    expect(trace.slice(0, 2)).toEqual([
      "append:EXECUTION_STARTED@0",
      "onEvent:EXECUTION_STARTED@0",
    ]);
    // Exactly one append of sequence 0 — `adopt` folds without enqueueing a second write.
    expect(trace.filter((t) => t === "append:EXECUTION_STARTED@0")).toHaveLength(1);
  });

  it("ulid path: the append/onEvent interleaving is unchanged (no barrier)", async () => {
    const trace: string[] = [];
    const app = boot(new InMemoryAsyncEventStore(), { trace });
    const handle = await app.runtime.start(FLOW, {});
    await handle.waitForCompletion();
    // Today's order, pinned: the journal folds + fires onEvent synchronously and enqueues
    // the durable write behind it, for every event including the bootstrap.
    expect(trace).toEqual([
      "onEvent:EXECUTION_STARTED@0",
      "onEvent:STEP_STARTED@1",
      "append:EXECUTION_STARTED@0",
      "onEvent:STEP_COMPLETED@2",
      "onEvent:EXECUTION_COMPLETED@3",
      "append:STEP_STARTED@1",
      "append:STEP_COMPLETED@2",
      "append:EXECUTION_COMPLETED@3",
    ]);
  });

  it("the durable bootstrap envelope is byte-identical to the one the journal would have written", async () => {
    // Same clock, same fence, same placement hint: the only difference between the two
    // runs is who chose the id, so the stored sequence-0 envelopes must match exactly once
    // the id is normalised.
    const opts = { fence: 7, computeTarget: "gpu-lane" };
    const ulidStore = new InMemoryAsyncEventStore();
    const a = boot(ulidStore, { now: fixedClock() });
    const ha = await a.runtime.start(FLOW, { k: 1 }, opts);
    await ha.waitForCompletion();

    const callerStore = new InMemoryAsyncEventStore();
    const b = boot(callerStore, { now: fixedClock() });
    const hb = await b.runtime.start(FLOW, { k: 1 }, { ...opts, executionId: "aug:chosen" });
    await hb.waitForCompletion();

    const norm = (e: EventEnvelope, id: string) => ({
      ...e,
      id: e.id.replace(id, "<id>"),
      executionId: "<id>",
    });
    const la = (await ulidStore.read(ha.executionId)).map((e) => norm(e, ha.executionId));
    const lb = (await callerStore.read("aug:chosen")).map((e) => norm(e, "aug:chosen"));
    expect(lb[0]).toEqual(la[0]);
    expect(lb[0]).toEqual({
      id: "<id>-0",
      workflowId: FLOW,
      executionId: "<id>",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: T0,
      payload: { input: { k: 1 }, flowHash: expect.stringMatching(/^fnv1a:/) },
      metadata: { computeTarget: "gpu-lane", fence: 7 },
    });
    // The whole log matches too — the barrier moved WHEN sequence 0 is written, not WHAT.
    expect(lb).toEqual(la);
    // And onEvent delivered the same envelopes in the same order on both paths.
    expect(b.seen.map((e) => norm(e, "aug:chosen"))).toEqual(
      a.seen.map((e) => norm(e, ha.executionId))
    );
  });
});
