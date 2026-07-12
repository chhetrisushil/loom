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
5. ships **conformance tests** for each SPI it implements (`@loom/testing/conformance`);
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

### Current first-party plugins

- `@loom/plugin-sqlite` — embedded SQLite `Event`/`Snapshot`/`Branch`/`Timer` stores + the
  `sqliteStorage()` preset.
- `@loom/plugin-postgres` — network Postgres stores (LISTEN/NOTIFY) + `postgresStorage()`.
- `@loom/plugin-crypto` — field-level crypto-shredding store wrappers (K10).
- `@loom/plugin-audit-chain` — tamper-evident hash-chained `EventStore` wrapper.

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
import { runEventStoreConformance } from "@loom/testing/conformance";
runEventStoreConformance(() => new MyEventStore(":memory:"));
```

Presets that contribute middleware/telemetry/surfaces return a `Partial<LoomConfig>`;
`defineConfig` concatenates arrays with the app's explicit entries (order = composition order).
Middleware order is behavioural — declare where in the chain your middleware belongs.

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
