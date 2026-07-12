import type { EventEnvelope, ExecutionState } from "@loom/core";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import type { CapabilityAuthorizer, CapabilityRequest } from "@loom/effect-runtime";
import type {
  BranchRef,
  BranchRegistry,
  EventStore,
  TimerRecord,
  TimerStore,
} from "@loom/event-runtime";
import { readRangeOf } from "@loom/event-runtime";
import type { LlmProvider } from "@loom/llm";
import type { Projection, ProjectionRuntime } from "@loom/projection-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import type { ExecutionPackage, WorkerRuntime } from "@loom/worker-runtime";
import { describe, expect, it } from "vitest";

// ── SPI conformance kits (ADR 0033) ──────────────────────────────────────────
//
// Portable contract suites for Loom's extension SPIs. A third-party implementation
// proves it conforms by running the matching `run<Spi>Conformance(factory)` against
// itself — the same idiom as the K1 (kernel ABI) and K5 (event-schema) conformance
// tests, extended from the syscall surface to the pluggable storage seams. Each kit
// exercises the REQUIRED contract and skips OPTIONAL methods a backend omits.

function evt(executionId: string, sequence: number, eventType = "STEP_COMPLETED"): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload: { sequence },
  };
}

/**
 * The EventStore contract (`@loom/event-runtime`): durable, append-only, per-execution
 * ordered reads, live subscribe, and (optionally) fencing.
 */
export function runEventStoreConformance(factory: () => EventStore, label = "EventStore"): void {
  describe(`${label} conformance (EventStore SPI)`, () => {
    it("append + read returns an execution's events in sequence order", async () => {
      const store = factory();
      await store.append(evt("x", 0, "EXECUTION_STARTED"));
      await store.append(evt("x", 1));
      await store.append(evt("x", 2));
      expect((await store.read("x")).map((e) => e.sequence)).toEqual([0, 1, 2]);
      await store.close();
    });

    it("read isolates executions", async () => {
      const store = factory();
      await store.append(evt("x", 0));
      await store.append(evt("y", 0));
      expect(await store.read("y")).toHaveLength(1);
      expect((await store.read("x"))[0]?.executionId).toBe("x");
      await store.close();
    });

    it("readFrom returns the suffix at/after a sequence", async () => {
      const store = factory();
      for (let i = 0; i < 4; i++) await store.append(evt("x", i));
      expect((await store.readFrom("x", 2)).map((e) => e.sequence)).toEqual([2, 3]);
      await store.close();
    });

    it("readRangeOf returns a bounded inclusive range (native or fallback)", async () => {
      const store = factory();
      for (let i = 0; i < 5; i++) await store.append(evt("x", i));
      expect((await readRangeOf(store, "x", 1, 3)).map((e) => e.sequence)).toEqual([1, 2, 3]);
      await store.close();
    });

    it("subscribe delivers appended events; unsubscribe stops them", async () => {
      const store = factory();
      const seen: number[] = [];
      const unsub = await store.subscribe("x", (e) => seen.push(e.sequence));
      await store.append(evt("x", 0));
      await store.append(evt("x", 1));
      unsub();
      await store.append(evt("x", 2));
      expect(seen).toEqual([0, 1]);
      await store.close();
    });

    it("acquireFence increments monotonically (when supported)", async () => {
      const store = factory();
      if (store.acquireFence === undefined) return; // OPTIONAL — single-node backends omit it
      expect(await store.acquireFence("x")).toBe(1);
      expect(await store.acquireFence("x")).toBe(2);
      expect(await store.acquireFence("y")).toBe(1);
      await store.close();
    });
  });
}

function snap(executionId: string, sequence: number): Snapshot {
  return {
    id: `${executionId}-${sequence}`,
    executionId,
    workflowId: "wf",
    sequence,
    state: { executionId, workflowId: "wf" } as unknown as ExecutionState,
    createdAt: 1000 + sequence,
  };
}

