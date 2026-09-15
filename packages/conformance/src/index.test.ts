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
  ShardPlan,
  ShardedEventStore,
} from "@loom/event-runtime";
import type { LlmProvider } from "@loom/llm";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { InMemoryAsyncSnapshotStore, SNAPSHOT_STORE_SPI_VERSION } from "@loom/snapshot-runtime";
import type {
  ExecutionPackage,
  ExecutionResult,
  WorkerLease,
  WorkerRequest,
  WorkerRuntime,
} from "@loom/worker-runtime";
import { describe, expect, it } from "vitest";
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
