# Composition-Layer Plugins / Modules — Requirements & Critical Evaluation

> **Status:** Evaluated — **Rejected as a runtime system; deferred as a composition helper, gated on a concrete consumer.** No code proposed to land yet; this is the record of the requirements and the reasoning.
> **Date:** 2026-07-13
> **Method:** the proposal's every factual premise was verified against the actual source
> (`packages/app/src/defineConfig.ts`, the seam interfaces, and how retry/metering/safety/
> Postgres/Cloud Run/telemetry/T1-timers are wired today) before the verdict was formed.
> Related: [ADR-0006](../adr/0006-config-and-effect-middleware.md) (middleware = static layers,
> not plugin magic), [ADR-0033](../adr/0033-spi-conformance-contracts.md) (SPI consolidation +
> conformance kits), [ADR-0025](../adr/0025-t1-durable-timers-and-scheduled-executions.md) (T1).

## The proposal, in one paragraph

Introduce a `LoomPlugin` abstraction so a developer can add a cross-cutting feature (e.g.
`@loom/plugin-observability` = telemetry adapter + metering middleware + projection + CLI
subcommand + blueprint widget) with one import and one config line, instead of hand-wiring
five seams in the right order. `setup(ctx)` runs **once at boot**, is pure, and returns
**contributions** to the *existing* seams; `defineConfig` concatenates them with the user's
explicit entries. A `contributes` manifest declares which seams a plugin touches (touch-what-
you-didn't-declare ⇒ boot failure). Explicitly **not** a runtime hook bus, **not** dynamic
`node_modules` discovery, **not** fold-path extensibility. The proposal itself pre-emptively
rejects those three as fatal.

## Grounding facts (verified against the code)

1. **The composition layer already exists and is exactly the shape a "good" plugin system
   would compile to.** `defineConfig` (`packages/app/src/defineConfig.ts:246–376`) is ~130
   lines of pure, ordered, side-effect-free-to-read composition over these seams: `storage`
   (union), `effectMiddleware[]`, `authorizer`, `telemetry[]`, `dispatcher`,
   `projectionRuntime`, `surfaces[]`, `flows[]`/`flowModules[]`, `onEvent`, `timers{}`,
   `catalog`, `agents[]`/`capabilityAgents`, `validate`, `verify`. No `plugin`/`contributes`/
   `setup(` concept exists anywhere in the runtime today.

2. **Every shipped "multi-seam feature" is already collapsed into a single declarative key** —
   this is the crux the steelman under-weights:

   | Feature | "Seams" (proposal framing) | What the developer actually writes |
   |---|---|---|
   | Retry | 1 (middleware) | `effectMiddleware: [retryMiddleware({…})]` |
   | Metering | 2 (middleware + `ctx.emit`) | `effectMiddleware: [meteringMiddleware({…})]` — the emit is *inside* the middleware; the fold into `_resources` lives in schema-pinned replay-vm |
   | Safety | 2 (middleware + `ctx.emit`) | `effectMiddleware: [safetyMiddleware({…})]` |
   | Postgres store | 3 (Event+Snapshot+Branch/Timer) | `storage: { kind: "postgres", url }` — the union **already bundles** all three |
   | Cloud Run | 2 (dispatcher + worker SPI) | `dispatcher: <constructed CloudRun dispatcher>` |
   | Telemetry | 2 (adapter + onEvent) | `telemetry: [adapter]` — `onEvent` fan-out is internal to `defineConfig` |
   | T1 timers | 3 (store + service + runtime) | `timers: { store, schedules, … }` — **already bundled** |

   Of seven real features, **six are one config key**. The "hand-wire five things in the right
   order" pain the steelman rests on is largely already solved — by `defineConfig`'s own
   declarative bundling and by the K5-pinned fold, not by a plugin protocol.

3. **The one genuine multi-object assembly is Cloud Run** (platform SPI + worker runtime +
   sizing policy + dispatcher). That is *construction verbosity*, solvable by a plain factory
   `cloudRunDispatcher(opts): ExecutionDispatcher`, with no plugin brand, no `setup()`
   lifecycle, no manifest.

4. **The proposal's own forcing-function test has already run — and came back "no plugin
   needed."** Litmus test #4 was "build T1 durable timers as the first plugin." T1 shipped
   (ADR-0025) as a `timers` config block. K7–K12 all shipped as one `defineConfig` key / one
   `ctx.*` method each — that is literally non-negotiable #2 in the prior evaluation
   ([kernel-hardening evaluation](2026-07-10-kernel-hardening-evaluation.md), "one optional
   `defineConfig` key… the bar is loom-starter's ~10-line wiring"). The seams keep proving
   sufficient *without* a packaging abstraction.

5. **`@loom/plugin-observability` — the motivating example spanning
   middleware+projection+CLI+telemetry+widget simultaneously — does not exist.** The closest
   thing (`@loom/analytics`) is a read-only offline lens deliberately *not* wired into config
   at all. The abstraction's flagship consumer is hypothetical.

## The four non-negotiables (inherited from the kernel-hardening evaluation)

1. **Kernel genericity (P10)** — the kernel carries mechanism; a plugin may only contribute to
   *existing* seams, never add a kernel hook site.
2. **DX is THE priority** — the bar is loom-starter's ~10-line wiring. A new abstraction must
   *beat* `defineConfig`'s current ergonomics, not merely match them with more ceremony.
3. **Performance (G2)** — zero-overhead-when-unused must be *benchmark-provable*. Post-boot,
   the assembled runtime must be byte-identical to hand-wiring (assert identity, like G2).
4. **Safety** — anything that looks like a guarantee but is forgeable is theater.

## Verdict summary (three-tier)

| Interpretation | Verdict | Why |
|---|---|---|
| **(A) Runtime extension system** — lifecycle hooks (`onBeforeStep`, `onEventAppend`), dynamic `node_modules` discovery, fold-path reducers | **Reject** | Kills ADR-0015's fold optimization, freezes internal ABI, violates P5 (static wiring) and P2/P9 (deterministic fold). This is the "plugin magic" ADR-0006 already refused. The proposal agrees. |
| **(B) Public third-party plugin *brand*** — a shipped `LoomPlugin` interface inviting an external ecosystem | **Reject (for now)** | `setup()` runs at boot with **full ambient Node authority** and *cannot* be sandboxed — K7 data-plane isolation covers tool *effects*, not composition-time code building your runtime. A third-party plugin brand is a new, unmitigated supply-chain surface with **zero current external consumers**. Publishing the brand creates an ecosystem promise the isolation story cannot yet honor. |
| **(C) Internal composition helper** — a `preset`/`module` = pure `(opts) => Partial<LoomConfig>` + a deterministic `mergeConfigs`, no manifest, no `setup()` lifecycle, no public brand | **Defer — build only when a concrete feature needs it** | Genuinely cheap and G2-safe, but marginal today: `defineConfig` already bundles, and the sole real gap (Cloud Run construction) is a one-line factory. Adopt when a real feature must contribute ≥3 seams *at once* and no single config key fits — not speculatively. |

**Bottom line:** as a runtime system, unnecessary overhead and the specific temptation this
codebase has documented resisting twice (ADR-0006, and the P10/advisory-plane discipline). As
a *composition-layer formalization*, the idea is sound but **premature** — it is a solution
searching for a problem the codebase keeps solving without it. The right artifact today is not
`LoomPlugin`; it is (i) this recorded decision, (ii) a plain `cloudRunDispatcher()` factory if
Cloud Run wiring is judged too verbose, and (iii) a **trigger condition** for revisiting (C).

## Requirements — the constraints any future helper (tier C) MUST satisfy

Captured now so a future implementation cannot quietly drift into tier A/B.

- **CL1 — Composition-time only.** A module is a pure function `(opts) => Partial<LoomConfig>`
  invoked once during `defineConfig`. No runtime object ever learns modules exist. (P5)
- **CL2 — Static values, no discovery.** Modules are statically imported and passed in config.
  No `node_modules` scanning, no string-to-`import` resolution, no env-conditional
  registration. A resumed/remote worker must reconstruct identical wiring. (P5)
- **CL3 — Contribute to existing seams only.** A module may return array-appends
  (`effectMiddleware`, `telemetry`, `surfaces`, `flows`, `agents`) and *at most one* claim per
  singleton seam (`storage`, `dispatcher`, `projectionRuntime`, `authorizer`). Two modules
  claiming the same singleton ⇒ boot error. **No new kernel hook site may be introduced** to
  support any module. (P10, non-negotiable #1)
- **CL4 — No fold-path extensibility.** A module may **not** inject a reducer into
  `foldEvents`/replay-vm. Durable custom facts are emitted as ordinary app events and folded by
  user-space projections (already extensible, outside durable-state ABI). This keeps K5 schema
  pinning enforceable and replay independent of module version/order. (P2/P9, K5)
- **CL5 — Byte-identical to hand-wiring (G2).** The `LoomApp` produced from a module set must be
  provably identical to the hand-wired equivalent. Ship an identity bench: `module-composed`
  vs `hand-wired`, asserted equal. Zero post-boot overhead by construction.
- **CL6 — Sugar, never replacement (P6).** Hand-wiring `defineConfig` stays fully supported and
  documented. Modules are exactly as optional as `defineConfig` is over raw `WorkflowRuntime`
  construction. Nothing a module does is unavailable to a developer writing config by hand.
- **CL7 — Deterministic, semantically-correct merge order.** Array concatenation order must be
  explicit and stable. **Middleware order is behavioral, not cosmetic** (metering-then-retry
  meters once; retry-then-meter meters per attempt) — so a module contributing middleware MUST
  declare its intended position relative to the base chain; "config order = composition order"
  is *necessary but not sufficient*. The merge must let the app author override placement.
- **CL8 — No public plugin brand without an isolation answer.** Tier (C) stays internal/first-
  party. Promoting it to a public `LoomPlugin` ecosystem (tier B) requires first resolving that
  `setup()` runs with unsandboxable ambient authority — i.e. a real supply-chain/authority
  story, referenced against K7/K12 — recorded in its own ADR. (non-negotiable #4)

## Decision gate — when to revisit tier (C)

Build the composition helper **iff** a concrete, in-tree feature must contribute **≥3 seams at
once** and no single `defineConfig` key naturally bundles it (the way `storage`/`timers`
already do). Until such a feature appears, the marginal value over the status quo does not clear
non-negotiable #2 (DX): more concept, not less ceremony.

If/when that feature appears, the cheapest correct first step is the plain-factory /
`Partial<LoomConfig>` form (CL1–CL7), **not** the `contributes`-manifest `LoomPlugin`. The
manifest and boot-time coherence validation are a worthwhile *second* increment only once there
are ≥2 real modules whose interaction actually needs policing.

---

## Addendum (2026-07-13) — Packaging: minimal kernel, adapters as plugins, 1P/3P split

> The concrete consumer that justified acting *now* was not a new feature but a **packaging**
> goal: keep the kernel minimal by relocating vendor-specific **adapters** out of `packages/`
> into a `plugins/` tier, with a first-party / third-party separation. Decision recorded in
> **[ADR 0043](../adr/0043-plugin-packaging-and-1p-3p-separation.md)**. This addendum captures the
> grounded inventory and the requirements that decision operates under.

### Classification of all 53 packages (litmus: *"exists because of a specific external system?"*)

| Bucket | Stays / Moves | Packages |
|---|---|---|
| **Kernel** (mechanism/ABI) | stays `packages/` | core, event-runtime¹, snapshot-runtime¹, replay-vm, effect-runtime, workflow-runtime, scheduler, wire-abi, sdk |
| **SPI-contract** (interface + in-memory reference) | stays `packages/` | worker-runtime, projection-runtime, llm, blueprint-runtime, registry, telemetry, dispatcher² |
| **Adapter** (vendor/backend/protocol/framework) | → `plugins/` | store-postgres, store-crypto, platform-cloudrun, worker-runtime-remote, worker-server, mcp, a2a, renderer-react, renderer-terminal, audit-chain, **+ new plugin-sqlite** |
| **Advisory** (generic optional module) | **stays** — not adapters | middleware, isolate, fair-scheduler, reasoning, memory, agent, capability, intent, planner, saga, orchestration, orchestrator, graph-executor, analytics, app |
| **Tooling** (build/dev/CLI/test) | stays | compiler, cli, eval, verify, deploy-sim, scaffold, appgen, appgen-model, testing, spec, dst, create-loom-app |

¹ `event-runtime`/`snapshot-runtime` currently **mix** an SPI with the SQLite driver (and ship
`better-sqlite3`). PK1 below splits the driver out; the interface + in-memory reference stay.
² `dispatcher` holds the interface + `LocalDispatcher` (reference, stays); `PlacementDispatcher` /
`SupervisingDispatcher` are advisory policies — **do not fragment into three packages**.

### Verified entanglements (block a naïve move)

- **PK-E1** `event-runtime` has a hard `better-sqlite3` dependency and holds
  `SqliteEventStore`/`SqliteBranchRegistry`/`SqliteTimerStore` next to the interface.
- **PK-E2** `workflow-runtime` (kernel) imports `@loom/a2ui` (`createA2UIEmitter`). a2ui's emitter
  contract backs the `ui` KERNEL_SYSCALL → a2ui is not a leaf adapter; its contract stays in the
  kernel/SPI tier, concrete-protocol split deferred.

### Packaging requirements

- **PK1 — split, don't just move.** Extract SQLite → `@loom/plugin-sqlite` (takes `better-sqlite3`);
  `event-runtime`/`snapshot-runtime` shed the native dep; `@loom/event-runtime/memory` subpath
  unchanged; repoint `@loom/app`'s lazy `kind:"sqlite"` loader.
- **PK2 — relocation is name-stable.** `git mv packages/x plugins/x` keeps `@loom/x`; only
  workspace globs + tsconfig `references`/`paths` update. Renaming to `@loom/plugin-*` is a
  *separate*, breaking step gated on re-export shims.
- **PK3 — preset inversion (required for 1P/3P symmetry).** Store plugins export
  `postgresStorage()`/`sqliteStorage()` returning a `StorageConfig`; `@loom/app` keeps only
  `kind:"memory"|"custom"` and drops vendor deps. A 3P store backend cannot add a `kind:` arm, so
  vendor `kind`s would make 1P/3P asymmetric — this **resolves the storage fork in favour of
  presets** on architectural, not aesthetic, grounds.
- **PK4 — 1P/3P is organisational, not mechanical.** Identical contract; no runtime 1P/3P branch.
  1P = `plugins/` under `@loom/plugin-*` (the `@loom/plugins` "namespace" = the workspace dir +
  optional umbrella meta-package, since npm scopes are single-level), conformance-gated in loom CI.
  3P = the `loom-plugins` community repo *or any repo*, named `loom-plugin-*` / keyword
  `loom-plugin`, depending only on published `@loom/*` SPI packages. No central registry (P5:
  plugins are explicit imports).
- **PK5 — checkable, not just foldered.** Each plugin runs the ADR-0033 conformance suite for its
  SPI; a CI layering guard forbids `packages/* → plugins/*` deps.
- **PK6 — security honesty.** Presets/adapter constructors run at composition time with
  unsandboxable ambient authority. 1P is core-vetted; 3P is the app author's supply-chain call.
  A published `LoomPlugin` brand + manifest (CL8) stays blocked until that authority story exists.

### Open public-surface question (tracked, not decided)

`@loom/sdk` re-exports some adapters (`a2a`, `a2ui`, `mcp`, `renderer-terminal`). Relocation
doesn't change that; whether the blessed barrel *should* re-export adapters is a separate call.

### Compiler plugin support (`@loom/compiler`) — analysed, rejected

Applying the kernel/1P/3P triage to the **build-time** layer.

- **Grounding:** `loomPlugin()` is *itself* a Vite plugin (`enforce:"pre"`, no options); the marker
  set (`step$`/`flow$`/`skill$`/`handler$`/`instructions$`) is a closed, string-matched list; and
  the emitted `loom-manifest.json` is a versioned contract (`COMPILER_MANIFEST_VERSION`) whose
  per-step **hashes feed K11 flow-versioning, resume-refusal, and deploy-sim drift** (ADR 0023
  requires the hash be over "compiler-normalized manifest content, never raw bundler output").
- **Verdict:** the compiler's **transform pipeline + marker set + manifest schema = the compile-time
  ABI → kernel-tier, closed** (twin of `KERNEL_SYSCALLS`/`EVENT_SCHEMA`; extend only by a
  core/language decision). A pipeline-hook plugin API is the **build-time twin of fold-path
  extensibility** — it makes the determinism-critical hash a function of 3P code (order/version) and
  breaks K11. It also **duplicates Vite/Rollup's plugin pipeline** (which loom already composes into)
  and freezes compiler internals as ABI. **Reject.**
- **Where build-time extensibility legitimately lives (both read-only, already present):**
  (1) consume the **versioned `loom-manifest.json`** artifact — the "lens on output" twin of
  analytics reading the log without hooking the fold; (2) a pure **`validators: FlowGraphValidator[]`**
  array on `loom check` / `defineConfig({validate})`. Cheap follow-ups: *document + version the
  manifest as the public compiler output contract*; add the validators array if demand appears.
  New `$`-markers are a versioned language change, never a plugin.
