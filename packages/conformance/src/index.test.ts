import type { ExecutionState } from "@loom/core";
import { DISPATCHER_SPI_VERSION, LocalDispatcher } from "@loom/dispatcher";
import { GrantTable } from "@loom/effect-runtime";
import {
  BRANCH_REGISTRY_SPI_VERSION,
  CoalescingEventStore,
  EVENT_STORE_SPI_VERSION,
  InMemoryAsyncEventStore,
  InMemoryBranchRegistry,
  InMemoryLeaseStore,
  InMemoryTimerStore,
  OPTIONAL_EVENT_STORE_METHODS,
  ProfilingEventStore,
  ShardPlan,
  ShardedEventStore,
  TenantScopedEventStore,
} from "@loom/event-runtime";
import type { LlmProvider } from "@loom/llm";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import {
  InMemoryAsyncSnapshotStore,
  SNAPSHOT_STORE_SPI_VERSION,
  TenantScopedSnapshotStore,
} from "@loom/snapshot-runtime";
import type {
  ExecutionPackage,
  ExecutionResult,
  WorkerLease,
  WorkerRequest,
  WorkerRuntime,
} from "@loom/worker-runtime";
import { describe, expect, it } from "vitest";
import {
  optionalSurfaceProblems,
  runEventStoreDecoratorConformance,
  runSnapshotStoreDecoratorConformance,
} from "./decorators";
import {
  runBranchRegistryConformance,
  runCapabilityAuthorizerConformance,
  runEventStoreConformance,
  runExecutionDispatcherConformance,
  runLeaseStoreConformance,
  runLlmProviderConformance,
  runProjectionRuntimeConformance,
  runSnapshotStoreConformance,
  runTimerStoreConformance,
} from "./index";

/** A minimal in-memory WorkerRuntime for the dispatcher conformance self-test. */
class FakeWorker implements WorkerRuntime {
  async allocate(request: WorkerRequest): Promise<WorkerLease> {
    return { leaseId: `lease-${request.executionId}` };
  }
  async execute(_lease: WorkerLease, p: ExecutionPackage): Promise<ExecutionResult> {
    const state: ExecutionState = {
      executionId: p.executionId,
      workflowId: "wf",
      workflowVersion: "1.0.0",
      status: "completed",
      frames: {},
      variables: {},
      sequence: 1,
      startedAt: 0,
      updatedAt: 0,
    };
    return {
      executionId: p.executionId,
      status: "completed",
      state,
      output: { ok: true },
      lastSequence: 1,
    };
  }
  async release(): Promise<void> {}
}

// The kits must pass against Loom's own reference impls — this self-tests the kits.
// Durable backends (SQLite, Postgres) run the SAME kits in their own packages; that
// is the point: a third-party backend proves conformance the same way.
runEventStoreConformance(() => new InMemoryAsyncEventStore(), "InMemoryAsyncEventStore");

// ADR 0074 — the scale decorators run the SAME suite as a backend. That is the strongest
// statement available about a decorator: it is indistinguishable from the store it wraps,
// including through the composition the ADR documents (sharding outermost).
runEventStoreConformance(
  () => new CoalescingEventStore(new InMemoryAsyncEventStore()),
  "CoalescingEventStore(InMemory)"
);
runEventStoreConformance(
  () => new ShardedEventStore(Array.from({ length: 4 }, () => new InMemoryAsyncEventStore())),
  "ShardedEventStore(4x InMemory)"
);
// ADR 0075 — plan-driven routing, and routing while a bucket is mid-migration, must both be
// indistinguishable from an unsharded store. The migrating case is the interesting one: it
// exercises the two-sided per-execution resolution on every contract case.
runEventStoreConformance(
  () =>
    new ShardedEventStore(
      Array.from({ length: 3 }, () => new InMemoryAsyncEventStore()),
      {
        plan: ShardPlan.uniform(3, 256),
      }
    ),
  "ShardedEventStore(planned)"
);
runEventStoreConformance(
  () =>
    new ShardedEventStore(
      Array.from({ length: 3 }, () => new InMemoryAsyncEventStore()),
      {
        plan: ShardPlan.uniform(2, 256).rebalanced(3),
      }
    ),
  "ShardedEventStore(mid-migration)"
);
runEventStoreConformance(
  () =>
    new ShardedEventStore([
      new CoalescingEventStore(new InMemoryAsyncEventStore()),
      new CoalescingEventStore(new InMemoryAsyncEventStore()),
    ]),
  "Sharded(Coalescing(InMemory))"
);
// ADR 0074 Amendment (L1) — every in-package decorator proves it carries the whole optional
// SPI through, and passes the full suite THROUGH itself. The plugin decorators (encryption,
// content, audit chain) and the tools (DST fault store, crash harness) register in their own
// packages; `packages/spec/src/decoratorConformance.test.ts` fails if any decorator does not.
runEventStoreDecoratorConformance(
  "TenantScopedEventStore",
  (inner) => new TenantScopedEventStore(inner, "acme")
);
runEventStoreDecoratorConformance(
  "CoalescingEventStore",
  (inner) => new CoalescingEventStore(inner)
);
runEventStoreDecoratorConformance("ProfilingEventStore", (inner) => new ProfilingEventStore(inner));
// Sharding over ONE shard is the decorator shape the kit can check (every capability the inner
// has must survive); the multi-shard compositions above cover routing.
runEventStoreDecoratorConformance("ShardedEventStore", (inner) => new ShardedEventStore([inner]));
runSnapshotStoreDecoratorConformance(
  "TenantScopedSnapshotStore",
  (inner) => new TenantScopedSnapshotStore(inner, "acme")
);