/** The SnapshotStore contract (`@loom/snapshot-runtime`): save + point/latest/before reads. */
export function runSnapshotStoreConformance(
  factory: () => SnapshotStore,
  label = "SnapshotStore"
): void {
  describe(`${label} conformance (SnapshotStore SPI)`, () => {
    it("save + loadLatest returns the greatest-sequence snapshot", async () => {
      const store = factory();
      await store.save(snap("x", 1));
      await store.save(snap("x", 3));
      await store.save(snap("x", 2));
      expect((await store.loadLatest("x"))?.sequence).toBe(3);
      await store.close();
    });

    it("loadAt returns the exact sequence, null when absent", async () => {
      const store = factory();
      await store.save(snap("x", 5));
      expect((await store.loadAt("x", 5))?.sequence).toBe(5);
      expect(await store.loadAt("x", 4)).toBeNull();
      await store.close();
    });

    it("loadLatestBefore returns the greatest snapshot at or below a sequence", async () => {
      const store = factory();
      await store.save(snap("x", 1));
      await store.save(snap("x", 3));
      expect((await store.loadLatestBefore("x", 2))?.sequence).toBe(1);
      expect((await store.loadLatestBefore("x", 3))?.sequence).toBe(3);
      expect(await store.loadLatestBefore("x", 0)).toBeNull();
      await store.close();
    });

    it("loadLatest is null for an unknown execution", async () => {
      const store = factory();
      expect(await store.loadLatest("nope")).toBeNull();
      await store.close();
    });

    it("deleteExecution removes an execution's snapshots (when supported)", async () => {
      const store = factory();
      if (store.deleteExecution === undefined) return; // OPTIONAL (K10.1)
      await store.save(snap("x", 1));
      await store.deleteExecution("x");
      expect(await store.loadLatest("x")).toBeNull();
      await store.close();
    });
  });
}

function ref(name: string, executionId: string, tip: number): BranchRef {
  return { name, executionId, tip, createdAt: 1, updatedAt: 1 };
}

/** The BranchRegistry contract (`@loom/event-runtime`): refs, tip moves, promote, lineage DAG. */
export function runBranchRegistryConformance(
  factory: () => BranchRegistry,
  label = "BranchRegistry"
): void {
  describe(`${label} conformance (BranchRegistry SPI)`, () => {
    it("putRef + getRef round-trips; listRefs is sorted by name; getRef null when absent", async () => {
      const reg = factory();
      await reg.putRef(ref("main", "execA", 5));
      await reg.putRef(ref("dev", "execB", 2));
      expect((await reg.getRef("main"))?.executionId).toBe("execA");
      expect(await reg.getRef("nope")).toBeNull();
      expect((await reg.listRefs()).map((r) => r.name)).toEqual(["dev", "main"]);
      await reg.close();
    });

    it("moveTip advances a ref's tip and is a no-op when absent", async () => {
      const reg = factory();
      await reg.putRef(ref("main", "execA", 5));
      await reg.moveTip("main", 9);
      expect((await reg.getRef("main"))?.tip).toBe(9);
      await reg.moveTip("ghost", 1); // no throw
      await reg.close();
    });

    it("promote repoints onto the winner's execution; throws when fromName is missing", async () => {
      const reg = factory();
      await reg.putRef(ref("cand", "execWin", 7));
      await reg.promote("cand", "release"); // creates release
      expect(await reg.getRef("release")).toMatchObject({ executionId: "execWin", tip: 7 });
      await reg.putRef(ref("release2", "execOld", 1));
      await reg.promote("cand", "release2"); // repoints existing
      expect((await reg.getRef("release2"))?.executionId).toBe("execWin");
      await expect(reg.promote("missing", "x")).rejects.toThrow();
      await reg.close();
    });

    it("deleteRef removes a ref", async () => {
      const reg = factory();
      await reg.putRef(ref("tmp", "execA", 1));
      await reg.deleteRef("tmp");
      expect(await reg.getRef("tmp")).toBeNull();
      await reg.close();
    });

    it("recordLineage + getLineage + children model the fork DAG", async () => {
      const reg = factory();
      await reg.recordLineage({
        executionId: "child1",
        parentExecutionId: "parent",
        forkSequence: 3,
      });
      await reg.recordLineage({
        executionId: "child2",
        parentExecutionId: "parent",
        forkSequence: 5,
      });
      expect((await reg.getLineage("child1"))?.parentExecutionId).toBe("parent");
      expect(await reg.getLineage("orphan")).toBeNull();
      expect((await reg.children("parent")).map((l) => l.executionId).sort()).toEqual([
        "child1",
        "child2",
      ]);
      await reg.close();
    });
  });
}

function pkg(executionId: string): ExecutionPackage {
  return { executionId, workflowId: "wf", flowId: "f", input: {} };
}

