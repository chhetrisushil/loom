# @loomwork/conformance

Portable conformance kits for loom's service provider interfaces (SPIs). A backend is conformant when it
passes the kit, not when it looks right. Each `run<Spi>Conformance(factory)` registers a vitest
`describe` block, so a storage backend, dispatcher, key store or sandbox that you write in your own
package proves itself in its own CI. The kits cover events, snapshots, archives, leases, branches,
timers, dispatchers, workers, projections, LLM providers, content, key, memory and read-model stores,
authorizers and sandboxes. `vitest` (2 or later) is a peer dependency, and the package is ESM.

```ts
// store.conformance.test.ts, in your backend's package
import { runEventStoreConformance, runEventStoreDecoratorConformance } from "@loomwork/conformance";
import { CoalescingEventStore, InMemoryAsyncEventStore } from "@loomwork/event-runtime";

// A backend: the factory returns a fresh, empty store on every call.
runEventStoreConformance(() => new InMemoryAsyncEventStore(), "InMemoryAsyncEventStore");

// A decorator: every optional method must survive a full-capability inner store, or be refused.
runEventStoreDecoratorConformance("CoalescingEventStore", (inner) => new CoalescingEventStore(inner));
```

## Surface

- **Storage.** `runEventStoreConformance`, `runSnapshotStoreConformance`, `runArchiveStoreConformance`,
  `runLeaseStoreConformance`, `runBranchRegistryConformance`, `runTimerStoreConformance`,
  `runContentStoreConformance`, `runDurableStateStoreConformance`, `runReadModelStoreConformance`,
  `runFoldedStateConformance`, `runMemoryStoreConformance`, `runVectorIndexConformance`.
- **Decorators.** `runEventStoreDecoratorConformance`, `runSnapshotStoreDecoratorConformance`,
  `runArchiveStoreDecoratorConformance`.
- **Runtime seams.** `runExecutionDispatcherConformance`, `runWorkerRuntimeConformance`,
  `runProjectionRuntimeConformance`, `runTimerDispatcherConformance`.
- **Models and security.** `runLlmProviderConformance`, `runEmbeddingProviderConformance`,
  `runKeyStoreConformance`, `runCapabilityAuthorizerConformance`, `runExecutionAuthorizerConformance`,
  `runResumeAuthenticatorConformance`, `runPolicyConformance`.
- **Sandbox.** `runSandboxBackendConformance(factory, { fixtures?, timeoutMs? })` with
  `JAVASCRIPT_FIXTURES`; it runs through `SandboxEffect`, so it proves the composition you deploy.

## Behaviour that surprises people

- **Call a kit at the top level of a test file**, not inside an `it`. It registers its own `describe`.
  Most kits take `(factory, label?)`; the factory is called per case, so it must hand back a fresh
  store. The event-store cases reuse the same execution ids.
- **Optional methods are skipped when absent.** `runEventStoreConformance` cannot tell a store that
  chose to omit `appendBatch` from a decorator that dropped it. For a decorator use
  `runEventStoreDecoratorConformance`, which wraps a store that has every optional method, so a missing
  one is the decorator's fault.
- **The SPI level is a claim under test.** `runEventStoreConformance` assumes the current level
  (`"2.6.0"`). A store that predates a minor passes `{ eventStoreSpi: "2.2.0" }` (or 2.3.0, 2.4.0,
  2.5.0) and the newer cases are skipped; claiming a level it does not meet fails.
- **Absent input is a failure, not a pass.** `runLlmProviderConformance` fails a streaming provider
  when you give it no `toolRequest`; a text-only provider opts out with `{ toolRequest: null }`.
  `runSandboxBackendConformance` refuses a non-JavaScript backend unless you pass `fixtures`.
- **A sealing content store needs `access`.** Without `{ access }`, `runContentStoreConformance` also
  asserts the plain-store rule that the argument is ignored.
- **Some cases wait.** The sandbox kit defaults to a 60 s per-case timeout, because a runaway script or
  allocation bomb may take a remote kill; a backend that cold-starts per run needs a larger `timeoutMs`.
- **The kit is evidence for what it asserts.** Passing it says nothing about behaviour it does not
  probe, such as your own durability under a crash.

## See also

- API reference: section "`@loomwork/conformance` — the portable SPI kits" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guide: [plugins](../../docs/plugins.md) (authoring a backend and proving it).
- ADRs: [0033 SPI conformance contracts](../../docs/adr/0033-spi-conformance-contracts.md),
  [0129 creation marker and incarnation](../../docs/adr/0129-creation-marker-incarnation.md),
  [0144 sandbox backend SPI](../../docs/adr/0144-sandbox-backend-spi.md).

## Install

`npm install @loomwork/conformance` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).
