# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`loom appgen` — natural-language → Loom app.** New `@loom/cli` subcommand that turns a
  natural-language intent into a Loom app following the **folder convention** (the same shape
  `create-loom-app` / `loom new` / `loom gen` produce), wiring the pure `@loom/appgen` library
  (`parseIntent` → `generateProject` / `generateFlows`) into the CLI. Output is plain, static,
  inspectable TypeScript with `TODO` handlers; parsing and code generation are deterministic and
  offline (no model call at generate time, none in the output).
  - **Adapts to the target `dir` (the project root, default `.`):** a new/empty dir gets a full
    runnable project (`package.json`, `tsconfig.json`, `app/config.ts` with `defineConfig({
    flowModules })`, `app/main.ts`, `app/loom.gen.ts`, and one `app/flows/<id>/flow.ts` per
    capability) so `pnpm install && pnpm start` works out of the box; an existing Loom app gets
    just the `app/flows/<id>/flow.ts` files, then `app/loom.gen.ts` is regenerated from the
    filesystem (the `loom gen` step) so pre-existing flows stay wired.
  - Reuses `@loom/scaffold` (`appFiles` / `generateRegistration`) rather than hand-rolling, so
    appgen output now matches every other generator. Flows export a `RegisteredFlow` (the older
    `capability$` / `CapabilityCatalog` composition root is gone). The one value-add over
    `loom new` is the NL-derived flow body (reasoning ladder, approval suspend gate, UI surface).
  - Intent is supplied as a quoted positional string or via `--from <file>`.
  - Writes each file directly when the target path is free; on a collision it prompts
    interactively per file — `[r]ename / [s]kip / [o]verwrite` — backed by a stdin line-queue
    reader that works for both TTYs and piped input.
  - `cmdAppgen` is exported from `@loom/cli` for programmatic use, with an injectable IO seam.
  - Docs: new section in [`docs/usage-cli.md`](docs/usage-cli.md) and the CLI overview in
    [`docs/user-guide.md`](docs/user-guide.md).