/**
 * The ExecutionDispatcher contract (`@loom/dispatcher`): dispatch a package to a terminal
 * result, report health, and accept a cancel without throwing.
 */
export function runExecutionDispatcherConformance(
  factory: () => ExecutionDispatcher,
  label = "ExecutionDispatcher"
): void {
  describe(`${label} conformance (ExecutionDispatcher SPI)`, () => {
    it("dispatch runs a package to a terminal result for the same executionId", async () => {
      const d = factory();
      const result = await d.dispatch(pkg("exec-1"));
      expect(result.executionId).toBe("exec-1");
      expect(["completed", "suspended", "failed"]).toContain(result.status);
      expect(typeof result.lastSequence).toBe("number");
    });

    it("health reports liveness and an in-flight count", async () => {
      const d = factory();
      const h = await d.health();
      expect(typeof h.healthy).toBe("boolean");
      expect(typeof h.inFlight).toBe("number");
    });

    it("cancel of an unknown execution is safe (no throw)", async () => {
      const d = factory();
      await expect(d.cancel("nope")).resolves.toBeUndefined();
    });
  });
}

/**
 * Prove a {@link TimerStore} (T1 durable timers) conforms: idempotent scheduling,
 * soonest-first due ordering with a limit, and completion semantics.
 */
export function runTimerStoreConformance(factory: () => TimerStore, label = "TimerStore"): void {
  describe(`${label} conformance (TimerStore SPI)`, () => {
    it("schedule + due returns due timers soonest-first", async () => {
      const s = factory();
      await s.schedule({ executionId: "b", wakeAt: 200 });
      await s.schedule({ executionId: "a", wakeAt: 100 });
      await s.schedule({ executionId: "c", wakeAt: 900 });
      expect(await s.due(500)).toEqual([
        { executionId: "a", wakeAt: 100 },
        { executionId: "b", wakeAt: 200 },
      ]);
      await s.close();
    });

    it("schedule is idempotent per (executionId, wakeAt)", async () => {
      const s = factory();
      await s.schedule({ executionId: "a", wakeAt: 100 });
      await s.schedule({ executionId: "a", wakeAt: 100 });
      expect((await s.due(500)).length).toBe(1);
      await s.close();
    });

    it("due excludes not-yet-due timers and respects the limit", async () => {
      const s = factory();
      for (let i = 0; i < 5; i++) await s.schedule({ executionId: `e${i}`, wakeAt: i });
      await s.schedule({ executionId: "future", wakeAt: 10_000 });
      const due: TimerRecord[] = await s.due(100, 3);
      expect(due.length).toBe(3);
      expect(due.every((t) => t.wakeAt <= 100)).toBe(true);
      await s.close();
    });

    it("complete removes a fired timer; unknown timers are a no-op", async () => {
      const s = factory();
      await s.schedule({ executionId: "a", wakeAt: 100 });
      await s.complete("a", 100);
      expect(await s.due(500)).toEqual([]);
      await expect(s.complete("nope", 1)).resolves.toBeUndefined();
      await s.close();
    });
  });
}

/**
 * Prove a {@link ProjectionRuntime} conforms: per-execution folding of matching
 * events, initial state before any events, live subscribe/unsubscribe, and
 * `seedState`. Drives a small counter projection.
 */
