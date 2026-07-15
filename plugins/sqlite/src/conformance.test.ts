import {
  runBranchRegistryConformance,
  runDurableStateStoreConformance,
  runEventStoreConformance,
  runSnapshotStoreConformance,
  runTimerStoreConformance,
} from "@loom/conformance";
import { SqliteBranchRegistry } from "./SqliteBranchRegistry";
import { SqliteDurableStateStore } from "./SqliteDurableStateStore";
import { SqliteEventStore } from "./SqliteEventStore";
import { SqliteSnapshotStore } from "./SqliteSnapshotStore";
import { SqliteTimerStore } from "./SqliteTimerStore";

// Dogfood the published conformance kits against the real SQLite backend — the same
// suite a third-party store runs to prove it conforms (ADR 0033). Fresh :memory: DB per case.
runEventStoreConformance(() => new SqliteEventStore(":memory:"), "SqliteEventStore");
runSnapshotStoreConformance(() => new SqliteSnapshotStore(":memory:"), "SqliteSnapshotStore");
runBranchRegistryConformance(() => new SqliteBranchRegistry(":memory:"), "SqliteBranchRegistry");
runTimerStoreConformance(() => new SqliteTimerStore(":memory:"), "SqliteTimerStore");
runDurableStateStoreConformance(
  () => new SqliteDurableStateStore(":memory:"),
  "SqliteDurableStateStore"
);
