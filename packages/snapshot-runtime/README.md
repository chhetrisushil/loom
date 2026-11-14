# @loomwork/snapshot-runtime — the SnapshotStore contract and its reference stores

A snapshot is a saved fold of an execution's state, so a resume reads one snapshot plus a short log
tail instead of the whole log. This package defines the `SnapshotStore` interface (the SPI), an
in-memory reference store, a tenant-scoping wrapper, a size-profiling wrapper and the snapshot codec.
Apps rarely import it directly: `defineConfig` builds an in-memory store for `storage: { kind: "memory" }`,
and `sqliteStorage({ dir })` and `postgresStorage({ url })` bring their own durable stores. Import it to
write a store, wrap one, or read snapshot sizes.

```ts
import { InMemoryAsyncSnapshotStore, ProfilingSnapshotStore } from "@loomwork/snapshot-runtime";

const store = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore({ codec: "zstd" }), {
  largeThresholdBytes: 512 * 1024,
  onLargeSnapshot: (executionId, bytes) => console.warn(`${executionId}: ${bytes} bytes`),
});

// ... pass `store` as the snapshotStore of a `{ kind: "custom", ... }` storage ...

console.log(store.profile().largest); // top executions by latest snapshot size
```

## Surface

- **Contract.** `SnapshotStore` (`save`, `loadLatest`, `loadAt`, `loadLatestBefore`, `close`), with
  optional `deleteExecution`, `loadLatestSealed`, `pruneSnapshots` and `listSequences`.
  `SNAPSHOT_STORE_SPI_VERSION` is `1.3.0`. A third-party store proves itself with
  `runSnapshotStoreConformance` from `@loomwork/conformance`.
- **Stores and wrappers.** `InMemoryAsyncSnapshotStore` (also importable from
  `@loomwork/snapshot-runtime/memory`), `TenantScopedSnapshotStore(inner, tenant)` and
  `ProfilingSnapshotStore(inner, options)`.
- **Codec.** `encodeState` and `decodeState` frame the state as JSON, optionally zstd-compressed
  (ADR 0141). `zstdAvailable()` says whether this Node can write zstd; asking for it on one that cannot
  throws at construction. In `defineConfig` the setting is `durability.snapshots.codec`.
- **Identity.** `assertSnapshotIdentity` and `SnapshotIdentityMismatchError` refuse a snapshot that
  names a different execution or workflow than the one it was loaded for.

## Behaviour that surprises people

- **A snapshot is a cache over the log.** The codec must decode to the identical state, and the default
  is no compression. `pruneSnapshots` applies the range and keep-set you give it literally, with both
  bounds exclusive; the caller decides what is safe to delete (ADR 0134).
- **Tenant isolation is a key prefix.** `TenantScopedSnapshotStore` rejects an empty tenant or one
  containing `:`, because prefix scoping is only isolation if no tenant's prefix is another's.
- **`ProfilingSnapshotStore` measures and never changes a save.** A measurement failure or a throwing
  `onLargeSnapshot` hook does not fail the save. A synchronous hook still runs on the save path.
  Outside an encrypting store it measures plaintext, around the raw store it measures ciphertext.
- **Sizes are the UTF-8 length of `JSON.stringify(state)` by default**, bucketed in powers of two. The
  `measure: "stored"` option measures the codec frame instead, and is refused over a store that seals the
  whole state, because its stored size would reveal the compressed length of the plaintext (ADR 0141).

## Status / See also

`npm install @loomwork/snapshot-runtime` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

- [ADR 0033](../../docs/adr/0033-spi-conformance-contracts.md): SPI conformance contracts.
- [ADR 0134](../../docs/adr/0134-snapshot-pruning.md): pruning, and
  [ADR 0141](../../docs/adr/0141-snapshot-zstd-codec.md): the zstd codec.
- API reference: section "`@loomwork/snapshot-runtime` — bounded-tail replay" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
