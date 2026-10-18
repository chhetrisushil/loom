import {
  runBranchRegistryConformance,
  runContentStoreConformance,
  runDurableStateStoreConformance,
  runEventStoreConformance,
  runFoldedStateConformance,
  runLeaseStoreConformance,
  runMemoryStoreConformance,
  runReadModelStoreConformance,
  runSnapshotStoreConformance,
  runTimerStoreConformance,
} from "@loom/conformance";
import { describe, expect, it } from "vitest";
import { SqliteBranchRegistry } from "./SqliteBranchRegistry";
import { SqliteContentStore } from "./SqliteContentStore";
import { SqliteDurableStateStore } from "./SqliteDurableStateStore";
import { SqliteEventStore } from "./SqliteEventStore";
import { SqliteLeaseStore } from "./SqliteLeaseStore";
import { SqliteMemoryStore } from "./SqliteMemoryStore";
import { SqliteReadModelStore } from "./SqliteReadModelStore";
import { SqliteSnapshotStore } from "./SqliteSnapshotStore";
import { SqliteTimerStore } from "./SqliteTimerStore";

// Dogfood the published conformance kits against the real SQLite backend — the same
// suite a third-party store runs to prove it conforms (ADR 0033). Fresh :memory: DB per case.
runEventStoreConformance(() => new SqliteEventStore(":memory:"), "SqliteEventStore");
runSnapshotStoreConformance(() => new SqliteSnapshotStore(":memory:"), "SqliteSnapshotStore");
runLeaseStoreConformance(() => new SqliteLeaseStore(":memory:"), "SqliteLeaseStore");
runBranchRegistryConformance(() => new SqliteBranchRegistry(":memory:"), "SqliteBranchRegistry");
runTimerStoreConformance(() => new SqliteTimerStore(":memory:"), "SqliteTimerStore");
runDurableStateStoreConformance(
  () => new SqliteDurableStateStore(":memory:"),
  "SqliteDurableStateStore"
);

runReadModelStoreConformance(() => new SqliteReadModelStore(":memory:"), "SqliteReadModelStore");
runFoldedStateConformance(() => new SqliteReadModelStore(":memory:"), "SqliteReadModelStore");
describe("SqliteReadModelStore folded", () => {
  it("implements the folded methods", async () => {
    const s = new SqliteReadModelStore(":memory:");
    expect(typeof s.applyFolded).toBe("function");
    await s.close();
  });
});
runContentStoreConformance(() => new SqliteContentStore(":memory:"), "SqliteContentStore", {
  clocked: (now) => new SqliteContentStore(":memory:", { now }),
});
runMemoryStoreConformance(() => new SqliteMemoryStore(":memory:"), "SqliteMemoryStore");
