# Loom plugins

A **plugin** is an ordinary package that contributes a concrete implementation of an existing
Loom seam (a store, dispatcher, worker, telemetry adapter, renderer, LLM provider, protocol
client) and/or a **preset** — a pure function returning a `Partial<LoomConfig>` (or a singleton
value like a `StorageConfig`). It is statically imported and passed to `defineConfig`. The
runtime never learns plugins exist; after boot the wiring is byte-identical to hand-wiring.

There is **no plugin runtime, no discovery, no hook bus, no `setup()` lifecycle** — those were
rejected (see [ADR 0006](adr/0006-config-and-effect-middleware.md),
[ADR 0043](adr/0043-plugin-packaging-and-1p-3p-separation.md)). "Using a plugin" is always an
explicit `import` plus one line in your config.

## The contract

A Loom plugin:

1. implements an existing **SPI** and/or exports a **preset** `(opts) => Partial<LoomConfig>`;
2. is **statically imported** and passed to `defineConfig` — no `node_modules` scanning, no
   config-string resolution (P5);
3. contributes only to **existing seams** — it never adds a kernel hook and never injects a
   reducer into the replay fold (durable custom facts are ordinary app events folded by
   user-space projections);
4. is **byte-identical to hand-wiring** after boot (zero runtime overhead);
5. ships **conformance tests** for each SPI it implements (`@loom/conformance`);
6. is **sugar, never a gate** — everything it does, you can also hand-wire into `defineConfig`.

## First-party (1P) vs third-party (3P)

The split is **organisational, not mechanical** — both use the identical contract and the kernel
treats them the same.

| | First-party (1P) | Third-party (3P) |
|---|---|---|
| Home | this repo, `plugins/` | the `loom-plugins` community repo — **or any repo you like** |
| Name | `@loom/plugin-<name>` | `loom-plugin-<name>` / `@scope/loom-plugin-<name>` (npm keyword `loom-plugin`) |
| Depends on | the workspace SPI packages | the published `@loom/*` **SPI** packages |
| Conformance | gated in Loom CI | run the published vectors in your own CI |
| Trust | vetted by core | **your** supply-chain responsibility (see Security) |

A 3P plugin can be **promoted** to 1P when it meets the 1P bar (maintained by/with core,
conformance-gated, security-reviewed).

### The public barrel (`@loom/sdk`) re-exports 1P plugins

