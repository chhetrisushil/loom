# @loom/create-loom-app

The project initializer: `create-loom-app <directory>` writes a minimal, working Loom app wired
through `defineConfig`: a `greet` flow under the folder convention, tools, middleware, a security
module, `loom.config.ts`, a passing vitest test, `tsconfig.json` and a README. The templates live in
[`@loom/scaffold`](../scaffold/README.md) and are shared with `loom new`.

## When to use it

To start a new app. For adding a flow, tool or agent to an existing app use `loom new` from
[`@loom/cli`](../cli/README.md) instead.

## Install

Not published to npm yet, so `npm create loom-app` does not work. Build the framework and run the
built binary, scaffolding inside the workspace (`apps/*` is a workspace glob):

```bash
git clone git@github.com:chhetrisushil/loom.git && cd loom
pnpm install && pnpm build           # or `pnpm build:fast`
node tools/create-loom-app/dist/index.js apps/my-app
pnpm install                         # links the new app to the workspace packages
cd apps/my-app && pnpm test          # the scaffold ships a passing test
```

`pnpm link:global` at the repo root also puts `create-loom-app` on your PATH. The generated app
depends on `@loom/*` as `workspace:*`, which is why it must live inside the checkout.

## Entry points

- Binary: `create-loom-app` (`dist/index.js`); usage is `create-loom-app <directory>`.
- Library: the package `main` exports `scaffoldFiles` (the file map, an alias of `appFiles` from
  `@loom/scaffold`). The package declares no `exports` map.

## Key concepts

- The target directory name becomes the app name; a leading `-` is refused as a flag, not a name.
- Existing files at the same paths are overwritten, so scaffold into a new directory.
- The generated `app/config.ts` is the `defineConfig` call; edit it to switch storage to
  [SQLite](../../plugins/sqlite/README.md) or [Postgres](../../plugins/postgres/README.md).

## See also

- [Getting started](../../docs/getting-started.md) (walks through the scaffold, a suspend/resume flow
  and a test), [usage guide](../../docs/usage.md).
- [`@loom/app`](../../packages/app/README.md), [`@loom/cli`](../cli/README.md).
- Not in the API reference by design: it is an initializer, not imported
  ([`apiReferenceDocs.test.ts`](../../packages/spec/src/apiReferenceDocs.test.ts)).
