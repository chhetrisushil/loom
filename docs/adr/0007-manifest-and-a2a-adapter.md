# ADR 0007 — Manifest cross-check, flow registration by shape, and the A2A AgentExecutor

- Status: Accepted (Tier 2 of the simplicity roadmap)
- Date: 2026-07-07
- Builds on: [ADR 0006](0006-config-and-effect-middleware.md)

## Context

Tier 1 gave apps `defineConfig` + middleware. Tier 2 reduces two more sources of
friction: hand-listing flows, and the bespoke A2A server. Both must respect the
determinism / keep-the-log invariants.

## Decision

**Flow registration by shape (not manifest dynamic-import).** The evaluation flagged
that dynamic-importing flows from a manifest path is exactly the env-dependent
wiring that breaks deterministic replay. So the replay-safe primitive is
`registerFlowsFrom(runtime, ...modules)` in `@loom/app`: the app **statically**
imports its flow modules (`import * as flows from "./flows"`) and hands the
namespaces over; every `RegisteredFlow`-shaped export is registered. Discovery is
by shape, so it also captures flows built via helpers (whose ids the compiler
can't read statically). The compiler manifest gains per-flow `module` + a
top-level `flowModules` list (metadata only), and `defineConfig` accepts a
`manifest` to **cross-check**: `manifestWarnings` reports (via `onWarn`) any flow
the compiler saw but nobody registered, and surfaces the compiler's own warnings —
at boot, instead of as a "No flow registered" error at dispatch.

**A2A reduces to one adapter.** `LoomAgentExecutor` (`@loom/a2a`) encapsulates the
A2A task lifecycle, which maps one-to-one onto Loom execution states:
submit→`start`, input-required→a suspend, provideInput→`resume`, completed/failed→
terminal `ExecutionState`. It is **stateless** — `get` rebuilds task status from
the durable log via `runtime.loadState`, with no in-memory handle map — so the
server can scale horizontally or restart without losing in-flight tasks (the same
statelessness the remote-worker model relies on). `createA2AServer` becomes a thin
HTTP transport over the executor. An external `@a2a-js/sdk` server could drive the
same executor; binding to it is a deferred, one-file follow-on (a real dependency +
protocol-conformance surface), so the in-house transport stays the default.

**Onboarding.** `tools/create-loom-app` scaffolds the ~10-file skeleton wired via
`defineConfig`, generated from string templates (unit-tested via a pure
`scaffoldFiles()`); `docs/examples/acme-support.org` is the end-to-end walkthrough.

## Consequences

- Apps can drop `flows: [...]` in favour of `flowModules: [flows]`, staying
  deterministic (static imports).
- The whole A2A layer is one adapter + a transport; the wire contract and all
  existing a2a tests are unchanged (`suspended→working` preserved).
- New packages: `tools/create-loom-app`. `@loom/a2a` gains `LoomAgentExecutor`;
  `@loom/compiler` manifest gains `module`/`flowModules` (additive).

## Verification

- `@loom/app`: `registerFlowsFrom` registers shaped exports / ignores non-flows /
  is idempotent / captures helper-built flows; `manifestWarnings` flags gaps;
  `defineConfig` integrates both.
- `@loom/a2a`: existing 12 tests pass unchanged; new `LoomAgentExecutor` tests
  cover status mapping, the full submit→input-required→provideInput→completed
  lifecycle, and unknown-task → null.
- `create-loom-app`: `scaffoldFiles` emits a defineConfig-wired skeleton with no
  unresolved placeholders; CLI smoke-generates 11 files.
- Full repo: build + typecheck clean, test tasks green, biome clean.
