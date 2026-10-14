import { runSnapshotStoreConformance } from "@loom/conformance";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { EncryptingSnapshotStore } from "./EncryptingSnapshotStore";
import { InMemoryKeyStore } from "./keystore";

// The published SnapshotStore contract, run against the decorator in BOTH modes.
runSnapshotStoreConformance(
  () =>
    new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), new InMemoryKeyStore(), {
      sensitive: ["variables._input.ssn"],
    }),
  "EncryptingSnapshotStore (static paths)"
);
runSnapshotStoreConformance(
  () =>
    new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), new InMemoryKeyStore(), {
      sealState: true,
    }),
  "EncryptingSnapshotStore (sealState)"
);
