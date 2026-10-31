# ADR 0054 — Claim-check middleware: the reference is the recorded value

- Status: **Accepted — shipped** (`claimCheckMiddleware` in `@loom/middleware` + `EffectContext.toolId`)
- Date: 2026-07-15
- Builds on: [ADR 0051 D3 (perpetual-agents placement)](0051-perpetual-agents-placement-schedule-remodel.md),
  the [requirements rewrite](../requirements/2026-07-15-perpetual-agents-sentinel-workloads.md) §3.2 (CC-1..4),
  ADR 0006 (effect middleware seam), ADR 0046 (`ContentStore`/`ContentRef`), ADR 0022 (K10).
- Part of: the perpetual-agents series (W2, issue #166). Additive/opt-in (G2); no new event
  kinds; EVENT_SCHEMA and KERNEL_ABI untouched.

## Context

Sentinel telemetry reads return large, high-frequency, individually low-value payloads.
Recording them inline conflates what the agent *saw* with what it *concluded*, bloats the log
and every snapshot, and makes replay meaningless (re-folding a million stat rows verifies
nothing). The requirements split the two: the log keeps a compact orchestration record; bulk
effect data lives in the content store, cited by hash.

## Decision

### D1 — `claimCheckMiddleware` (CC-1): offload over-cap results, record `{ ref, size, digest }`

On the ADR 0006 seam: when an effect result's JSON encoding exceeds `inlineCapBytes`
(default 16 KiB), the payload is stored via the content store's `put` (content-addressed,
idempotent by hash) and the middleware returns a `ClaimCheckEnvelope`
(`{ __loomClaimCheck: true, ref, size, digest? }`) — which is what `STEP_COMPLETED` records.
Replay correctness is automatic: middleware runs only when the effect executes (completed
steps short-circuit upstream), so the envelope is the durable value and crash-recovery re-runs
reproduce an identical envelope (same bytes → same hash). Under-cap results pass through
untouched, as do results JSON cannot encode; an envelope returned by the effect itself is
never double-wrapped.

**Deliberately NOT ADR 0046 externalization** — the two contracts on the same store:

| | 0046 externalization | claim-check (this ADR) |
|---|---|---|
| Log records | value logically inline, physically external | the ref + digest **as the value** |
| Fold/replay | `ContentResolvingEventStore` resolves; blob is load-bearing | never resolves; replay touches no content store |
| Blob erasure | loud `ContentMissingError` on fold | invisible to replay (`resolveClaimCheck` → `null` outside the boundary) |
| For | PII/residency — log must never have contained the bytes | telemetry — replaying raw payloads verifies nothing |

### D2 — Digests are per-tool declarations (CC-2)

`digests: { [toolId]: (result) => projection }` — the digest is the tool's **deterministic
projection** of its result: the one inline part of an offloaded payload orchestration may
branch on. It MUST be pure. Tools without a digest record `{ ref, size }` only. Branching on
content reached *through* the ref is the anti-pattern CC-5's lint (W6, `tools/*`) flags.

### D3 — `EffectContext.toolId`: the one kernel touch

Middleware previously could not see which effect they wrapped — per-tool digest declarations
had no key. `EffectRuntime.execute` now passes the middleware chain a context view carrying
the resolved `toolId` (optional field, additive): the effect itself still receives the
caller's context object unchanged, hand-built contexts leave it unset, and a pre-populated
value is honored. Zero behavior change when unused (G2); useful to any per-tool middleware.

### D4 — Structural store types; observability; read-side helper

`ClaimCheckStore`/`ClaimCheckReader` are structural views of the ADR 0046 `put`/`get`
contract, so `@loom/middleware` (kernel tier) takes **no plugin dependency** — the same idiom
as `@loom/conformance`. `onOffload` (CC-3) reports `{ toolId, stepId, executionId, size,
contentAddress }` per offload so log-budget regressions surface in metrics, not replay
latency. `resolveClaimCheck` (CC-4) is the sanctioned read-side path for use OUTSIDE the
determinism boundary (UI evidence rendering, exports), surfacing the store's null-on-absence
contract as-is.

## Consequences

- The sentinel telemetry pattern is complete at the app level: `tool$` reads over aggregate
  views + claim-check offload + findings via `ctx.emit` citing `ref`/hash — tamper-evident
  evidence (TS-3) for free from content addressing.
- Unpinned blob TTL can now age out telemetry without touching replay — but evidence cited by
  findings needs the K10.6 pin seam (W3, next) before aggressive TTLs are safe.
- `isClaimCheck`/`ClaimCheckEnvelope` are the shared vocabulary W3's pin index and W6's lint
  build on.

## Amendment (2026-10-31) — a documented opt-in for agent workloads, and a default digest

[ADR 0140](0140-agent-claim-check-opt-in.md) wires this middleware for `agentLoop$` tools with one grouped
option, `defineConfig({ execution: { claimCheck: { store, toolIds } } })` (off unless set). `claimCheckMiddleware`
gains an optional `defaultDigest(result, toolId)`, used for an offloaded result whose tool has no `digests`
entry (a declared digest always wins), and `@loom/middleware` exports `previewDigest(maxChars)`, a ready-made
one that records the head of the result's JSON text and nothing at all for a result carrying an ADR 0085 taint
marker. Unset, `defaultDigest` changes nothing (D2's "`{ ref, size }` only" still holds).

Review round (2026-10-31): the middleware also gains `retain` (stamps `retain: true` on the envelope, which the
content walker reports as load-bearing, so the sweep never TTL-reclaims the blob while a log, archive or snapshot
cites it; the ADR 0140 opt-in sets it, the classic telemetry offload does not), `passThrough`, `envelopesAreData`,
and a tainted result (top level or nested) is now recorded as `tainted(envelope, origin)` instead of a clean
envelope. A `retain`ed ref is erased only by subject erasure (`ERASURE_CONTENT_DELETED`), never by TTL.
