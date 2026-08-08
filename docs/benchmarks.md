# Loom Benchmarks — Committed Baselines

Run all benches: `pnpm bench`. Per package: `pnpm --filter @loom/<pkg> bench`.

These baselines are the **no-regression gate** for the cooperative-scheduling work
(see `packages/scheduler` and the plan). The render fast-path (`traverseBlueprint`)
is deliberately left untouched; treat a >~2% regression on it as a failure.

Numbers below are indicative (Apple Silicon, Node 20, vitest bench). Re-capture on
your CI host to set the authoritative baseline; compare relative movement, not
absolute hz, across machines.

## `@loom/plugin-crypto` — field-level encryption overhead (K10-R7 / ADR 0022 A4)

`plugins/crypto/src/append.bench.ts` — the marked-vs-unmarked-vs-unwired append benchmark ADR
0022 amendment A4 promised, proving the G2 bound (no overhead when unwired) and the honest
opt-in cost. Three shapes on the same payload:

| Shape | Relative | What it shows |
|---|---|---|
| unwired (plain `store.append`) | 1× (baseline) | no wrapper at all |
| wrapped, **empty** sensitive map | ~1.3× | one per-event-type map lookup, no crypto — within noise (**G2**) |
| wrapped, one field encrypted | ~20× | the actual per-marked-field AES cost (paid only for marked fields) |

The empty-map wrapper being ~1.3× (a single lookup) — not the 20×+ of the encrypted path — is the
provable "byte-identical when unmarked" claim. Run: `pnpm --filter @loom/plugin-crypto bench`.

## traverseBlueprint — render fast path (regression gate)

Pure synchronous walk, no scheduler involvement. Scales ~linearly with node count.

| Nodes  | mean (ms) | hz        |
|--------|-----------|-----------|
| 10     | 0.0005    | ~1,970,000 |
| 100    | 0.0048    | ~207,000  |
| 1,000  | 0.0451    | ~22,000   |
| 10,000 | 0.4668    | ~2,140    |

Takeaway: even a 10k-node tree traverses in ~0.47ms — well inside a frame budget.
This is the empirical basis for **not** adding a Fiber-style time-slicer to the
render path.

## @loom/scheduler — overhead guardrails

| Bench                              | Result vs baseline |
|------------------------------------|--------------------|
| `schedule` (Infinity) vs direct await | ~1.0–1.04× (negligible) |
| `parallelLimit` unbounded vs `Promise.all` | ~1.7× (sub-µs absolute; dwarfed by real I/O) |

Takeaway: the unbounded scheduler adds no meaningful latency; gating cost is only
paid when a finite concurrency cap is explicitly configured.

## projection storm — pre-coalescing baseline (Phase 4 target)

One `handleEvent` per streamed token; subscriber fires once per event today.

| Burst  | mean (ms) | subscriber calls |
|--------|-----------|------------------|
| 100    | 0.0131    | 100              |
| 1,000  | 0.1214    | 1,000            |

Phase 4 coalescing target: keep wall time flat or better while collapsing
subscriber calls from O(events) → O(microtask flushes).

## DS&A hot-path optimizations (PR #63)

Algorithmic wins on paths that are hit per-tick or per-append. Each is a strict
complexity improvement with identical outputs — no behavior change, so they only
*widen* the no-regression margin. See [ADR 0015](adr/0015-dsa-performance-optimizations.md#amendments).

| Path | Before | After |
|------|--------|-------|
| `nextOccurrence` cron matching (`workflow-runtime/src/cron.ts`) | minute-by-minute scan | **field-jumping** — advance directly to the next matching field |
| Reasoning model routing (`reasoning/src/router.ts`) | linear scan of routes per call | **prebuilt index** — O(1) tag lookup |
| Crypto field walks (`plugins/crypto/src/crypto.ts`) | repeated full-object traversal | single-pass walk over marked paths |
| `deploy-sim` census | re-derived per flow | hoisted/linearized |

These sit off the render fast-path and within the >~2% regression gate above.

## Advisory pre-warming — cold-start hidden (PR #64)

Off-log, opt-in warming of cold resources (P10 advisory plane; latency-only, never a
fold input). Measured on the K7 isolated-executor boundary — the largest cold start:

| K7 isolated tool — first-call latency | ms |
|---|---|
| cold (lazy fork + module require on first `execute`) | ~54.2 |
| warm (child pre-spawned at boot via `warm()` / `spec.warm`) | ~2.0 |
| **cold start hidden by pre-warm** | **~52** |

Pre-warming boosts *latency, not throughput*, and only pays off at genuine I/O /
cold-start boundaries (K7 child, LLM connection, scheduled fires) — so it is scoped
there and nowhere else. See [ADR 0027](adr/0027-advisory-pre-warming.md).

## Batched content resolution — frozen-snapshot serving (ADR 0062)

`ContentStore.getMany` + batch-scoped two-phase resolution in
`ContentResolvingEventStore` (collect distinct refs across the read batch → one
round-trip → pure substitute). Measured resolving 50 externalized refs through a
2ms-per-round-trip backend (`plugins/content/src/content.bench.ts`):

| resolve 50 refs @ 2ms backend latency | mean ms |
|---|---|
| pre-ADR-0062 shape (serialized per-ref awaits) | ~114 |
| coalesced parallel `get`s (fallback, no `getMany`) | ~2.7 |
| **`getMany` (one batched round-trip)** | **~2.6** |

~44× over the old serialized shape; comfortably inside the TS-10 interactive
budget (p95 ≤ 150ms for ≤ 50 refs, asserted in `batchedResolution.test.ts`).
The batched-vs-coalesced gap is small against an in-memory backend (latency
does not scale with concurrency there); on real network stores with connection
caps the single round-trip is the durable win. `CachingContentStore` layers
cache-forever on top (content-addressed ⇒ immutable), with `delete`-evicts-first
so erasure is never resurrected.
