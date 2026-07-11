# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`loom appgen` — natural-language → app skeleton.** New `@loom/cli` subcommand that turns a
  natural-language intent into a Loom app skeleton, wiring the existing pure `@loom/appgen`
  library (`parseIntent` → `generateApp`) into the CLI. Emits one `src/<capability>.ts` flow file
  per capability plus a `src/app.ts` composition root — plain, static, inspectable TypeScript with
  `TODO` handlers. Parsing and code generation are deterministic and offline (no model call at
  generate time, none in the output).
  - Intent is supplied as a quoted positional string or via `--from <file>`; output goes under
    `--dir` (default `app`).
  - Writes each file directly when the target path is free; on a collision it prompts
    interactively per file — `[r]ename / [s]kip / [o]verwrite` — the CLI's first interactive
    prompt, backed by a stdin line-queue reader that works for both TTYs and piped input.
  - `cmdAppgen` is exported from `@loom/cli` for programmatic use, with an injectable IO seam.
  - Docs: new section in [`docs/usage-cli.md`](docs/usage-cli.md) and the CLI overview in
    [`docs/user-guide.md`](docs/user-guide.md).
