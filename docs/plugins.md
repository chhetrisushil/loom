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

## Should it exist at all?

The contract above says what a plugin *is*; [ADR 0043](adr/0043-plugin-packaging-and-1p-3p-separation.md)'s
litmus says whether a thing is a plugin or belongs in the kernel. Neither asks whether it should
be **first-party surface**, which is a separate question with its own rule:

> **The second-consumer rule** ([ADR 0083](adr/0083-second-consumer-rule.md)) — before a
> workload-derived requirement becomes a 1P package, a new `@loom/verify` rule, a new seam, or an
> exported *vocabulary*, name a second **unrelated** consumer of the same mechanism. If you
> cannot, it is application code: land it in the consuming app (or `loom-examples`) and say what
> would change the verdict.

It gates 1P surface only — a 3P plugin is its author's business — and it is applied **in review,
against a claim written in the proposing ADR**, not by the author's own judgement. "Obviously
generic" is a missing answer, not a passing one.

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

- Light 1P plugins (protocols, renderers) → `import { … } from "@loom/sdk"` — today
  `@loom/plugin-a2a`, `@loom/plugin-mcp`, `@loom/plugin-renderer-terminal`.
- Native/heavy 1P plugins → their own subpath: `import { SqliteEventStore } from "@loom/sdk/sqlite"`,
  `import { postgresStorage } from "@loom/sdk/postgres"`,
  `import { sandboxEval$ } from "@loom/sdk/sandbox"`.

Plugins outside the barrel (renderers with a framework peer dependency, the compute adapters, the
UI-protocol plugins) are imported by their own package name — being outside the barrel is a
packaging call about weight and peer deps, not a tier.

The barrel also re-exports a few non-plugin packages that are part of the public surface —
notably `@loom/registry` (`AgentRegistry`/`globalAgentRegistry`, the agent-card registry the A2A
peer client reads), which has no plugin of its own but is imported through `@loom/sdk`.

3P plugins are never in the barrel; you import them by their own name. Both remain explicit
imports, so the 1P/3P distinction stays purely organisational.

### Current first-party plugins

Eighteen, grouped by the seam each one fills. Storage and data first, then protocols, surfaces,
and compute.

**Storage & data**

- `@loom/plugin-sqlite` — embedded SQLite `Event`/`Snapshot`/`Branch`/`Timer`/`DurableState`/
  `ReadModel`/`Content` stores + the `sqliteStorage()` preset.
- `@loom/plugin-postgres` — network Postgres stores (LISTEN/NOTIFY) + `postgresStorage()`.
  **Bring your own pool:** the stores accept any object satisfying `PoolLike` — `query`,
  `connect`, `end`, and optionally `options` — so a pool from a *different copy of `pg`*
  (the normal state for a `link:`/`file:` consumer, where each side resolves its own), or an
  API-compatible one from a serverless driver or an instrumented wrapper, is borrowed rather
  than refused. A borrowed pool is never `end()`ed by a store's `close()`. `postgresPool()`
  is still exported for a caller who wants a real `pg.Pool` from this package — the sizing
  surface (`totalCount` and friends) that `PoolLike` deliberately omits. Without `options`,
  the dedicated `LISTEN` session cannot be opened and cross-node delivery degrades; the log
  stays authoritative and same-process subscribers are unaffected.
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
- `@loom/plugin-audit-chain` — tamper-evident hash-chained `EventStore` wrapper. Wrap it
  *outside* `ContentResolvingEventStore` if you use both — inverted, the chain hashes only the
  content ref and a rewritten blob verifies clean (see the plugin README).

**Composition patterns**

- `@loom/plugin-sentinel` — `sentinelPreset()`: the perpetual-agent pattern (schedule + carry
  state + claim-check + K10.6 pin policy) as one composition-time declaration, plus the
  `loom new sentinel` scaffold.
- `@loom/plugin-sandbox` — hardened QuickJS-in-WASM eval of content-addressed, LLM-authored
  reshaping scripts: in-engine memory/CPU/wall-clock limits, no ambient I/O by construction,
  output shape-hash validation; `scriptMissing`/`limitExceeded`/`shapeMismatch` are typed
  channels so a planner re-plans and replay never re-burns CPU
  ([ADR 0064](adr/0064-sandbox-eval-plugin.md)).

