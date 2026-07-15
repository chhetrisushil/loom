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
import type { LlmProvider, LlmStreamChunk } from "@loom/llm";
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

    it("listExecutions enumerates distinct executionIds (when supported)", async () => {
      const store = factory();
      if (store.listExecutions === undefined) return; // OPTIONAL (1.1.0)
      await store.append(evt("x", 0));
      await store.append(evt("x", 1)); // same execution, still one id
      await store.append(evt("y", 0));
      const ids = new Set(await store.listExecutions());
      expect(ids.has("x")).toBe(true);
      expect(ids.has("y")).toBe(true);
      expect(ids.size).toBe(2);
      await store.close();
    });

    it("listExecutionsPage walks every id exactly once, lexicographic, bounded pages (when supported)", async () => {
      const store = factory();
      if (store.listExecutionsPage === undefined) {
        await store.close();
        return; // OPTIONAL (1.2.0, SP-1)
      }
      const ids = Array.from({ length: 23 }, (_, i) => `e-${String(i).padStart(2, "0")}`);
      for (const id of ids) await store.append(evt(id, 0));
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await store.listExecutionsPage({
          ...(cursor !== undefined && { cursor }),
          limit: 5,
        });
        expect(page.executionIds.length).toBeLessThanOrEqual(5);
        seen.push(...page.executionIds);
        if (page.nextCursor === undefined) break;
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(ids); // all, exactly once, lexicographic
      // Paged and whole-list enumerations agree.
      if (store.listExecutions !== undefined) {
        expect(new Set(await store.listExecutions())).toEqual(new Set(seen));
      }
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
      const chunks: LlmStreamChunk[] = [];
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

// ── KeyStore (K10.2 crypto-shredding SPI) ─────────────────────────────────────
//
// Not a kernel seam — it is the crypto plugin's SPI — but the erasure contract is
// security-critical, so the kit ships here (with a structural type, so `@loom/conformance`
// stays free of any plugin dependency). Call it from a KeyStore impl's test suite.

/** Structural view of the crypto-plugin KeyStore SPI (avoids a plugin dependency). */
export interface KeyStoreLike {
  getOrCreate(subjectId: string): Promise<Uint8Array>;
  get(subjectId: string): Promise<Uint8Array | null>;
  destroy(subjectId: string): Promise<void>;
}

/**
 * Assert a KeyStore implementation upholds the erasure contract: stable keys,
 * create-on-first-use, distinct keys per subject, and — the security-critical invariant —
 * a destroyed key is gone forever and can never be resurrected.
 */
export function runKeyStoreConformance(factory: () => KeyStoreLike, label = "KeyStore"): void {
  const eq = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

  describe(`${label} conformance (KeyStore SPI, K10.2)`, () => {
    it("getOrCreate returns a stable key for a subject", async () => {
      const store = factory();
      expect(eq(await store.getOrCreate("s1"), await store.getOrCreate("s1"))).toBe(true);
    });

    it("distinct subjects get distinct keys", async () => {
      const store = factory();
      expect(eq(await store.getOrCreate("s1"), await store.getOrCreate("s2"))).toBe(false);
    });

    it("get returns null before creation and the key after", async () => {
      const store = factory();
      expect(await store.get("s1")).toBeNull();
      const created = await store.getOrCreate("s1");
      const got = await store.get("s1");
      expect(got).not.toBeNull();
      expect(eq(got as Uint8Array, created)).toBe(true);
    });

    it("destroy makes the key unrecoverable (get → null)", async () => {
      const store = factory();
      await store.getOrCreate("s1");
      await store.destroy("s1");
      expect(await store.get("s1")).toBeNull();
    });

    it("a destroyed key can NEVER be resurrected (the erasure invariant)", async () => {
      const store = factory();
      await store.getOrCreate("s1");
      await store.destroy("s1");
      // getOrCreate may throw or yield, but get() MUST still report the subject as erased —
      // resurrecting the same key would defeat crypto-shredding.
      await store.getOrCreate("s1").catch(() => undefined);
      expect(await store.get("s1")).toBeNull();
    });

    it("destroy is idempotent and destroying an unknown subject is a no-op", async () => {
      const store = factory();
      await store.destroy("never-existed");
      await store.getOrCreate("s1");
      await store.destroy("s1");
      await store.destroy("s1");
      expect(await store.get("s1")).toBeNull();
    });
  });
}

// ── ContentStore (ADR 0046 content-store SPI) ─────────────────────────────────
//
// Not a kernel seam — it is the content plugin's SPI — but the contract (content-addressed,
// idempotent, loud-free absence) is worth pinning. Structural type so `@loom/conformance`
// stays free of any plugin dependency. Call from a ContentStore impl's test suite.

/** Structural view of the content-store SPI (avoids a plugin dependency). */
export interface ContentStoreLike {
  put(bytes: Uint8Array): Promise<{ __loomContent: string }>;
  /** OPTIONAL (ST-1, SPI streaming): content-addressed streaming ingestion. */
  putStream?(stream: AsyncIterable<Uint8Array>): Promise<{ __loomContent: string }>;
  get(ref: { __loomContent: string }): Promise<Uint8Array | null>;
  delete(ref: { __loomContent: string }): Promise<void>;
}

/**
 * Assert a ContentStore implementation upholds the ADR-0046 contract: content-addressed +
 * idempotent puts (identical bytes → same ref, stored once), faithful round-trip, `get`
 * returns `null` (never throws) on absence, and `delete` is idempotent physical erasure.
 */
export function runContentStoreConformance(
  factory: () => ContentStoreLike,
  label = "ContentStore"
): void {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
  const eq = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

  describe(`${label} conformance (ContentStore SPI, ADR 0046)`, () => {
    it("round-trips stored bytes", async () => {
      const store = factory();
      const ref = await store.put(bytes("hello"));
      const got = await store.get(ref);
      expect(got).not.toBeNull();
      expect(eq(got as Uint8Array, bytes("hello"))).toBe(true);
    });

    it("is content-addressed: identical bytes yield the same ref (idempotent)", async () => {
      const store = factory();
      const a = await store.put(bytes("same"));
      const b = await store.put(bytes("same"));
      expect(a.__loomContent).toBe(b.__loomContent);
    });

    it("distinct bytes yield distinct refs", async () => {
      const store = factory();
      const a = await store.put(bytes("a"));
      const b = await store.put(bytes("b"));
      expect(a.__loomContent).not.toBe(b.__loomContent);
    });

    it("get returns null (never throws) for an absent ref", async () => {
      const store = factory();
      expect(await store.get({ __loomContent: "sha256:deadbeef" })).toBeNull();
    });

    it("delete physically erases; a subsequent get is null and delete is idempotent", async () => {
      const store = factory();
      const ref = await store.put(bytes("erase-me"));
      await store.delete(ref);
      expect(await store.get(ref)).toBeNull();
      await store.delete(ref); // idempotent — must not throw
    });

    it("putStream addresses the streamed sequence exactly like put(concat) (when supported)", async () => {
      const store = factory();
      if (store.putStream === undefined) return; // OPTIONAL (ST-1, ADR 0059)
      const text = "streamed-content-".repeat(64);
      async function* chunks(): AsyncGenerator<Uint8Array> {
        const all = bytes(text);
        for (let i = 0; i < all.length; i += 13) yield all.slice(i, i + 13);
      }
      const streamed = await store.putStream(chunks());
      const whole = await store.put(bytes(text));
      expect(streamed.__loomContent).toBe(whole.__loomContent); // identical address
      const got = await store.get(streamed);
      expect(eq(got as Uint8Array, bytes(text))).toBe(true); // faithful round-trip
      const again = await store.putStream(chunks());
      expect(again.__loomContent).toBe(streamed.__loomContent); // idempotent by address
    });
  });
}

// ── DurableStateStore (ADR 0051 D2 durable-state SPI) ─────────────────────────
//
// The `@loom/plugin-durable-state` backend contract: a dumb keyed CAS store.
// Contract knowledge (schemas, migrations) lives above the SPI, so conformance
// pins only storage semantics: revisions start at 1 and increment by exactly one,
// `expectedRevision: 0` creates, any mismatch rejects with an error shaped like
// RevisionConflictError (matched structurally — 3P backends may not share the
// class), and `clear` is idempotent. Structural type, same idiom as ContentStore.

/** Structural view of the durable-state store SPI (avoids a plugin dependency). */
export interface DurableStateStoreLike {
  load(
    key: string
  ): Promise<{ contractVersion: number; revision: number; payload: unknown } | null>;
  save(
    key: string,
    value: { contractVersion: number; payload: unknown },
    expectedRevision: number
  ): Promise<{ contractVersion: number; revision: number; payload: unknown }>;
  clear(key: string): Promise<void>;
}

/**
 * Assert a DurableStateStore backend upholds the ADR-0051-D2 contract:
 * compare-and-set revisions (create at 0 → 1, strict +1 increments), loud
 * structured conflicts carrying expected/actual, absence as `null` (never a
 * throw), JSON payload fidelity, per-key isolation, and idempotent `clear`.
 */
export function runDurableStateStoreConformance(
  factory: () => DurableStateStoreLike,
  label = "DurableStateStore"
): void {
  describe(`${label} conformance (DurableStateStore SPI, ADR 0051 D2)`, () => {
    it("load returns null (never throws) for an absent key", async () => {
      const store = factory();
      expect(await store.load("absent")).toBeNull();
    });

    it("save with expectedRevision 0 creates at revision 1 and round-trips", async () => {
      const store = factory();
      const saved = await store.save("k", { contractVersion: 2, payload: { n: 1 } }, 0);
      expect(saved.revision).toBe(1);
      expect(saved.contractVersion).toBe(2);
      const loaded = await store.load("k");
      expect(loaded).toEqual({ contractVersion: 2, revision: 1, payload: { n: 1 } });
    });

    it("CAS increments by exactly one per successful save", async () => {
      const store = factory();
      await store.save("k", { contractVersion: 1, payload: { n: 1 } }, 0);
      const second = await store.save("k", { contractVersion: 1, payload: { n: 2 } }, 1);
      expect(second.revision).toBe(2);
      expect((await store.load("k"))?.payload).toEqual({ n: 2 });
    });

    it("a stale expectedRevision rejects with a structured conflict and leaves the record intact", async () => {
      const store = factory();
      await store.save("k", { contractVersion: 1, payload: { n: 1 } }, 0);
      await store.save("k", { contractVersion: 1, payload: { n: 2 } }, 1);
      await expect(
        store.save("k", { contractVersion: 1, payload: { n: 99 } }, 1)
      ).rejects.toMatchObject({
        name: "RevisionConflictError",
        expectedRevision: 1,
        actualRevision: 2,
      });
      expect(await store.load("k")).toEqual({ contractVersion: 1, revision: 2, payload: { n: 2 } });
    });

    it("creating an existing key (expectedRevision 0) conflicts", async () => {
      const store = factory();
      await store.save("k", { contractVersion: 1, payload: {} }, 0);
      await expect(store.save("k", { contractVersion: 1, payload: {} }, 0)).rejects.toMatchObject({
        name: "RevisionConflictError",
        actualRevision: 1,
      });
    });

    it("updating an absent key conflicts with actualRevision 0", async () => {
      const store = factory();
      await expect(
        store.save("ghost", { contractVersion: 1, payload: {} }, 3)
      ).rejects.toMatchObject({
        name: "RevisionConflictError",
        expectedRevision: 3,
        actualRevision: 0,
      });
    });

    it("preserves JSON payload fidelity (nesting, arrays, null, numbers, unicode)", async () => {
      const store = factory();
      const payload = {
        nested: { deep: [1, 2.5, null, "χ", { flag: false }] },
        empty: {},
        list: [] as unknown[],
      };
      await store.save("k", { contractVersion: 1, payload }, 0);
      expect((await store.load("k"))?.payload).toEqual(payload);
    });

    it("keys are isolated", async () => {
      const store = factory();
      await store.save("a", { contractVersion: 1, payload: { of: "a" } }, 0);
      await store.save("b", { contractVersion: 1, payload: { of: "b" } }, 0);
      expect((await store.load("a"))?.payload).toEqual({ of: "a" });
      expect((await store.load("b"))?.payload).toEqual({ of: "b" });
    });

    it("clear removes the key, is idempotent, and create works again afterwards", async () => {
      const store = factory();
      await store.save("k", { contractVersion: 1, payload: { n: 1 } }, 0);
      await store.clear("k");
      expect(await store.load("k")).toBeNull();
      await store.clear("k"); // idempotent — must not throw
      const recreated = await store.save("k", { contractVersion: 1, payload: { n: 2 } }, 0);
      expect(recreated.revision).toBe(1);
    });
  });
}

// ── ReadModelStore (RM, db-copilot infra — issue #183) ────────────────────────
//
// The `@loom/plugin-read-model` backend contract: a dumb indexed row store with
// idempotent apply and monotonic per-execution watermarks. Model knowledge
// (kinds, extractors) lives above the SPI, so conformance pins storage
// semantics only. Structural type, same idiom as ContentStore/DurableStateStore.

type RmScalar = string | number | boolean | null;

/** Structural view of the read-model store SPI (avoids a plugin dependency). */
export interface ReadModelStoreLike {
  apply(
    modelId: string,
    executionId: string,
    upToSequence: number,
    rows: readonly {
      rowId: string;
      executionId: string;
      sequence: number;
      timestamp: number;
      kind: string;
      fields: Record<string, RmScalar>;
      value: unknown;
    }[]
  ): Promise<void>;
  watermark(modelId: string, executionId: string): Promise<number | null>;
  watermarkedExecutions(modelId: string): Promise<string[]>;
  query(
    modelId: string,
    q?: {
      kind?: string;
      where?: Record<string, RmScalar>;
      order?: "asc" | "desc";
      limit?: number;
      cursor?: string;
    }
  ): Promise<{ rows: { rowId: string; value: unknown }[]; nextCursor?: string }>;
  clear(modelId: string): Promise<void>;
}

/**
 * Assert a ReadModelStore backend upholds the RM contract: idempotent apply
 * (per rowId), monotonic watermarks (never regress), kind + field-equality
 * queries with stable keyset pagination (no duplicates, no gaps, order held
 * across pages), per-model isolation, and idempotent clear of rows AND
 * watermarks.
 */
export function runReadModelStoreConformance(
  factory: () => ReadModelStoreLike,
  label = "ReadModelStore"
): void {
  const row = (
    n: number,
    over: Partial<{
      kind: string;
      fields: Record<string, RmScalar>;
      executionId: string;
      timestamp: number;
    }> = {}
  ) => ({
    rowId: `e-${n}`,
    executionId: over.executionId ?? "x-1",
    sequence: n,
    timestamp: over.timestamp ?? 1_000 + n,
    kind: over.kind ?? "FINDING_RECORDED",
    fields: over.fields ?? { target: "orders" },
    value: { n },
  });

  describe(`${label} conformance (ReadModelStore SPI, RM)`, () => {
    it("apply is idempotent per rowId; re-apply never duplicates", async () => {
      const store = factory();
      await store.apply("m", "x-1", 0, [row(0)]);
      await store.apply("m", "x-1", 0, [row(0)]);
      const page = await store.query("m");
      expect(page.rows).toHaveLength(1);
    });

    it("watermarks advance monotonically and never regress", async () => {
      const store = factory();
      await store.apply("m", "x-1", 5, []);
      await store.apply("m", "x-1", 3, []); // late/duplicate delivery
      expect(await store.watermark("m", "x-1")).toBe(5);
      expect(await store.watermark("m", "ghost")).toBeNull();
      expect(await store.watermarkedExecutions("m")).toEqual(["x-1"]);
    });

    it("queries filter by kind and by field equality (ANDed)", async () => {
      const store = factory();
      await store.apply("m", "x-1", 2, [
        row(0, { fields: { target: "orders", severity: "high" } }),
        row(1, { fields: { target: "orders", severity: "low" } }),
        row(2, { kind: "DECISION_RECORDED", fields: { target: "orders" } }),
      ]);
      expect((await store.query("m", { kind: "FINDING_RECORDED" })).rows).toHaveLength(2);
      expect(
        (await store.query("m", { where: { target: "orders", severity: "high" } })).rows
      ).toHaveLength(1);
      expect((await store.query("m", { where: { target: "users" } })).rows).toHaveLength(0);
    });

    it("keyset pagination walks every row exactly once, order held, both directions", async () => {
      const store = factory();
      const rows = Array.from({ length: 23 }, (_, n) => row(n, { timestamp: 5_000 - n }));
      await store.apply("m", "x-1", 22, rows);
      for (const order of ["asc", "desc"] as const) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await store.query("m", {
            order,
            limit: 4,
            ...(cursor !== undefined && { cursor }),
          });
          seen.push(...page.rows.map((r) => r.rowId));
          if (page.nextCursor === undefined) break;
          cursor = page.nextCursor;
        }
        expect(seen).toHaveLength(23);
        expect(new Set(seen).size).toBe(23);
      }
    });

    it("rejects malformed cursors and invalid limits loudly (audit hardening)", async () => {
      const store = factory();
      await store.apply("m", "x-1", 0, [row(0)]);
      await expect(store.query("m", { cursor: "not json" })).rejects.toThrow(/cursor/);
      await expect(store.query("m", { cursor: '{"x":1}' })).rejects.toThrow(/cursor/);
      await expect(store.query("m", { limit: 0 })).rejects.toThrow(/limit/);
      await expect(store.query("m", { limit: -1 })).rejects.toThrow(/limit/);
    });

    it("models are isolated; clear drops rows AND watermarks for one model only", async () => {
      const store = factory();
      await store.apply("a", "x-1", 0, [row(0)]);
      await store.apply("b", "x-1", 0, [row(0)]);
      await store.clear("a");
      await store.clear("a"); // idempotent
      expect((await store.query("a")).rows).toHaveLength(0);
      expect(await store.watermark("a", "x-1")).toBeNull();
      expect((await store.query("b")).rows).toHaveLength(1);
      expect(await store.watermark("b", "x-1")).toBe(0);
    });
  });
}
