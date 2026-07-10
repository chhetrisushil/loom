# ADR 0037 — Tamper-Evident Audit Chain (`@loom/audit-chain`)

- Status: Accepted (2026-07-11)
- Date: 2026-07-11
- Builds on: the `EventStore` SPI + composable store wrappers (`TenantScopedEventStore`, fencing —
  [ADR 0033](0033-spi-conformance-contracts.md)), the K2/K12 durable audit facts, and the HMAC-SHA256
  helper already used for signed delegation (`@loom/effect-runtime` `authz.ts`).
- Part of: the three-direction kernel arc, multi-tenant isolation (Direction C), Phase 1.

## Context

Loom's event log is append-only (a `UNIQUE(execution_id, sequence)` constraint on Postgres), and the
kernel records rich durable audit facts (`EFFECT_DENIED`, `RESOURCE_METERED`, `QUOTA_EXCEEDED`,
`APPROVAL_GRANTED`, `EGRESS_DENIED`). But nothing made the log **cryptographically** tamper-evident:
an actor with write access to the store could edit, insert, reorder, or drop an event post-hoc and
leave no trace. For a hostile-multi-tenant or compliance setting that is a real gap.

## Decision

Add **`@loom/audit-chain`**, a composable `EventStore` wrapper. On each append it stamps, in the
event's `metadata.auditChain`:

- `prevHash` — the previous event's hash for that execution (genesis = `""`);
- `hash` — `SHA-256(prevHash ‖ canonical(event-without-chain))`;
- `sig` — OPTIONAL `HMAC-SHA256(secret, hash)` when an `hmacSecret` is configured.

`verifyChain(executionId)` recomputes the whole chain out-of-band and reports the first break
(`brokenAt` + a specific `reason`). Any edit changes a `hash`; any drop/reorder breaks a `prevHash`
link; and with a secret, an attacker who re-chains the hashes still cannot forge the HMAC.

**Canonicalization is explicit** — `canonicalize` sorts object keys recursively and omits
`undefined`, so structurally-equal events always serialize identically. This closes the
canonicalization ambiguity that would otherwise let a tamper reorder keys to preserve a hash.

**Fold-invisible by construction.** The chain lives ENTIRELY in `metadata`, which the ReplayVM fold
ignores. So replay is **byte-identical** whether or not chaining is wired (G1/G2), and the wrapper
composes cleanly below tenant-scoping and above the base store:
`hashChainedEventStore(tenantScopedEventStore(fencingStore(base)))`. The chain head is advanced only
after a durable append succeeds, so a rejected append (e.g. a stale fence) never poisons the next
event's `prevHash`.

## Consequences

- The durable log becomes independently verifiable; a compliance/forensics tool can prove a log was
  not altered (and, with a secret, that only the secret-holder could have written it).
- **No ABI/event-schema change; no core change.** It is a pure store wrapper (P10). Opt-in and
  fold-invisible (G2). Crypto reuses the existing `node:crypto` HMAC pattern with a timing-safe
  comparison.
- Honest limitation: hash-chain verification assumes an **un-truncated** log. K10 compaction /
  retention (`truncatePrefix`, `deleteExecution`) deletes prefix events, which breaks a naive
  `verifyChain` at the new head. Tamper-evidence and compaction are in tension; an archive step
  should verify the full chain BEFORE truncating and retain the removed segment (or an anchor hash)
  out of band. `truncatePrefix`/`deleteExecution` are forwarded unchanged; verification over a
  truncated log correctly reports a break rather than silently passing.

## Verification

- `@loom/audit-chain` tests (11): genesis-rooted chain verifies; a tampered payload is caught at the
  right sequence; a dropped event breaks `prevHash`; with a secret, a re-chained forgery fails on the
  signature; the chain continues across a cold start (recovery reads the durable tail); the
  payload/sequence/eventType stream is unchanged versus an unchained store (fold-invisible), only
  metadata grows; optional store capabilities are forwarded.
- A **DST integrity property** (`@loom/dst`): compose `runtime → faultInjectingStore → hash chain →
  base`, crash at seed-chosen points, recover, and assert `verifyChain` holds across the whole
  crash-schedule space (crashes really fire; the surviving log is always an intact, signed chain — no
  fork, gap, or forgery).
- `@loom/spec` registers the `audit-chain` capability at L2.
