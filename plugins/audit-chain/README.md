# @loom/plugin-audit-chain — tamper-evident hash-chained event log

A composable `EventStore` wrapper that makes Loom's durable log **cryptographically verifiable**.
Each event carries, in its metadata, `H(prevHash ‖ canonical(event))` and (optionally) an
`HMAC-SHA256` signature — so any later edit, insert, reorder, or drop is detectable out-of-band.

> The chain lives entirely in `metadata`, which the ReplayVM fold ignores — replay is **byte-identical**
> whether or not chaining is wired (G1/G2). See [ADR 0037](../../docs/adr/0037-tamper-evident-audit-chain.md).

```ts
import { hashChainedEventStore } from "@loom/plugin-audit-chain";

// Compose below tenant-scoping, above the base store:
const store = hashChainedEventStore(tenantScopedEventStore(fencingStore(base)), {
  hmacSecret: process.env.AUDIT_SECRET, // optional: also HMAC-sign each hash
});

// … the runtime writes through `store` normally …

const v = await store.verifyChain(executionId);
if (!v.ok) console.error(`log tampered at seq ${v.brokenAt}: ${v.reason}`);
```

## What it detects

- **Edit** — a changed payload/metadata → `hash` no longer recomputes (`reason: "…tampered"`).
- **Drop / reorder** — a broken `prevHash` link (`reason: "…dropped or reordered"`).
- **Forgery** (with `hmacSecret`) — an attacker who re-chains hashes still cannot produce a valid
  signature (`reason: "signature invalid…"`).

## Guarantees & limits

- **Fold-invisible / opt-in** — off the execution path; the wrapper only adds metadata.
- **Cold-start safe** — a fresh wrapper instance continues the chain by reading the durable tail.
- **Canonicalization** — `canonicalize` sorts keys recursively and omits `undefined`, so a tamper
  can't reorder keys to preserve a hash.
- **Ordering vs content externalization (load-bearing)** — wrap the chain *outside*
  `ContentResolvingEventStore`:
  `hashChainedEventStore(new ContentResolvingEventStore(raw, content, { externalize }))`. Then
  the chain covers the full payload and `verifyChain` re-reads it resolved, so rewriting an
  externalized blob is detected. Inverted, the chain hashes only the content *ref* — the bytes
  are outside everything it signed, and tampering passes silently. Both orderings compile and
  behave identically otherwise, so `contentOrdering.test.ts` pins the difference. (This is also
  why `ContentStore` has no verify-on-read obligation: the correct ordering gives blob
  integrity for one hash per write instead of one per read, across the whole log rather than
  just externalized fields.)
- **Truncation tension (honest)** — `verifyChain` assumes an un-truncated log. K10 compaction
  (`truncatePrefix`) deletes prefix events and breaks the chain at the new head; verify (and archive)
  the full chain *before* truncating.
