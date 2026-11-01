# ADR 0143 — `EncryptingContentStore`: a subject-aware ContentStore so claim-check works under `security.crypto`

- Status: **Accepted** (2026-11-01) — proposed 2026-10-31, implemented and merged; accepted by the owner
- Date: 2026-10-31
- Found by: GitHub issue #737 (follow-up of ADR 0140 D8, which refuses `execution.claimCheck` with
  `security.crypto` unless the store declares `sealsContent: true`, and shipped no such store). Owner rulings:
  auditability intact (nothing pruned except erasure, which is recorded); erasure must reach every copy
  (a crypto-shred is sufficient for sealed data); fail closed; opt-in; resume never slower; never silently wrong.
- Builds on: [ADR 0046](0046-content-store-seam-thin-authoritative-log.md) (content store), [ADR 0054](0054-claim-check-middleware.md)
  (claim-check), [ADR 0120](0120-llm-content-parts-and-tool-threading.md) (owner sets, dedupe across subjects),
  [ADR 0130](0130-sealed-payload-delivery-guard.md) (crypto), [ADR 0138](0138-compaction-archives-what-it-removes.md) /
  [0139](0139-reserved-streams-archive-before-removal.md) (archive, erasure over plaintext),
  [ADR 0140](0140-agent-claim-check-opt-in.md) (the opt-in and its erasure plan),
  [ADR 0083](0083-second-consumer-rule.md).
- Placement: **1P, `@loom/plugin-crypto` (the store) + `@loom/plugin-content` (the SPI) + `@loom/middleware`,
  `@loom/compliance`, `@loom/app` (threading and wiring).** Kernel, KERNEL_ABI, EVENT_SCHEMA unchanged.
  ContentStore SPI `1.4.0 -> 1.5.0` (additive, optional).

## Context

`ContentStore.put/get` carry no subject, and a plain content-hash address (`sha256(bytes)`) leaks plaintext
equality across subjects: two subjects' identical blob is ONE blob, so one subject's erasure either cannot
delete it (another still cites it, ADR 0120) or, if it did, would delete the other's. A sealing store needs
(1) the subject at `put`/`get`, and (2) an address that is not a function of the plaintext alone.

## Decisions

**D1 - the SPI carries the OWNING EXECUTION, not a resolved subject.** `put(bytes, access?)`,
`putStream?(stream, access?)`, `get(ref, access?)`, `getMany?(refs, access?)` take an optional
`ContentAccess { executionId, workflowId }` (SPI 1.5.0), plus an optional `readonly sealsContent?: boolean`
marker. It is the exact pair every `EncryptingEventStore`/`EncryptingSnapshotStore` `subjectOf` already takes,
so the sealing store maps owner to subject with the SAME mapping as the log (a custom `subjectOf` that needs
the workflow id keeps working) and no layer has to know crypto's subject. A plain store ignores the argument:
default behaviour is byte-identical (tested on memory, SQLite and the caching decorator via the conformance
kit). A sealing store REFUSES a call without it (`ContentAccessRequiredError`): it never seals under a guess
and never returns bytes it could not attribute to a subject.

**D2 - address scheme: ciphertext addressing with a synthetic IV (no new address format).** A blob is stored as
`[0x01][iv 12][tag 16][ciphertext]` under AES-256-GCM, with
`encKey = HMAC-SHA256(subjectKey, "loom/content/enc/v1")` and the IV a keyed hash of the SUBJECT AND the
PLAINTEXT (a synthetic IV over the associated data, SIV-style):
`iv = HMAC-SHA256(HMAC-SHA256(subjectKey, "loom/content/iv/v1"), version || len32(subject) || subject || plaintext)[0..12]`.
The subject is in the IV input because a KeyStore may serve ONE key to many subjects (D3): with an IV that
omitted it, the same plaintext under two subjects would reuse a (key, nonce) pair with different AAD, which
recovers the GHASH key and permits forgery. The ciphertext is therefore
DETERMINISTIC per (subject key, subject, plaintext), and the address is the inner store's own address of the stored
bytes (`sha256:<hex of the blob>`). Consequences: (a) within a subject identical plaintext is ONE blob (dedupe,
and a crash re-run reproduces the identical envelope - the ADR 0054 property); (b) across subjects the same
plaintext is two unrelated blobs at two unrelated addresses, so an address reveals no cross-subject equality
and one subject's erasure can never be defeated or blocked by another's identical blob; (c) the inner store,
`listPage`, touch times, `deleteIfUntouchedSince` and the content sweep work UNCHANGED on those addresses and
need no key (they are forwarded when the inner store has them). A synthetic IV repeats only for an identical
(subject, plaintext) under one key, which leaks only the equality this design already exposes within a subject. The
considered alternative (`address = HMAC(subjectKey, sha256(plaintext))`) needs the inner store to accept a
caller-chosen address, which the content-addressed SPI forbids.

