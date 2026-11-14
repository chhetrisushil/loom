import { runSnapshotStoreConformance } from "@loomwork/conformance";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
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
