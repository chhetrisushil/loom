# Database Copilot on Loom: Infrastructure Requirements & Placement Verdicts

**Status:** Draft for evaluation
**Date:** 2026-07-15
**Companion to:** the "Context-Native Database Copilot" product proposal (July 2026, leadership review)
**Builds on:** [the perpetual-agents requirements](2026-07-15-perpetual-agents-sentinel-workloads.md)
(ADRs 0051–0057, all shipped), [the W8 audit](2026-07-15-perpetual-agents-audit.md)
**Kernel baseline:** EVENT_SCHEMA 1.16.0, KERNEL_ABI 1.1.0, ADRs 0001–0057

---

## 0. Placement verdict (read this first)

The copilot's platform risk was retired by the perpetual-agents series: sentinels, findings
with hash-verifiable evidence, pinned retention, contract migration across years of deploys,
trust-ladder enforcement, shadow execution, decision capture, and acceptance-governed
proactivity all map to shipped mechanisms (§1). **Nothing blocks Phase 1 on today's `main`.**
The remaining infrastructure work:

| Layer | What lands there |
| --- | --- |
| **Performance / 1P plugin** (§3 RM) | Durable, checkpointed cross-execution read models — the institutional-memory query engine ("why is this column nullable?") |
| **SPI evolution — additive** (§3 SP) | Paged store enumeration (`listExecutions` cursor variant) — retention/sweep at year scale |
| **1P — evidence-gated** (§3 SW) | Incremental K10.6 sweep via a durable pin projection (composes with RM) |
| **SPI + 1P — streaming, bounded** (§3 ST) | `putStream` on the `ContentStore` SPI + stream-typed claim-check results. **Durable kernel streams/pipes: REJECTED** (ST-R) |
| **3P plugin** (§3 CX) | `loom-plugin-pg-stats` — PostgreSQL telemetry connector (staleness-typed, digest-declared tools) |
| **DX** (§3 DX) | `sentinelPreset()`, `loom sweep content` CLI, the acceptance-governance worked example |

No new syscalls anywhere in this set. One optional-method SPI MINOR (SP-1, ST-1 each).
KERNEL_ABI unchanged.

---

## 1. What the shipped series already answers

| Copilot capability (proposal) | Mechanism (shipped) |
| --- | --- |
| Continuously observing sentinels, day zero onward | `schedule$` over bounded runs + `sentinelState` carry state (ADR 0051 D1, 0053) |
| Findings that "ship with their evidence" | `ctx.emit` domain events citing claim-check refs; evidence hash-verifies byte-for-byte for the audit trail's lifetime (ADR 0054, TS-3) |
| *Findings permanent, runs archivable, telemetry disposable* | K10.6 pin seam + pinned mark-and-sweep GC, pins survive archival (ADR 0055) |
| Years of deploys over long-lived state | DS-3 carry-state migrations (ADR 0053) + K11.5 `resumeAs` state migration (ADR 0056); multi-gate approvals correct (ADR 0057) |
| Trust ladder; destructive DDL "structurally unreachable" | K2 capability grants + `policy$` + K12 verified approvals (`APPROVAL_GRANTED`) + suspend gates — the ladder is **policy content over existing enforcement rings**, per environment |
| Shadow execution / lock estimation dry-runs | fork → simulate → promote branching (ADR 0005; `incident-war-room`, `schema-migration-planner`) |
| Decisional layer captured as interaction exhaust | `ctx.decide` / `DECISION_RECORDED` + `OUTCOME_RECORDED` |
| Acceptance-governed proactivity / self-demoting categories | `@loom/analytics` outcome mining + `rankedRouter` (M9–M11) |
| Ambient panel / interruptive alerts | A2UI durable panels folded from the log; alert tiering is app policy |
| Stale telemetry → "confidently wrong" defense | Staleness-typed reads: a stale wake is a recorded, replayable outcome (requirements P-3) |
| Data governance (query text carries PII) | `classify` markers, K10.2 crypto-shredding, K10.3 redaction, T3 subject rights, K12 tenant scoping |
| End-to-end proof | `examples/db-sentinel`: the Phase-1 architecture over a DST-simulated year, all ten acceptance criteria |

**Proposal review notes carried here for the record** (product-level, for the proposal's next
revision): (a) the day-zero moat argument is weakest in Phase 1 — structural/behavioral layers
are partially backfillable by a competitor; the unreplicable decisional exhaust starts with
Phase 2 adoption, so the moat claim is an argument for reaching Phase 2 quickly; (b) the
proposal needs a data-protection section — the answers exist in the K10/T3/K12 row above;
(c) cite `examples/db-sentinel` as de-risking evidence for the two-engineer Phase 1 ask.

