# ADR 0044 — No compiler plugin API; the manifest is the public build-time contract

- Status: Accepted (2026-07-13)
- Date: 2026-07-13
- Builds on: [ADR 0006](0006-config-and-effect-middleware.md) (static composition, not plugin
  magic), [ADR 0011](0011-folder-convention-codegen.md) (codegen decoupled from the heavy
  compiler), [ADR 0023](0023-k11-flow-code-versioning-in-flight-executions.md) (K11 flow-code
  hash over compiler-normalized manifest content), [ADR 0043](0043-plugin-packaging-and-1p-3p-separation.md)
  (the kernel/1P/3P triage this applies to the build-time layer).
- Part of: the plugin-boundary analysis. **No kernel or runtime behaviour changes.**
- Related: [requirements](../requirements/2026-07-13-composition-layer-plugins.md) (§"Compiler
  plugin support — analysed, rejected").

## Context

The plugin question was raised for `@loom/compiler` — the build-time Vite plugin + CLI that does
`step$`/`flow$`/`skill$` extraction, `handler$`/`instructions$` chunking, flow-graph +
non-determinism analysis, and emits `loom-manifest.json`. Grounded facts:

- `loomPlugin()` is **itself a Vite plugin** (`enforce: "pre"`), and takes **no options** — there
  is no extension surface today (`tools/compiler/src/plugin.ts:10`).
- The recognised markers (`step$`, `flow$`, `skill$`, `handler$`, `instructions$`) are a **closed,
  string-matched set** validated by AST checks; adding one touches three layers (scanner,
  transform, visitor) (`tools/compiler/src/transform.ts`).
- The emitted manifest is a **versioned contract** (`COMPILER_MANIFEST_VERSION = "1"`,
  `tools/compiler/src/manifest.ts:5`) carrying per-step/chunk **hashes**. Those hashes feed
  **K11 flow-code versioning**, resume-refusal, and `deploy-sim` drift detection; `@loom/spec`
  pins the version and `@loom/app` cross-checks flows against it at boot. ADR 0023 requires the
  hash be computed over *"compiler-normalized manifest content, never raw bundler output"* so it
  is reproducible.

## Decision

**Do not add a compiler plugin / transform-hook API.** Apply the ADR-0043 triage to the build-time
layer:

1. **The transform pipeline + marker set + manifest schema are the compile-time ABI → kernel-tier,
   closed.** They are the build-time twin of `KERNEL_SYSCALLS` / `EVENT_SCHEMA`. They evolve only by
   a deliberate core/language decision (versioned), never by third-party contribution. A new
   `$`-marker is a language change, not a plugin.
2. **A transform-hook plugin API is rejected as the build-time twin of fold-path extensibility.**
   The compile output feeds determinism-critical machinery (K11 hash → resume-refusal, deploy-sim
   drift). If third-party passes participate, the manifest/hash becomes a function of plugin set,
   version, and order — resume decisions flap and K11 becomes unenforceable. This is precisely the
   hazard ADR 0023 exists to prevent.
3. **Generic build-time extension already has a home: the Vite/Rollup plugin pipeline.** `loomPlugin`
   composes into it via `enforce: "pre"`. Building a second plugin system *inside* a Vite plugin is
   redundant and would freeze `@loom/compiler` internals as public ABI on a young compiler.

**Where build-time extensibility legitimately lives — both read-only, downstream of the pass:**

4. **The manifest is the public build-time output contract.** `loom-manifest.json` is versioned and
   already consumed by `@loom/spec` / `@loom/app`. Formalise it: a documented schema + a stability
   guarantee tied to `COMPILER_MANIFEST_VERSION`, so first- and third-party **build-time tooling**
   (custom validators, dashboards, codegen, drift reports) can depend on it **read-only**. This is
   the build-time twin of "analytics reads the event log as a lens, never hooks the fold."
5. **Custom checks attach at the `validate` seam, not the compiler.** Project- or plugin-specific
   flow-graph lints are a pure `FlowGraphValidator[]` passed to `loom check` /
   `defineConfig({validate})` — read-only over the already-built graph, additive, no ABI exposure.
   Ship this only when demand is real (it is a one-function seam extension, not a subsystem).

## Consequences

- `@loom/compiler` gains **no** public extension API; its internals stay free to refactor.
- The manifest schema is documented as the versioned public output contract (see the requirements
  doc and `docs/`); third-party build tooling targets that JSON, never the compiler's pipeline.
- Determinism guarantees (K11, deploy-sim, resumability) remain a function of *core* code only.

## Non-goals / explicitly deferred

- **No** transform-hook API, custom-marker registry, or manifest-mutation hook — ever (they break
  §Decision 1–2).
- The `FlowGraphValidator[]` seam (Decision 5) is **demand-gated**, not built now.
- Whether `@loom/sdk` should re-export adapter packages is tracked in ADR 0043, not here.
