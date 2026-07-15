# db-sentinel — the perpetual-agent pattern, proven over a simulated year

The reference example for the perpetual-agents series (ADR 0051–0056; requirements in
`docs/requirements/2026-07-15-perpetual-agents-sentinel-workloads.md`): a database
replication-lag **sentinel** that "runs forever" — without a perpetual execution.

## The pattern (requirements §2, one line each)

| Requirement | Here |
| --- | --- |
| **P-1** sentinel = `schedule$` over bounded runs | `SENTINEL_SCHEDULE` (6-hour cron); every wake is a new execution with T1's deterministic `pg-sentinel@<occurrence>` id — no rotation, no perpetual log |
| **DS-1..5** typed carry state | `sentinelState(...)` in `src/sentinel.ts`: load → validated/migrated, save → CAS with the loaded revision; contracts v1→v2→v3 with registered migrations |
| **CC-1..4** claim-checked telemetry | `claimCheckMiddleware` (4 KiB cap): the log records `{ ref, size, digest }`; the flow branches ONLY on the declared digest |
| **P-2** findings = domain events | `ctx.emit(FINDING_RECORDED, …)` with an app-owned Zod schema, citing evidence by content hash |
| **P-3** staleness, never a hang | outage reads return `{ stale: true, asOf }` — small, inline, recorded |
| **K10.1 + K10.5** retention | archive runs at 60d; `sweepUnpinnedContent` reclaims telemetry blobs at 30d — evidence cited by findings is pinned forever, across archival |
| **ADR 0051 D7** boundary validation | `validateInput: true` — schedule inputs parse the declared contract (defaults applied) |

## What the acceptance suite proves (`pnpm test`)

Twelve simulated months at 6-hour cadence (1,460 wakes — the cadence is one constant;
the properties are cadence-independent), everything a pure function of virtual time:

1. Every wake stays within its event budget; every non-stale telemetry read is recorded
   **by reference** — no over-cap payload ever enters the log.
2. Findings match the anomaly model exactly, across a **mid-year contract deploy**
   (v1 → v2): the first v2 wake's recorded load carries `migrated: { from: 1, to: 2 }`;
   zero manual intervention.
3. Carry state advances one CAS revision per wake (1,460 exactly).
4. A 24-hour ingestion outage produces stale-marked, completed wakes — zero stuck runs.
5. Re-firing an occurrence (crash recovery / cross-node race) is a **no-op** — T1's
   idempotent-start discipline.
6. Archive everything older than 60 days, reclaim telemetry blobs older than 30 days:
   **every finding's evidence — including month 1, in archived runs — still resolves and
   hash-verifies**; disposable telemetry is gone.
7. Replay of any wake folds in well under a second and never touches the content store.
8. A v3 deploy **without** a migration path stalls loudly (`no-migration-path` in the
   recorded failure); registering the migration resumes cleanly on the next wake.
9. `TimerService` fires the cron deterministically and idempotently under `@loom/dst`'s
   virtual clock.
10. Evidence is readable outside the determinism boundary via `resolveClaimCheck`
    (CC-4); erased telemetry reads `null`, replay unaffected.

## Run

```sh
pnpm test        # the 12-month acceptance suite
pnpm start       # 3 simulated days, printed (findings, offloads, carry state)
```

## Layout

```
src/domain.ts     Finding schema + carry-state contracts v1/v2/v3 + migrations
src/substrate.ts  deterministic pg_stat substrate (anomalies on the 7th; outage windows)
src/sentinel.ts   the flow, schedule, digest declaration, per-version deployment
src/harness.ts    shared stores + per-deploy runtimes + T1 idempotent occurrence firing
src/main.ts       headless demo driver
test/             the acceptance suite
```

Offline and deterministic end to end: no database, no network, no wall clock.
