# ADR 0148 — Publish to npm as `@loomwork/*`, 0.1.0 on the `next` dist-tag

- Status: **Accepted** (2026-11-14)
- Date: 2026-11-14
- Placement: **release tooling only** (`scripts/publish-metadata.mjs`, `scripts/publish.mjs`, the spec guard
  `packages/spec/src/publishMetadata.test.ts`) plus a mechanical package rename. No behaviour changes:
  KERNEL_ABI, EVENT_SCHEMA and every SPI version are unchanged, and no persisted value names a package.

## Context

The framework was consumed only from a sibling checkout (`link:` overrides). Publishing needed a scope the
owner controls. `@loom` is taken on npm, and the unscoped `create-loom-app` belongs to an unrelated project
(LoomKit), so `npm create loom-app` would run someone else's initializer.

## Decision

1. **One scope, `@loomwork`, for every published package.** loom keeps its package names under it
   (`@loomwork/core`, `@loomwork/plugin-postgres`, …); loom-ui publishes as `@loomwork/ui-*`; the five
   plugins in loom-plugins as `@loomwork/plugin-*`. The framework is still named Loom: the `loom` CLI,
   `loom.config.ts` and `LOOM_*` variables are unchanged. The app initializer is
   `npm create @loomwork/loom-app`; never document the unscoped `npm create loom-app`.
2. **0.1.0 on the `next` dist-tag**, not `latest`, until the owner promotes a release (amended below: every
   release is promoted to `latest` once verified). Every public package
   carries the same version.
3. **Sibling dependencies are `workspace:^`**, published as `^0.1.0`, so an app installs one copy of each
   package instead of exact pins that fail to dedupe.
4. **One generator owns the publish fields** (`version`, `license`, `repository.directory`, a `files`
   allowlist that ships `dist`, `src` for the sourcemaps and root subpath shims but never tests, fixtures,
   tsconfig or build caches, `publishConfig`, `engines`). The spec guard re-runs it in memory and refuses
   drift and a public package that depends on a private one.
5. **Publishing is a deliberate act.** `scripts/publish.mjs` is a dry run unless given `--yes`, and refuses a
   dirty tree, stale metadata or an unbuilt package. Order: loom first, then loom-ui and loom-plugins (their
   `@loomwork/*` ranges name the published loom). Publish only from an account verified as an Owner of the
   `@loomwork` org.

## Consequences

- The rename is mechanical (every `@loom/` became `@loomwork/`, including escaped regex literals). Event logs,
  flow and schema hashes, effect ids and eval cassettes never contain a package name, so existing logs replay
  unchanged.
- **Kernel budget: +1 code line in total.** The longer specifier pushed three kernel import lines over the
  formatter's width. `WorkflowRuntime.ts` merged two imports from one module (−1 net); `sealGuard.ts` and
  `types.ts` each split one import into two type-only lines (+1 each). No kernel code was added.
- Sibling repos that link to loom (loom-ui, loom-plugins, loom-examples, loom-demo) must rename their
  `@loom/*` references when this lands; their `link:` paths do not change.

## Amendment (2026-11-14): promote every release to `latest`

Decision 2 assumed a package published with `--tag next` has no `latest`. npm sets `latest` on a package's
FIRST publish whatever tag it is given, so after 0.1.0 every package had `latest` = 0.1.0. When 0.1.1
shipped on `next`, a consumer that asked for it still received 0.1.0 transitively: sibling dependencies are
`^0.1.x` ranges, and npm and pnpm resolve a range to the `latest` version whenever it satisfies it. That
pulled in the broken 0.1.0 `@loomwork/conformance` and `@loomwork/ui-renderer-lit`, and installed some
packages twice, at both versions.

npm will not delete a `latest` tag, so it cannot be left behind. Every release is therefore two steps:

1. `node scripts/publish.mjs --yes` publishes under `next`. Verify it from a clean install pinned to the
   new version (every entry point under `import` and `require`).
2. `node scripts/promote-latest.mjs --yes` points `latest` at it, for every public package in the
   workspace. It is a dry run without `--yes`, skips packages already promoted, and is run the same way
   from loom-ui and loom-plugins (`node ../loom/scripts/promote-latest.mjs`). npm asks for 2FA once per
   package. A granular token allowed to bypass 2FA (`NPM_TOKEN=<token>`, revoked afterwards) avoids the
   prompts.

Until step 2 runs, a release is visible only to consumers that ask for `next`. Docs show the plain
`npm create @loomwork/loom-app`, which resolves `latest`.

