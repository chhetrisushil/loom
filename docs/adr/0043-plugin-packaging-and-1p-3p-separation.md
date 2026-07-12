# ADR 0043 — Plugin packaging: minimal kernel, adapters as plugins, 1P/3P separation

- Status: Accepted (2026-07-13)
- Date: 2026-07-13
- Builds on: [ADR 0006](0006-config-and-effect-middleware.md) (static, replay-safe composition —
  *not* dynamic plugin magic), [ADR 0033](0033-spi-conformance-contracts.md) (SPI map +
  portable conformance suites), and the P5/P6/P10 principles in
  [architecture.md](../architecture.md).
- Part of: **packaging / repository structure only — the framework kernel and public runtime
  behaviour are not modified.** No new runtime protocol, no discovery, no hook bus.
- Related: [requirements + evaluation](../requirements/2026-07-13-composition-layer-plugins.md)
  (the CL1–CL8 constraints this ADR operates under).

## Context

The composition-layer evaluation (the related requirements doc) rejected a *runtime* plugin
system and accepted, at most, a **composition-time contributor** model: a plugin is a package
that implements an existing SPI and/or returns a `Partial<LoomConfig>`, statically imported and
passed to `defineConfig`. The kernel never learns plugins exist.

What remained was a **packaging** decision. A grounded inventory of all 53 packages found:

- The kernel *mechanism* packages (`core`, `event-runtime`, `snapshot-runtime`, `replay-vm`,
  `effect-runtime`, `workflow-runtime`, `scheduler`, `wire-abi`) and the *SPI-contract* packages
  (`worker-runtime`, `projection-runtime`, `llm`, `blueprint-runtime`, `registry`, `telemetry`,
  and the `dispatcher` interface) are generic — they carry mechanism, not vendor.
- ~11 packages are **concrete adapters** that exist because of a specific external system:
  `store-postgres` (pg), `platform-cloudrun` (GCP), `store-crypto`, `audit-chain`,
  `worker-runtime-remote` (HTTP), `worker-server`, `mcp`, `a2a`, `renderer-react`,
  `renderer-terminal` — plus the SQLite drivers currently *buried inside* `event-runtime` /
  `snapshot-runtime`.
- Two concrete entanglements block a naïve move (both verified in source):
  1. **`event-runtime` ships `better-sqlite3` as a hard dependency** and holds the
     `SqliteEventStore`/`SqliteBranchRegistry`/`SqliteTimerStore` alongside the `EventStore`
     *interface* and the in-memory reference. The kernel event package literally carries a native
     DB driver.
  2. **`workflow-runtime` (kernel) imports `@loom/a2ui`** (`createA2UIEmitter` in
     `WorkflowContext.ts`). a2ui's emitter *contract* is fused into the `ui` KERNEL_SYSCALL, so
     a2ui is not a leaf adapter.

The maintainer additionally requires a **first-party / third-party split**: 1P plugins in this
repo under the `@loom/` scope; 3P plugins in a separate `loom-plugins` community repo, with
authors free to keep plugins in any repo they like.

## Decision

### D1 — A minimal kernel; concrete adapters become plugins

Classify every package by the litmus test *"does it exist because of a specific external system
(DB engine, cloud vendor, wire protocol, UI framework)?"* Yes → **plugin**. Generic mechanism →
**kernel**. Generic *optional* pattern (retry, saga, reasoning, memory, …) → **advisory, stays
put** (these are "generic enough" and are explicitly **not** adapters). In-memory / local
*reference* implementations stay next to their SPI (the kernel needs them to boot and self-test).

Add a `plugins/*` glob to `pnpm-workspace.yaml`, peer to the existing `packages/*` / `apps/*` /
`tools/*` convention. Move the adapter packages there. **Package names are the contract, not
folder paths** — pnpm/turbo resolve by name, so relocation is inert for importers; only
path-coupled config (workspace globs, tsconfig `references`/`paths`) updates.

### D2 — Split the two packages that mix an SPI with a vendor driver

- Extract the SQLite drivers into a new plugin **`@loom/plugin-sqlite`** (takes `better-sqlite3`
  with it). `event-runtime` / `snapshot-runtime` keep the interface + in-memory reference and
  **shed the native dependency**. The `@loom/event-runtime/memory` subpath is unchanged.
- Leave `@loom/dispatcher` intact: its interface + `LocalDispatcher` (reference) are kernel-grade;
  `PlacementDispatcher` / `SupervisingDispatcher` are *advisory policies*, not vendor adapters.
  **Do not fragment it into three packages.**
- `a2ui`: keep the `A2UIEmitter` contract in the kernel/SPI tier (it backs the `ui` syscall).
  Splitting the concrete patch/event protocol into a plugin is deferred (see Non-goals) — do it
  only if the wire format ever needs to be swappable.

### D3 — Preset inversion (resolves the storage-`kind` fork on 1P/3P grounds)

