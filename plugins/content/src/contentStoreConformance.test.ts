import { runContentStoreConformance } from "@loom/conformance";
import { CachingContentStore } from "./CachingContentStore";
import { InMemoryContentStore } from "./ContentStore";

// The reference ContentStore must uphold the ADR-0046 contract every backing (S3/FS/KMS) owes.
runContentStoreConformance(() => new InMemoryContentStore(), "InMemoryContentStore");

// ADR 0062 — a caching decorator is still a conformant store (incl. delete-evicts-first).
runContentStoreConformance(
  () => new CachingContentStore(new InMemoryContentStore(), { maxBytes: 1024 * 1024 }),
  "CachingContentStore(InMemory)"
);