Because 1P plugins are the curated set, `@loom/sdk` re-exports them — curation, not a runtime
privilege (a 3P plugin wires through the identical seams, it just isn't ours to vouch for). To
keep a bare `import "@loom/sdk"` lean and browser-safe, **native/heavy** plugins are re-exported
via a **subpath**, not the main barrel:

- Light 1P plugins (protocols, renderers) → `import { … } from "@loom/sdk"`.
- Native/heavy 1P plugins → `import { SqliteEventStore } from "@loom/sdk/sqlite"`,
  `import { postgresStorage } from "@loom/sdk/postgres"`.

3P plugins are never in the barrel; you import them by their own name. Both remain explicit
imports, so the 1P/3P distinction stays purely organisational.

### Current first-party plugins

- `@loom/plugin-sqlite` — embedded SQLite `Event`/`Snapshot`/`Branch`/`Timer`/`DurableState`/
  `ReadModel`/`Content` stores + the `sqliteStorage()` preset.
- `@loom/plugin-postgres` — network Postgres stores (LISTEN/NOTIFY) + `postgresStorage()`.
- `@loom/plugin-crypto` — field-level crypto-shredding store wrappers (K10) + `KeyStore` SPI.
- `@loom/plugin-content` — content-store seam: `ContentResolvingEventStore` externalizes marked
  payload fields to a content-addressed side store + `ContentStore` SPI ([ADR 0046](adr/0046-content-store-seam-thin-authoritative-log.md)).
- `@loom/plugin-durable-state` — typed, versioned, contract-migratable keyed carry state as
  RECORDED effects (replay folds the recorded value, never the store) + CAS revisions and the
  `sentinelState()` schedule-driven convenience ([ADR 0053](adr/0053-durable-state-plugin.md)).
  SQLite/Postgres backends ship in their storage plugins.
- `@loom/plugin-read-model` — durable, checkpointed cross-execution read models: app-declared
  extractors index domain events into a persisted, queryable store (kind + field-equality,
  keyset-paged); convergent ingestion from the live `onEvent` tail + watermark-incremental
  catch-up; a cache of the log, never an authority ([ADR 0058](adr/0058-read-model-plugin.md)).
- `@loom/plugin-sentinel` — `sentinelPreset()`: the perpetual-agent pattern (schedule + carry
  state + claim-check + K10.6 pin policy) as one composition-time declaration, plus the
  `loom new sentinel` scaffold.
- `@loom/plugin-audit-chain` — tamper-evident hash-chained `EventStore` wrapper.

## Scaffolding a plugin

The CLI generates a ready-to-fill package for a seam, in first- or third-party shape, with the
preset stub, an SPI implementation stub, and a conformance-wired test:

```
loom plugin seams                              # list the seams you can target
loom plugin new store my-backend               # third-party: ./loom-plugin-my-backend
loom plugin new store my-backend --first-party # first-party: ./plugins/my-backend (@loom/plugin-*)
```

Seams: `store`, `dispatcher`, `telemetry`, `middleware`, `timer`, `projection`, `worker`, `llm`,
`authorizer`. Then implement
the SPI, un-comment the conformance test, and run your formatter.

Validate it against the contract at any time:

```
loom plugin check --dir ./loom-plugin-my-backend
```

`check` verifies the naming convention, that the package does **not** depend on the replay fold
engine (`@loom/replay-vm` — the "no reducer into the fold" rule), that a 3P plugin peer-depends on
the `@loom/*` SPI (one kernel copy) and carries the `loom-plugin` keyword, and that a test wires
`@loom/conformance`. Non-zero exit on any error.

And **run a storage plugin end-to-end** — wire its preset into a real app, run a durable flow,
and confirm it persisted and replays (what `check` and conformance can't tell you):

```
loom plugin try --module ./loom-plugin-my-backend/dist/index.js \
  --preset myStorage --options '{"url":"…"}'
```

## Authoring a plugin (worked example: a storage backend)

```ts
// 1. implement the SPI (or reuse an existing store)
import type { EventStore, SnapshotStore } from "@loom/event-runtime";

// 2. export a preset returning the shape defineConfig accepts
export function myStorage(opts: { url: string }): {
  kind: "custom";
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
} {
  return { kind: "custom", eventStore: new MyEventStore(opts.url), snapshotStore: new MySnapshotStore(opts.url) };
}
```

```ts
// 3. the app wires it exactly like a first-party backend — no privileged `kind:`
import { defineConfig } from "@loom/app";
import { myStorage } from "loom-plugin-mystore";

export const app = defineConfig({ storage: myStorage({ url: process.env.DB_URL! }) });
```

```ts
// 4. prove conformance in your own CI
import { runEventStoreConformance } from "@loom/conformance";
runEventStoreConformance(() => new MyEventStore(":memory:"));
```

Presets that contribute middleware/telemetry/surfaces return a `Partial<LoomConfig>`;
`defineConfig` concatenates arrays with the app's explicit entries (order = composition order).
Middleware order is behavioural — declare where in the chain your middleware belongs.

## Discovering & publishing

Find published plugins by the `loom-plugin` npm keyword:

```
loom plugin search redis
```

Before you publish, run the readiness check — it adds npm-metadata checks (version bumped,
description, license, repository, entry point + types) on top of the contract check:

```
loom plugin check --dir . --publish
```

Pre-publish checklist:

- [ ] `name` is `loom-plugin-<name>` (or `@scope/loom-plugin-<name>`); keyword `loom-plugin` present
- [ ] `@loom/*` SPI packages are **peerDependencies**, not bundled
- [ ] a test wires `@loom/conformance` and passes (`run<Spi>Conformance`)
- [ ] `version` bumped, plus `description`, `license`, `repository`, and `exports`/`main`+`types`
- [ ] `loom plugin try` succeeds (for a store plugin) and `loom plugin check --publish` is clean

## Security (read this)

A preset and any adapter constructor run at **composition time with full host authority, and
cannot be sandboxed** — K7 data-plane isolation governs *tool effects at runtime*, not the code
that builds your runtime. Importing a plugin grants it boot-time authority, exactly like any
dependency you `import`.

- **1P** plugins are vetted by core — that is the trust basis for the `@loom/` scope.
- **3P** plugins are the **app author's supply-chain call.** Vet them as you would any dependency.

## Keeping the kernel minimal

A CI guard (`@loom/spec` `findLayeringViolations`) fails the build if any kernel or SPI package
gains a dependency on a `plugins/*` adapter. The kernel carries mechanism; adapters live outside
it. See [ADR 0043](adr/0043-plugin-packaging-and-1p-3p-separation.md).
