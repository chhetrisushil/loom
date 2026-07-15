# Perpetual-Agent Workloads: Bounded Runs & High-Volume Effect Data

**Status:** Draft for evaluation
**Date:** 2026-07-15
**Supersedes:** the "Perpetual-Agent Stress Points" draft (run chaining + telemetry substrate split)
**Kernel baseline:** EVENT_SCHEMA 1.14.0, KERNEL_ABI 1.1.0, ADRs 0001–0050
**Motivating workload:** database-copilot sentinel flows (5-minute wake cadence, pg_stat/lock/plan telemetry, durable findings)

---

## 0. Placement verdict (read this first)

The original draft derived kernel requirements from an application modeling choice — a
single never-terminating `flow$` per sentinel — and from problem statements that predate
K10/K11/T1. Rewritten against the current kernel:

| Layer | What lands there |
| --- | --- |
| **Application patterns** (§2) | Sentinel = `schedule$` over bounded runs; findings as domain events; staleness-typed reads; substrate isolation; chain-level OTel |
| **First-party plugins** (§3) | `@loom/plugin-durable-state` (typed, versioned, migratable carry state as recorded effects); claim-check middleware over `@loom/plugin-content` |
| **Kernel — small, governed** (§4) | K10.6 pin seam for retention; K11.5 contract-versioned state migration on resume; opt-in `inputSchema` enforcement at start |
| **Deferred, evidence-gated** (§5) | T4 run chaining (`rotate$`) — drafted, not scheduled; promoted only if the schedule-based sentinel hits a documented wall |
| **Rejected** | Identity-preserving transfer of live suspensions across runs (original RC-4a); a kernel `finding$` primitive (original TS-4) |