// The kit's guard must FIRE: a decorator that forgets `appendBatch` is exactly the drift it
// exists to catch. `optionalSurfaceProblems` is the check the kit's own `it` asserts empty.
describe("the decorator kit rejects a decorator that drops an optional method", () => {
  /** Hand-forwards everything EXCEPT appendBatch — the pre-L1 TenantScopedEventStore shape. */
  const droppingDecorator = (inner: InstanceType<typeof InMemoryAsyncEventStore>) => ({
    append: inner.append.bind(inner),
    read: inner.read.bind(inner),
    readFrom: inner.readFrom.bind(inner),
    subscribe: inner.subscribe.bind(inner),
    close: inner.close.bind(inner),
    readRange: inner.readRange.bind(inner),
    head: inner.head.bind(inner),
    acquireFence: inner.acquireFence.bind(inner),
    copyPrefix: inner.copyPrefix.bind(inner),
    deleteExecution: inner.deleteExecution.bind(inner),
    truncatePrefix: inner.truncatePrefix.bind(inner),
    listExecutions: inner.listExecutions.bind(inner),
    listExecutionsPage: inner.listExecutionsPage.bind(inner),
  });

  it("fails it, naming the method", () => {
    const store = droppingDecorator(new InMemoryAsyncEventStore());
    const problems = optionalSurfaceProblems("Dropper", store, OPTIONAL_EVENT_STORE_METHODS);
    expect(problems).toEqual([expect.stringContaining("Dropper silently drops appendBatch")]);
    // …which is what the kit's `it` asserts is empty — so the kit fails for this decorator.
    expect(() => expect(problems).toEqual([])).toThrow();
  });

  it("accepts the same omission once it is refused with a reason — and not with an empty one", () => {
    const store = droppingDecorator(new InMemoryAsyncEventStore());
    expect(
      optionalSurfaceProblems("Dropper", store, OPTIONAL_EVENT_STORE_METHODS, {
        appendBatch: "cannot batch: each envelope needs its own round-trip",
      })
    ).toEqual([]);
    expect(
      optionalSurfaceProblems("Dropper", store, OPTIONAL_EVENT_STORE_METHODS, { appendBatch: " " })
    ).toEqual([expect.stringContaining("without a reason")]);
  });

  it("rejects a stale refusal — declared refused, still exposed", () => {
    const store = new InMemoryAsyncEventStore();
    expect(
      optionalSurfaceProblems("Liar", store, OPTIONAL_EVENT_STORE_METHODS, { head: "no tips" })
    ).toEqual([expect.stringContaining("declares head refused")]);
  });
});

runSnapshotStoreConformance(() => new InMemoryAsyncSnapshotStore(), "InMemoryAsyncSnapshotStore");
runBranchRegistryConformance(() => new InMemoryBranchRegistry(), "InMemoryBranchRegistry");
runLeaseStoreConformance(() => new InMemoryLeaseStore(), "InMemoryLeaseStore");
runExecutionDispatcherConformance(() => new LocalDispatcher(new FakeWorker()), "LocalDispatcher");
runTimerStoreConformance(() => new InMemoryTimerStore(), "InMemoryTimerStore");
runProjectionRuntimeConformance(() => new InMemoryProjectionRuntime(), "InMemoryProjectionRuntime");

// Every public SPI declares a version constant (ADR 0033 — versioning policy).
describe("SPI version constants", () => {
  it("are semver strings", () => {
    for (const v of [
      EVENT_STORE_SPI_VERSION,
      SNAPSHOT_STORE_SPI_VERSION,
      BRANCH_REGISTRY_SPI_VERSION,
      DISPATCHER_SPI_VERSION,
    ]) {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

// (WorkerRuntime conformance self-tests against LocalWorkerRuntime in
// @loom/worker-runtime-local — that package owns the reference impl + a runtime to run.)

// --- LlmProvider: a deterministic echo provider (offline). ---
const echoProvider: LlmProvider = {
  async complete(req) {
    const last = req.messages[req.messages.length - 1];
    return { content: `echo:${last?.content ?? ""}`, stopReason: "end_turn" };
  },
  async *stream(req) {
    const last = req.messages[req.messages.length - 1];
    yield { delta: `echo:${last?.content ?? ""}`, done: false };
    yield { delta: "", done: true };
  },
};
runLlmProviderConformance(() => echoProvider, "EchoLlmProvider");

// A provider that REPORTS the outcome on its terminal chunk — the shape an agent
// turn needs. Without one of these in the fixture set, the parity assertions all
// take their "not reported" branch and the suite proves only that text matches.
const richProvider: LlmProvider = {
  async complete() {
    return {
      content: "thinking",
      toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 7, outputTokens: 3 },
    };
  },
  async *stream() {
    yield { delta: "think", done: false };
    yield { delta: "ing", done: false };
    yield {
      delta: "",
      done: true,
      toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
      stopReason: "tool_use" as const,
      usage: { inputTokens: 7, outputTokens: 3 },
    };
  },
};
runLlmProviderConformance(() => richProvider, "RichLlmProvider");

// --- CapabilityAuthorizer: the reference GrantTable. ---
runCapabilityAuthorizerConformance(() => new GrantTable({ w: ["t"] }), "GrantTable");

describe("TenantScopedSnapshotStore rejects a tenant containing the separator (K12.5)", () => {
  it("throws for 'a:b' and '' — the same prefix-collision rule as the event store", () => {
    const inner = new InMemoryAsyncSnapshotStore();
    expect(() => new TenantScopedSnapshotStore(inner, "a:b")).toThrow(/separator/);
    expect(() => new TenantScopedSnapshotStore(inner, "")).toThrow(/tenant/);
    expect(() => new TenantScopedSnapshotStore(inner, "acme")).not.toThrow();
  });
});