`@loom/app` today hard-depends on `@loom/store-postgres` and lazy-loads SQLite from
`event-runtime`, and the `storage` union names vendors (`kind:"postgres"|"sqlite"`). A third-party
store plugin can *never* add a `kind:` arm to the core union — so vendor `kind`s make 1P and 3P
**asymmetric**. Therefore each store plugin exports a **preset** returning a `StorageConfig`:

```ts
storage: postgresStorage({ url })   // from @loom/plugin-postgres
storage: sqliteStorage({ dir })     // from @loom/plugin-sqlite
```

`@loom/app` keeps only `kind:"memory"` (default) and `kind:"custom"` (the escape hatch presets
resolve to), and **drops its vendor dependencies**. 1P and 3P storage backends are now wired
identically. Trade-off, accepted: one extra import versus the old zero-import `kind` sugar. This
is the CL1–CL7 `(opts) => Partial<config>` pattern applied to the (singleton) storage seam.

### D4 — First-party vs third-party is organisational, never mechanical

Both use the **identical contract** (§Plugin contract). The kernel treats them the same; there is
no 1P/3P branch anywhere in the runtime.

- **1P plugins** live in this repo under `plugins/`, published as **`@loom/plugin-<name>`**
  (npm scopes are single-level, so `@loom/plugins` is realised as the `plugins/` workspace dir
  plus an optional `@loom/plugins` umbrella meta-package that re-exports the set — *not* a package
  namespace). 1P plugins are conformance-gated in loom CI, versioned with the kernel, and
  security-reviewed by core.
- **3P plugins** live in a separate **`loom-plugins`** community repo (the curated-but-not-core
  home) *or in any repository the author chooses*. Convention: name them **`loom-plugin-<name>`**
  (or `@scope/loom-plugin-<name>`) and tag the npm keyword `loom-plugin` for discovery — mirroring
  `eslint-plugin-*` / `vite-plugin-*`. They depend on the published `@loom/*` **SPI** packages
  only. **No central registry is required or wanted**: a plugin is a statically-imported value
  passed to `defineConfig` (P5), so "use a plugin" is always an explicit `import`, never
  discovery.
- **Promotion** 3P→1P is allowed when a plugin meets the 1P bar (maintained by/with core,
  conformance-gated in loom CI, security-reviewed). Demotion is the reverse.

### D5 — Make "plugin" a checkable category, not just a folder

- Every plugin's test runs the matching **conformance suite** from `@loom/testing/conformance`
  (ADR 0033). 1P runs it in loom CI; 3P is expected to run the published vectors in its own CI.
