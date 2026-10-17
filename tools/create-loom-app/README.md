# @loom/create-loom-app

The project initializer: `create-loom-app <directory>` writes a minimal, working Loom app wired
through `defineConfig`: a `greet` flow under the folder convention, tools, middleware, a security
module, `loom.config.ts`, a passing vitest test, `tsconfig.json` and a README. The templates live in
[`@loom/scaffold`](../scaffold/README.md) and are shared with `loom new`.

## When to use it

To start a new app. For adding a flow, tool or agent to an existing app use `loom new` from
[`@loom/cli`](../cli/README.md) instead.

## Install

Not published to npm yet, so `npm create loom-app` does not work. Build the framework once, then run
the built binary. Where the app lives decides how `@loom/*` is wired:

```bash
git clone git@github.com:chhetrisushil/loom.git && cd loom
pnpm install && pnpm build           # or `pnpm build:fast`

# Anywhere on disk: link to the built checkout (the usual day-one path)
node tools/create-loom-app/dist/index.js ~/code/my-app --loom-path "$PWD"
cd ~/code/my-app && pnpm install && pnpm test && pnpm start

# Inside the checkout (apps/* is a workspace glob): workspace:*, no flag
node tools/create-loom-app/dist/index.js apps/my-app
pnpm install && cd apps/my-app && pnpm test && pnpm start
```

`pnpm link:global` at the repo root also puts `create-loom-app` on your PATH.

Outside the checkout `workspace:*` cannot resolve (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`), so
`--loom-path <dir>` is **required** there: `create-loom-app` refuses up front (exit 2, nothing
written) without it, and also when `<dir>` is not a loom checkout or is not built. With it, the app's
`package.json` lists `@loom/*` as `*` and carries a `pnpm.overrides` map pointing **every** loom
package at a `link:` into the checkout, the same wiring as the sibling `loom-examples` repo (a
`link:` dependency does not bring its own `workspace:*` dependencies, so each transitive package is
mapped too). The links are relative to the app: move both folders together, or re-scaffold.

## Flags

| | |
|---|---|
| `--loom-path <dir>` | a built loom checkout; required outside the loom workspace, ignored inside it |
| `--name <pkg>` | npm package name; default is the folder name, which must itself be valid (`Bad Name!` is refused with a suggestion) |
| `--force` | scaffold into a non-empty folder. It overwrites only the files it generates and never deletes anything else; it says how many it overwrote |

Exit codes: `0` scaffolded, `2` refused (nothing written), `1` usage error.

## Entry points

- Binary: `create-loom-app` (`dist/index.js`); usage is `create-loom-app <directory> [--loom-path <dir>] [--name <pkg>] [--force]`.
- Library: the package `main` exports `scaffoldFiles` (the file map, an alias of `appFiles` from
  `@loom/scaffold`). The package declares no `exports` map.

## Key concepts

- The target directory name becomes the app name; a leading `-` is refused as a flag, not a name.
- A non-empty target is refused (including `create-loom-app .` in a non-empty folder) unless `--force`.
- The printed `Next:` line is `cd <dir> && pnpm install && pnpm test && pnpm start` (the `cd` is shell-quoted when needed, and omitted for `.`); it is only printed when it can work.
- The day-one path is exercised for real by `pnpm test:e2e` (scaffold with `--loom-path`, install, test, start, `loom new flow` + its test); it needs a built checkout and a package store, so it is not in the default suite.
- The generated `app/config.ts` is the `defineConfig` call; edit it to switch storage to
  [SQLite](../../plugins/sqlite/README.md) or [Postgres](../../plugins/postgres/README.md).

## See also

- [Getting started](../../docs/getting-started.md) (walks through the scaffold, a suspend/resume flow
  and a test), [usage guide](../../docs/usage.md).
- [`@loom/app`](../../packages/app/README.md), [`@loom/cli`](../cli/README.md).
- Not in the API reference by design: it is an initializer, not imported
  ([`apiReferenceDocs.test.ts`](../../packages/spec/src/apiReferenceDocs.test.ts)).