No new syscalls. At most two additive MINOR event-schema changes (K11.5's migration
fact; T4's rotation fact *if* T4 is ever promoted). KERNEL_ABI unchanged.

---

## 1. What the current kernel already answers

Requirements in the original draft that are satisfied by shipped work, with no action:

| Original requirement | Answered by |
| --- | --- |
| RC-9 `checkpoint$` (bound replay depth) | `SnapshotStore` + `loadLatestBefore` + `snapshotEvery` (mid-run cadence); `LogLifecycle.compact` (K10.4, ADR 0022) with fold-equivalence conformance |
| "Resume against code deployed dozens of times" | K11 (ADR 0023): `flowContentHash` pinning, version-aware registry, `resumeAs(…, { strategy: "replay-check" \| "operator-ack" })`, `EXECUTION_MIGRATED`, `loom deploy check` census |
| RC-11 archival / cold storage | K10.1 retention: archive-before-delete, `EXECUTION_ARCHIVED`, live-descendant guard via `BranchRegistry`. Per-chain policy is configuration over this mechanism |
| Exactly-once wake delivery | T1 (ADR 0025): `schedule$` occurrences fire as new executions with deterministic `scheduleId@occurrenceMs` ids, at-least-once firing + idempotent starts, K9.4 fencing multi-node |
| RC-6 replay scoped to a single run | Already true by construction: every execution replays from its own log |
| TS-3 content-addressed references | ADR 0046: `ContentRef` (`__loomContent: "sha256:<hex>"`), `ContentStore.put` idempotent by hash, `ContentResolvingEventStore` |
| TS-7 physical isolation | The content store and substrate tables are separate stores with separate write paths by construction; separate databases is deployment configuration |
| TS-9 pluggable effect-store backends | `ContentStore` is an SPI (ADR 0046); `plugin-kit` presets govern backend packaging (ADR 0043) |

---

## 2. Application patterns (no framework change)

The load-bearing decision, stated as a pattern requirement because everything downstream
depends on it:

**P-1 (MUST).** A sentinel is modeled as a `schedule$` cron entry whose every occurrence
starts a **new, bounded execution** on currently deployed code, not as a perpetual
`flow$`. Consequences, all free: per-run logs stay small (wake, reads, findings — no
accumulation), replay is trivially fast, every wake re-versions onto the current deploy
(the original RC-8 "rotate on deploy" trigger), and T1's deterministic occurrence ids
already provide exactly-once wake semantics (the original RC-4's hardest clause). The
chain identity **is** the schedule: `chain_id = scheduleId`, and lineage enumeration
(original RC-3) falls out of the `scheduleId@occurrenceMs` id scheme or a small
projection.

**P-2 (MUST).** Findings are **application domain events**, emitted via `ctx.emit` with
an app-owned Zod schema (category, severity, confidence, target objects, evidence
`ContentRef`s, acting model/version). They are durable log facts, always inline (findings
are small by construction — evidence goes by reference, §3). No kernel `finding$`
primitive: "finding" is copilot vocabulary, and a domain schema over `ctx.emit` gives the
triage flow, acceptance-rate metrics, and decisional-layer queries everything the
original TS-4 asked for. Publish the schema as a copilot module (or a contrib package if
a second app wants it — not before).

**P-3 (MUST).** Substrate reads are ordinary `tool$` effects whose result type carries
freshness metadata: `{ data, asOf, stale: boolean }`. An ingestion outage yields a
recorded, replayable "observed nothing new, stale since T" outcome — never a hung wake.
This is tool authorship (original TS-6), not framework capability.

**P-4 (SHOULD).** Sentinel tools read **aggregate views**, not raw sample tables, so the
determinism boundary and the aggregation boundary coincide (original TS-8). Collectors,
rollup jobs, and substrate tables live entirely outside Loom; the framework's
responsibility begins at the `tool$` boundary (unchanged non-goal).

**P-5 (SHOULD).** Chain-level observability is wired through the existing
`TelemetryAdapter` hooks: stamp `scheduleId` as a span/metric attribute in
`onFlowStart`, link consecutive occurrence spans by attribute query. Operators think in
schedules; runs are an implementation detail (original RC-10, app-wired).

**P-6 (SHOULD).** The joint retention rule from the original draft is adopted **as
declared policy over existing mechanism**: findings and their pinned evidence are
permanent; runs are archivable (K10.1); raw telemetry is disposable on its own TTL
outside Loom. The one mechanism gap this exposes is the pin seam — §4, K10.6.

---

## 3. First-party plugin requirements

### 3.1 `@loom/plugin-durable-state` — typed carry state across runs

The one genuine new capability in Part 1 of the original draft. `memory$` does not cover
it: memory is an agent/app-layer side channel — flows cannot reach it, writes are not
recorded in the log, and reads are not deterministic on replay. Carry state for
schedule-driven sentinels must therefore be built as **recorded effects**, which also
makes it replay-correct for free (the read lands in `STEP_COMPLETED.output`; replay folds
the recorded value and never re-reads the store).

**DS-1 (MUST).** Typed keyed state exposed as `tool$`-shaped effects: `load(key)` and
`save(key, value)`. Reads and writes are recorded steps; replay never touches the
backing store. Backends are pluggable via `plugin-kit` presets (in-memory, sqlite,
postgres to start).

**DS-2 (MUST).** Every stored value is wrapped in a version envelope
`{ contractVersion, payload }` and validated against the flow-declared Zod contract on
`load`. A run never proceeds on unvalidated state (original RC-2, at the layer that owns
the state).

**DS-3 (MUST).** Versioned migration: the plugin accepts a registry of
version-to-version Zod transforms. When `load` encounters an older envelope, it applies
the migration chain, records the migration as part of the (already-recorded) load
result, and persists the upgraded envelope on next `save`. Absent a migration path,
`load` fails **explicitly and loudly** — the run fails with a typed
`StateContractMismatch` error, which is alertable and operator-resumable after a
migration is registered. State is never silently coerced (original RC-5/RC-7 semantics,
without a chain).

**DS-4 (MUST).** Single-writer discipline per key: the schedule-driven pattern
guarantees at most one live occurrence per schedule writes a given key (T1 idempotent
starts). The plugin additionally supports compare-and-set on the envelope (a
`revision` field) so a misconfigured overlapping occurrence fails fast rather than
lost-updating.

**DS-5 (SHOULD).** A `sentinelState(schedule, schema, migrations)` convenience that
derives the key from `scheduleId` and packages DS-1..4 as one declaration — the pattern
in §2 P-1 expressed as one line.

**Rationale for plugin, not kernel:** no new event kinds (loads/saves are ordinary
steps), no ABI change, and the capability is general — any long-lived keyed state has
the same contract-evolution problem, chain or no chain.

### 3.2 Claim-check middleware — completing ADR 0046

The reference envelope, content addressing, and store SPI already exist. What remains is
the ergonomic path from "tool returned 2 MB" to "log recorded 200 bytes":

**CC-1 (MUST).** `claimCheckMiddleware` on the ADR 0006 effect-middleware seam: when an
effect result exceeds a configurable inline cap (default 16 KB), the middleware stores
the payload via `ContentStore.put` and returns
`{ ref: ContentRef, size, digest }` as the effect's output — which is what
`STEP_COMPLETED` records. Same architectural move as K10.3's `secretRef` (deterministic
marker in the log, resolution outside it), applied to the output side. Replay
determinism is automatic: the recorded value *is* the reference + digest, and middleware
is not re-invoked for completed steps.

**CC-2 (MUST).** The **digest is declared alongside the tool's result schema** as a pure
function of the payload — it is the deterministic projection the orchestration is
allowed to branch on (resolves the original draft's open question). Tools with no
declared digest get `{ ref, size }` only, and orchestration can branch on nothing but
existence.

**CC-3 (MUST).** Offload is observable: the middleware records size and hash; a
counters/metrics hook reports offload volume per tool so log-budget regressions surface
in operations, not in replay latency.

**CC-4 (SHOULD).** A read-side helper (`resolveRef`) for the rare legitimate
reach-through (e.g., rendering evidence in a UI outside the determinism boundary),
implemented over `ContentStore.get` with its null-on-absence contract, so application
code never handles raw refs.

**CC-5 (SHOULD).** Lint: flag orchestration code that passes a `ContentRef` back into
flow control (branching on resolved payload content rather than the recorded digest).
Per ADR 0044/0047 this lives in first-party dev tooling (`tools/*`), driven by the
manifest — not in the kernel and not as a compiler plugin API.

---

## 4. Kernel requirements (small, K5-governed)

**K10.6 — Pin seam in retention (MUST).** `LogLifecycle.applyRetention` and
`ContentStore` garbage collection currently have no way to know that a `ContentRef`
cited by a finding must outlive both the raw-telemetry TTL and the archival of the run
that produced it. Requirement: the retention path accepts a **pin predicate** —
"executions/refs reachable from designated event kinds are exempt" — evaluated before
archive/delete, with the reachability index maintained by the claim-check plugin (it
knows the envelope format; `ContentStore.delete` explicitly leaves referential integrity
to the caller). This is a seam in K10, not a subsystem: the kernel checks the predicate;
*what pins* (findings) and the pin bookkeeping (reference-count vs mark-and-sweep —
implementation detail) live in the plugin. Pinning survives run archival by
construction, because the pin index is keyed by ref, not by run (the original draft's
RC-11/TS-5 compatibility requirement, resolved once).

**K11.5 — Contract-versioned state migration on resume (MUST).** K11 migrates **code**;
it does not address a *suspended* execution whose folded state must be transformed to
match an evolved contract before resuming under new code — `resumeAs` replay-check
rightly refuses such a resume today, and no ADR flags the gap. Requirement: `resumeAs`
accepts a registered state transform (Zod transform, old contract → new), applies it at
migration time, and records the transformation as a durable fact (extend
`EXECUTION_MIGRATED` payload or add one event kind; additive MINOR on EVENT_SCHEMA
1.14.0). Absent a transform where one is needed, the migration fails explicitly —
exactly K11's current behavior, now with an escape hatch. **Specified here as a general
K11 amendment, deliberately not as a chain feature**: schedule-driven sentinels barely
need it (each wake starts fresh; carry-state migration is DS-3's job), but any
long-suspended execution — human gates, A2A waits — has this problem, and it should be
built once.

**K1.x — Opt-in input validation at start (SHOULD).** `FlowDefinition.inputSchema` is
currently metadata (used by manifest/deploy tooling, not enforced). An opt-in runtime
flag to `parse` input at `start()` closes the gap between "declared contract" and
"validated contract" for every entry path — schedules, A2A `submit`, direct starts.
Unwired = unchanged behavior (G2 discipline). This is the honest residue of the original
RC-2: carry-forward validation is DS-2's job, but *input* validation on start is a
one-flag kernel nicety.

---

## 5. T4 (draft, evidence-gated) — run chaining for genuinely unrotatable executions

**Not scheduled. Promoted only on evidence.** The schedule-driven pattern (§2) covers
the motivating workload without it. Two concrete walls, and only these, would justify
promotion:

1. **Stable signal-addressability.** External parties must address "the sentinel" as one
   logical endpoint whose conversation outlives any single run. Today A2A correlates by
   raw `executionId` (task id *is* the execution id) — there is no logical-name routing,
   so a chain would need kernel-visible identity for signal delivery to
   current-run-of-chain. Note this is really a *routing* requirement and should be
   specified as such if it materializes; rotation would ride on it, not vice versa.
2. **A genuinely unrotatable long-lived run** that must both hold live suspensions
   across months *and* cross deploys that `resumeAs` + K11.5 cannot bridge. (Long-lived
   human gates alone do not qualify: model the gate as a child execution via
   `@loom/orchestration` `awaitChild` — the child survives its parent's completion
   naturally.)

If promoted, the draft shape — recorded here so the adversarial criteria don't get
diluted later:

- **T4-1.** `rotate$(carryForward)`: terminal event + successor start as one journal
  transaction; successor id deterministic (`chainId@n+1`), start idempotent via K9 keys.
  Crash mid-rotation recovers to **exactly one** live successor.
- **T4-2.** Wake signals arriving in the predecessor-terminal → successor-start window
  land in a chain-scoped inbox drained by the successor: delivered to exactly one run,
  never dropped, never doubled. This is the adversarial acceptance criterion — kill the
  worker between terminal-commit and successor-start with a signal in flight, recover,
  assert single delivery.
- **T4-3.** Pending suspensions are **deterministically re-established from
  carry-forward state** by the successor. Identity-preserving transfer of live
  suspensions across executions (original RC-4 option a) is **rejected permanently**: it
  breaks single-writer clarity and exists only to serve the perpetual-run model this
  document retires.
- **T4-4.** One additive event kind (`EXECUTION_ROTATED`, carrying `chainId`,
  predecessor, carry-forward hash). Lineage queries are a projection, not an SPI.

Before promotion, T4-1/2 have a userland approximation worth attempting first: a
supervisor projection in the `superviseChildren` style plus a durable inbox keyed by
chain id, drained idempotently at run start. If that approximation proves insufficient
*in operation*, its failure report is T4's promotion evidence.

---

## 6. Traceability

| Original | Disposition |
| --- | --- |
| RC-1 `rotate$` | Deferred → T4 draft (§5); workload remodeled to `schedule$` (P-1) |
| RC-2 carry-forward validation | DS-2 (plugin); plus K1.x opt-in start validation (§4) |
| RC-3 `chain_id` + lineage | P-1: chain = schedule; id scheme + projection. T4-4 if promoted |
| RC-4 atomic wake handoff | Dissolved by P-1/T1 for schedules; T4-2 inbox if promoted; option (a) transfer **rejected** |
| RC-5 stalled chains | DS-3 typed failure + alerting for state; T4-1 for rotation if promoted |
| RC-6 per-run replay | Already true (§1) |
| RC-7 versioned state migration | Split: carry state → DS-3 (plugin); suspended-execution state → **K11.5 (kernel, general)** |
| RC-8 rotation policies | On-deploy: free under P-1. Event-count/duration: moot without perpetual runs; T4 config if promoted |
| RC-9 `checkpoint$` | Shipped (§1: snapshots + K10.4 compaction) |
| RC-10 chain OTel | P-5 (TelemetryAdapter, app-wired) |
| RC-11 retention/cold storage | Shipped (K10.1) + K10.6 pin seam for evidence reachability |
| TS-1 result-by-reference | CC-1 middleware over shipped ADR 0046 store |
| TS-2 replay determinism + lint | Automatic under CC-1; digest = CC-2; lint = CC-5 (tools/*, not kernel) |
| TS-3 content addressing | Shipped (`ContentRef`, §1) |
| TS-4 `finding$` primitive | **Rejected**; P-2 domain events via `ctx.emit` |
| TS-5 evidence pinning | K10.6 seam (kernel) + pin index in claim-check plugin |
| TS-6 staleness-typed reads | P-3 (tool contract) |
| TS-7 physical isolation | Shipped/deployment (§1) |
| TS-8 aggregate-view convention | P-4 + CC-5 lint |
| TS-9 pluggable backends | Shipped (`ContentStore` SPI, plugin-kit) |

## 7. Acceptance criteria (rewritten)

A sentinel schedule running 12 simulated months at 5-minute cadence:

1. Every wake is its own execution; no execution's log exceeds the per-wake budget
   (wake, digest-reads, findings, state load/save — target under a few dozen events).
   Replay of any single wake completes in well under 1 second; there is no
   "current run" whose replay can degrade.
2. A deploy that evolves the sentinel's state contract mid-year: the next wake's DS-3
   `load` migrates the envelope, records it, and continues — zero manual intervention.
   Removing the migration registration instead yields a typed, alertable
   `StateContractMismatch` failure on the next wake, and re-registering resumes cleanly.
3. Killing the worker at any point: at most the in-flight wake re-runs (idempotent
   start); the schedule fires the next occurrence normally. No stalled chain state can
   exist because no chain state machine exists.
4. Deleting all raw telemetry older than 30 days and archiving all executions older
   than 60: every finding emitted in month 1 remains queryable from the log/projections,
   and every `ContentRef` it cites resolves byte-for-byte against its recorded hash
   (K10.6 pin held against both `ContentStore` GC and K10.1 archival).
5. A simulated 6-hour ingestion outage: every wake in the window records a
   stale-marked read (P-3) and completes; zero hung or failed executions.
6. The event log for the full year contains no payload over the CC-1 inline cap;
   replay of any wake touches neither substrate tables nor the content store.
7. A suspended non-sentinel execution (human gate) crossing a contract-evolving deploy:
   `resumeAs` with a registered K11.5 transform migrates and resumes; without one, it
   refuses explicitly — no silent contract mismatch.

## 8. Open questions

1. K10.6 pin-predicate granularity: per-execution exemption vs per-ref reachability —
   per-ref is strictly more precise but requires the plugin-maintained index; decide in
   the K10.6 ADR.
2. K11.5 event shape: extend `EXECUTION_MIGRATED` payload vs a distinct
   `STATE_MIGRATED` kind — both additive MINOR; prefer whichever keeps fold logic
   simplest.
3. DS-4 compare-and-set: is `revision` on the envelope enough, or should the postgres
   backend use row-level locking? (Backend detail; the envelope contract is the SPI.)
4. If T4's promotion evidence ever arrives via the signal-addressability wall (§5
   case 1), whether the right primitive is chaining at all — or logical-name routing in
   the A2A layer with runs as interchangeable handlers behind it.