- Add a **CI layering guard**: no `packages/*` (kernel/SPI/advisory) may depend on `plugins/*`.
  A small test over the workspace graph (reusing `@loom/spec`'s manifest machinery) fails the
  build if an adapter creeps inward. This is the structural guarantee that keeps the kernel
  minimal over time; it is also what flags the a2ui exception explicitly.

## The plugin contract (normative)

A Loom plugin is a package that:

1. provides one or more **concrete implementations of an existing SPI** (store, dispatcher,
   worker, telemetry adapter, renderer, LLM provider, effect/protocol client), and/or an optional
   **preset** `(opts) => Partial<LoomConfig>` (or a singleton value: `StorageConfig`,
   `ExecutionDispatcher`, …);
2. is **statically imported** and passed to `defineConfig` — no discovery, no config-string
   resolution, no `node_modules` scanning (P5, CL2);
3. contributes **only to existing seams**; introduces **no kernel hook site** (P10, CL3) and
   **never a reducer into the fold** — durable custom facts are ordinary app events folded by
   user-space projections (K5, CL4);
4. is **byte-identical to hand-wiring** after boot — provable, zero post-boot overhead (G2, CL5);
5. ships **conformance tests** for each SPI it implements (D5);
6. is **sugar, never a gate**: hand-wiring the same objects into `defineConfig` stays fully
   supported and documented (P6, CL6).

There is deliberately no `LoomPlugin` interface, no `setup()` lifecycle object, no `contributes`
manifest at this stage — a plugin is just a package that exports adapters and/or a preset. (The
manifest/validation layer of CL8 is deferred until ≥2 plugins actually interact and need
policing.)

## Security note (load-bearing)

A preset and any adapter constructor run at **composition time with full ambient host authority**,
and **cannot be sandboxed** — K7 data-plane isolation governs *tool effects at runtime*, not the
code that builds your runtime. Consequences:

- **1P** plugins are vetted by core; that is the trust basis for the `@loom/` scope.
- **3P** plugins are the **app author's supply-chain responsibility.** Importing a 3P plugin is
  granting it boot-time host authority. The `loom-plugins` repo README must carry a vetting
  checklist; the docs must state that a 3P plugin is as trusted as any dependency you `import`.
- This raises the stakes on the K7/K12 isolation gap but does not change it: the guarantee was
  always "tool effects are isolated," never "composition code is." Promoting the contributor model
  to a *published `LoomPlugin` brand with a manifest* (CL8) stays blocked until that authority
  story has an answer.

## Consequences

- Kernel = ~8 mechanism + ~6 SPI-contract packages, none naming a vendor or shipping a native
  driver. `event-runtime`/`snapshot-runtime` lose `better-sqlite3`.
- `plugins/` = ~11 conformance-tested adapters under `@loom/plugin-*`; advisory modules untouched.
- `@loom/app` drops its `@loom/store-postgres` dependency; storage backends (1P and 3P) are
  symmetric.
- The public `@loom/sdk` barrel currently re-exports some adapters (`a2a`, `a2ui`, `mcp`,
  `renderer-terminal`). Relocation does not change that; **whether the blessed barrel should
  re-export adapters at all is a separate public-surface decision** (tracked, not decided here).
- Renaming `@loom/store-postgres` → `@loom/plugin-postgres` (etc.) is a breaking rename; ship
  thin re-export shims under the old names for one release, then remove.

## Non-goals / explicitly deferred

- **No** runtime plugin protocol, hook bus, dynamic discovery, or fold extensibility (ADR 0006,
  CL1–CL4 forbid them).
- **No** `LoomPlugin` interface / `contributes` manifest / `setup()` lifecycle yet (CL8).
- **No** dispatcher fragmentation; **no** moving in-memory/local reference impls out of the kernel.
- **a2ui contract/impl split** deferred until the UI wire format needs to be swappable.
- **Advisory packages stay in `packages/`** — they are generic optional modules, not adapters.

## Implementation status (2026-07-13)

Landed on branch `feat/plugin-packaging-1p-3p`, each phase built + tested + linted green:

- **Done — Phase 0:** `plugins/*` workspace tier; `@loom/spec` layering guard
  (`findLayeringViolations`, transitive) enforced in CI. ADR 0044 (compiler) recorded.
- **Done — Phase 2 (SQLite split):** `@loom/plugin-sqlite` created; `@loom/event-runtime` and
  `@loom/snapshot-runtime` **dropped `better-sqlite3`** from their dependencies (kernel packages
  now depend only on `@loom/core`). 20 importers relocated; kernel *tests* take the plugin as a
  devDependency (guard checks runtime deps only).
- **Done — Phase 3 (preset inversion):** `sqliteStorage()` / `postgresStorage()` presets;
  `@loom/app` **dropped its vendor dependencies** and the `kind:"sqlite"/"postgres"` union arms +
  the `loadNodeModule` hack. 1P and 3P storage backends now wire identically. Examples migrated.
- **Done — Phase 1/4 (storage family):** relocated + renamed `store-postgres → @loom/plugin-postgres`,
  `store-crypto → @loom/plugin-crypto`, `audit-chain → @loom/plugin-audit-chain`, all under
  `plugins/`. 3P authoring guide: [`docs/plugins.md`](../plugins.md).
- **Done — all remaining adapters relocated:** `worker-runtime-remote → @loom/plugin-worker-remote`,
  `worker-server → @loom/plugin-worker-server`, `platform-cloudrun → @loom/plugin-cloudrun`,
  `renderer-react → @loom/plugin-renderer-react`, `mcp → @loom/plugin-mcp`, `a2a → @loom/plugin-a2a`,
  `renderer-terminal → @loom/plugin-renderer-terminal`. **`plugins/` now holds all 11 first-party
  adapters**; `packages/` is kernel + SPI + advisory + tooling only.
- **Done — sdk re-exports 1P plugins** per the decision below: light plugins (`a2a`, `mcp`,
  `renderer-terminal`) in the main barrel; native/heavy store plugins behind `@loom/sdk/sqlite` and
  `@loom/sdk/postgres` subpaths so a bare `@loom/sdk` import stays lean.
- **Deferred by design:** the a2ui contract/impl split (Phase 5) and the `LoomPlugin` manifest/brand
  (CL8) remain gated as recorded above.
- **Decided (2026-07-13):** `@loom/sdk` **re-exports 1P plugins** — this is *curation*, not the
  forbidden *mechanical* 1P/3P asymmetry (D4 bans a runtime branch; a barrel re-export is neither).
  Guardrail: dependency-light 1P plugins (protocols, renderers) re-export from the **main** barrel;
  **native/heavy** ones (`plugin-sqlite`→better-sqlite3, `plugin-postgres`→pg) re-export via a
  **subpath** (`@loom/sdk/sqlite`, `@loom/sdk/postgres`) so a bare `import "@loom/sdk"` stays lean
  and browser-safe — preserving the very native-dep-shedding win this ADR lands. 3P plugins are
  never in the barrel (they are not core's to vouch for); both remain explicit imports, so
  value-level symmetry holds.

## Phasing

0. **Guard first** — land the CI layering check against today's graph (annotates the a2ui
   exception). The invariant is enforced before anything moves.
1. **Relocate clean adapters** (`git mv` to `plugins/`, names stable) — pure move, green build.
2. **SQLite split** into `@loom/plugin-sqlite`; ship the store-conformance suite with it.
3. **Preset inversion** (D3); `@loom/app` drops vendor deps.
4. **1P rename** to `@loom/plugin-*` with shims; stand up the `loom-plugins` repo + author
   template + vetting checklist.
5. **a2ui split** — only if/when the wire format must be swappable.
