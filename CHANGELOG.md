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

- **`loom appgen` — brownfield-aware, four-stage pipeline (foundation for AI-driven appgen).**
  `appgen` now *scans the existing app* and applies a **delta** rather than only scaffolding from
  scratch. Four stages, all deterministic and offline: **scan** (`scanApp(dir) → AppModel`,
  a compact TS-AST summary of flows/steps/gates — never raw file dumps), **plan**
  (`planChangesDeterministic(intent, appModel) → ChangeSpec`, tagging each capability/step
  `create` / `extend` / `modify`), **apply** (`applyChanges` → creates via the existing templates,
  surgical formatting-preserving edits to existing flows), and **validate** (in-process `tsc`).
  The plan stage is the single seam where NL understanding lives and it emits a structured
  `ChangeSpec` — a local model can be swapped in here later without touching codegen.
  - **Plan → diff → confirm DX.** `--dry-run` renders a terraform-style plan (creates / edits /
    skips) and writes nothing; omit it to apply. `--check` typechecks the app after applying.
  - **Safety gate.** appgen only overwrites a handler body that still hashes to the generated
    `TODO` stub; any human-edited handler is **insert-only**, never clobbered (`FlowEditor`,
    content-hash gate). Brownfield edits add step consts, register them in the flow's `steps: []`
    array, and insert approval / UI gates into the runner while preserving surrounding code.
  - **Replayable spec lockfile.** Each apply records the accepted `ChangeSpec` to
    `.loom/appgen/<timestamp>.spec.json`; `loom appgen --from-spec <file>` reproduces it
    byte-for-byte with no model — the appgen equivalent of a golden log.
  - `@loom/appgen` stays zero-dependency and offline (only `typescript` promoted to a runtime
    dep for the AST scan/edit); the framework kernel is untouched. New exports: `scanApp`,
    `planChangesDeterministic`, `applyChanges`, `FlowEditor`, `typecheck`, lockfile helpers.
