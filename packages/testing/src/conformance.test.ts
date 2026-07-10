import {
  InMemoryAsyncEventStore,
  InMemoryBranchRegistry,
  SqliteBranchRegistry,
  SqliteEventStore,
} from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore, SqliteSnapshotStore } from "@loom/snapshot-runtime";
import {
  runBranchRegistryConformance,
  runEventStoreConformance,
  runSnapshotStoreConformance,
} from "./conformance";

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
