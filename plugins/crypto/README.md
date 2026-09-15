# @loom/plugin-crypto

**K10.2 — crypto-shredding.** Field-level payload encryption wrappers over any
`EventStore`/`SnapshotStore`, so an append-only log can satisfy GDPR erasure by
**destroying a key** instead of rewriting history.

## The idea

Sensitive fields are encrypted at rest under a **per-subject key**; erasing a
subject destroys its key, making every field encrypted under it permanently
unrecoverable — in the **event log and the snapshots** alike. A durable
`PAYLOAD_SHREDDED` tombstone records the erasure, and any later decrypting read
fails **loudly** (`PayloadShreddedError`) rather than silently folding
ciphertext.

```ts
import {
  EncryptingEventStore, EncryptingSnapshotStore, InMemoryKeyStore, shredSubject,
} from "@loom/plugin-crypto";

const keys = new InMemoryKeyStore(); // back with a KMS in production
const eventStore = new EncryptingEventStore(innerEvents, keys, {
  sensitive: { STEP_COMPLETED: ["output.ssn", "output.email"] }, // dot-paths into the payload
});
const snapshotStore = new EncryptingSnapshotStore(innerSnaps, keys, {
  sensitive: ["variables._input.ssn"], // same fields as they appear in folded state
});

// …later, an erasure request:
await shredSubject(keys, innerEvents, executionId, { reason: "gdpr-erasure" });
// key destroyed; PAYLOAD_SHREDDED tombstoned; reads of the sensitive fields now throw.
```

## Guarantees (and non-guarantees)

- **A4 — field-level, opt-in.** Only marked paths are encrypted; unmarked
  payloads (and stores with no `sensitive` config) are byte-identical
  pass-throughs (G2).
- **A1 — snapshots are covered.** Snapshots fold plaintext, so encrypting only
  the event log would leave the secret in the snapshot — erasure theater. The
  snapshot wrapper encrypts the same fields under the same subject key.
- **A2 — fork lineage.** `copyPrefix` copies *ciphertext* verbatim, so a fork
  must resolve to the parent's **subject** (`subjectOf`) to read the copied
  prefix; shredding that subject then erases the parent and all its forks
  together (they hold the same personal data). Choose per-execution keys
  (default) when forks should be independent, or a shared subject when they
  should erase together.
- **A3 — tombstone at shred time.** `PAYLOAD_SHREDDED` is appended by
  `shredSubject`, never at replay time, so replay stays a pure read and
  deterministically *encounters* the erasure.
- **Real encryption** — AES-256-GCM with a per-value random IV and an auth tag;
  a wrong key fails, not silently mis-decrypts.

The `KeyStore` is the security boundary: destroying a key must be true deletion,
so back it with a KMS/HSM. `InMemoryKeyStore` is for tests and ephemeral apps, and it
declares `durable = false` so `loom doctor` **fails** rather than letting the combination
ship: an encrypting store with non-durable keys writes a log whose contents are unreadable
from the next boot, and nothing fails at the time it happens.

Implementing your own? Declare `durable` either way. Omitting it is reported as an advisory —
*this store does not say* — which is different from saying no.