**D3 - integrity binding.** AAD = `version byte || "loom/content/v1|" || subject` (the format version is
authenticated, not just read; reads accept only the one version, strictly), so a blob moved to another subject does not
open even under one key (tested with a key store that hands every subject the same key). The address cannot
also be in the AAD (it is the hash of the sealed bytes), so it is checked instead: `get` recomputes
`sha256(stored)` and refuses a mismatch BEFORE decrypting (an address scheme other than `sha256:` cannot be
verified and is refused outright, fail closed), which catches a blob swapped under an address or an
inner store that returns another blob. Any failure is `ContentUndecryptableError` (the key exists, the bytes do
not open): never plaintext, never garbage, and never `PayloadShreddedError` (a defect must not read as an
erasure).

**D4 - reading.** A read needs the subject's key via `KeyStore.get` (never `getOrCreate`). Absent blob: `null`
(the SPI never throws on absence, and needs no key). Present blob, key destroyed (`wasDestroyed`): the typed
`PayloadShreddedError` the kernel already classifies as erasure. Present blob, key absent but not proven
destroyed: `KeyUnavailableError` (this node lacks the key; not an erasure). A `put` for a destroyed subject is
refused as `PayloadShreddedError` (a key is never re-minted, ADR 0139 D22). The key is created by
`getOrCreate`, atomic create-if-absent.

**D5 - threading, and a citation is not ownership.** `claimCheckMiddleware` passes `{ executionId, workflowId }` of the running effect to every
`put`/`putStream`; `resolveClaimCheck`, `resolveClaimCheckBytes` and `resolveClaimChecks` take an optional
`access` and pass it to `get`/`getMany`. `exportSubject` resolves each execution's blobs with that execution's
ids and reports a blob whose subject key was destroyed as `missing` (it is erased), while a merely-unavailable
key stays loud. A log CITES addresses it never put (an input, a resume payload, an `awaitChild` result, a
carried envelope), so before an export opens, or an erasure deletes, a cited blob the sealing store PROVES
ownership: `ownedBy(ref, access)` authenticates the GCM tag under the subject's key and AAD (decrypt and
discard) and answers `true` only for a blob this subject sealed. A cited blob that does not prove is reported by
the export as `{ address, foreign: true }` (not the subject's data: not even its cited size) and is never
deleted by erasure (D7). `ownedBy` is `false` for an absent blob and for one that does not open (GCM cannot
tell another subject's blob from a corrupted one, so a damaged blob reads as foreign here and stays loud on
an ordinary `get` by its owner); it REJECTS when ownership cannot be decided (`PayloadShreddedError`, the key
is destroyed; `KeyUnavailableError`, the key is not on this node), so a failure never reads as "not mine".
Limit: the proof runs under the citing execution's access, so a cited blob is the subject's only if the
subject itself sealed it (a fork shares its parent's subject, so a blob the parent put is owned; a blob put by
another subject is not, however it came to be cited, and is not resolved cross-subject). No `ClaimCheckStore`/`ClaimCheckReader` structural type changed shape
beyond the optional argument, so every existing store and caller compiles and behaves as before.

**D6 - `defineConfig`: explicit, validated, not auto-wrapped.** `execution.claimCheck` stays opt-in. With
`security.crypto` it is accepted only for a store with `sealsContent: true`; the refusal message now names the
fix (`new EncryptingContentStore(inner, keys, { subjectOf })`). The store's `keys` and
`subjectOf` must be the SAME OBJECTS as `security.crypto.events`' (compared by identity, like the archive guard
of ADR 0138), and a pair that cannot be COMPARED (a wrapper or registry that hides `keys`/`subjectOf`) is
REFUSED, not waved through: an unverifiable pairing is not a verified one (each marker is looked up THROUGH decorators first, by the ADR 0138 `decoratedInnerOf`/`inner` walk
used for `tenantScope`, so a wrapper that merely does not forward them is still compared): a blob sealed under a different KeyStore or mapping is not reached by the log's shred, which would
be exactly the erasure theater D8 of ADR 0140 exists to prevent. Auto-wrapping the configured store was
rejected: it would silently change what the caller's own handle (the one given to `sweepUnpinnedContent`, the
resolvers) means, and `defineConfig` does not own the content store.