---

## 2. Non-goals

Loom does not become a telemetry ingestion system (unchanged from the sentinel requirements);
collectors and rollup jobs stay outside the `tool$` boundary. Editor/CI surfaces, NL query
authoring, and the diagram UI are application work over existing seams (`@loom/llm`, A2UI,
deploy-check tooling). T4 run chaining stays behind its ADR 0052 evidence gate — nothing in
the copilot (including on-demand Q&A, which is ordinary request/response executions) hits
either promotion wall.

---

## 3. Requirements

### RM — Durable cross-execution read models (1P plugin; the priority item)

The institutional-memory queries ("why is this column nullable?", "what happened during the
March migration?") span years of findings and decisions across millions of executions.
Today's query story — per-execution `read()` + in-memory projections (ADR 0049 lazy folds) —
re-folds the world on cold start.

**RM-1 (MUST, alongside copilot Phase 1–2).** A first-party read-model plugin
(`@loom/plugin-read-model` or a durable-projection extension of `projection-runtime`):
projections whose folded state is **persisted and checkpointed** (state + last-seen watermark),
tailing the store's cross-node `subscribe` feed, resuming from the watermark on restart. No
kernel change — a consumer of existing seams.

**RM-2 (MUST).** Read models are **rebuildable from the log** (drop the checkpoint, re-fold) —
the log remains the only source of truth; a read model is a cache with a watermark, never an
authority. Divergence detection (re-fold a sample and compare) SHOULD ship in the conformance
kit.

**RM-3 (MUST).** Query interface sufficient for the decisional layer: filter by event kind +
payload predicates over app-declared indexed fields (e.g. `FINDING_RECORDED` by target object;
`DECISION_RECORDED` by subject), ordered, paged. Backends via `plugin-kit` presets (in-memory,
sqlite, postgres).

**RM-4 (SHOULD).** Archived executions participate: a read model MAY tail an archive store's
feed too (same rationale as the K10.6 sweep scanning archives — month-1 decisions stay
queryable after K10.1 archival).

### SP — Paged store enumeration (additive SPI evolution)

`listExecutions?(): Promise<string[]>` is unbounded; the retention pass and the K10.6 sweep
iterate it wholesale. At sentinel cadence × years this is memory- and time-unbounded.

**SP-1 (MUST, before year-scale deployment).** An optional paged variant on the EventStore
SPI (cursor + limit), additive MINOR, conformance-tested; unpaged stores keep working (G2).

**SP-2 (MUST, with SP-1).** `loom retention run` and `sweepUnpinnedContent` consume the paged
variant when available.

### SW — Incremental sweep (evidence-gated)

ADR 0055 chose mark-and-sweep re-derived from the log per sweep — deliberately (no mutable
pin index to corrupt). At true scale each sweep re-reads everything.

**SW-1 (SHOULD, when a design partner's numbers demand it).** The pin set becomes a durable
read model (RM-1 consumer) and the sweep becomes watermark-incremental. ADR 0055's rationale
is preserved: the projection is a rebuildable cache of the log, not a second source of truth.
Do not build speculatively — Phase-1 scale is fine on the current sweep.

### ST — Streaming: one bounded enhancement, one recorded rejection

**ST-R (REJECTED — recorded like `finding$`/`rotate$`).** Durable kernel stream/pipe
primitives — chunks as events, pipes between steps: state is `fold(events)`, so everything
recorded is load-bearing for replay forever; streaming bulk data through the log re-creates
exactly the problem ADR 0054 solved (replaying a million chunks verifies nothing), and
unrecorded in-flight data between steps breaks the determinism boundary. Userland alternatives
exist for every use (below). Fails P10 twice over. This is the second time this workload
proposed routing high-volume data through the orchestration log; the placement answer is the
same both times.

**ST-0 (no action — already shipped transports).** UI/token streaming: `ctx.stream(eventType,
delta, done)` (durable, replay-deterministic — the A2UI path) and the LLM SPI's
`LlmStreamChunk`. Cross-flow composition ("piping" flows): `@loom/orchestration` /
graph-executor. Live tailing: `subscribe` / `@loom/live-query`.

**ST-1 (SHOULD).** Optional **`putStream()`** on the `ContentStore` SPI (additive MINOR,
conformance-tested): content-addressed streaming ingestion, hash computed over the stream,
idempotent by resulting address. Motivation: `put(bytes)` requires full in-memory payloads;
large captures (table samples, shadow-execution output) shouldn't be memory-bound, and the
future object-storage backend wants multipart upload anyway.

**ST-2 (SHOULD, with ST-1).** Claim-check support for stream-typed tool results: the tool
streams into the content store *inside the effect*; the recorded value is still the small
`{ ref, size, digest }` envelope. Streaming stays on the transient side of the determinism
boundary; only the outcome is durable — the same discipline as effect execution, warming, and
`now()` injection.

### CX — PostgreSQL telemetry connector (3P)

**CX-1 (MUST for the copilot; lives outside this repo).** `loom-plugin-pg-stats`: typed,
read-only `tool$` wrappers over `pg_stat_*` **aggregate views** (P-4 discipline), with
staleness-typed results (P-3) and declared digests (CC-2) baked in. Vendor adapter → 3P per
ADR 0043; a good candidate for design-partner co-ownership. The copilot app composes it with
`claimCheckMiddleware` and `sentinelState` exactly as `examples/db-sentinel` shows.

### DX — Developer experience

**DX-1 (SHOULD).** `sentinelPreset()` (1P, composition-time only per ADR 0043/0044): one
declaration bundling schedule + durable-state contract + claim-check wiring + pin policy —
the five files of `examples/db-sentinel`'s harness as a preset, plus a
`loom new --template sentinel` scaffold.

**DX-2 (SHOULD).** `loom sweep content` CLI: the K10.6 sweep is library-only today;
retention has an operator surface (`loom retention run`), the blob sweep needs the same
(dry-run by default, `--apply`, report table).

**DX-3 (SHOULD).** The acceptance-governance loop as a worked example/doc:
`OUTCOME_RECORDED` → `@loom/analytics` → `rankedRouter` demotion — the proposal's
"suggestion categories demote themselves" is assembled from existing parts; document the
assembly so the copilot team doesn't rediscover it.

**DX-4 (MAY).** A data-protection pattern page for copilot-shaped apps: query-literal
redaction via `classify` markers, per-tenant scoping, retention posture — the proposal's
missing governance section, written once as reusable guidance.

---

## 4. Alignment with the copilot's phases

| Copilot phase | Infra needed | Status |
| --- | --- | --- |
| Phase 1 — observe & prove | Sentinels, findings, retention, staleness, A2UI panel | **Shipped.** Start on `main` today; CX-1 connector is app/3P work within the phase |
| Phase 2 — author & explain | Decisional-layer queries at product quality | **RM-1..4** — start alongside Phase 1; SP-1/2 with it |
| Phase 3 — plan & protect | Trust ladder, shadow execution, CI review | Shipped (rings + branching + deploy-check); DX-1..3 polish |
| Phase 4 — broaden | Scale hardening | SW-1 and ST-1/2 behind design-partner evidence |

## 5. Acceptance criteria

1. **RM:** a read model over one year of db-sentinel-shaped logs answers a
   `FINDING_RECORDED`-by-target query in <100ms warm; cold restart resumes from the watermark
   without re-folding history; dropping the checkpoint and rebuilding yields identical state.
2. **SP:** retention + sweep over 1M executions run in bounded memory via the paged variant;
   unpaged in-memory stores still pass conformance unchanged.
3. **ST-1/2:** a tool returning a 1 GB stream lands content-addressed without the worker's
   heap holding the payload; the log records only the envelope; replay touches nothing.
4. **DX-2:** `loom sweep content --dry-run` over the db-sentinel example reports exactly the
   pins/reclaims the acceptance suite asserts.

## 6. Open questions

1. RM backend: does the postgres read-model ride the same database as the event log (one
   backup, like timers) or its own — decide in the RM ADR with the LISTEN/NOTIFY load in view.
2. RM indexing declaration: per-projection field list vs. deriving from the app's Zod event
   schemas (`classify`-style walker) — prefer derivation if it stays cheap.
3. ST-1 hash-while-streaming for backends that can't (object stores that hash server-side):
   is a post-upload verify acceptable, or must the SPI require client-side hashing?
4. Whether DX-1's preset should also standardize the finding schema envelope (category /
   severity / confidence / evidence) as an optional export — still app vocabulary (ADR 0051
   D4), but the copilot + a second adopter would justify a contrib schema.
