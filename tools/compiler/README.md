# @loomwork/compiler — optional build-time pass for Loom apps

A Vite plugin and a command-line tool that read your Loom source at build time. They move
`handler$()` bodies into lazy chunks, analyze each flow's steps, and write a `loom-manifest.json`
describing what they found, including source analyses that `loom verify` picks up. It is optional:
without it an app runs as written, `handler$(fn)` returns a reference that is called directly, and
nothing in your bundle depends on this package. The full walkthrough is
[docs/usage-compiler.org](../../docs/usage-compiler.org).

```ts
// vite.config.ts: add it before the React plugin
import { loomPlugin } from "@loomwork/compiler";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [loomPlugin(), react()],
});
```

Without Vite, transform a directory from the command line:

```sh
npx loom-compile src dist-loom   # loom-compile [srcDir=src] [outDir=dist-loom]
```

It writes transformed files with source maps, the extracted chunks under `<outDir>/chunks/`, and
`<outDir>/loom-manifest.json`, then prints per-flow summaries and warnings.

## Surface

- **`loomPlugin()`** is the Vite plugin. It runs on `.ts` and `.tsx` files outside `node_modules`.
- **`transformFile(source, filePath, state)`** and **`buildManifest(state, outDir?, root?)`** with
  `printWarnings(manifest)` are the programmatic entry points; `state` is a `PluginState` you build up
  across files. The manifest lists flows, steps, chunk paths, suspend points and warnings.
- **Source analyses**, each also placed in a flow's manifest entry: `analyzeNonDeterminism`
  (`Date.now`, `Math.random` and similar), `analyzeLoopIdentity` (ADR 0061: dynamic step ids must be a
  pure function of logged input) and `analyzeRunnerReach` (ADR 0086: the steps and suspends a runner body reaches).
- **Hashing.** `shortHash` and `fnv1a32` name the chunks; a chunk id depends on the file path and step id,
  so renaming either changes it.

## Behaviour that surprises people

- **Warnings are advisory.** A step with no `handler$` and no `toolId`, a step referenced but not
  defined, or a flow with no steps is reported but never fails the build.
- **The analyses are source-level and approximate.** The guide lists the current limits: chunks re-emit
  every top-level import of their file, `flow$` step resolution follows direct variable references only,
  and suspend-point detection is a text scan.
- **`vite` is an optional peer dependency** (version 5 or later); the CLI needs none.
- **Plugin order matters.** The guide says to put `loomPlugin()` before `@vitejs/plugin-react`.

## Status / See also

`npm install @loomwork/compiler` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

- Guide: [docs/usage-compiler.org](../../docs/usage-compiler.org).
- [ADR 0044](../../docs/adr/0044-no-compiler-plugin-api-manifest-as-output-contract.md): the manifest as the
  output contract; [ADR 0061](../../docs/adr/0061-step-identity-interpreter-guardrails.md) and
  [ADR 0086](../../docs/adr/0086-runner-body-reach-analysis.md): loop identity and runner reach.
- API reference: section "`@loomwork/compiler` — build-time enhancement (optional)" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Related: `loom verify` ([docs/usage-cli.md](../../docs/usage-cli.md)).
