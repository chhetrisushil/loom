import { runArchiveStoreConformance } from "@loom/conformance";
import { InMemoryArchiveStore } from "@loom/event-runtime";
import { EncryptingArchiveStore } from "./EncryptingArchiveStore";
import { InMemoryKeyStore } from "./keystore";

// The published ArchiveStore contract (ADR 0138), run against the sealing decorator.
runArchiveStoreConformance(
  () => new EncryptingArchiveStore(new InMemoryArchiveStore(), new InMemoryKeyStore()),
  "EncryptingArchiveStore"
);
