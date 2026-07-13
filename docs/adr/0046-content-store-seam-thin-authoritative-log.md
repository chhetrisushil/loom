# ADR 0046 — Content-store seam: a thin, PII-light authoritative log

- Status: **Accepted (design/SPI only); implementation deferred — gated on a concrete use case**
- Date: 2026-07-13
- Builds on: [ADR 0022 (K10 log lifecycle / retention / redaction / encryption)](0022-k10-log-lifecycle-retention-redaction-encryption.md),
  the `@loom/classify` taxonomy (K10-R1), `@loom/compliance` subject rights (T3),
  `secretRef`/`SecretResolver` (K10-R2/R3), `ctx.decide` / `DECISION_RECORDED` (Loom 2.0).
- Part of: the "how do we log for durability/replay without the log becoming a PII system?"
  question. Additive/opt-in (G2). Not legal advice.

## Context

Event-sourcing's durability and replay come from one property: **the log is the authoritative
record and the fold is a pure function of it.** The naïve consequence is that every raw
input/output a step touched is *load-bearing for determinism* — replay re-folds over it, so it
must persist verbatim, forever. That single coupling is what turns "durable + replayable" into
"stores PII and customer content forever," which is a security liability and, for many
prospective adopters, a hard blocker.

K10 already breaks most of this coupling **cryptographically and by reference**:

- **`secretRef`** (K10-R2/R3) — the value never lands; the log holds a resolver-backed
  reference, resolved only at live effect time (never on replay).
- **Crypto-shredding** (K10.2) — data that must be in the log is encrypted per-subject;
  erasure destroys the key; a post-erasure read fails *loudly* (`PAYLOAD_SHREDDED`, G1).
- **`ctx.decide` / recorded outcomes** — when later logic branches on a value, the *decision*
  is the durable fact, so the raw value becomes a shreddable leaf the fold never re-reads.
- **Retention/compaction** (K10.1/K10.4) — bounds how long raw events persist.

So for **small-field PII the coupling is already solved**: mark the field, it is encrypted +
erasable, and if the fold depends on it, record the decision instead. What K10 does *not* give
is a way for the authoritative log to have **never physically contained** the bytes — the
ciphertext still lives in the log, and erasability rests on "the key is truly gone *and* the
cipher is not broken later." A distinct quadrant of data wants physical, not cryptographic,
separation.

## Decision

Define — but **do not yet build** — a **`ContentStore` SPI** and a content-addressed
**`ContentRef`**, so a payload (or a marked field within one) can be *externalized*: the
authoritative event log stores a hash reference, and the bytes live in a separate, erasable,
non-authoritative store. This is a **complement** to crypto-shredding for the large /
physically-separated quadrant, not a replacement for it.

### The seam (mechanism — kernel/SPI tier)

```ts
/** A content-addressed reference: a PURE function of the bytes (determinism + natural dedup). */
export interface ContentRef {
  readonly __loomContent: string; // e.g. "sha256:<hex>" — the content address
  readonly size?: number;
  readonly codec?: string;        // how the bytes decode back (e.g. "json")
}

export interface ContentStore {
  /** Idempotent by hash: putting identical bytes twice yields the same ref, stored once. */
  put(bytes: Uint8Array): Promise<ContentRef>;
  /** Resolve a ref to its bytes, or null if erased/absent (never throws on absence). */
  get(ref: ContentRef): Promise<Uint8Array | null>;
  /** Physical erasure of the bytes. Idempotent. Referential integrity is the lifecycle's job. */
  delete(ref: ContentRef): Promise<void>;
}
```

Three properties make this safe against the four invariants:

1. **Content-addressing is what preserves determinism.** The ref is `hash(bytes)`, a pure
   function of the content — so producing the ref is deterministic, replay reproduces the same
   ref, and forks that copy a prefix naturally share the same blob (dedup, and the basis for
   refcounted erasure).
2. **Resolution is a store decorator**, mirroring `EncryptingEventStore` exactly: a
   `ContentResolvingEventStore` swaps `ContentRef`s back to values on read/fold, so *nothing
   above the store layer changes* — the fold, resume, and every consumer see plain values.
3. **Absence is loud, never silent.** A fold that needs an erased/missing blob raises a
   `ContentMissingError` (the K10.2 `PAYLOAD_SHREDDED` contract, generalized) — replay of
   erased data fails explicitly; it never diverges.

### Externalization is opt-in and policy-driven (above the kernel)

