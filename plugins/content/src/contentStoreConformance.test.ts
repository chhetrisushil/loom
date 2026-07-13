import { runContentStoreConformance } from "@loom/conformance";
import { InMemoryContentStore } from "./ContentStore";

// The reference ContentStore must uphold the ADR-0046 contract every backing (S3/FS/KMS) owes.
runContentStoreConformance(() => new InMemoryContentStore(), "InMemoryContentStore");
