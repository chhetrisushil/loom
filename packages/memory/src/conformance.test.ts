import { runMemoryStoreConformance } from "@loom/conformance";
import { InMemoryMemoryStore } from "./InMemoryMemoryStore";

// The reference backend runs the same published kit the durable ones do — so the
// contract is defined by the suite, not by whichever store was written first. The
// in-memory store deliberately omits `replace` (it has no crash to lose a rewrite
// to), which also keeps MemoryRuntime's clear-then-append fallback under test.
runMemoryStoreConformance(() => new InMemoryMemoryStore(), "InMemoryMemoryStore");