**D7 - erasure.** A sealing store is erased by the shred: every blob the subject put is unreadable the moment
its key is destroyed, with no plaintext copy anywhere. `eraseSubject` still RECORDS it: before the shred it
collects the refs the subject's executions cite (live log, archive, snapshot, the ADR 0140 collection), asks
the store to PROVE ownership of each (D5), and journals `ERASURE_CONTENT_DELETE_INTENDED { addresses (the
OWNED ones), retained, foreign, sealed: true }`; after the shred it deletes the now-unreadable ciphertext of
the owned blobs where the store has `delete()` and journals `ERASURE_CONTENT_DELETED { deleted, retained,
sealed, foreign }`; `EraseSubjectResult.contentDeleted` reports `{ deleted, retained, sealed, foreign }`.
A cited blob that does not prove (another subject's blob the log merely cites, or an absent one) is NEVER
deleted: it is counted in `retained` and `foreign`, so erasing bob cannot delete ann's blob, and the record says
so honestly. One whose proving key is ALREADY destroyed (a re-erasure after a direct `shredSubject`, or a
citation added after the intent) cannot be proved either way, so it is counted in `retained` and a distinct
`unprovable` (never `foreign`, never deleted): `{ deleted, retained, sealed, foreign, unprovable }` on the result
and on `ERASURE_CONTENT_DELETED`. The intent also names the foreign and unprovable addresses, so a retry after the
shred (when every proof now throws) neither reclassifies nor double counts them.

The ownership proof is tried under EVERY distinct citing execution of the subject (a bounded set, 16 per address),
not only the first: the compliance `subjectOf` (the SubjectIndex) and the crypto `subjectOf` may differ (crypto by
execution, compliance by user), so one data subject spans executions under distinct keys and a blob put by one may
be first cited by another. The address is owned if the proof holds under ANY of them, and then it is deleted and
counted `deleted`, not `foreign`. Aligning the two `subjectOf` functions is still recommended (`docs/compliance.md`). A sealing store without `ownedBy`, or a proof that cannot
be decided (the key is not on this node), REFUSES the erasure before anything is shredded. There is
no owner-set scan and no conditional delete: addresses are subject-scoped (D2), so no other subject's blob can
share one (ADR 0120 owner sets collapse to a single subject). A store without `delete()` still completes (the
ciphertext is unreadable; the content sweep reclaims it once the history is gone) and the record says
`deleted: 0, sealed: N`. A crash between the intent and the completion is finished by the retry from the
intent, as for plaintext.

**D8 - what is deliberately not supported.** (a) `putStream`: the synthetic IV needs the whole plaintext before
the first byte is sealed, so a stream would be buffered; the store omits the method and the claim-check
middleware fails with its existing named error for a stream result. (b) `CachingContentStore` above a sealing
store (it would serve plaintext from a warm cache without the subject check) and `ContentResolvingEventStore`
(ADR 0046 externalization resolves a read batch across executions and does not carry the owner) REFUSE a
sealing store at construction. Cache BELOW the sealing store (`new EncryptingContentStore(new
CachingContentStore(plain, ..), ..)` caches ciphertext). (c) A sealed blob moved to a different subject mapping
(`subjectOf` drift) is `ContentUndecryptableError`.

**D9 - sweep, archive, snapshot codec.** The sweep and `reclaimOrphans` act on inner addresses and never open a
blob (tested: a sweep through the sealing store keeps retained blobs and needs no key). Retained envelopes
(ADR 0140 D6) are unchanged: the envelope in the log, archive and snapshot cites the sealed address. The zstd
snapshot codec (ADR 0141) compresses state, not blobs; blobs are not compressed here, because ciphertext is
incompressible and compress-before-seal would open the CRIME/BREACH length leak ADR 0141 D3 gates behind an
acknowledgment; a caller that wants compressed blobs compresses before `put`.

## What it does not do

- It does not seal the Postgres/SQLite inner rows twice or add a store: it wraps any `ContentStore`. (Only the
  in-memory and SQLite content stores exist; both run the conformance kit unchanged.)
- It does not make the ADR 0120 media resolvers subject-aware on their own: a media `ContentResolver` that
  reads a sealing store must pass the owner, `{ executionId, workflowId }`, both of which the resolver context
  now carries (`ContentResolveContext.workflowId`, set from the effect context); the store fails closed
  without it. A hand-built context without `workflowId` cannot serve a workflow-keyed `subjectOf`.
- It hides neither the blob SIZE (ciphertext length = plaintext + 29 bytes) nor within-subject equality.
  Deterministic encryption also lets anyone who can read the store and run `put` as the subject CONFIRM a
  guessed plaintext within that subject (put the guess, compare addresses): a tool whose output an attacker
  can choose (an echo of attacker-chosen input) exposes that equality to the attacker. Equality is never
  visible across subjects (D2).
- It does not resolve a blob across subjects: an execution that cites another subject's address (an
  `awaitChild` result, a resume payload) sees it as foreign (D5); forks share the parent's subject, so the
  parent's blobs resolve.

## Consequences

ContentStore SPI `1.5.0` (additive; `CONTENT_STORE_SPI_VERSION`, compatibility matrix). The conformance kit
gains an owner-argument case and an `access` option that runs the whole suite per subject. `@loom/plugin-crypto`
gains a dependency on `@loom/plugin-content` (types only).
