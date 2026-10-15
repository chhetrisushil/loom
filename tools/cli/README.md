# @loom/cli

The `loom` command: project-local commands that are all lenses on the same durable event log. It
scaffolds code (`new`, `gen`, `appgen`), validates before you run (`doctor`, `check`, `verify`,
`lint`), observes a run (`logs`, `debug`, `inspect`, `profile`, `introspect`), gates a deploy
(`eval`, `deploy check`), and operates a durable deployment (`census`, `recover`, `branches`,
`retention run`, `sweep content`, `compliance report`, `knowledge ...`). It adds no infrastructure,
holds no state and runs no live effects.

## When to use it

In any Loom project once you persist to a store (SQLite or Postgres): to read what an execution did,
time-travel to a sequence number, check a flow graph, or run the pre-flight `loom doctor` before a
deploy. The in-memory default has no log for it to read.

## Install

Not published to npm yet. Inside this workspace add `"@loom/cli": "workspace:*"` (the scaffold already
lists it as a dev dependency) and run `pnpm loom ...` or `npx loom ...`. To put `loom` on your PATH
from a checkout, run `pnpm link:global` at the repo root (`pnpm unlink:global` removes it).

## Entry points

- Binary: `loom` (`dist/cli.js`).
- Library: `@loom/cli` exports the core commands as functions (`cmdLogs`, `cmdDebug`, `cmdEval`,
  `cmdCheck`, `cmdGen`, `cmdNew`, `cmdAppgen`, `cmdDeployCheck`, `serveInspector`, `parseArgs`, ...).
  The newer commands are reachable through the binary only; import their logic from the packages
  they wrap.

## Example

```bash
# persist to SQLite first: defineConfig({ storage: sqliteStorage({ dir: ".loom" }), ... })
npx loom logs .loom/events.db <executionId>            # print the event timeline
npx loom debug .loom/events.db <executionId> --at 3    # fold the state as of sequence 3
npx loom doctor --config ./loom.config.ts              # every pre-flight check that can run
```

```ts
import { cmdEval } from "@loom/cli";

const { report } = cmdEval("evals/");
if (!report.ok) process.exit(1);
```

## Key concepts

- `<store>` names where a command reads storage (a `.db` path or a config module); the full grammar,
  the exit codes and scripting notes are in the CLI usage guide.
- Commands that mutate (`recover`, `branches retire|prune`, `retention run`, `sweep content`,
  `repair ...`) are dry runs unless you pass `--apply`.
- `loom gen` regenerates `loom.gen.ts` from the folder convention
  ([ADR 0011](../../docs/adr/0011-folder-convention-codegen.md)); `loom new` scaffolds a file.

## See also

- [CLI usage guide](../../docs/usage-cli.md) (command-by-command reference),
  [user guide, section 11](../../docs/user-guide.md#11-the-loom-cli).
- [API reference: `@loom/cli`](../../docs/api-reference.org).
- [ADR 0010](../../docs/adr/0010-loom-cli.md), [operations runbook](../../docs/operations.md#6-pre-flight-checklist-loom-doctor).
- [`@loom/create-loom-app`](../create-loom-app/README.md), [`@loom/compiler`](../compiler/README.md).
