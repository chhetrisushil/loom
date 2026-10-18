import { runFoldedStateConformance, runReadModelStoreConformance } from "@loom/conformance";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";

// Dogfood the published conformance kit against the reference backend — the same
// suite the SQLite/Postgres (and any 3P) backends run to prove they conform.
runReadModelStoreConformance(() => new InMemoryReadModelStore(), "InMemoryReadModelStore");
runFoldedStateConformance(() => new InMemoryReadModelStore(), "InMemoryReadModelStore");
