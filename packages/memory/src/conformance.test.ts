import { runMemoryStoreConformance } from "@loom/conformance";
import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "./InMemoryMemoryStore";
import { MEMORY_STORE_SPI_VERSION } from "./types";

// The reference backend runs the same published kit the durable ones do — so the
// contract is defined by the suite, not by whichever store was written first. The
// in-memory store deliberately omits `replace` (it has no crash to lose a rewrite
// to), which also keeps MemoryRuntime's clear-then-append fallback under test.
runMemoryStoreConformance(() => new InMemoryMemoryStore(), "InMemoryMemoryStore");

describe("MemoryStore SPI version", () => {
  it("is semver and exported for a backend to pin against", () => {
    // The seam's implementations now include one in another repository, which is what
    // makes an unversioned contract a hazard rather than a formality: a breaking change
    // would otherwise reach a backend nothing in this workspace builds or tests.
    expect(MEMORY_STORE_SPI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