**Protocols**

- `@loom/plugin-mcp` — MCP **client + server**. Client: dynamic dispatch — `mcpInvoke$` mints
  steps whose tool name/args/schema-pin are runtime data through ONE registered `mcp.invoke`
  effect; pinned `jsonSchemaHash` verified per call → typed `schemaDrift`/`toolNotFound`
  channels; principals ride `ctx.principal`/`secretRef`, never the log; `MCP_DISPATCHED` +
  `mcpDispatchIndex` projection for the "which executions called tool X at schema H" query
  ([ADR 0063](adr/0063-mcp-dynamic-dispatch.md)). An in-band `isError` throws rather than
  returning a failure as a value. A step yields the convenience projection
  (`structuredContent`, else joined-and-parsed text) by default and the whole `CallToolResult`
  under `resultFidelity: "full"` — the only shape in which `_meta` and non-text content blocks
  survive, and therefore the only one in which a UI declaration is visible to a flow. Server:
  `createMcpServer` exposes Loom tools/resources to any MCP host (the
  `createA2AServer` analogue) with audience-scoped listing/dispatch, and `servedEffect` routes a
  call by its declared seam. The transport answers OAuth-discovery probes under `/.well-known/`
  with 404 above the authorize gate, and negotiates the protocol version on `initialize` rather
  than asserting it — the two things a hosted client settles before it will talk to a remote
  server at all. Also carries MCP Apps (`io.modelcontextprotocol/ui`) declarations and `ui://`
  resources with content-hash provenance — **carry, never render** — writing both the nested and
  the deprecated flat `_meta` UI form on egress and accepting either on ingress, because the
  reference SDK emits both ([ADR 0072](adr/0072-mcp-apps-ui-extension-placement.md)). A dispatch
  whose result declares a UI records `MCP_UI_OBSERVED` with the resource URI and an explicit
  `pin` — `embedded` (inlined, hashed for free), `resolved` (`resolveUi` fetched it),
  `not-requested`, or `unresolvable` — so "no pin" is never ambiguous between *not asked for*
  and *asked for and unavailable*.
- `@loom/plugin-mcp-app` — MCP Apps (SEP-1865) **egress**: projects a Loom agent surface onto
  the extension as ONE static, content-pinned surface-host template whose payload is the
  existing A2UI catalog model — so MCP Apps is a second *transport binding* for a surface
  protocol Loom already ships, not a second UI protocol, and the rendered UI is a pure function
  of (pinned template hash, logged `structuredContent`). The extension has no server push, so an
  `ambient`/app-visibility `loom.surface.since` cursor over `EventStore.readRange` is the View's
  refresh channel; `seenSequence` + `isStale` carry decision provenance across a long
  suspension. Egress redaction is required-by-configuration, never defaulted. The **host** role
  (iframe, CSP, postMessage) is deliberately out of scope
  ([ADR 0072](adr/0072-mcp-apps-ui-extension-placement.md)).
- `@loom/plugin-a2a` — Agent-to-Agent protocol, **client + server**. `A2APeerClient` discovers a
  remote agent's card and registers it as an ordinary Loom tool; `createA2AServer` publishes your
  flows as an A2A agent (`/.well-known/agent.json`, `/tasks/send`) with `LoomAgentExecutor`
  mapping execution status onto A2A task state.

**Surfaces**

- `@loom/plugin-a2ui` — projects a Loom agent surface onto the Google **A2UI** wire protocol v1.0
  (`createSurface`/`updateDataModel`/`deleteSurface`), so any A2UI-compliant client renders a
  Loom-driven UI. Egress + inbound actions + `callFunction` bidirectional RPC — the client's
  *result* re-enters as a recorded fact under a deterministic `callId`, which is what keeps a
  client-invoked function inside Loom's replay grain
  ([ADRs 0069](adr/0069-a2ui-egress-adapter.md)–[0070](adr/0070-a2ui-callfunction-bidirectional-rpc.md)).
  Continuous two-way binding sync is out of scope.