*Which* fields externalize is policy, so it rides the `@loom/classify` seam — either a new
`externalized()` marker (orthogonal to `secret`/`sensitive`/`internal` — it names *where* a
value is stored, not its sensitivity) or a store-level rule ("externalize any `sensitive`
field over N bytes"). The kernel supplies the ref-resolution mechanism; the app declares the
policy (G3).

### Backends are plugins

`ContentStore` implementations — filesystem, S3/object-store, an encrypted blob store, an
in-region residency store — ship as plugins (`@loom/plugin-content-*`, 1P/3P), exactly like
storage presets (ADR 0043). `@loom/app` names no vendor.

## The four invariants — explicit analysis

| Invariant | Preserved by | Failure mode |
|---|---|---|
| **Determinism** | Content-addressing: the ref is `hash(bytes)`, a pure function; the resolving decorator restores plain values before the fold. | None while the blob lives. A *changed* blob would change its hash → a different ref → detected, not silently folded. |
| **Durability** | The log durably holds the ref + structure + recorded decisions; the content store durably holds the bytes until erasure. | Two stores now have a referential contract (see Risks). |
| **Resumability** | The resolving decorator restores values on read, so resume reconstructs identical state — as today. | A resume needing an erased blob fails loudly (correct: you erased it). |
| **Replayability** | Byte-identical for key-live / non-erased executions. | Replay of *erased* content fails loudly (`ContentMissingError`) — this is erasure working, not a bug. Shrink the blast radius by recording decisions (`ctx.decide`) so the fold rarely needs the raw bytes. |

The honest, irreducible limit is unchanged from K10: **you cannot byte-replay data you
destroyed** — and that is the point. The content-store seam does not weaken any invariant over
the facts; it only moves the *raw bytes* out of the authoritative path, and makes their absence
a loud, deterministic failure rather than a silent one.

## Why it is worth defining — and when it is worth *building*

Build it **only** where crypto-shredding is genuinely insufficient:

- ✅ **Large payloads** (documents, images, model outputs) that bloat the log, every snapshot,
  and every replica — a thin log replays and replicates far faster.
- ✅ **Data residency** — PII blobs pinned in-region while the log (refs + decisions only)
  replicates globally.
- ✅ **"The audit/authoritative log must not be a PII system"** — a physical-separation
  compliance posture some regulators/customers require, which encryption-in-log cannot claim.
- ✅ **Defense-in-depth** — destroyed *bytes* are unconditionally unrecoverable; crypto-shredding
  is only as strong as "the key is truly gone *and* the cipher is not broken later."

It is **overkill** — and crypto-shredding + `ctx.decide` remain the recommended default — for:

- ❌ **Small-field PII** (ssn, email): one store, no dangling-ref/refcount/transactionality
  problem. Crypto-shredding is simpler and strictly less machinery.
- ❌ **Data the fold branches on**: the content store does not help if the fold still needs the
  value — the answer there is `ctx.decide` (record the outcome), not externalization.

## Consequences and risks

- **Referential integrity is a new failure class.** A ref with no blob (partial write, premature
  GC, mis-tiered) is a dangling pointer. Mitigations: content-addressing makes writes idempotent
  and retryable; append the event only after the blob is durable (or make the pair transactional
  where the backend allows); a fold that hits a missing blob fails loudly.
- **Refcounted erasure.** Forks share prefixes → shared content refs. Erasing/reclaiming a blob
  must be refcount-aware (the K10-R5 branch-integrity guard already establishes this discipline
  for executions; the content store extends it to blobs). Content-addressing gives the refcount
  key for free.
- **Two stores to operate.** More moving parts, backup/restore coordination, consistency
  windows. This is the primary reason implementation is **deferred**, not built speculatively.
- **Overlap with `secretRef`.** `secretRef` = resolver-backed, never-persisted, live-only
  (secrets). `ContentRef` = content-addressed, persisted-in-side-store, resolvable on replay,
  erasable (large/PII content). They are cousins; a future refactor may unify them behind one
  "reference resolution" seam, but not before a second concrete consumer exists.

## Alternatives considered

- **Crypto-shredding alone (status quo).** Sufficient for small-field PII; does not deliver
  physical separation, residency, or thin-log/large-payload benefits. Kept as the default; the
  content store is additive on top.
- **Inline compression / external "blob" fields with no addressing.** Loses determinism (no
  integrity check), loses dedup, and reintroduces the dangling-ref problem without the
  idempotency content-addressing buys. Rejected.
- **A kernel-mandated content store (always on).** Violates G2/G3 — most apps do not need two
  stores; forcing referential-integrity machinery on everyone is a tax. Rejected in favour of
  an opt-in SPI + policy marker.

## Status of this decision

**Design accepted; implementation deferred.** This ADR fixes the *shape* — content-addressed
`ContentRef`, a `ContentStore` SPI resolved by a store decorator, loud-on-absence, policy above
the kernel, backends as plugins — so the door is open and consistent with the existing store
SPIs. It is **not built** now: the two-store referential-integrity + refcounting + transactional
cost is real, and the project builds on concrete requirements rather than speculative infra (cf.
K10-R4.2, deferred "until a use case appears"). It is promoted to implementation when a
large-payload, data-residency, or physical-PII-separation requirement actually lands. Until
then, mark fields `sensitive()`/`secret()` and record decisions with `ctx.decide` — that already
keeps raw PII out of the deterministic path for the common case.
