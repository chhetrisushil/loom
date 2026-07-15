import { runDurableStateStoreConformance } from "@loom/conformance";
import { InMemoryDurableStateStore } from "./InMemoryDurableStateStore";

// Dogfood the published conformance kit against the reference backend — the same
// suite the SQLite/Postgres (and any 3P) backends run to prove they conform.
runDurableStateStoreConformance(() => new InMemoryDurableStateStore(), "InMemoryDurableStateStore");
