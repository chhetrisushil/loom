import type { ExecutionState } from "@loom/core";
import { DISPATCHER_SPI_VERSION, LocalDispatcher } from "@loom/dispatcher";
import {
  BRANCH_REGISTRY_SPI_VERSION,
  EVENT_STORE_SPI_VERSION,
  InMemoryAsyncEventStore,
  InMemoryBranchRegistry,
} from "@loom/event-runtime";
import { SqliteBranchRegistry, SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
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
  runEventStoreConformance,
  runExecutionDispatcherConformance,
  runSnapshotStoreConformance,
} from "./conformance";

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

// The conformance kits must pass against Loom's own reference impls — this self-tests
// the kits AND pins every backend to the SPI contracts. Running the SAME kit against
// both the in-memory and the durable SQLite backends is the point of the exercise:
// a third-party backend proves conformance the same way.
runEventStoreConformance(() => new InMemoryAsyncEventStore(), "InMemoryAsyncEventStore");
runEventStoreConformance(() => new SqliteEventStore(":memory:"), "SqliteEventStore(:memory:)");

runSnapshotStoreConformance(() => new InMemoryAsyncSnapshotStore(), "InMemoryAsyncSnapshotStore");
runSnapshotStoreConformance(
  () => new SqliteSnapshotStore(":memory:"),
  "SqliteSnapshotStore(:memory:)"
);

runBranchRegistryConformance(() => new InMemoryBranchRegistry(), "InMemoryBranchRegistry");
runBranchRegistryConformance(
  () => new SqliteBranchRegistry(":memory:"),
  "SqliteBranchRegistry(:memory:)"
);

runExecutionDispatcherConformance(() => new LocalDispatcher(new FakeWorker()), "LocalDispatcher");

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