export function runProjectionRuntimeConformance(
  factory: () => ProjectionRuntime,
  label = "ProjectionRuntime"
): void {
  const counter: Projection<{ n: number }> = {
    id: "counter",
    initialState: { n: 0 },
    handlers: {
      TICK: (s, e) => ({ n: s.n + ((e.payload as { by?: number }).by ?? 1) }),
    },
  };
  const tick = (executionId: string, by: number, sequence: number): EventEnvelope => ({
    id: `evt-${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType: "TICK",
    sequence,
    timestamp: 0,
    payload: { by },
  });

  describe(`${label} conformance (ProjectionRuntime SPI)`, () => {
    it("getState returns the initial state before any events", () => {
      const r = factory();
      r.register(counter);
      expect(r.getState("counter", "x")).toEqual({ n: 0 });
    });

    it("handleEvent folds matching events per execution", () => {
      const r = factory();
      r.register(counter);
      r.handleEvent(tick("x", 2, 1));
      r.handleEvent(tick("x", 3, 2));
      r.handleEvent(tick("y", 5, 1));
      expect(r.getState("counter", "x")).toEqual({ n: 5 });
      expect(r.getState("counter", "y")).toEqual({ n: 5 });
    });

    it("subscribe fires on change; unsubscribe stops delivery", () => {
      const r = factory();
      r.register(counter);
      const seen: number[] = [];
      const unsub = r.subscribe<{ n: number }>("counter", "x", (s) => seen.push(s.n));
      r.handleEvent(tick("x", 1, 1));
      unsub();
      r.handleEvent(tick("x", 1, 2));
      expect(seen).toContain(1);
      expect(seen).not.toContain(2);
    });

    it("seedState sets state directly", () => {
      const r = factory();
      r.register(counter);
      r.seedState("counter", "x", { n: 42 });
      expect(r.getState("counter", "x")).toEqual({ n: 42 });
    });

    it("an unhandled event type leaves state unchanged", () => {
      const r = factory();
      r.register(counter);
      r.handleEvent({ ...tick("x", 1, 1), eventType: "OTHER" });
      expect(r.getState("counter", "x")).toEqual({ n: 0 });
    });
  });
}

/**
 * Prove a {@link WorkerRuntime} conforms: `allocate` yields a lease, `execute` runs a
 * package to a terminal status echoing the executionId, and `release` is safe. Because
 * `execute` needs a runnable package, the factory returns a worker AND a package it can
 * run (fresh per case, so their flow ids match).
 */
export function runWorkerRuntimeConformance(
  factory: () => { worker: WorkerRuntime; pkg: ExecutionPackage },
  label = "WorkerRuntime"
): void {
  describe(`${label} conformance (WorkerRuntime SPI)`, () => {
    it("allocate → execute → release runs a package to a terminal status", async () => {
      const { worker, pkg } = factory();
      const lease = await worker.allocate({ executionId: pkg.executionId });
      expect(typeof lease.leaseId).toBe("string");
      const result = await worker.execute(lease, pkg);
      expect(result.executionId).toBe(pkg.executionId);
      expect(["completed", "suspended", "failed"]).toContain(result.status);
      expect(result.lastSequence).toBeGreaterThanOrEqual(0);
      await expect(worker.release(lease)).resolves.toBeUndefined();
    });
  });
}

/**
 * Prove an {@link LlmProvider} conforms: `complete` returns `content` + a valid
 * `stopReason`; `stream` (when supported) yields chunks terminated by `done`.
 */
export function runLlmProviderConformance(factory: () => LlmProvider, label = "LlmProvider"): void {
  const req = { messages: [{ role: "user" as const, content: "hi" }] };
  describe(`${label} conformance (LlmProvider SPI)`, () => {
    it("complete returns content and a valid stopReason", async () => {
      const res = await factory().complete(req);
      expect(typeof res.content).toBe("string");
      expect(["end_turn", "tool_use", "max_tokens"]).toContain(res.stopReason);
    });

    it("stream (when supported) yields chunks ending with done:true", async () => {
      const provider = factory();
      if (provider.stream === undefined) return;
      const chunks = [];
      for await (const c of provider.stream(req)) chunks.push(c);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[chunks.length - 1]?.done).toBe(true);
    });
  });
}

/**
 * Prove a {@link CapabilityAuthorizer} conforms: `authorize` returns a boolean decision,
 * deterministically for a given request, and a denial's `reason` (if any) is a string.
 * (Policy content is the plugin's — the kit pins the *shape* and determinism.)
 */
export function runCapabilityAuthorizerConformance(
  factory: () => CapabilityAuthorizer,
  label = "CapabilityAuthorizer"
): void {
  const req: CapabilityRequest = { toolId: "t", executionId: "e", workflowId: "w", stepId: "s" };
  describe(`${label} conformance (CapabilityAuthorizer SPI)`, () => {
    it("authorize returns a boolean decision", () => {
      expect(typeof factory().authorize(req).allowed).toBe("boolean");
    });

    it("authorize is deterministic for the same request", () => {
      const a = factory();
      expect(a.authorize(req).allowed).toBe(a.authorize(req).allowed);
    });

    it("a denial's reason, when present, is a string", () => {
      const d = factory().authorize(req);
      if (!d.allowed && d.reason !== undefined) expect(typeof d.reason).toBe("string");
    });
  });
}
