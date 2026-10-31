import { runArchiveStoreDecoratorConformance } from "@loom/conformance";
import { EncryptingArchiveStore } from "./EncryptingArchiveStore";
import { InMemoryKeyStore } from "./keystore";

// The published ArchiveStore contract (ADR 0138), run against the sealing decorator.
runArchiveStoreDecoratorConformance(
  "EncryptingArchiveStore",
  (inner) => new EncryptingArchiveStore(inner, new InMemoryKeyStore())
);