- `@loom/plugin-renderer-react` — React blueprint renderer (`defaultRegistry`); React is a peer
  dependency, so it stays out of the `@loom/sdk` barrel. Placed grid cells get explicit
  `grid-column`/`grid-row`, titled layouts a `<section>` with an `h2` (ADR 0098). A layout's
  `role` is ignored — it draws the plain container (ADR 0099). An `empty` binding status draws a
  `role="status"` "no data" marker in place of the widget (ADR 0100). A layout's `id` is its
  container's React key, so a container inserted or reordered around it keeps its widgets'
  DOM; the markup is unchanged (ADR 0101).
- `@loom/plugin-renderer-terminal` — string/terminal blueprint renderer
  (`renderBlueprintToString`), the second surface that proves blueprint delivery is
  renderer-agnostic rather than React-shaped. Kind-aware when given a registry —
  `defaultTerminalRegistry` covers the eight built-in kinds and an unregistered kind is marked
  `[kind]` on the surface rather than flattened silently (ADR 0096). A widget with a declared
  binding status renders the canonical `⋯`/`~`/`✗`/`○` glyph (`○` no data, ADR 0100) plus, when `source.degradedFrom` is
  set, a trailing `(degraded from …)` suffix — absent either, the line is unchanged (ADR 0097).
  Placed grid cells print in reading order and a titled layout under an underlined heading
  (ADR 0098); a layout's `role` or `id` changes nothing in the output (ADR 0099, ADR 0101).

**Compute**

- `@loom/plugin-worker-remote` — `RemoteWorkerRuntime`: dispatches an `ExecutionPackage` to a
  stateless worker's `POST /execute` and collects the `ExecutionResult`.
- `@loom/plugin-worker-server` — `createWorkerServer`: the other half, and the container
  entrypoint for remote/Cloud Run execution — runs one `ExecutionPackage` on an injected
  `WorkerRuntime`.
- `@loom/plugin-cloudrun` — Cloud Run adapter: `CloudRunWorkerRuntime` maps `DispatchMetadata`
  onto a sizing config and resolves a service endpoint, with cloud specifics behind the
  `CloudRunPlatform` SPI (`StaticCloudRunPlatform` runs the same path offline)
  ([ADRs 0001–0005](adr/)).

## Scaffolding a plugin

The CLI generates a ready-to-fill package for a seam, in first- or third-party shape, with the
preset stub, an SPI implementation stub, and a conformance-wired test:

```
loom plugin seams                              # list the seams you can target
loom plugin new store my-backend               # third-party: ./loom-plugin-my-backend
loom plugin new store my-backend --first-party # first-party: ./plugins/my-backend (@loom/plugin-*)
```

Seams: `store`, `dispatcher`, `telemetry`, `middleware`, `timer`, `lease`, `content`,
`durable-state`, `read-model`, `keystore`, `memory`, `projection`, `worker`, `llm`,
`authorizer`, `execution-authorizer`,
`resume-authenticator`, `timer-dispatcher`, `policy`. Then implement
the SPI, un-comment the conformance test, and run your formatter.

**`policy` is the one seam that is not a `defineConfig` contributor.** Every other seam is
passed to the composition root; a `Policy` ([ADR 0080](adr/0080-learning-substrate.md)) is
consumed from *flow code* via `decideWithPolicy(ctx, id, policy, context, actions)`. That is
deliberate — the runtime never learns a policy exists, so a learned choice can only reach a run
through `ctx.decide`, where it is recorded, replayable and auditable. Everything else about
authoring one is identical: same naming, same peer-dependency rule, same conformance
requirement (`runPolicyConformance`).

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
// 1. implement the SPI (or reuse an existing store). Each SPI lives in its OWN package.
import type { EventStore } from "@loom/event-runtime";
import type { CustomStorage } from "@loom/plugin-kit";
import type { SnapshotStore } from "@loom/snapshot-runtime";

// 2. export a preset returning the shape defineConfig accepts. Name the CONTRACT TYPE
//    rather than re-declaring its shape: a copied shape silently stops matching when the
//    contract evolves, whereas the imported type turns that into a compile error.
export function myStorage(opts: { url: string }): CustomStorage {
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
