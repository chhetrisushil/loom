# Codebase audit — DS&A, security, memory, docs (2026-07-13)

> **Method.** Four parallel read-only audits (DS&A hot paths, security, memory/resources, docs),
> each instructed to cite `file:line`, rate confidence, and flag whether a fix is *safe* or would
> break a load-bearing invariant. Every finding was then verified against the invariants before any
> change — the codebase has a documented history of *rejecting* plausible-but-wrong "optimizations"
> (PR #63 rejected an O(N²) array-spread "fix" that would corrupt copy-on-write snapshots), so the
> bar was: fix only what is verified-safe; record the rest.
>
> **Fixed** in `fix(audit): …` + `docs(audit): …`. **Deferred** items below are real but are either
> design-level (need a decision), interact with an invariant, or are low-severity hardening.

## Summary

The kernel is already well-optimized (ADR 0015) and disciplined (parameterized SQL, real
env-scrubbing, fail-closed crypto, per-execution collections evicted on terminal events). The
material findings cluster in a few places: **unauthenticated HTTP servers**, a **delegation-token
confused-deputy** bug, **in-memory retention that isn't auto-driven**, and **docs that never caught
up to the plugin repackaging** (example code stopped compiling).

## Fixed (verified-safe)

| Area | Finding | File | Fix |
|---|---|---|---|
| Security | **Delegation confused-deputy (HIGH).** A signed token minted for `issuedTo` was honored for *any* bearer — signature proves authenticity, not that the holder is intended. | `effect-runtime/src/authz.ts` | Enforce `req.principal.actor === token.issuedTo` after signature check + regression test. Delegation is opt-in/test-only in-tree, so no production flow breaks. |
| Security | **Proto-pollution defense-in-depth.** Fold-key denylist covered only `__proto__`. | `replay-vm/src/eventHandlers.ts` | Extend to `constructor`/`prototype`. (No global path is reachable; cheap fail-closed.) |
| Memory | **SQLite handle leaked if `pragma`/`migrate` throws** at startup on a corrupt/locked file. | `plugins/sqlite/src/Sqlite*Store.ts` (×4) | `try { … } catch { db.close(); throw }`. |
| Memory | **CLI `inspect`/`dev` left server + DB open on Ctrl-C.** | `cli/src/cli.ts` | SIGINT/SIGTERM → `server.stop()` + `store.close()`. |
| DS&A | **Duplicated `rankFromOutcomes` pass** in the analytics advisory pipeline. | `analytics/src/advisory.ts` | Reuse `runtimeIntelligence`'s `outcomeRankings` (byte-identical) — drops one O(N) pass + sort. |
| Docs | Plugin repackaging never propagated — see below. | `docs/**` | Renamed packages, fixed broken storage examples, added README + plugins-tier note, regenerated `maturity.md`, fixed counts. |

## Deferred — real, but not a verified-safe local fix

### Security (design-level; recommend follow-up)
- **S1 — Unauthenticated `POST /execute` runs arbitrary flows and forges resume/approval events (HIGH; CRITICAL if network-exposed).** `plugins/worker-server/src/createWorkerServer.ts`. The endpoint never threads a `principal`, so the runtime's `executionAuthorizer` (K12) is inert over HTTP; a `resumeEvent` can inject e.g. `APPROVAL_GRANTED` into any execution. **Root fix** (also covers S2/S3): require auth (shared secret / mTLS / signed dispatch token) on `/execute`+`/cancel`, derive a `principal`, thread it into `WorkerRequest`→runtime. This is a design decision (which scheme) + an SPI change — not an audit-pass edit. **Interim:** documented as strictly-internal; do not expose without an authenticating proxy.
- **S2 — Unauthenticated `POST /cancel` → targeted durable DoS (MEDIUM).** Same server, same fix.
- **S3 — A2A `/tasks/send` + `/tasks/:id`: unauth, unvalidated body, caller-chosen execution id (MEDIUM).** `plugins/a2a/src/A2AServer.ts`. Validate the task shape, authenticate, server-generate/namespace the id.
- **S4 — Delegation tokens have no `exp`/`jti`/revocation (MEDIUM).** `effect-runtime/src/authz.ts`. Add `exp` to the signed payload + reject expired. Deferred because it changes the token wire format (coordinate with any live issuers).
- **S5 — `--from-spec` lockfile skips id validation (LOW–MED).** `appgen/src/lockfile.ts`. Trusted CLI arg, but lockfiles read as shareable data; run `validateChangeSpec` on read + `JSON.stringify`-escape interpolated template strings.
- **S6 — No path-containment guard on codegen output writes (LOW).** appgen/scaffold/cli. Add a shared `assertWithin(root, candidate)`.
- **S7 — Egress allowlist doesn't re-check the resolved IP against private/link-local ranges (LOW).** `isolate/src/broker.ts`. Resolve-and-pin is correct (defeats rebind); add a private-range reject for metadata-SSRF hardening.

### Memory (document / opt-in feature)
- **M1 — Retention/compaction is opt-in and nothing auto-drives it (HIGH for a long-running in-memory node).** `workflow-runtime/src/LogLifecycle.ts` exports `applyRetention`/`compact` but nothing schedules them → in-memory `event`/`snapshot` stores grow one entry per execution forever. **Recommended:** an opt-in sweeper in `defineConfig` (e.g. `retention: { ttlMs, everyMs }`); until then, a long-running node must use a durable backend or schedule `applyRetention` itself. *(Documentation, not a silent behavior change.)*
- **M2 — `InMemoryAsyncSnapshotStore` never trims per-execution checkpoints (HIGH for a server).** A naive "keep latest K" cap was **rejected**: it interacts with `compact`'s coverage-back-to-truncation-point and with `loadAt`/`loadLatestBefore` time-travel, and would make the in-memory store diverge behaviorally from the durable ones. Correct fix is the same as M1 (scheduled retention), not a cap. Reference/dev impl; production uses SQLite/Postgres.
- **M3 — `postgresStorage({url})` builds 2–3 separate Pools (MEDIUM, not a leak — all closed on `app.close()`).** `plugins/postgres/src/preset.ts`. Consolidating to one pool while preserving correct `close()` ownership is fiddly (risk of a real pool leak if mis-wired). Passing a shared `new Pool(...)` to `postgresStorage({ url: pool })` is **already supported** and is the recommended pattern for connection efficiency (you own the pool's lifecycle).
- **M4 — HTTP servers don't destroy sockets on `stop()` (LOW–MED).** worker-server / a2a / inspector — `server.close()` waits on keep-alive sockets; add `server.closeAllConnections()` (Node ≥ 18.2) in `stop()`.
- **M5 — Isolate `pendingFetches` has no timeout cleanup (LOW).** `isolate/src/runner.ts` — a dropped broker reply leaves an entry; tie to the run's AbortSignal or a timeout.

### DS&A (do not "fix")
- **D1 — Live-run audit-list append is O(k²) per execution (guarded — DO NOT patch).** `replay-vm` commits events one-at-a-time via `applyEvent` → `foldEvents([event], state)`, which calls `resetFoldOwnership()` each time, defeating the batch-replay WeakSet; each `appendAudit` does `[...existing, item]`. The per-call reset is **load-bearing**: `foldEvents` shallow-spreads `initial`, snapshots retain references to folded state, so keeping ownership and pushing in place would mutate arrays prior states/snapshots alias — the exact copy-on-write violation PR #63 rejected. Real-world impact is low (the per-step event is `RESOURCE_METERED`, an O(1) accumulator; `appendAudit` lists are rare audit facts). A safe fix needs a persistent/immutable list with O(1) structural-sharing append — a design change, not a tweak.
- **D2 — Asymptotic wins confined to in-memory *reference* stores** (`InMemoryTimerStore.due` scan+sort, `InMemoryBranchRegistry.children` scan, `InMemoryProjectionRuntime.handleEvent` over-all-projections): all RISKY (fire/notify ordering determinism) or low value; the durable backends already do the work indexed. Not recommended.

**Confirmed already-optimal (no action):** `foldEvents`/step handlers (copy-on-write), event/snapshot stores (sorted-log + binary search), workflow-runtime (snapshot + binary-searched tail), effect-runtime (Map/Set O(1) authz, folded-once middleware), scheduler/dispatcher (deliberate small-N sorted array), graph-executor (pure fan-out), reasoning/analytics (single-pass, indexed).

**Confirmed clean (security):** all SQL parameterized (both stores); no `eval`/`child_process`/injection on untrusted input; the `new Function("s","return import(s)")` CJS→ESM trampolines take only literal/resolved specifiers; SSRF none (all fetch targets are trusted config); crypto AES-256-GCM fail-closed, keys never logged; both HTTP servers cap bodies at 10 MB; `loom plugin search` encodes the query and hardcodes the registry host.

**Confirmed clean (memory):** all timers cleared+`unref`'d on every settle path; all AbortSignal listeners removed (`{once:true}`/cleanup); Postgres LISTEN/NOTIFY self-cleans empty subscriber sets and `.end()`s on close; LiveQuery/projection/renderer subscriptions return and invoke their unsubscribe; dispatcher/scheduler/registry state is bounded-by-design (LRU caps, config-time, or drained-on-empty).

## Docs — fixed vs remaining

**Fixed:** package renames (`@loom/store-postgres`→`@loom/plugin-postgres`, etc.; `packages/…`→`plugins/…`; `@loom/testing/conformance`→`@loom/conformance`) across guides, spec, loom-2.0, and decks (excluding ADR/requirements, which document the migration); broken storage examples (`kind:"sqlite"`→`sqliteStorage()`) in the core guides + the `StorageConfig` type/table; **new root `README.md`**; architecture.md §6 plugins-tier note; regenerated `docs/spec/maturity.md`; fixed the P1–P11 and ADR-range strings.

**Remaining (lower value / mechanical):**
- Per-example **import lines** for the `sqliteStorage`/`postgresStorage` presets in some guide snippets.
- **`docs/usage-cli.md`** — add the `loom plugin *` family (+ `optimize`/`profile`/`introspect`/`verify`/`compat`/`kernel-manifest`).
- **`docs/api-reference.org`** — a plugins section + `@loom/conformance`/`@loom/plugin-kit` entries; fix the dead `platform-cloudrun/deploy.md` link.
- **`docs/adr/README.md`** — an index of all 44 ADRs (none exists).
- **`docs/pdf/architecture.pdf`** — regenerate (`pnpm present`) after architecture.md settles.
- **A "Plugins & Extensibility" deck** in `docs/presentation/` (prose already covered by `plugins.md`).
