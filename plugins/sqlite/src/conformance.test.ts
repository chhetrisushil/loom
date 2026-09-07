import {
  runBranchRegistryConformance,
  runContentStoreConformance,
  runDurableStateStoreConformance,
  runEventStoreConformance,
  runMemoryStoreConformance,
  runReadModelStoreConformance,
  runSnapshotStoreConformance,
  runTimerStoreConformance,
} from "@loom/conformance";
import { SqliteBranchRegistry } from "./SqliteBranchRegistry";
import { SqliteContentStore } from "./SqliteContentStore";
import { SqliteDurableStateStore } from "./SqliteDurableStateStore";
import { SqliteEventStore } from "./SqliteEventStore";
import { SqliteMemoryStore } from "./SqliteMemoryStore";
import { SqliteReadModelStore } from "./SqliteReadModelStore";
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

runReadModelStoreConformance(() => new SqliteReadModelStore(":memory:"), "SqliteReadModelStore");
runContentStoreConformance(() => new SqliteContentStore(":memory:"), "SqliteContentStore");
runMemoryStoreConformance(() => new SqliteMemoryStore(":memory:"), "SqliteMemoryStore");
