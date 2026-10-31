# Loom — CLI Usage Guide

`loom` is the project-local command line for a Loom app. Every command is a **lens on the same durable event log** — it adds no infrastructure and holds no state of its own, and — apart from the three lifecycle verbs `resume`, `cancel` and `start`, which act only through your app's own runtime and say so — runs no live effects. You use it to scaffold code, validate a flow graph before it runs, observe an execution after it ran, and gate a deploy on replay.

> New here? Follow the **[Getting Started](getting-started.md)** quickstart first, then the **[Usage Guide](usage.md)** (Step 13 introduces the CLI in context). This doc is the command-by-command reference.

The binary ships in `@loom/cli`. Run it with `npx loom …`, a package script (`"scripts": { "loom": "loom" }` → `pnpm loom …`), or the local `node_modules/.bin/loom`. Starting a brand-new project? `create-loom-app <dir> --loom-path <your built loom checkout>` (see [Getting Started](getting-started.md)); `npm create loom-app` does not work until the packages are published.

> **Working in the Loom monorepo?** The dev-tooling bins (`loom`, `loom-compile`, `create-loom-app`) live under `tools/`. Expose them globally against your local build with **`pnpm link:global`** (and `pnpm unlink:global` to remove) — a root script that re-links all three from `tools/*`. Run it after a fresh clone, or any time the tooling packages move (a stale global link left over from an old path is what breaks `loom` otherwise).

**Contents**

1. [The command set](#the-command-set)
2. [Scaffold & wire: `new`, `gen`, `appgen`](#scaffold--wire-new-gen-appgen)
3. [Validate before you run: `doctor`, `check`, `verify`, `lint`](#validate-before-you-run-doctor-check-verify-lint)
4. [Observe a run: `logs`, `debug`, `inspect`](#observe-a-run-logs-debug-inspect)
   - [Act on a run: `resume`, `cancel`, `start`](#act-on-a-run-resume-cancel-start)
   - [Keep it healthy: `census`, `recover`, `branches`](#keep-it-healthy-census-recover-branches)
5. [Analyze a run: `profile`, `introspect`, `optimize`](#analyze-a-run-profile-introspect-optimize)
6. [Learn from the log: `learn report`, `learn eval`](#learn-from-the-log-learn-report-learn-eval)
7. [Ship safely: `eval`, `deploy check`](#ship-safely-eval-deploy-check)
8. [Data protection: `retention run`, `sweep content`, `compliance report`](#data-protection-retention-run-sweep-content-compliance-report)
9. [Operate a corpus: `knowledge sync`, `list`, `search`](#operate-a-corpus-knowledge-sync-list-search)
10. [Deployment contracts: `kernel-manifest`, `compat`](#deployment-contracts-kernel-manifest-compat)
11. [Author a plugin: `plugin …`](#author-a-plugin-plugin-)
12. [Cheat sheet](#cheat-sheet)
13. [Exit codes & scripting](#exit-codes--scripting)
14. [Programmatic use](#programmatic-use)

---

## The command set

`loom`, `loom help`, or `loom --help` prints the usage summary:

```text
loom — project-local commands for a Loom app

scaffold
  loom gen   [--dir app] [--watch]                regenerate loom.gen.ts from app/flows (--watch: keep it current)
  loom new   <flow|agent|tool|skill|schedule|memory|projection|sentinel> <name> [--dir app] [--no-gen] scaffold a file, then run gen
  loom new   flow <name> --template echo|approval|timer|saga [--dir app]  a non-agentic starter (human gate, timer, compensation)
  loom dev   --config <module> [--dir app] [--run <command>] [--port N]  the dev loop: gen --watch + run the app,
                                                  restarting on change + the inspector (NOT an alias of inspect)
  loom appgen <intent> | --from <file> [--dir .] [--dry-run] [--check] [--yes] [--offline]  NL → new project or edits
                                                  (--dry-run previews; --check typechecks after apply;
                                                   --yes skips the confirmation; --offline never calls
                                                   a model. Without --model it plans with the
                                                   deterministic keyword parser and says so)
  loom appgen ... --model <spec> [--model-big <spec>] [--model-tier <t>]  plan with a model of your choice
                                                  (anthropic:<m> / openai:<m> / gemini:<m> / a .gguf path)
  loom appgen --from-spec <file> [--dir .]        replay a .loom/appgen/<ts>.spec.json (no model)

validate
  loom doctor [--dir .] [--config <module>] [--manifest <path>] [--strict] [--require <check,check>] [--json]
                                                  run every pre-flight check that can run, and report
                                                  which ones could NOT (--strict: those fail; --require:
                                                  the named ones must have run)
  loom check --manifest <path> [--json]           static flow-graph checks (compiler manifest)
  loom lint claim-check [--dir .] [--json]        CC-5: flag claim-check reach-through inside flows
  loom verify --config <module> [--manifest <path>] [--json]  pre-flight runtime verification (@loom/verify)
                                                  (auto-reads loom-manifest.json loopIdentity findings, ADR 0061)
  loom migrate-config [<file>...] [--config <file>] [--apply] [--json]  rewrite flat defineConfig options into their groups
                                                  (dry run prints a diff; --apply writes; refuses a
                                                   spread / computed key / non-literal config; never
                                                   runs the config; default ./loom.config.{js,ts})
  loom kernel-manifest [--json] [--emit-docs <dir>]  kernel version + maturity manifest
  loom compat --abi <v> --event-schema <v> [...] [--json]  validate a deployment's contract versions
  loom eval  --dir <path> [--json]                replay golden logs vs expectations

observe
  loom ls    <store-flags> [--status running|suspended|failed|completed|cancelled] [--workflow <id>] [--since <dur>] [--limit N] [--keys] [--json]
                                                  list executions: status, last activity, and what a
                                                  suspended one waits on (read-only; --leases adds owners)
  loom logs  <store-flags> <executionId> [--redact a,b] [--json]  print the event timeline (--json: ndjson)
  loom logs  <store-flags> <executionId> [-v] [--type A,B] [--from N] [--to N]  detail (timestamps, gaps, payloads) / filter
  loom logs  <store-flags> <executionId> --follow [--interval <dur>]  tail it until it finishes (Ctrl-C stops)
  loom debug <store-flags> <executionId> [--at N] [--redact a,b] [--json]  time-travel: state at sequence N
  loom profile <store-flags> <executionId> [--json]     flame graph + latency breakdown
  loom introspect <store-flags> <executionId> [--graph N] [--json]  execution/task/decision/resource graphs
  loom optimize <store-flags> <executionId>       advisory optimization report (recommendations)
  loom snapshot show <store-flags> <executionId> [--at SEQ] [--redact a,b]  print a stored snapshot, DECODED
                                                  (JSON; a zstd BYTEA/BLOB frame is decoded, an
                                                   encrypting store opens it; --db also needs --snap)
  loom census <store-flags> [--buckets 5m,1h,6h,24h] [--sample N] [--json]  what is stuck, and is anything watching it
                                                  (read-only; takes no predicate; --sample: ids kept
                                                   per band, default 5)
  loom learn report <store-flags> [executionId]   trajectories, per-arm rewards, learning coverage
  loom learn eval <store-flags> --policy <module> [--min-steps N] [executionId]
                                                  shadow-evaluate a candidate policy on real logs
  loom compliance report <store-flags> --subject-path <p> [--tenant-path <p>]  data-subject inventory
  loom inspect <store-flags> [--port N]           web inspector (timeline + slider)

operate
  loom resume <executionId> --config <module> --as <principal> [--tenant <t>] --event <type> (--payload <json> | --payload-file <path>) [--wait-id <id>] [--show-payload] [--redact a,b] [--force] [--allow-local-controls] [--skip-effect-check] [--apply] [--json]
                                                  answer a suspended gate THROUGH your app's runtime:
                                                  its resume authenticator, execution authorizer and
                                                  resumeSchemas all run (dry run unless --apply; --db
                                                  is refused; the continuation runs in THIS process;
                                                  a process-local kill switch refuses unless
                                                  --allow-local-controls; unknown lease liveness
                                                  refuses unless --force; --skip-effect-check
                                                  skips the registered-effect check)
  loom cancel <executionId> --config <module> --as <principal> [--tenant <t>] [--reason <text>] [--force] [--apply] [--json]
                                                  cancel through your app's runtime (dry run unless
                                                  --apply; a live or unknown lease holder refuses
                                                  unless --force)
  loom start <flowId> --config <module> --as <principal> [--tenant <t>] (--input <json> | --input-file <path>) [--id <executionId> | --idempotency-key <k>] [--show-payload] [--redact a,b] [--allow-local-controls] [--skip-effect-check] [--apply] [--json]
                                                  start a flow through your app's runtime (dry run
                                                  unless --apply; the flow runs in THIS process; a
                                                  process-local kill switch refuses unless
                                                  --allow-local-controls; --skip-effect-check
                                                  skips the registered-effect check)
  loom recover <store-flags> (--stale 15m | --config <module> with timers.leases) [--owner <id>] [--limit N] [--max-recoveries N] [--apply]
                                                  re-drive executions whose supervisor died
                                                  (--max-recoveries: skip + list those whose
                                                   last N re-drives made no progress)
                                                  (needs `timers.leases` or --stale; --apply
                                                   needs --config: re-driving runs the flow)
  loom branches retire <store-flags> (--branches <b.db> | --config <module>) --parent <id> --stale <d> [--limit N] [--apply]
                                                  cancel branches nobody is coming back to
                                                  (they keep the parent uncollectable)
  loom branches prune <store-flags> (--branches <b.db> | --config <module>) [--protect main,rel] [--limit N] [--apply]
                                                  delete refs that name nothing (main protected)
  loom knowledge sync --config <mod> --scope <s> --dir <path> [--ext md,txt] [--source <s>] [--apply]
                                                  reconcile a directory into a corpus
                                                  (dry run by default; --apply also REMOVES
                                                   documents the directory no longer has —
                                                   but never another writer's, see --source)
  loom knowledge list --config <mod> --scope <s>  what the corpus holds
  loom knowledge search --config <mod> --scope <s> "<query>" [--limit N]
                                                  ask the corpus (operator query — not recorded)

maintain
  loom repair blank-stream <store-flags> (--snap <s.db> | --config <module>) [--assign <id>:<from>-<through>,…] [--apply]
                                                  re-home what the pre-0106 compaction bug
                                                  wrote to execution "" (ADR 0107): proven
                                                  segments only; the rest is listed with its
                                                  candidates, never guessed
  loom repair terminal-event <store-flags> (--snap <s.db> | --config <module>) [executionId] [--apply] [--force]
                                                  give an execution a pre-0116 compaction left
                                                  as [0]+checkpoint its terminal event back, so
                                                  it can take a late outcome (ADR 0116)
  loom retention run <store-flags> --ttl <dur|ms> [--apply]  reclaim aged terminal executions
                                                  (a branchRegistry enables the live-descendant
                                                   guard; without one a parent with live
                                                   branches is NOT protected)
  loom sweep content <store-flags> --content <path> [--archive-db <path> [--archive-snap <path>]] [--pin KIND,KIND] [--ttl ms] [--compaction-archive <archive.db> | --no-compaction-archive] [--acknowledge-unarchived] [--orphans [--no-archive] [--snapshots-touch-content]] [--apply]  K10.6 pinned blob sweep
                                                  (--orphans also erases blobs NOTHING scanned
                                                   cites, so it needs the snapshot store and
                                                   every archive; with --apply and no archive
                                                   it refuses unless --no-archive;
                                                   it also needs --snapshots-touch-content;
                                                   compacted logs also need the compaction
                                                   archive: --compaction-archive <archive.db>
                                                   (default archive.db beside --db; --config
                                                   wires it); logs compacted BEFORE ADR 0138
                                                   (history already gone) also need
                                                   --acknowledge-unarchived)

plugin
  loom plugin new <seam> <name> [--first-party] [--dir .]  scaffold a plugin package
  loom plugin check [--dir .] [--publish]         validate a plugin (--publish adds npm-readiness)
  loom plugin try --module <path> [--preset <name>] [--options <json>]  run a store plugin end-to-end
  loom plugin search <term>                       find plugins on npm (keyword loom-plugin)
  loom plugin seams                               list the seams a plugin can target

deploy
  loom deploy check --logs <dir> --config <module>  simulate deploy vs new flow defs

help
  loom help [command]                             this summary, or one command's usage
  loom <command> --help                           same as `loom help <command>`
  loom version                                    print the @loom/cli version (also --version)
  loom completion <zsh|bash|fish>                 print a shell completion script

  <store-flags>  where a command reads storage — FLAGS, never a positional path (a bare path is refused;
                 next to --db, "loom logs --db x.db events.db" reads "events.db" as the execution id).
                 Either half works for every command above:
    --config <module>    the stores YOUR app wired (defineConfig) — SQLite, Postgres, or any
                         conforming backend; importing it starts nothing
    --db <events.db> [--snap <s.db>] [--branches <b.db>] [--leases <l.db>]
                         SQLite shorthand, one file per store — for a dev machine with loose
                         files. Flags you omit are stores the command cannot consult, and it
                         says so rather than reporting them as empty.

New project?  →  create-loom-app <dir> --loom-path <loom>   (unpublished: see getting-started)
```

> Data-protection commands: `--redact a,b` masks output dot-paths from `logs`/`debug` (K10-R6);
> `retention run`, `sweep content` (both dry-run by default, `--apply` to reclaim) and
> `compliance report` (subject inventory) sweep the store via the `listExecutions` SPI.

There are no global flags — each command declares its own. The recurring ones are `--db <path>` (a SQLite event-store file), `--dir <path>` (a directory, defaulting to `app` for `gen`/`new` and `.` elsewhere), and `--at <N>` (a sequence number). An unknown command prints a one-line error with a did-you-mean (`unknown command "logz" (did you mean "logs"?) — see \`loom help\``) to stderr and exits `2`; it no longer dumps the whole usage.

### Help, version, completion: `help`, `version`, `completion`

- `loom help` prints the grouped summary above (scaffold · validate · observe · operate · maintain · plugin · deploy).
- `loom <command> --help`, `loom <command> -h` and `loom help <command>` print **that command's** summary, synopsis lines and flags (exit `0`) — the text comes from the same command table the strict flag parser uses, so it cannot name a flag the command rejects. `loom <command> <subcommand> --help` (e.g. `loom branches retire --help`) narrows to that subcommand's synopsis and the flags it names. `loom help --help` prints help's own help.
- `--help` / `-h` is recognised **in flag position**. For commands whose later words are free text, a `-h` after them is a literal word: `loom appgen make a cli with -h flag` is an intent, not a help request (`appgen` reads help only before its first positional; `knowledge` only before its query). A `--` ends help scanning everywhere. `loom logs --db x --help` still prints help.
- `loom version` / `loom --version` prints the `@loom/cli` package version.
- `loom completion zsh|bash|fish` prints a completion script generated from the command table (commands, subcommands, flags): `eval "$(loom completion bash)"`, `loom completion zsh > "${fpath[1]}/_loom"`, or `loom completion fish > ~/.config/fish/completions/loom.fish`. Value flags take a value in every shell (fish `-r`; zsh `--db=[db]:file:_files`; bash completes the next word as a file for path flags such as `--db`/`--config`/`--dir`, and as nothing for the others), and subcommand words are offered only right after the command.

`loom help`, `loom --version` and `loom completion` load none of the command implementations (each command's modules are imported when it runs), so they answer in roughly node's own startup time.

### Machine output: `--json`

`--json` is accepted by the commands that report a result: `resume`, `cancel`, `start`, `ls`, `logs`, `debug`, `census`, `doctor`, `check`, `verify`, `eval`, `lint claim-check`, `compat`, `profile`, `introspect`, `migrate-config` and `kernel-manifest`. Any other command rejects it as an unknown flag (exit `2`) rather than ignoring it.

- **stdout is exactly the JSON** — one document (pretty-printed), or **ndjson** for `logs` (one event envelope per line). Banners, progress lines, `console.*` calls and direct `process.stdout.write` calls from an imported config are all diverted to stderr for the run.
- Verdict commands put `ok` first-class: `{ "ok": boolean, … }`. The **exit code is unchanged** (`0` / `1` / `2`), so `loom doctor --json | jq .ok` and `loom doctor` agree. `ok` is meaningful where the command has a verdict; for `debug`, `profile`, `introspect` and `census` it is always `true` — a failure there (unknown execution, unreadable store) throws, so it exits non-zero with the stderr error document instead of emitting `ok:false`.
- **Errors** (including refusals and bad usage) go to **stderr** as `{"error":{"code":<exit code>,"message":"…"}}`; stdout is empty.

| Command | `--json` shape |
|---|---|
| `logs` | ndjson: one event envelope per line (`--redact` masks the same dot-paths at every depth of the envelope — `input`, `output`, resume payloads, results, arrays — and scrubs the masked values out of free text such as an error message) |
| `debug` | `{ ok, executionId, at?, eventCount, state }` (`--redact` masks the folded `state`: frames, variables, output) |
| `census` | `{ ok, census, suspended, note? }` (`suspended`: parked count, timer waits, overdue `wakeAt`s) |
| `ls` | `{ ok, executions[], scanned, limit, truncated?, unreadable? }` |
| `resume` · `cancel` · `start` | `{ ok, action, dryRun, executionId, before?, after?, refusal?, failure? }` — a refusal is `ok:false` with the app's reason **on stdout** and exit `2`; a runtime failure is `failure` and exit `1` |
| `doctor` | `{ ok, checks: [{ id, name, status, detail }] }` |
| `check` | `{ ok, issues }` |
| `verify` | the verification report (`ok`, `findings`, `checked`, …) plus `banner?` |
| `eval` | `{ ok, passed, failed, results }` |
| `lint claim-check` | `{ ok, findings }` |
| `compat` | the compatibility report (`ok`, `issues`) |
| `profile` | `{ ok, profile }` |
| `introspect` | `{ ok, introspection }` (`--graph` keeps only that key) |
| `migrate-config` | `{ apply, files: [{ path, changed, moved: [{ key, group }], conflicts, refusal, diff }], refused }` (exit `2` when `refused`) |
| `kernel-manifest` | the kernel manifest itself (unchanged) |

**Flags are checked strictly.** Each command declares the flags it takes, and what kind each is:

- an **unknown flag** is an error with a did-you-mean, exit `2` (`--aply` used to run the dry-run path of `recover` without a word);
- a **boolean flag never swallows the next word** — `loom repair terminal-event --db x --apply <id>` and `loom logs --db x --json <id>` read `<id>` as the id;
- a **number or duration is validated where it is typed** — `--at abc`, `--limit many` and `--ttl soon` exit `2` instead of becoming `NaN`/`0`. Durations are `30s`, `5m`, `6h`, `2d`, or bare milliseconds;
- `--flag=value` and a bare `--` (everything after it is positional) both work.

Several commands are **two words** — the first positional selects the subcommand: `deploy check`, `lint claim-check`, `repair blank-stream`, `retention run`, `sweep content`, `compliance report`, `learn report|eval`, and `plugin new|check|try|search|seams`.

> **The `--db` commands need SQLite storage.** `logs`, `debug`, and `inspect` read a durable log, so your app must persist one. Wire `storage: { kind: "sqlite", dir: ".data" }` in [`defineConfig`](usage.md#step-3--wire-the-app-with-defineconfig) — the event store is then at `.data/events.db`. In-memory apps leave nothing to inspect.

---

## Scaffold & wire: `new`, `gen`, `appgen`

These follow the **folder convention** — flows live at `app/flows/<name>/flow.ts` (folder); agents, tools, skills, schedules, memories, and projections are flat files at `app/agents/<name>.ts`, `app/tools/<name>.ts`, `app/skills/<name>.ts`, `app/schedules/<name>.ts`, `app/memories/<name>.ts`, `app/projections/<name>.ts` ([ADR 0011](adr/0011-folder-convention-codegen.md)).

### `loom new <flow|agent|tool|skill|schedule|memory|projection|sentinel> <name> [--dir app] [--no-gen]`

Scaffolds a single file from a template, then runs `loom gen` so the new file is wired (the result line is printed; `--no-gen` skips it).

| Argument / flag | Required | Default | Meaning |
|---|---|---|---|
| `<kind>` | yes | — | `flow`, `agent`, `tool`, `skill`, `schedule`, `memory`, `projection`, or `sentinel` (any other kind is an error) |
| `<name>` | yes | — | kebab-case, `^[a-z][a-z0-9-]*$`, e.g. `greet` or `pg-lag`. Anything else is refused with a `did you mean` suggestion, and so is a path (`../evil`, `a/b`, an absolute path): a name can never leave the convention folder |
| `--dir` | no | `app` | base directory the subfolders go under |
| `--template` | no | `echo` | flows only: `echo` (default), `approval`, `timer` or `saga` (see below) |
| `--no-gen` | no | off | do not run `loom gen` afterwards |

```bash
npx loom new flow greet          # → creates app/flows/greet/flow.ts
npx loom new sentinel pg-lag     # → app/flows/pg-lag/flow.ts — a schedule-driven sentinel starter (@loom/plugin-sentinel)
npx loom new agent triager       # → creates app/agents/triager.ts
npx loom new skill refunds       # → creates app/skills/refunds.ts
npx loom new schedule nightly    # → creates app/schedules/nightly.ts
npx loom new memory chat         # → creates app/memories/chat.ts
npx loom new projection counter  # → creates app/projections/counter.ts
npx loom new tool lookup --dir src
```

`loom new flow` also writes a sibling `app/flows/<name>/flow.test.ts` that runs the flow through [`@loom/testing`](../tools/testing/README.md)'s `createTestApp` (it passes on a fresh scaffold; the other kinds have no natural test and get none).

#### Non-agentic flow templates: `loom new flow <name> --template approval|timer|saga`

The default flow is an echo step. These three are the plain-workflow starting points; each writes `flow.ts` plus a sibling `flow.test.ts` that passes on a fresh scaffold and uses [`@loom/testing`](../tools/testing/README.md) time travel (`createTestApp({ clock: true })`, `advanceTime`) instead of real waiting:

| Template | What it shows | Test |
|---|---|---|
| `approval` | `ctx.suspend` on a typed gate (`flow$({ resumeSchemas })`) with a 24h timeout, and a note on wiring `security.resumeAuthenticator` for who may approve | approve → applied; no answer for 24h → expired |
| `timer` | a durable `ctx.sleep` (1 day) between steps (`ctx.sleepUntil` for an absolute instant) | one millisecond short of a day: still suspended; then due: completed |
| `saga` | `withSaga` from `@loom/saga`: each forward step registers a compensator, a later failure runs them in reverse | success keeps the work; a failure undoes it in reverse |

`saga` imports `@loom/saga`, which a fresh `create-loom-app` project does not declare, so `loom new` prints the line to add (the same hint as above). Saga steps are **tool steps** (a compensator runs under a derived step id, so an inline `handler$` cannot be one): the flow exports `<Name>Tools` and `<Name>Grants`, and under the scaffold's `security.strict` you must spread `<Name>Grants` into the `GrantTable` in `app/security.ts` or the app refuses to start with a `capability-compat` finding; register an effect per tool id on `app.effectRuntime` (the generated test stubs them). The `timer` and `approval` templates need a `TimerService` in the app that runs them (`defineConfig({ timers: { store } })`); the generated tests provide one through `clock: true`. After writing, `loom new` prints these follow-ups as `note - ...` lines.

It **never overwrites** an existing file: it prints `created <path>` (exit `0`) or `skipped <path> (already exists)` (exit `1`). A refused name exits `1` with nothing written.

When a generated file imports a package the nearest `package.json` does not declare (`loom new sentinel` imports `@loom/plugin-sentinel`; every other kind needs nothing a fresh `create-loom-app` project lacks), `loom new` prints the exact line to add — `"@loom/plugin-sentinel": "workspace:*"` inside the Loom workspace, `"*"` in an app created with `--loom-path` (its `pnpm.overrides` already map every `@loom/*` package). It never edits `package.json`; without the dependency the whole app fails to load, not just the new file.

### `loom gen [--dir app] [--watch]`

`--watch` generates once, then keeps `loom.gen.ts` current while you work: it regenerates when a module is **added, removed or renamed** under a convention folder (editing a file's contents, or adding a `*.test.ts`, changes nothing in `loom.gen.ts` and is ignored), prints what changed (`wrote app/loom.gen.ts (2 flows, …)  +./flows/refund/flow`), debounces a burst of events into one run, and reports a transient failure without exiting. It uses recursive `fs.watch` (macOS, Windows, Linux on Node 20+) and falls back to polling the tree when that is unavailable. Ctrl-C (or SIGTERM) stops it with exit `0`.

`--dir` must be an existing directory: a typo'd one is refused (exit `1`) rather than created and "succeeding" with zero of everything. Scans the seven convention folders and writes `<dir>/loom.gen.ts` — a static, alphabetically-sorted registration module. Wiring is build-time and replay-safe (P5), so discovery is codegen, not runtime globbing:

- `<dir>/flows/<name>/flow.{ts,tsx}` → `flowModules`
- `<dir>/agents/<name>.{ts,tsx}` → `agentModules`
- `<dir>/tools/<name>.{ts,tsx}` → `toolModules`
- `<dir>/skills/<name>.{ts,tsx}` → `skillModules`
- `<dir>/schedules/<name>.{ts,tsx}` → `scheduleModules`
- `<dir>/memories/<name>.{ts,tsx}` → `memoryModules`
- `<dir>/projections/<name>.{ts,tsx}` → `projectionModules`

```bash
npx loom gen            # scans app/flows/**, app/{agents,tools,skills,schedules,memories,projections}/*
# → "wrote app/loom.gen.ts (2 flows, 1 agent, 1 tool, 1 skill, 1 schedule, 1 memory, 1 projection)"
```

```ts
// app/loom.gen.ts (generated — do not edit)
import * as _f0 from "./flows/greet/flow";
import * as _f1 from "./flows/report/flow";

export const flowModules = [_f0, _f1];

import * as _a0 from "./agents/triager";

export const agentModules = [_a0];

import * as _t0 from "./tools/lookup";

export const toolModules = [_t0];

import * as _s0 from "./skills/refunds";

export const skillModules = [_s0];

import * as _sc0 from "./schedules/nightly";

export const scheduleModules = [_sc0];

import * as _m0 from "./memories/chat";

export const memoryModules = [_m0];

import * as _p0 from "./projections/counter";

export const projectionModules = [_p0];
```

Feed the generated modules to `defineConfig({ flowModules, agentModules, toolModules, skillModules, scheduleModules, memoryModules, projectionModules })`. Each construct is discovered by **value shape** (its `_tag`), so discovery is robust to how it's declared or exported, and each is wired **iff a runtime consumes it**:

| module | wired into | notes |
|---|---|---|
| `flowModules` | the workflow runtime | every `RegisteredFlow`-shaped export registers |
| `agentModules` | `agents` → A2A bus / agent-surface | auto-wired behind the opt-in `a2a` / `agentSurface` flags |
| `toolModules` | `app.tools` | introspection only — a tool's effect is registered separately |
| `skillModules` | `app.skills` (`SkillRegistry`) | deterministic offline selection (`app.skills.find(query)`) |
| `scheduleModules` | `app.schedules` → `TimerService` | fire **only** when `timers: { store }` is configured (else a boot warning) |
| `memoryModules` | `app.memory` (`MemoryRuntime`) | agents resolve their `memoryId` against it |
| `projectionModules` | the projection runtime | compiled projections fold **on demand** — see below |

Re-run `loom gen` whenever you add or remove any construct (`loom new` does it for you; `loom gen --watch` and `loom dev` keep it current). Exit `0` on a successful write.

**Projections load their fold code on demand** ([ADR 0049](adr/0049-projection-on-demand-fold-code.md)). When the `@loom/compiler` plugin builds a `projection$`, it extracts the whole `handlers` fold map into its own `import()` chunk (exactly like `handler$`/`instructions$`) and records the handled event-type keys. At runtime the projection stays **code-dormant** until an event whose type it folds first fires — then it imports the chunk once (buffering until ready) and folds normally after. A projection whose events never fire never loads its code. Uncompiled (dev), the handlers are inline and eager.

> `policy$` is **not** `loom gen`-discovered: it **is** enforced (a `PolicyAuthorizer` reads each flow's `policies` + `defineConfig({ security: { policies } })` — see the [user guide](user-guide.md#7-agents-tools--a2a)), but it's carried *inline on the flow definition*, not from an `app/policies/*` folder, so there's no separate module to generate. Discovery stays gated on "a runtime consumes a discovered *file*."

### `loom appgen <intent> | --from <file> | --from-spec <file> [--dir .] [flags]`

Turns a **natural-language intent** into a change to a Loom app, following the **[folder convention](#scaffold--wire-new-gen-appgen)**. It is **brownfield-aware**: it scans what already exists and applies a *delta* rather than only scaffolding from scratch. Four stages, with **NL understanding isolated to exactly one** and everything else deterministic and offline ([`@loom/appgen`](../tools/appgen)); the generated output is ordinary, statically-wired Loom code with `TODO` handlers you own (P5, P11):

1. **scan** — `scanApp(dir)` summarizes the app (flows, steps, gates, and whether each handler is still a generated stub or hand-edited). Never raw file contents.
2. **plan** — the intent is parsed into a `ChangeSpec` that tags each capability/step `create | extend | modify | delete`. This is the only stage that reads NL. Deterministic by default; a **model of your choice** can drive it (see `--model`) and can plan all four ops, deletes included (a delete of a flow or step the scan does not see is rejected and the model is asked to repair it).
3. **apply** — new flows come from the templates; existing flows are edited **surgically** (a new step is inserted, registered, and wired into the runner; approval/UI gates and grants are added) while untouched code is preserved byte-for-byte. A handler body is overwritten **only if it still hashes to the generated stub** — anything you have edited is insert-only.
4. **validate** — with `--check`, the app is typechecked in-process (`tsc`) after applying.

`appgen` **adapts to the target directory**: a new/empty dir gets a full runnable project (`package.json`, `tsconfig.json`, `app/config.ts`, `app/main.ts`, `app/loom.gen.ts`, one `app/flows/<id>/flow.ts` per capability); an existing app gets new flow files + surgical edits, then `app/loom.gen.ts` is regenerated.

**Symlinks.** `appgen` (and `gen`, `new`, `plugin new`) never reads a flow or writes through a symbolic link: a link anywhere below `--dir` on a write path (a flow folder, `flow.ts`, `app/`, `app/loom.gen.ts`, `.loom/`) is refused with an error naming the link, even when it points back inside the project, and a linked `flow.ts`/flow folder is skipped by the scan with a warning (so it is never planned as an edit). Never trust a symlink below the cwd, judged by REAL path and never by spelling: when the real path of the cwd is an ancestor of `--dir` (`app`, `./app`, `app/nested`, an absolute `/tmp/...` or logical `$PWD/app` spelling of it, typed or defaulted - the default `loom gen --dir app` of a scaffolded project included) the cwd is the containment root and `--dir` itself is checked, so a repo's own `app -> /elsewhere` link is refused. Real paths are NATIVE (`realpathSync.native`: canonical case and Unicode form), so `../PROJ/app` or a decomposed spelling of an ancestor is the same place. A `--dir` whose real location is OUTSIDE the cwd (a sibling directory, an absolute path elsewhere) is its own root, but the FINAL component of `--dir` may never be a symbolic link, wherever it points: pass the real path of an outside target. Links above it (`/tmp`) and a cwd reached through a link are fine. `appgen`, `plugin new`, the lockfile writer, `gen`, `new` and `dev` all use this one rule. The library entry points (`cmdGen`, `cmdNew`, `genWatch`, `runDev`) derive the same root with `containmentRootFor(dir)` when none is passed. Residual race: a swap of a parent directory by a concurrent writer between the final realpath check and the `rename` (Node has no `openat`/`renameat`). Replace the link with a real file to let `appgen` manage it. **Containment is decided by filesystem identity (st_dev + st_ino), not path spelling** (this supersedes the real-path wording above): the root is the nearest ancestor of `--dir`, as spelled, that IS the cwd (same device and inode - case, Unicode form, `/tmp`, a logical `$PWD` and macOS firmlinks such as `/System/Volumes/Data/...` all qualify), and everything below it is lstat-checked. If no spelled ancestor is the cwd but the target's physical parent chain reaches it, the command refuses (pass a path relative to the project). `create-loom-app` and `loom migrate-config --apply` follow the same rule (a symlinked target / linked directory is refused). The cwd itself is trusted even when reached through a link: a repository cannot make you `cd`, but take care with `cd repo/examples/demo` when `demo -> ../../..`.

| Argument / flag | Meaning |
|---|---|
| `<intent>` | the intent as a quoted positional string |
| `--from <file>` | read the intent from a text file (takes precedence over the positional) |
| `--from-spec <file>` | replay a `.loom/appgen/<ts>.spec.json` lockfile verbatim — no NL, no model |
| `--dir <path>` | the project root (default `.`) |
| `--dry-run` | render the plan as a unified diff and write nothing |
| `--yes` | apply without the interactive confirmation prompt. A plan that **deletes** a flow or a step (from either planner, including `--model`) lists every deletion under `DESTRUCTIVE:` and asks first; with no TTY it is refused (exit 1, nothing written) unless `--yes` is given - this includes scripted or CI `--from-spec` replays whose lockfile deletes, which need `--yes`. Deleting a flow removes its flow file and its registration in `app/loom.gen.ts`; it does not edit grants in `app/config.ts` or any test, so clean those up yourself. Library callers of `cmdAppgen` must pass `confirm` or `allowDeletes: true` to apply a plan with deletes |
| `--check` | typecheck the app (`tsc`) after applying |
| `--model <spec>` | plan with a **model of your choice**: `anthropic:<model>`, `openai:<model>`, `gemini:<model>` (API key from the provider's env var), or a local `.gguf` path / `gemma:<path>` (needs [`@loom/appgen-model`](../tools/appgen-model) + `node-llama-cpp`) |
| `--model-big <spec>` | a stronger model the reasoning ladder elevates to on low confidence (any provider spec) |
| `--model-tier <e2b\|e4b\|12b>` | tier label for a **local** `--model` (default `e4b`; ignored for API providers) |
| `--offline` | force the deterministic, model-free planner (overrides `--model`) |

The intent grammar: `create a <name>` (a capability), `step <name>` / `delete <name>`, `use <model> first` / `elevate to <model>`, `pause for approval`, `generate ui`, `grant <tool> to <cap>`, `deploy on <target>`. Reasoning / approval / UI / grant wiring is emitted only when asked for.

```bash
# 1. preview a brownfield change as a diff (writes nothing)
npx loom appgen "Add a summarize step to the planner and pause for approval." --dir ./planner --dry-run

# 2. apply it (shows the plan, asks to confirm; --yes skips the prompt), then typecheck
npx loom appgen "Add a summarize step to the planner and pause for approval." --dir ./planner --yes --check

# 3. reproduce a previous generation exactly, with no model
npx loom appgen --from-spec ./planner/.loom/appgen/1783875332959.spec.json --dir ./elsewhere
```

**Spec lockfile.** Each apply records the accepted `ChangeSpec` to `.loom/appgen/<timestamp>.spec.json`. `--from-spec` replays it byte-for-byte — the appgen equivalent of a golden log, so CI stays model-free. When a new file collides, `appgen` prompts per file — `[r]ename / [s]kip / [o]verwrite`.

**Model of your choice (`--model`).** Optional. The planner is **provider-agnostic** — it reasons over whichever model you name:

- `--model anthropic:claude-opus-4-8` — via `@loom/llm`'s `AnthropicProvider` (`ANTHROPIC_API_KEY`).
- `--model openai:gpt-4o` — `OpenAiProvider` (`OPENAI_API_KEY`).
- `--model gemini:gemini-2.0-flash` — `GeminiProvider` (`GEMINI_API_KEY`).
- `--model ./model.gguf` (or `gemma:<path>`) — a **local** model via the optional `@loom/appgen-model` + `node-llama-cpp` (fully offline).

Planning runs through a cheap-first elevation ladder (`--model-big <spec>` names a stronger tier). If the provider/key is missing, the model is too weak, or it produces an invalid plan, `appgen` **falls back to the deterministic parser** — it is never left without a valid `ChangeSpec`. Any `@loom/llm` `LlmProvider` works; these four are wired by name for convenience.

**Which planner ran.** The plan header (and `--dry-run` output) is tagged `[deterministic]` or `[model]` (with any `[model, elevated e4b→12b]` ladder steps), and the spec lockfile records `changeSpec.planner`. When you pass `--model` but the model can't produce a usable plan, `appgen` prints a loud warning and falls back — so a `[deterministic]` tag after `--model` means the model bailed (try a stronger tier / Node LTS, or name steps explicitly). The generated *code* is identical either way; provenance lives in the header and lockfile, not the files.

---

## Validate before you run: `doctor`, `check`, `verify`, `lint`

Three static gates, in increasing order of what they need: `check` reads only a compiler manifest, `verify` loads your built config, `lint` reads source files. `loom doctor` is the front door that runs whichever of the three it can find inputs for — start there.

### `loom doctor [--dir .] [--config <module>] [--manifest <path>] [--strict] [--require <check,check>] [--json]`

Runs every pre-flight check whose input it can discover, and **reports the ones it could not run and why**. It adds no checking capability of its own; it exists because three commands with three different inputs meant a developer had to know all three existed before running one.

| Input | Discovered from | Enables |
|---|---|---|
| compiler manifest | `--manifest`, else `loom-manifest.json` or `dist/loom-manifest.json` under `--dir` | `loom check` |
| built config module | `--config`, else `loom.config.js` / `loom.config.mjs` / `dist/loom.config.js` / `dist/config.js` | `loom verify`, the memory-store check |
| source tree | `--dir` (defaults to `.`) | `loom lint claim-check` |

The memory-store check reads the app's configured `memoryStore` and answers two questions the
runtime otherwise answers much later. **Not configured** is a skip, not a failure — a browser app
or a test suite wants the in-memory default — but the skip says what it costs: agent memory and
any corpus are lost on restart, which is exactly the shape
[ADR 0090](adr/0090-knowledge-is-retrieval-over-memory.md) opened with. **Configured but without
`search`** is a failure: somebody chose that backend, and `recallRelevant()` /
`KnowledgeBase.retrieve()` refuse such a store rather than degrading to the newest N, so the app
is one relevance query away from throwing.

```bash
npx loom doctor
```

```text
loom doctor

  ✓ flow-graph (loom check)
      loom-manifest.json
  ✓ runtime verification (loom verify)
      8 rule(s), 0 error(s), 0 warning(s)
  – memory store (durability + relevance recall)
      no `memoryStore` configured — agent memory and any corpus live in the in-memory default and are LOST ON RESTART
  ✓ durable timers (can this deployment wake?)
      TimerStore wired
  ! timer wake ownership (does anything own a wake?)
      a TimerStore with no `timers.leases`: if more than one process polls it, every node
      resumes the same due execution. Fencing (K9.4) makes that safe, not cheap — the loser
      still pays for its effects up to the point it loses. Harmless on a single node; wire
      `timers.leases` before there are two
  ✓ claim-check reach-through (loom lint)
      .

passed, but 1 could not run — coverage is partial; 1 advisory (depends on how you deploy)
```

Four statuses, and the distinctions are the point:

| | meaning | fails the run? |
|---|---|---|
| `✓` | the check ran and passed | no |
| `✗` | the check ran and found a defect | **yes** (exit `1`) |
| `–` | **skipped** — the input it needs was not there | no |
| `!` | **advisory** — it ran, and what it found matters *depending on how you deploy* | no |

Two flags turn "could not run" into a gate. **`--strict`** makes every skipped check a failure (exit `1`, detail prefixed `could not run (--strict)`). **`--require <id,id>`** fails only if the named checks did not run; an unknown id is exit `2`. The ids are `flow-graph`, `verify`, `memory-store`, `timers`, `timer-ownership`, `heartbeat-leases`, `encryption-keys`, `plaintext-snapshot`, `archive-snapshot`, `claim-check` (also the `id` in `--json`).

```bash
loom doctor --config dist/loom.config.js --require verify,timers   # CI: these two must have run
loom doctor --strict --config dist/loom.config.js                  # CI: nothing may be skipped
```

Without either flag, a **skipped check never fails the run**, but it never reads as a pass either: `all checks passed` and `passed, but 1 could not run — coverage is partial` are deliberately different strings, so a green `doctor` can't be cited as evidence for a check that never ran.

An **advisory** is the other half of that honesty. "A TimerStore with no lease store" is a defect on a multi-node deployment and completely fine on one node, and `doctor` cannot see how many nodes you run — so it reports the fact, names the consequence, and leaves the judgement with you rather than failing your build on a guess or staying silent. Advisories are counted in the summary for the same reason skips are.

The two timer checks read what the **composition** wired, which is where the answer lives:

- **`durable timers`** — `✗` when schedules are declared with no `timers: { store }` (they can never fire), `!` when flows declare resume gates and no store exists (a `timeout` lives in the runner body, so this is inference, not proof — and it says so, including that `loom verify`'s timed-suspend rule cannot see them either).
- **`timer wake ownership`** — `!` when a timer store has no `timers.leases` behind it.

### `loom check --manifest <path>`

Static flow-graph validation from a **compiler manifest** — no app is loaded and nothing executes. It catches issues the type system can't: a step whose `toolId` has no registered effect, a capability routed to a missing agent, and similar graph defects. This is the same engine `defineConfig({ checks: { validate } })` runs at boot ([ADR 0012](adr/0012-flow-graph-validation.md)).

```bash
npx loom check --manifest loom-manifest.json
```

Output is either `✓ no issues` (exit `0`) or one line per problem followed by a count (exit `1`):

```text
  ✗ flow "investigate": step "triage" references unknown effect "triage-llm"

1 issue(s)
```

### `loom verify --config <module> [--manifest <path>]`

Pre-flight **runtime** verification over a built app ([`@loom/verify`](../packages/verify)). Unlike `check`, this one loads real wiring: the config module must export a `LoomApp` — the result of `defineConfig({…})` — as its **default export or as `app`**. The command calls `app.verify()`, which is read-only and off-log, prints the report, and exits `1` on any error-severity finding.

| Flag | Required | Meaning |
|---|---|---|
| `--config` | yes | path to the **built** config module (JS), or run the CLI under `tsx` |
| `--manifest` | no | a compiler manifest; **auto-discovered** if omitted |

The compiler manifest carries **three** per-flow source analyses, and all of them are **auto-injected** — you never hand-plumb runner source into a linter:

| Manifest field | Feeds | Catches |
|---|---|---|
| `loopIdentity` ([ADR 0061](adr/0061-step-identity-interpreter-guardrails.md)) | `determinism` | a loop-scoped `ctx.run`/`ctx.execute` whose step id can't vary per iteration |
| `nonDeterministic` | `determinism` | `Date.now`/`Math.random`/bare `fetch` reachable outside `ctx.decide`/`ctx.execute` |
| `runnerReach` ([ADR 0086](adr/0086-runner-body-reach-analysis.md)) | `capability-compat`, `effect-class`, `suspension-safety` | steps and suspend points reached from the runner body without being declared in `FlowDefinition.steps` |

Pass `--manifest` explicitly, or leave it off and a `loom-manifest.json` next to the config module — or in the cwd — is picked up automatically. Reach analysis also reports what it **could not** resolve (a `ctx.run` target imported from another module, a minted step id) as a `warn` on each of the three rules, so a partial analysis never reads as a complete one.

**And when there is no analysis at all, it says that too.** Without a manifest those three rules see only a flow's *declared* steps — no suspend points, no `ctx.run` targets — and used to report exactly as they do with full coverage:

```text
[manifest] none found — runner bodies were not analysed, so suspend points and undeclared
`ctx.run` targets are invisible to three rules (ADR 0086). Build with @loom/compiler, or
pass --manifest <loom-manifest.json>.
loom verify: 2 finding(s) — 1 error(s), 0 warning(s), 1 coverage note(s)
  [info] suspension-safety: 1 of 1 flow(s) had no runner-body analysis ("checkout"), so no
  suspend point is visible at all — timed-suspend safety is UNVERIFIED rather than clean…
  [error] suspension-safety (checkout): Flow "checkout" uses approval/resume but no
  ResumeAuthenticator is wired (K12); resume events would be unauthenticated.
```

Coverage notes are `info`: they **never** fail the run (`--manifest` is not mandatory, and an app that does not use the compiler is not wrong), and they are counted in the headline so `0 error(s)` cannot stand alone as a claim about code nothing read. One note per rule, not per flow. A manifest that carries no `runnerReach` gets the same message — the question is whether the analysis was *injected*, not whether a file exists.

```bash
npx loom verify --config dist/app.js
npx loom verify --config dist/app.js --manifest loom-manifest.json
```

Most rules need no configuration. One does: **`effect-class`** (ADR 0084) only runs when the app
declares its class vocabulary, because the taxonomy is a product decision rather than loom's —

```ts
defineConfig({
  checks: { verify: { mode: "error", effectClasses: ["read-only", "local-write", "external-write", "irreversible"] } },
});
```

— and each flow declares its ceiling with `flow$({ effectClass })`, each step the class of the
effect it performs with `step$({ effectClass })`. Omit the vocabulary and the rule is a no-op.
A flow that declares a ceiling but reaches unclassified steps is reported as **only partially
verified** rather than passing clean.

`checks.verify` also takes **`reach`** (L32): a map from the callee a flow hands its `ctx` to
(`"planner"` or `"planner.compose"`, as written in the flow source) to the real object carrying
its reach declaration, e.g. `checks: { verify: { reach: { planner } } }`. A hand-off with no entry
is reported unresolved, naming the key to add (ADR 0086, L32).

> If the config's own `defineConfig` sets `checks: { verify: "error" }`, requiring the module throws at boot; the CLI catches that and prints it. This command exists for on-demand verification **independent** of the config's own mode.

### `loom migrate-config [<file>...] [--config <file>] [--apply] [--json]`

`defineConfig` options were grouped into `security`, `observability`, `durability`, `execution` and `checks`; the old flat spellings (`strict: true`, `telemetry`, `now`, ...) now **throw** at boot. This codemod rewrites them for you. The old-to-new table is `GROUPED_OPTIONS` in `@loom/app`, the same one the error message is built from.

- It **reads** the config as text and never imports or runs it, so it is safe on any file. With no argument it uses `./loom.config.js` or `./loom.config.ts`; otherwise name the file(s) (positional or `--config`).
- **Dry run by default**: it prints a unified diff and exits `0`, like every other verb with `--apply`. `--apply` writes the files. Run it again and it reports `nothing to migrate`.
- Each flat entry moves **verbatim**, with its leading comments, into its group: merged into an existing `security: { ... }` literal, or a new group object placed where the first moved entry was. Everything else in the file is byte-identical.
- It **refuses (exit `2`) and writes nothing** for that file when it cannot be sure: a spread (`...base`, which may carry flat keys), a computed key, `defineConfig(cfg)` with a non-literal argument, a group that is not an object literal (`security: shared`), or entries sharing a line (run your formatter). The message says what to change by hand.
- A key set **both** flat and inside its group is a **conflict**: reported, exit `2`, nothing written. Keep the one you want and re-run.
- `--json` emits `{ apply, files: [{ path, changed, moved, conflicts, refusal, diff }], refused }`.

```bash
npx loom migrate-config               # preview ./loom.config.ts
npx loom migrate-config --apply       # rewrite it
```

### `loom lint claim-check [--dir .]`

Source lint for the claim-check contract (CC-5, [ADR 0054](adr/0054-claim-check-middleware.md)). Only modules that *define flows* are scanned — a file containing `flow$(`, `step$(`, or `handler$(` — since the rules are about the determinism boundary:

| Rule | Flags |
|---|---|
| `resolve-inside-flow` | `resolveClaimCheck` referenced where flows are defined — replay never resolves a ref, so flow control fed by resolved payload content diverges |
| `forged-envelope` | a hand-written `__loomClaimCheck:` literal — envelopes are minted by the middleware from stored bytes; a forged one cites content that may not exist |

Branching on the **envelope itself** (`isClaimCheck`, the `digest`, `size`) is the sanctioned pattern and is never flagged. `--dir` defaults to `.`. Exit `0` when there are no findings, `1` otherwise.

```bash
npx loom lint claim-check --dir app
```

---

## Observe a run: `ls`, `logs`, `debug`, `inspect`

All of them fold the durable log deterministically — they replay events, they never re-run effects, and none of them writes.

### Choosing the store: `--config`, `--db`, or `./loom.config.js`

Every `<store-flags>` command takes `--config <module>` or `--db <events.db>`. With **neither**, the **read-only** commands (`ls`, `logs`, `debug`, `census`, `profile`, `introspect`, `inspect`) look for `./loom.config.js` (then `./loom.config.ts`) in the working directory, use it, and say which on stderr (`loom: using ./loom.config.js …`). No file → the usual refusal (exit `2`). Every other command (`recover`, `repair`, `retention`, `sweep`, `branches`, `learn`, `optimize`, `dev`, …) never guesses a store, with or without `--apply`: name it explicitly.

> **Discovery executes code.** Using `./loom.config.js` means *importing* it, which runs that file and everything it imports. Do not run `loom ls` (or any read-only command) bare in a checkout you do not trust — pass `--db` (SQLite shorthand; nothing is imported) instead.

Loading a config:

- **TypeScript configs.** A `.ts` `--config` is loaded through [`tsx`](https://tsx.is) **if it resolves from the config's own directory** upward through its `node_modules` chain (`NODE_PATH` is honoured too; `pnpm add -D tsx` in that project). The CLI bundles no transpiler. A config with **top-level await** must be an ES module — name it `loom.config.mts` or set `"type": "module"` in its `package.json` (tsx compiles a plain `.ts` in a CommonJS package to CommonJS, which cannot hold a top-level `await`; the error says so, exit `1`). Without it: `built? point --config at the compiled .js, or install tsx …`, exit `2`.
- **Errors say where.** A config that throws on import is reported as `while loading <absolute file>: <message>` plus a hint (exit `1`). `--verbose` or `LOOM_DEBUG=1` also prints the original stack to stderr.
- **No `[loom] …` noise.** While importing a config the CLI sets `LOOM_QUIET=1`, which silences `defineConfig`'s default `console.warn("[loom] …")` composition notices so they do not bury the command's answer (they never touch stdout, and `--json` stays pure either way). `LOOM_DEBUG=1` leaves them on. `LOOM_QUIET=1` only mutes that default sink: an `onWarn` you pass still runs, and refusals (thrown errors) are never silenced. Set it yourself to quiet a script that imports your config.

### `loom ls <store-flags> [--status …] [--workflow <id>] [--since <dur>] [--limit N] [--keys] [--json]`

Lists executions: id, workflow, status, last sequence, last activity time (absolute plus `5m ago`), and for a **suspended** one what it waits on — the event type it is parked on, or for a timer `timer wakeAt <iso> (in 3m)` (and `overdue` when the time has passed and nothing has woken it). The gate's `correlationKey` is an application-chosen id that can be sensitive, so it is **omitted** from the text, from `--json` and from the inspector list; `--keys` includes it (`key <id>`). The lease owner and the gate event name are operational ids and always shown. Give a lease store (`--leases <l.db>`, or the app's `timers.leases` via `--config`) and a row also shows the lease owner and whether it is expired.

```bash
npx loom ls --db .data/events.db --status suspended
```

```text
ID        WORKFLOW  STATUS     LAST  LAST ACTIVITY                         WAITING ON
01J8…a    refund    suspended  #6    2026-10-17T09:12:03.000Z (4m ago)     event ApprovalGranted
01J8…b    nightly   suspended  #3    2026-10-17T09:00:00.000Z (16m ago)    timer wakeAt 2026-10-17T10:00:00.000Z (in 44m)

2 shown, 41 execution(s) scanned
```

- `--status` is one of `pending|running|suspended|completed|failed|cancelled|continued`; `--since 1h` keeps executions with activity in the last hour.
- It is **bounded**: it scans at most 5000 executions (the cap bounds the *scan*, not the matches), orders the matches by last activity, newest first, and prints the first `--limit` of them (default `50`). When it cuts anything it says so (`2 shown of 9 matched`, `truncated at --limit 50 …` / `stopped after scanning …`) — a partial list is never printed as a complete one; `--json` carries `matched` and `truncated`. One read and fold per execution scanned; reserved control streams are skipped.
- A store that cannot enumerate executions is refused with the same wording as `loom census` (exit `2`).

### `loom logs <store-flags> <executionId> [--redact a,b] [-v] [--type A,B] [--from N] [--to N] [--follow]`

Prints the event timeline, one line per event: a `⏸` marker on `EXECUTION_SUSPENDED`, the sequence `#N`, the event type, and a per-type detail (the step id, the suspension target, a truncated output, or an error message).

```bash
npx loom logs --db .data/events.db 01J8…
```

```text
   #0  EXECUTION_STARTED
   #1  STEP_STARTED        collect-metrics
   #2  STEP_COMPLETED      collect-metrics
 ⏸ #3  EXECUTION_SUSPENDED on ApprovalGranted
   #4  STEP_STARTED        remediate
   #5  EXECUTION_COMPLETED {"summary":"…"}
```

- **`-v` / `--verbose`** adds, under each event: its timestamp, the time since the previous event shown (`+120ms`), a step's own duration on its `STEP_COMPLETED`/`FAILED`/`CANCELLED` (`step 95ms`), the recorded actor/principal when the event carries one, and the payload cut to 200 characters. `--redact` is applied first, so a masked value is what gets truncated.
- **`--type A,B`** keeps only those event types; **`--from N` / `--to N`** keep an inclusive sequence window (read as a range query where the store offers one). An empty window prints `(no events match …)`; an unknown execution id is still exit `1`. `--from` after `--to` is exit `2`.
- **`--follow`** prints what is there, then polls the log from the last sequence every `--interval <dur>` (default `500ms`) and prints each new event as it lands (with `--json`: one event per line, ndjson). It stops with exit `0` when the execution reaches a terminal state (`completed`, `failed`, `cancelled`, `continued`; a `-- execution <id> completed (seq N) --` line (for `continued`, `-- execution <id> continued -> <successor> (seq N) --`) goes to stdout, or to stderr under `--json`) and on Ctrl-C. A suspended execution is **not** terminal — `--follow` keeps waiting for the resume. Read-only: it only reads past the tip. `--interval` below `50ms` is refused (exit `2`) so the poll cannot busy-loop the store. `--redact` masks by path; each batch of events (the first batch is the whole existing log) is learned in full before anything is printed, so a secret found at a redact path in any event — including one that `--type/--from/--to` filters out — is scrubbed from every line, earlier ones in the batch included. Only a secret that first appears in a LATER batch cannot scrub lines already printed.

### `loom debug --db <path> <executionId> [--at N]`

Time-travel inspection. With `--at N` it prints the **folded state at sequence `N`** (an `N` past the last event is refused — `sequence N > last (M)`, exit `2` — rather than quietly showing the final state); without `--at` it prints the full timeline followed by the final folded state.

```bash
npx loom debug --db .data/events.db 01J8… --at 3   # state as of sequence 3
npx loom debug --db .data/events.db 01J8…          # timeline + final state
```

The state block reports the execution and workflow ids, status, sequence, the suspension target (if suspended), each step frame's status, and the output (if set):

```text
execution 01J8…  (workflow investigate)
status: suspended   sequence: 3
suspended on: ApprovalGranted
frames:
    collect-metrics: completed
    remediate: pending
```

### `loom snapshot show <store-flags> <executionId> [--at SEQ] [--redact a,b]`

Print one stored **snapshot**, decoded, as indented JSON (`id`, `executionId`, `workflowId`, `sequence`, `createdAt`, `state`). Without `--at` it is the latest snapshot; with `--at SEQ`, the one stored at exactly `SEQ` (a snapshot at another sequence is a different state, so it errors and says so rather than substituting a neighbour).

Use it instead of SQL on `snapshots.state`: with the opt-in zstd snapshot codec ([ADR 0141](adr/0141-snapshot-zstd-codec.md)) the state lives in a `BYTEA`/`BLOB` frame that `state->` cannot traverse, and the command reads it through the same snapshot store the runtime resumes from (either storage format decodes; an encrypting store opens it). `--redact` masks output dot-paths as in `loom debug`. With `--db` it also needs `--snap <snapshots.db>`; with `--config` it uses the app's own snapshot store. It is read-only, and exits `1` when there is no such snapshot and `2` when the store has no snapshot store.

```bash
npx loom snapshot show --db .data/events.db --snap .data/snapshots.db 01J8…
npx loom snapshot show --config ./loom.config.js 01J8… --at 40 --redact variables._input.ssn
```

### `loom inspect --db <path> [--port N]`

The page opens with a clickable **executions** list (filterable by status) backed by the same scan as `loom ls` — read-only, `GET /api/executions[?status=&limit=]`; click a row to load its timeline. It binds `127.0.0.1` unless told otherwise.

Launches a local **web inspector**: a timeline with a time-travel slider that fetches the folded state at each sequence. `--port` defaults to `0`, letting the OS pick a free port; the chosen URL is printed. The server runs until you stop it with Ctrl-C ([ADR 0014](adr/0014-deploy-check-and-inspector.md)).

```bash
npx loom inspect --db .data/events.db
# → loom inspector on http://localhost:53812  (Ctrl-C to stop)
```

Enter an execution id in the page, then drag the slider to walk the run. Under the hood it serves `/api/trace/:executionId` (the timeline render model) and `/api/state/:executionId/:sequence` (the same folded state as `loom debug --at`).

### `loom dev --config <module> [--dir app] [--run <command>] [--port N]`

The development loop. **Behaviour change:** until now `loom dev` was an alias of `loom inspect`; it is now a real dev loop and `loom inspect` is unchanged. `loom dev --db …` is refused (exit `2`, pointing at `loom inspect`).

It does three things at once:

1. **`gen --watch`** over `--dir` (default `app`): `loom.gen.ts` is regenerated when a module is added, removed or renamed.
2. **Runs your app** as a child process and **restarts it on change**. The command is `--run "<command>"`, or else the `dev` script in `./package.json`, or else its `start` script (a `dev` script that itself calls `loom dev` is skipped). It runs through the shell with `node_modules/.bin` on `PATH` (as an npm script would), with `LOOM_DEV=1` set. Any file change under `--dir` (not `node_modules`, `dist`, `.git`, `.data`) restarts it once per burst; a change that adds/removes a module also regenerates first. Only source files restart it (`.ts .tsx .mts .cts .js .mjs .cjs .json`; dotfiles, editor swap/backup files and SQLite `-wal`/`-shm`/`-journal`/`.db` files are ignored). **`.json` is a watched extension**, so an app that writes `.json` files under `--dir` restarts itself in a loop - write runtime data outside `--dir`. And a steady stream of events cannot postpone a restart for more than about a second. **Limits:** only `--dir` is watched, so the entry file, `loom.config`, `.env` and `package.json` changes outside it do not restart the app (restart `loom dev` yourself); the child's stdin is not attached; on Windows only the shell child is killed, not its grandchildren; the config module's top-level side effects run in both the dev process (for the inspector, which loads the config once) and the app. The child inherits the environment `loom dev` was started with (the inspector's `LOOM_NO_AUTOSTART` / `LOOM_QUIET` are not passed on). A stopping app gets a 3 s grace after SIGTERM before its group is SIGKILLed; a second Ctrl-C kills the group at once; SIGHUP stops gracefully. `loom dev` refuses to run inside its own child (`LOOM_DEV=1`, exit `2`) and validates `--port` (integer 0..65535).
3. **The inspector** over the stores of `--config`, on `127.0.0.1` (`--port`, default: a free port, printed). The config is loaded **in the dev process** without starting its timers, so the inspector sees executions only when the app uses durable storage (for example sqlite) shared with the child. If the config does not load yet (mid-edit), the loop continues without the inspector.

The child runs in its **own process group**: a restart or Ctrl-C signals the whole group (SIGTERM, then SIGKILL after 3 s), so no orphan keeps a port or a database open. An app that exits `0` waits for the next change; one that exits non-zero is restarted with a backoff (1 s, doubling to 30 s; a change restarts it immediately). Ctrl-C (or SIGTERM) stops everything and exits `0`.

```bash
npx loom dev --config ./loom.config.ts                 # runs the "dev" or "start" script
npx loom dev --config ./loom.config.ts --run "tsx app/main.ts" --port 4000
```

---

## Act on a run: `resume`, `cancel`, `start`

The only commands that make an execution *do* something. They are a **security boundary**, so they are built to add no privilege and to bypass no check:

```bash
loom resume <executionId> --config <module> --as <principal> [--tenant <t>] \
    --event <type> (--payload <json> | --payload-file <path>) [--wait-id <id>] [--show-payload] [--redact a,b] \
    [--force] [--allow-local-controls] [--skip-effect-check] [--apply] [--json]
loom cancel <executionId> --config <module> --as <principal> [--tenant <t>] [--reason <text>] [--force] [--apply] [--json]
loom start  <flowId>      --config <module> --as <principal> [--tenant <t>] (--input <json> | --input-file <path>) \
    [--id <executionId> | --idempotency-key <k>] [--show-payload] [--redact a,b] [--allow-local-controls] [--skip-effect-check] [--apply] [--json]
```

**Dry run by default.** Without `--apply` they report, and change nothing: the execution's status and what it waits on (for `resume`, also the park's sequence number — an approval signed to a park binds it, [ADR 0117](adr/0117-approvals-bound-to-what-the-approver-saw.md)), the live lease if any, and for `resume` what the flow's `resumeSchemas` ([ADR 0077](adr/0077-typed-resume-payloads.md)) make of your payload — **the parsed value, with the keys the schema strips named**, because `z.object` drops unknown keys and what is recorded is the parsed value, not what you typed. For `start` the input is shown **as given** (redacted) and the flow's input schema is evaluated: if the app enforces it (`execution.validateInput`) a failing input is predicted, and if the app does not, the dry run says "schema not enforced by the app - recorded as given". On `--apply` the CLI never validates the input itself: the runtime does, after its authorizer. Whether the resume authenticator and the execution authorizer will admit the call is **evaluated on `--apply`** (the runtime offers no side-effect-free way to ask), and the dry run says so.

### The trust model

- **Only through your app.** `--config <module>` is required and is never discovered (the module is imported and executed, so a verb that writes never guesses it). `--db` — and `--snap`, `--branches`, `--leases` — are **refused (exit `2`)**: a bare store has no resume authenticator, execution authorizer, `resumeSchemas`, tenant isolation or sealed-payload keys, so acting on it would bypass all of them. The verbs call `app.runtime.resume` / `cancel` / `start` / `loadState` / `parkedAtSequence` and nothing else; they never append to the log and never build a runtime of their own. So every check the app's own code path runs, these run: the `ResumeAuthenticator` (K12.2, [ADR 0024](adr/0024-k12-identity-tenancy-delegated-authority.md)), the `ExecutionAuthorizer` including tenant scoping and fail-closed principals ([ADR 0111](adr/0111-durable-principal.md)), the typed resume gate, the gate/event-type check, input validation, start-once ids ([ADR 0103](adr/0103-durable-bootstrap-for-caller-chosen-ids.md)), fencing and heartbeat leases ([ADR 0118](adr/0118-acquire-if-parked-fence.md), [ADR 0130](adr/0130-sealed-payload-delivery-guard.md)), sealed streams. Because the continuation runs in this process through the app's effect runtime, the capability ring and policies ([ADR 0017](adr/0017-k6-behavioral-safety-ring.md)) carry over - they are config-time. The **kill switch, budgets and rate limits are per process** (next section).
- **Identity is `--as`** (the principal's `actor`) plus `--tenant`. `--as` is **required**: a call with no principal bypasses a non-strict app's authorizer by design (that is how the kernel's own machinery is exempt), and a CLI must not use that door. The CLI asserts the principal; it does not authenticate it. An operator who holds the config module and the store credentials is trusted **exactly as far as the app's checks admit** — the CLI grants nothing a check would refuse and removes nothing. Effects of a resumed execution run as the principal **recorded when it started**, never as `--as`.
- **A credential rides in the payload, untouched.** If the app verifies an approval (a signature, a session), put the signed event in `--payload` / `--payload-file`; the authenticator sees exactly the event you gave. The CLI invents no credential. Prefer `--payload-file` for secrets: it keeps them out of shell history, and the file's contents are never echoed unless you pass `--show-payload`. Shown payloads go through `--redact` (the same masking as `logs`), and a JSON syntax error says "not valid JSON" without quoting your text.
- **Refusals are exit `2`, with the app's reason, and append nothing** — a rejected approver, a payload failing `resumeSchemas`, a wrong event type, a non-suspended or unknown execution, an authorizer denial, a tenant mismatch, a live foreign lease, unknown lease liveness without `--force`, a kill switch that is process-local or does not declare itself shared, without `--allow-local-controls`, a flow effect the app has not registered, a timer service already running, a duplicate start. One honest exception: when the *app's authorizer* denies a `resume`/`cancel`, the app's own runtime records its `EXECUTION_DENIED` audit fact, exactly as it would for the app's code; the CLI does not suppress that. A failure *after* acceptance is exit `1`: the resumed flow throws, the runtime's storage fails, the runtime refuses a diverged body (the execution is parked on the reserved gate `__loom_diverged__`), or the log does not end up suspended / completed / cancelled. The CLI waits for whichever of completion or park settles first, treats a *rejected* park as the failure it is, and re-reads the log (as `--as`) rather than trusting the in-memory handle.
- **Failures print the error's NAME, not its message.** A step, effect or tool that throws, or a `ZodError` from a step/tool schema, can quote a value the run handled, so an exit-`1` failure reads `the run failed: <ErrorName> — rerun with --show-payload for the message, or see \`loom logs <id>\`` unless you pass `--show-payload`. Messages that are policy or contract text (`ExecutionDeniedError`, `ResumeRefusedError`, `FlowCodeMismatchError`, `Sealed*`, `Quarantine*`) are relayed as is. A run that failed *and* was cancelled reports both (exit `1`).
- **Durability is verified, or the output says it was not.** After `resume --apply` / `start --apply` the CLI re-reads the log as `--as`. If that read is denied by the app's query authorizer (or the state is sealed/erased) the output says `durability not verified: <reason>` and `--json` carries `"verified": false`; the exit code follows the handle's own status (`0` for a non-failure). If the store read itself fails the verb exits `1`.
- **Nothing a failing schema quotes is printed.** A zod message can echo the received value, so the schema predictions and the relayed `ResumePayloadValidationError` / `InputValidationError` / `ApprovalRejectedError` show the issue path and code only (the runtime's detail is withheld) unless you pass `--show-payload`.

### In process, not delivered

`resume` and `start` **run the continuation in this process**, through your app's effect runtime - the runtime has no public path that records a gate answer for "the owning worker" to pick up (only the durable inbox, `runtime.send`, delivers by itself, and it is not a gate). So the effects of the resumed steps happen *here*, with this machine's network and credentials. `cancel` runs nothing: it records `EXECUTION_CANCELLED` under a fence (K8.2).

**The `--config` module must be the side-effect-free composition module** (the file that calls `defineConfig` and exports the app), not a server entry that also calls `app.start()` or `listen()` - importing the module runs it. The CLI sets `LOOM_NO_AUTOSTART=1`, which suppresses only `defineConfig`'s own timer start; a module that starts services itself still does. So after the import the CLI checks `app.timerService.running`: if it is running it warns on stderr and **refuses `--apply` (exit `2`)**. A flow that parks again leaves its timer row in the store for your real workers to fire.

**What carries over and what does not.** The capability ring and policies are composed from config and apply here. The **kill switch, budgets and rate limits are per process**: under `security.strict` the default kill switch is an `InMemoryKillSwitch`, so an operator `stopTenant` issued in the running app is invisible to the CLI. The dry run says "kill switch / budgets / rate limits are process-local: a stop issued in the running app does NOT apply here", and `resume --apply` / `start --apply` **refuse (exit `2`) unless you pass `--allow-local-controls`**. **Fail-closed:** a kill switch counts as shared only if it *affirmatively declares* `scope: "shared"` — the optional `KillSwitchRegistry.scope` marker (`"process" | "shared"`, `@loom/middleware`; `InMemoryKillSwitch` declares `"process"`). A store-backed registry opts in with `readonly scope = "shared" as const;`. A registry with no marker, a subclass or proxy of `InMemoryKillSwitch`, a wrapper or decorator that does not re-declare `scope`, and a custom `{ check }` are all treated as process-local and need `--allow-local-controls`. `cancel` runs no effects and is exempt. Budgets and rate limits are per process either way.

**Effects must be registered.** The dry run checks the effects the flow *declares* and has not yet run (each such step's `toolId`, else its id; for `resume`, steps already completed in the folded state are skipped) against `app.effectRuntime`; a missing handler would fail the execution permanently, so `--apply` is refused (exit `2`) listing them. If the execution is pinned to a different flow version than the registered one (the runtime does not expose older versions' steps) the check is skipped and the dry run says so. A step the flow runs without declaring it cannot be known ahead of time. `--skip-effect-check` bypasses the check: you accept that a missing handler will fail the execution.

**Concurrency and leases.** `resume` answers exactly the park it read, under a conditional fence (`fenceIfParkedAt`, ADR 0118 - the same path the timer service uses), takes the runtime's heartbeat lease before the first append, and is refused if another live owner holds the lease (exit `2`, nothing appended; a holder that arrives after the CLI's check is refused by the runtime the same way). The lease line says `none live` only when the app's lease store could be asked. When it cannot - the lease store has no `get`, is process-local, errors, or heartbeat leases are off (`heartbeat leases off - liveness unknown`) - it says so, and **both `resume --apply` and `cancel --apply` require `--force`** (a live owner may be mid-run). `cancel` also refuses a *known* live foreign lease unless `--force`. The fence stops the owner's **next** write; it does not stop an effect that is already running. `start --id` is start-once.

**Idempotency keys.** `--idempotency-key k` derives the execution id `idem-` + the first 32 hex digits of `sha256` over a domain-separated, length-prefixed encoding of (`loom.cli.start.idempotency.v1`, tenant, flow id, key). The **tenant** is part of it, so two tenants using one key get two executions and one cannot squat or probe the other's id; the acting principal is not (the key names the request, not who retries it). A retried start in the same tenant is refused (start-once) rather than run twice.

**Cancelling an erased execution.** If the execution was crypto-shredded in place its state is unreadable, so `cancel` skips the snapshot and records the cancel through the runtime as `--as`. A dry run prints only `state not shown` - identical to a read the authorizer denied, because the runtime folds a state before it authorizes the read and a distinct message would tell an unauthorized caller that the execution exists and was erased. Only after `--apply` succeeds (the runtime's cancel authorized you) does the output say the state was unreadable.

```bash
# What would this approval do?
loom resume rel-42 --config dist/app.js --as release-bot --tenant acme \
    --event ApprovalGranted --payload-file approval.json
# …do it.
loom resume rel-42 --config dist/app.js --as release-bot --tenant acme \
    --event ApprovalGranted --payload-file approval.json --apply
loom cancel rel-42 --config dist/app.js --as release-bot --tenant acme --reason "superseded" --apply
loom start release-approval --config dist/app.js --as release-bot --input '{"service":"api","changeType":"hotfix"}' --idempotency-key api-2026-10-17 --apply
```

---

## Keep it healthy: `census`, `recover`, `branches`

The fleet-level maintenance verbs. `census` only reads; `recover` and `branches` **write**, so both are **dry runs by default** and act only under `--apply` (the same vocabulary as `retention` and `sweep content`). None of them discovers a store for a write: `recover`, `branches` take `--config <module>` or `--db <events.db>` (see [Choosing the store](#choosing-the-store---config---db-or-loomconfigjs)); `census` may also use `./loom.config.js`.

### `loom census <store-flags> [--buckets 5m,1h,6h,24h] [--sample N] [--json]`

What is stuck, and is anything watching it. Counts the in-flight (running/pending) executions older than each bucket, and, when the store has leases, how many of them hold a live lease, an expired one, or none at all (`no lease at all` is the number to watch: nothing can recover those from evidence). Parked executions are summarized separately: how many are suspended, how many wait on a timer, and how many timers are **overdue** (`wakeAt` already passed, nothing has woken them).

- `--buckets` are the age thresholds, as durations or plain milliseconds (default `5m,1h,6h,24h`).
- `--sample N` is how many example execution ids are kept per band (default `5`), so a band is a pointer, not a dump.
- `--json` emits `{ ok, census, suspended, note? }`. Read-only, takes no predicate, and exits `0` whenever it ran.

```bash
npx loom census --db .data/events.db --leases .data/leases.db --buckets 1h,24h --sample 3
```

### `loom recover <store-flags> (--stale 15m | --config <module> with timers.leases) [--owner <id>] [--limit N] [--max-recoveries N] [--apply]`

Re-drives executions whose supervisor died. Loom will not guess what counts as abandoned, so you must supply the evidence: either the app wires `timers.leases` (an **expired lease** is the evidence), or you pass `--stale <duration>` to state your own rule. With neither it refuses (exit `2`), because a running execution owned by a healthy node looks exactly like an orphaned one.

- `--owner <id>` names the lease holder the command takes while re-driving (default `loom-recover`).
- `--limit N` caps how many executions one pass touches.
- `--max-recoveries N` (an integer, at least 1) skips and lists executions whose last N re-drives made no progress, so a poison execution cannot be re-driven forever.
- **`--apply` needs `--config`**: re-driving runs the flow's steps, and only your app has the flows and effects registered. Through `--db` you can preview but not apply (exit `2`).

### `loom branches retire <store-flags> (--branches <b.db> | --config <module>) --parent <id> --stale <d> [--limit N] [--apply]`

Cancels branches of `--parent` that nobody is coming back to, so the parent they pin stops being uncollectable by `retention run`. `--stale` is required with no default: a branch parked on a human gate is an open question, not garbage. It needs a branch registry (`--branches <branches.db>`, or `--config` where the app supplies one). The report also lists what stays open and why.

### `loom branches prune <store-flags> (--branches <b.db> | --config <module>) [--protect main,rel] [--limit N] [--apply]`

Deletes branch refs that name executions the log no longer has. `main` is protected by default; `--protect` names more refs to keep.

```bash
npx loom recover --db .data/events.db --stale 15m                  # preview
npx loom recover --config dist/app.js --stale 15m --max-recoveries 3 --apply
npx loom branches retire --config dist/app.js --parent rel-42 --stale 7d --apply
npx loom branches prune --config dist/app.js --protect main,release
```

---

## Analyze a run: `profile`, `introspect`, `optimize`

Three read-only lenses from [`@loom/analytics`](../packages/analytics), all with the same shape: `--db <path>` plus a positional `<executionId>`. They fold one execution's log and print — nothing is mutated, no effect re-runs. An unknown id is an error — `no such execution <id> (N executions in this store — try loom census)` on stderr, exit `1` (it used to print `(no execution "<id>")` and exit `0`, which read as "nothing happened" when the id was merely mistyped). `--graph` must be one of `executions|tasks|decisions|resources`, else exit `2`.

### `loom profile --db <path> <executionId>`

A flame graph plus latency breakdown for one execution — "DevTools for Loom" in the terminal ([ADR 0029](adr/0029-runtime-observability-profiler.md)). Use it to find which step actually owns the wall clock.

```bash
npx loom profile --db .data/events.db 01J8…
```

### `loom introspect --db <path> <executionId> [--graph <name>]`

The runtime introspection facade ([ADR 0031](adr/0031-runtime-introspection-facade.md)): the **execution**, **task**, **decision**, and **resource** graphs folded from the log. `--graph <name>` prints just one; omit it for all four.

```bash
npx loom introspect --db .data/events.db 01J8…
npx loom introspect --db .data/events.db 01J8… --graph decision
```

### `loom optimize --db <path> <executionId>`

The advisory optimization report ([ADR 0034](adr/0034-advisory-optimization-pipeline.md)) — observe → analyze → recommend → evaluate → learn over one execution's log. **Advisory only**: it emits recommendations and mutates nothing. Adopting one is an explicit `ctx.decide` you write in app code, so the choice stays on the log.

```bash
npx loom optimize --db .data/events.db 01J8…
```

---

## Learn from the log: `learn report`, `learn eval`

The offline half of the learning loop ([ADR 0080](adr/0080-learning-substrate.md), [`@loom/learning`](../packages/learning)). Both are read-only over the log and run out of band — neither touches a live execution, and adopting a policy remains an explicit wiring change in application code.

Both take `--db <path>` and an **optional positional `<executionId>`**. Omit it to sweep every execution — which requires the store to implement the optional `listExecutions` SPI (1.1.0); a store without it errors and asks for an explicit id.

### `loom learn report --db <path> [executionId]`

What the log can — and cannot — teach. Folds `DECISION_RECORDED` into trajectories and reports decision-step coverage (how many steps carry a `context`, how many carry a `policy.propensity`), reward attribution (`direct` / `terminal` / `none`), and per-arm evidence best-first — the same shape `@loom/reasoning`'s `ucb1` consumes.

It also prints **blocking gaps** — e.g. no outcome naming a `decisionId`, meaning rewards are aggregated globally rather than per decision. Read this before you write a policy: it tells you whether off-policy evaluation is even possible on the log you have.

```bash
npx loom learn report --db .data/events.db            # every execution
npx loom learn report --db .data/events.db 01J8…      # just one
```

Prints `(no events)` or `(no decisions recorded — nothing to learn from)` when there's nothing to fold. Exits `0`; an explicit `[executionId]` that does not exist is exit `1` (`no such execution`).

### `loom learn eval --db <path> --policy <module> [--min-steps N] [executionId]`

Shadow-evaluate a **candidate policy** against historical traffic — SNIPS off-policy evaluation, then the promotion gate. Nothing is promoted; the exit code *is* the verdict.

| Flag | Required | Meaning |
|---|---|---|
| `--policy` | yes | module exporting a `Policy` as `policy` or as the default export (needs `id`, `version`, `select`) |
| `--min-steps` | no | the promotion gate's minimum decision-step evidence |

The module path may be relative (resolved against the cwd) or absolute. A module that doesn't export a usable `Policy` fails with a message and exit `1`.

```bash
npx loom learn eval --db .data/events.db --policy dist/policies/linucb.js --min-steps 500
```

```text
  GATE: refused
    - only 120 decision steps (min 500)
```

Exit `0` when the gate passes, `1` when it refuses — so it drops straight into a promotion pipeline.

---

## Ship safely: `eval`, `deploy check`

Both replay stored logs offline — no live model calls, no flakiness — so they run as CI gates.

### `loom eval --dir <path>`

Replays **golden logs** against declared expectations, a deterministic regression gate ([ADR 0010](adr/0010-loom-cli.md)). Each `*.json` file in `--dir` is a fixture:

```json
{
  "name": "happy-path",
  "log": [ /* EventEnvelope[] — a captured run */ ],
  "expect": {
    "status": "completed",
    "outputContains": "remediated",
    "stepsCompleted": ["collect-metrics", "remediate"]
  }
}
```

The `expect` block (and each key in it) is optional. Capture a `log` with `@loom/testing`'s `captureGolden` (see [Usage Step 12](usage.md#step-12--test-it)).

```bash
npx loom eval --dir evals/
```

```text
  ✓ happy-path
  ✗ denied-path
      status: expected completed, got failed

1 passed, 1 failed
```

Exit `0` when every golden passes, `1` if any fail.

### `loom deploy check --logs <dir> --config <module>`

Replays **historical logs against your new flow definitions** to catch resume-incompatibility *before* you promote — the kind of break types can't see, like a removed step that an in-flight execution still needs to replay ([ADR 0014](adr/0014-deploy-check-and-inspector.md)).

| Flag | Required | Meaning |
|---|---|---|
| `--logs` | yes | directory of `*.json` files, each an `EventEnvelope[]` array |
| `--config` | yes | a module exporting a `FlowResolver` (`getFlow(flowId)`; optionally `getFlowIds()` and a paired `effectRuntime`) |

```bash
npx loom deploy check --logs logs/ --config dist/app.js
```

```text
  ✗ [flow-missing] 01J8…: flow "investigate" missing in new definition
  • [step-removed]  01J7…: flow "remediate": step "old-gate" removed (resume-incompatible)

2 checked, 2 issue(s), NOT SAFE to promote
```

`✗` marks a **breaking** change (fails the gate, exit `1`); `•` marks an advisory. A clean run prints `✓ N execution(s) — safe to promote` (exit `0`). When the config also exports an `effectRuntime`, an optional K9 advisory flags tool effects with no `idempotent` declaration (re-run at-least-once on recovery) — advisory only, it never fails the gate.

---

## Data protection: `retention run`, `sweep content`, `compliance report`

Operator sweeps over a stored log, built on the `listExecutions` store-SPI (1.1.0). Reserved
control streams (`__loom_*`) are filtered automatically. See [data classification](data-classification.md) and [compliance](compliance.md).

**Nothing prunes on a timer** — the operator drives every sweep, and both reclaiming commands are **dry-run by default**.

### `loom retention run --db <events.db> --snap <snap.db> --ttl <dur|ms> [--apply]`

Reclaim terminal executions older than the TTL (K10.1). **Dry run by default** — it reports
`would-reclaim` / `kept` / `not-terminal` per execution; `--apply` performs the deletion via
`LogLifecycle` (branch-integrity guard + `EXECUTION_ARCHIVED`/`EXECUTION_DELETED` control facts
included) and reports `reclaimed` / `blocked-by-branch` / …

> **`--ttl` is required.** It used to default to `0`, which makes *every* terminal execution
> eligible — so forgetting (or mistyping) the flag chose "reclaim everything". Now an omitted or
> malformed `--ttl` is refused with exit `2` before any store is opened. `--ttl 0` is still
> accepted when you really mean it. Accepts `30d`/`12h`/… or milliseconds.

```bash
npx loom retention run --db .data/events.db --snap .data/snapshots.db --ttl 90d   # dry run
npx loom retention run --db .data/events.db --snap .data/snapshots.db --ttl 90d --apply
```

### `loom sweep content --db <events.db> [--snap <snap.db>] --content <content.db> [--archive-db <path> [--archive-snap <path>]] [--compaction-archive <archive.db> | --no-compaction-archive] [--acknowledge-unarchived] [--pin KIND,KIND] [--ttl <ms>] [--orphans [--no-archive] [--snapshots-touch-content]] [--apply]`

The operator surface for the K10.6 **pinned blob sweep** ([ADR 0055](adr/0055-k10-6-pin-seam-content-gc.md)) — content-store garbage collection for claim-check payloads whose log references have aged out.

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--db` | yes | — | the event store — pins are re-derived from it every sweep (mark-and-sweep) |
| `--content` | yes | — | the content store being reclaimed |
| `--archive-db` | no | — | also scan an archived event store, so evidence cited by findings in archived runs stays pinned |
| `--pin` | no | — | comma-separated event **kinds** to treat as pinning |
| `--ttl` | no | `2592000000` (30 days) | age threshold in ms |
| `--orphans` | no | off | also erase blobs that NO scanned event cites and that were untouched for the TTL: runs deleted without an archive, crashes between `put` and the append ([ADR 0055](adr/0055-k10-6-pin-seam-content-gc.md) D6). Needs the snapshot store (`--snap`, `--archive-snap`), because a compacted execution's prefix refs live only in its checkpoint. **Every archive must be scanned**: under `--config` the app's `durability.retention.archive` is scanned automatically; on the `--db` path pass `--archive-db`. With `--apply` and no archive the command refuses. A fork or an append that carries an existing ref touches the blob (ContentStore SPI 1.4.0 `touch`, [ADR 0055](adr/0055-k10-6-pin-seam-content-gc.md) D6 amendment 2), so a fork made mid-sweep is safe; `--orphans --apply` therefore refuses a `--content` store that lacks `touch` (the SQLite store has it). The touch only protects a write shorter than the TTL, so `--orphans --apply` also refuses `--ttl` below 60000 ms (`--ttl 0` included); a dry run is exempt. `--orphans --apply` also needs `--snapshots-touch-content` (below), and a `--content` store with `touchClock` as well as `touch` (the SQLite store has both). |
| `--snapshots-touch-content` | with `--orphans --apply` | off | assert that the runtime which WROTE the snapshot stores wrapped them in `ContentTouchingSnapshotStore` (`@loom/plugin-content`, outside any encrypting snapshot store, over the same content store). A fork of a compacted parent saves a seed snapshot citing refs that exist nowhere else; only that wrapper touches them. The CLI opens raw snapshot stores and cannot tell, so without the flag `--orphans --apply` refuses and erases nothing; a dry run is exempt. loom does not build the wrapper for you: wire it where you build your `ContentResolvingEventStore`. |
| `--compaction-archive` / `--no-compaction-archive` | with `--orphans --apply` over a compacted log | `archive.db` beside `--db`, if it exists; under `--config` the app's `storage.archiveStore` | the compaction archive ([ADR 0138](adr/0138-compaction-archives-what-it-removes.md)): compaction MOVES events there, so a blob only an archived event cites is an orphan without it. An erasing pass over a compacted log refuses without one; `--no-compaction-archive` asserts that none exists, which alone no longer passes a compacted log: the archive's headers must cover its removed range, or `--acknowledge-unarchived` states that the history is already gone (logs compacted before the archive; fork children) and erasing their orphan blobs is accepted - the executions are printed. An explicit path that does not exist is refused, not created. |
| `--no-archive` | no | off | with `--orphans --apply`: assert that retention archives nowhere. The command then warns on stderr before erasing anything. |
| `--snap` / `--archive-snap` | with `--orphans` (`--archive-snap` whenever `--archive-db` is given) | — | the live / archive snapshot stores, where compaction checkpoints live |
| `--apply` | no | dry run | actually erase |

`.data/content.db` below is wherever YOUR content store lives (the path you gave your
`SqliteContentStore`); `sqliteStorage()` does not create it, and neither does this command.

```bash
npx loom sweep content --db .data/events.db --content .data/content.db          # dry run, 30-day ttl
npx loom sweep content --db .data/events.db --content .data/content.db --apply
```

```text
content sweep DRY RUN (pass --apply to erase) — ttl 2592000000ms — pins: (none)
  executions scanned: 412
  refs seen: 1180   pinned: 934   load-bearing: 934
  race-safe: yes
  would-reclaim (246):
    sha256:9f2c…
    … +226 more
```

Every refusal (a missing snapshot store, `--orphans --apply` with no archive, an execution that
looks compacted with no checkpoint) exits non-zero and erases nothing. At most 20 addresses are
listed, then `… +N more`. `race-safe: yes` means every erase is
conditional on the blob's touch time: a blob that some execution `put` again while the sweep ran
is kept ([ADR 0055](adr/0055-k10-6-pin-seam-content-gc.md) D5). The SQLite content store
supports this. An app with blobs cited from its own tables sweeps through the API instead, with
`sweepUnpinnedContent({ roots })` (D7). Pins are recomputed from the log on **every** sweep, so a run that becomes pinned between sweeps is protected without any bookkeeping.

### `loom repair blank-stream (--config <module> | --db <events.db> --snap <snap.db>) [--assign <id>:<from>-<through>,…] [--apply]`

Before [ADR 0106](adr/0106-compaction-integrity.md), a compaction checkpoint named execution
`""`, and every resume that followed a compaction wrote its events to execution `""` instead of
its own log. This censuses that stream and repairs what can be proven ([ADR 0107](adr/0107-compacted-fork-points-and-the-blank-stream.md)).
**Dry run by default.** It needs the snapshot store, because the proof lives there. Prefer
`--config`: it uses your app's own stores, including an encrypting store that can decrypt the
stray events. With `--config`, `--db`/`--snap` are not needed.

- **Proven segments are re-homed.** A resumed run saved its suspend snapshot under its REAL id,
  with only the state inside blank. A segment is proven when that snapshot is exactly the fold
  of the stray events onto the execution's previous blank snapshot. `--apply` writes the
  segments into the execution's log at the same sequences, in one batch per execution
  (`metadata.rehomedFrom` names the stray id). A fenced execution is written under a new fence,
  which also fences out a runner still holding the old one. Each segment is journaled as
  `EVENTS_REHOMED` on the lifecycle stream. A re-run is a no-op, and finishes a repair (or a
  fact) that stopped halfway. The `""` stream is left in place as evidence.
- **Everything else is listed, never guessed.** A run that completed without a checkpoint left
  nothing that names its writer. Such a range is printed as `UNATTRIBUTED`, with the executions
  parked at the sequence just below it. If your own records say whose it is, assert it with
  `--assign <executionId>:<from>-<through>`. The execution must hold a pre-0106 (blank)
  snapshot at `<from − 1>`, with nothing of its own above it. That snapshot must be parked at a
  gate the range opens by answering: with the awaited event, or `TIMER_FIRED` at the park's
  wake time, after any approval or `resumeAs` migration fact. The range must also fold onto the
  snapshot. A healthy execution can never be assigned a stray run. Once re-homed, an assigned
  range is reported as `rehomed`, and the census does not list it again.
- **Refused, with a reason:**
  - `occupied`: the execution's own log already has an event there, e.g. a pre-0106 denial in
    the checkpoint's slot;
  - `superseded`: compacted again after the fix, so its checkpoint already folds these events;
  - `conflict`: two executions prove one slot;
  - `invalid`: an assignment that fails its checks.

  An execution that changed between the census and the apply is reported as failed and left
  alone, and the others proceed.
- **Encrypted stores.** Through `--db` the stray payloads are ciphertext the command cannot
  read. It says so, and refuses `--apply` before writing anything. Use `--config`. If the key of
  subject `""` has already been destroyed, the payloads are shredded placeholders, and nothing
  is re-homed.

Run it with the affected executions quiesced and with retention and compaction paused. After
`--apply`, two things are yours to do, and the command prints both:

- **Rebuild read models.** They never saw the re-homed events: purge their `""` rows and
  rebuild them.
- **Destroy the blank stream's key.** If your stores encrypt, the kept stream still holds the
  re-homed payloads under the key of subject `""`, beyond the reach of the owning execution's
  erasure. Once nothing is left to re-home, destroy that key:
  `shredSubject(keys, raw, "", { executionIds: [] })` or `keys.destroy("")`.

```bash
npx loom repair blank-stream --config ./loom.config.ts                     # census
npx loom repair blank-stream --config ./loom.config.ts --apply             # re-home proven
npx loom repair blank-stream --config ./loom.config.ts --assign e1:13-15 --apply
npx loom repair blank-stream --db .data/events.db --snap .data/snapshots.db   # SQLite shorthand
```

### `loom repair terminal-event (--config <module> | --db <events.db> --snap <snap.db>) [executionId] [--apply]`

A finished execution a pre-[ADR 0116](adr/0116-late-outcome-attach.md) compaction left as `[0]` + a
checkpoint can never take a late outcome (`recordOutcome` refuses it) and retention cannot date its end.
This writes the terminal event back above the checkpoint. **Dry run by default**, idempotent, refuses
non-terminal executions; run it with the executions quiesced. Needs the snapshot store.

### `loom compliance report --db <path> --subject-path <dotpath> [--tenant-path <dotpath>]`

A data-subject inventory (T3): folds every execution's `EXECUTION_STARTED`, attributing it to a
subject (and optional tenant) read from a dot-path off the input — a cold log has no flow code,
so you name the path, e.g. `--subject-path input.userId --tenant-path input.tenant`. Reports
subject → execution counts, per tenant.

```bash
npx loom compliance report --db .data/events.db --subject-path input.userId
```

---

## Operate a corpus: `knowledge sync`, `list`, `search`

A document corpus ([`@loom/knowledge`](adr/0091-corpus-lifecycle-and-the-knowledge-package.md))
lives in the app's `memoryStore`, so operating one needs the built config module — the same
input `verify` and `deploy check` take. All three subcommands **refuse an app with no
configured `memoryStore`**: that app's corpus lives in the in-memory default, so this process
would ingest into a store it throws away on exit and print a successful-looking summary.

### `loom knowledge sync --config <mod> --scope <s> --dir <path> [--ext md,txt] [--max-bytes N] [--source <s>] [--apply]`

Reconciles a directory of documents into the corpus: write what changed, leave what did not,
**remove what the directory no longer contains**. That last clause is why it is a dry run by
default — `--apply` deletes as well as writes.

**`--source` when the corpus has more than one writer.** A reconcile deletes what it owns, and
this command owns a directory. An agent that writes down what it learned from feedback owns its
own documents — without `--source` on both sides, one nightly directory sync would delete every
one of them, since they are not in the set the directory produced and never will be. Documents
another writer owns are reported as `kept (another writer's)` and never touched.

The document id is the path relative to `--dir`, which is what makes a second run recognise the
same document; the title is the file's first markdown heading, or its filename. Symlinks are not
followed, files over `--max-bytes` (1 MiB) and empty files are skipped — and every skip is
listed, because a file the corpus does not contain is the answer to a "why did retrieval miss
that" question nobody could otherwise answer.

```bash
npx loom knowledge sync --config dist/loom.config.js --scope runbooks --dir docs/runbooks
npx loom knowledge sync --config dist/loom.config.js --scope runbooks --dir docs/runbooks --apply
```

```text
knowledge sync: 14 document(s) from /app/docs/runbooks → "runbooks"
  write (2): replica-lag.md, pool-exhaustion.md
  unchanged (11): checkpoints.md, …
  REMOVE (1): failover-drill.md
  skipped (1):
    dump.sql.txt — 4194304 bytes exceeds the 1048576-byte cap
  dry run — nothing written. Re-run with --apply. NOTE: `REMOVE` deletes documents the directory no longer contains.
```

Re-running it against an unchanged directory writes nothing (documents are compared by a
content fingerprint), which is what makes it safe on a schedule.

### `loom knowledge list --config <mod> --scope <s>`

What the corpus holds: one line per document, with its passage count and fingerprint. A row
marked `[uncommitted]` is a document whose manifest row was written but whose passages were
not — a crash mid-ingest — and the next `sync` rewrites it.

### `loom knowledge search --config <mod> --scope <s> "<query>" [--limit N]`

Asks the corpus what a flow would retrieve, which is how you answer *why did it return that*.

```bash
npx loom knowledge search --config dist/loom.config.js --scope runbooks "replica lag" --limit 3
```

**This is not a recorded retrieval, and the output says so.** Inside a flow, `retrieve` requires
`ctx.decide` because a corpus changes between a run and its replay; an operator query has no
execution to record into. Never read a transcript of this command as what an execution saw.

---

## Deployment contracts: `kernel-manifest`, `compat`

The kernel-governance surface ([ADR 0035](adr/0035-kernel-governance-layer.md), [`@loom/spec`](../packages/spec)). Neither reads a log — they report and check the **versioned contracts** a deployment depends on.

### `loom kernel-manifest [--json] [--emit-docs <dir>]`

Prints this kernel's manifest: the version constants plus capability maturity.

```bash
npx loom kernel-manifest
```

```text
Loom kernel manifest
  kernel ABI      1.3.0   (10 syscalls)
  event schema    1.25.0  (34 event types)
  wire ABI        1.0.0
  event store SPI 2.6.0
  snapshot SPI    1.2.0
  branch SPI      1.2.0
  dispatcher SPI  1.0.0
  memory SPI      2.1.0
  compiler manif. 1
  capabilities    42 (see loom kernel-manifest --json)
```

| Flag | Meaning |
|---|---|
| `--json` | print the aggregate manifest as JSON (including every capability) instead of the text summary |
| `--emit-docs <dir>` | regenerate `compatibility-matrix.md` and `maturity.md` **into `<dir>`** from the manifest, so the published docs can't drift from the code |

```bash
npx loom kernel-manifest --json > kernel-manifest.json
npx loom kernel-manifest --emit-docs docs/spec     # → "wrote docs/spec/compatibility-matrix.md and docs/spec/maturity.md"
```

> `--emit-docs` takes a **directory**, not a file — the two filenames are fixed. Always exits `0`.

### `loom compat --abi <v> --event-schema <v> [...]`

Validate a deployment's declared contract versions against this kernel's manifest — a deploy gate. **Omitted contracts are not checked**, so pass only what your deployment pins.

| Flag | Contract |
|---|---|
| `--abi` | kernel ABI |
| `--event-schema` | event schema |
| `--wire` | wire ABI |
| `--event-store-spi` | event-store SPI |
| `--snapshot-store-spi` | snapshot-store SPI |
| `--branch-registry-spi` | branch-registry SPI |
| `--dispatcher-spi` | dispatcher SPI |
| `--compiler-manifest` | compiler-manifest version |

```bash
npx loom compat --abi 1.2.0 --event-schema 1.18.0 --event-store-spi 2.0.0
```

```text
compatible ✓ — all declared versions share the kernel's major line
```

A major-version mismatch prints one `✗ <component>: <reason>` line per issue and exits `1`.

---

## Author a plugin: `plugin …`

Plugin authoring tooling ([ADR 0043](adr/0043-plugin-packaging-and-1p-3p-separation.md)). First-party plugins are `@loom/plugin-*` and live in this repo; third-party plugins are `loom-plugin-*` and live in your own — `--first-party` selects which naming and layout the scaffold uses.

### `loom plugin seams`

Lists the seams a plugin can target, each with its title, whether a conformance kit exists, and the exact `defineConfig` line that wires it:

```bash
npx loom plugin seams
```

```text
Loom plugin seams (loom plugin new <seam> <name>):

  store         Durable storage backend (EventStore + SnapshotStore [+ BranchRegistry]) (conformance ✓)
                wire: storage: <name>Storage({ /* … */ })
  dispatcher    Compute placement (ExecutionDispatcher) (conformance ✓)
                wire: execution: { dispatcher: new <Name>Dispatcher({ /* … */ }) }
  …
```

The current seams are **`store`**, **`dispatcher`**, **`telemetry`**, **`middleware`**, **`timer`**, **`lease`**, **`content`**, **`durable-state`**, **`read-model`**, **`keystore`**, **`memory`**, **`projection`**, **`worker`**, **`llm`**, **`authorizer`**, **`execution-authorizer`**, **`resume-authenticator`**, **`timer-dispatcher`**, and **`policy`** — one for every SPI that publishes a conformance kit, which is the rule a fitness test now holds rather than a list someone remembers to extend.

Note that `policy` is wired in **flow code** (`decideWithPolicy(ctx, id, policy, context, actions)`), not in `defineConfig`.

### `loom plugin new <seam> <name> [--first-party] [--dir .]`

Scaffolds a plugin package for a seam: a `package.json`, `tsconfig.json`, a preset/SPI stub, a conformance-wired test, and a README. It **never overwrites** an existing file.

| Argument / flag | Required | Default | Meaning |
|---|---|---|---|
| `<seam>` | yes | — | one of the seams above |
| `<name>` | yes | — | the bare name — `redis` becomes `loom-plugin-redis`, or `@loom/plugin-redis` with `--first-party` |
| `--first-party` (`--1p`) | no | third-party | first-party naming + monorepo layout (`workspace:*` deps) |
| `--dir` | no | `.` | where the package directory is created |

```bash
npx loom plugin new store redis                 # → loom-plugin-redis/
npx loom plugin new store redis --first-party   # → packages/… as @loom/plugin-redis
```

Exit `0` when at least one file was written, `1` when everything was skipped (the package already exists). The scaffold's conformance test ships commented out — un-comment it once your SPI impl is real, and run your formatter over the generated files.

### `loom plugin check [--dir .] [--publish]`

Validates a plugin package and prints one `✓` / `⚠` / `✗` line per finding, then a verdict. Among the structural checks: an `exports` map that declares `require` with no `default`/`import` resolves for `require()` and raises `ERR_PACKAGE_PATH_NOT_EXPORTED` for an `import` — a shape neither tsc nor a CJS test runner can see. `--publish` adds npm-readiness checks on top of the structural ones. Exit `0` when there are no errors (warnings don't fail), `1` otherwise. The directory may also be given positionally — `loom plugin check ./loom-plugin-redis` — with `--dir` winning if both are present.

```bash
npx loom plugin check --dir ./loom-plugin-redis --publish
```

```text
  ✓ package name loom-plugin-redis matches the third-party convention
  ⚠ no test imports @loom/conformance — prove your SPI impl with the conformance kit (if one exists for your seam)

plugin check: passed (0 error, 1 warn)
```

### `loom plugin try --module <path> [--preset <name>] [--options <json>] [--verbose]`

End-to-end smoke test for a **store** plugin: imports your built module, calls its storage preset, runs a smoke flow against it, and asserts the run completed, events persisted, and the execution **replays from the durable store**.

| Flag | Required | Meaning |
|---|---|---|
| `--module` | yes | path to the plugin's **built** module |
| `--preset` | no | the preset export to call; defaults to the first exported `*Storage` function |
| `--options` | no | a JSON string passed to the preset |

```bash
npx loom plugin try --module ./loom-plugin-redis/dist/index.js --options '{"url":"redis://localhost:6379"}'
```

```text
  ✓ smoke flow completed (preset redisStorage)
  ✓ persisted 6 events
  ✓ replays from the durable store

plugin try: passed
```

Exit `0` only when all three pass. If no exported function is found and `--preset` was omitted, it errors and asks for one.

### `loom plugin search <term>`

Finds published plugins on npm by the `loom-plugin` keyword. The search term is everything after `search`, so it may be several words.

```bash
npx loom plugin search postgres
```

---

## Cheat sheet

| Command | Purpose | Key flags | Exit `1` when |
|---|---|---|---|
| `loom new <kind> <name>` | scaffold a flow/agent/tool/… file | `--dir app` | file already exists |
| `loom gen` | regenerate `loom.gen.ts` (`--watch` keeps it current) | `--dir app` | (write failure) |
| `loom dev` | gen --watch + run the app (restart on change) + the inspector | `--config` *(req)*, `--run`, `--dir app` | no `--config`; nothing to run |
| `loom appgen <intent>` | brownfield-aware NL → new project or surgical edits (scan→plan→apply→validate) | `--dry-run`, `--yes`, `--check`, `--from <file>`, `--from-spec <file>`, `--model <spec>`, `--offline`, `--dir .` | no intent supplied; `--check` typecheck fails |
| `loom doctor` | run every pre-flight check whose input it can find, and name the ones it skipped | `--dir .`, `--config`, `--manifest` | any check fails (never for a skip) |
| *store commands* | `ls` `logs` `debug` `inspect` `profile` `introspect` `optimize` `learn` `repair` `retention` `sweep` `compliance` | **`<store-flags>` = `--config <module>` _or_ `--db <events.db>`** — `--config` works wherever `--db` does, and neither flag is individually required | — |
| `loom resume` · `cancel` · `start` | act on an execution THROUGH your app's runtime (authenticator, authorizer, `resumeSchemas`, leases all run; dry run unless `--apply`; the continuation runs in this process) | `--config` *(req)*, `--as` *(req)*, `--tenant`, `--event` *(req, resume)*, `--payload`/`--payload-file` *(req, resume)*, `--input`/`--input-file` *(req, start)*, `--id`/`--idempotency-key`, `--force` (cancel, resume), `--allow-local-controls` (resume, start), `--redact`, `--show-payload`, `--apply` | a resumed/started execution fails after acceptance (refusals are exit `2`; `--db` is refused) |
| `loom census` | what is stuck, and is anything watching it (read-only) | store *(req)*, `--buckets`, `--sample N`, `--json` | (never; a store that cannot enumerate is exit `2`) |
| `loom recover` | re-drive executions whose supervisor died (dry run unless `--apply`) | store *(req)*, `--stale` *(req unless the app wires `timers.leases`)*, `--owner`, `--limit`, `--max-recoveries`, `--apply` (needs `--config`) | (refusals are exit `2`) |
| `loom branches retire` | cancel branches nobody is coming back to | store *(req)*, `--parent` *(req)*, `--stale` *(req)*, `--limit`, `--apply` | (refusals are exit `2`) |
| `loom branches prune` | delete refs that name nothing (`main` protected) | store *(req)*, `--protect`, `--limit`, `--apply` | (refusals are exit `2`) |
| `loom check` | static flow-graph validation | `--manifest` *(req)* | issues found |
| `loom verify` | pre-flight runtime verification over a built app | `--config` *(req)*, `--manifest` | any error-severity finding |
| `loom lint claim-check` | claim-check reach-through lint (CC-5) | `--dir .` | any finding |
| `loom ls` | list executions + what each suspended one waits on | store *(req)*, `--status`, `--workflow`, `--since`, `--limit` | unknown store (a store that cannot enumerate is exit `2`) |
| `loom logs` | print the event timeline | store *(req)*, `--redact`, `-v`, `--type`, `--from`, `--to`, `--follow` | unknown execution id; `--db` file missing |
| `loom debug` | folded state at / after a sequence | store *(req)*, `--at N`, `--redact` | unknown execution id; `--db` file missing |
| `loom snapshot show` | a stored snapshot, decoded (zstd frame or JSON) | store *(req)* (`--db` also needs `--snap`), `--at SEQ`, `--redact` | no snapshot for the id / sequence |
| `loom inspect` (`dev`) | web timeline + time-travel slider | store *(req)*, `--port 0` | `--db` file missing |
| `loom profile` | flame graph + latency breakdown | store *(req)* | unknown execution id; `--db` file missing |
| `loom introspect` | execution/task/decision/resource graphs | store *(req)*, `--graph <name>` | unknown execution id (unknown `--graph` is exit `2`) |
| `loom optimize` | advisory optimization report | store *(req)* | unknown execution id; `--db` file missing |
| `loom learn report` | decision coverage + per-arm rewards | store *(req)* | unknown explicit execution id |
| `loom learn eval` | shadow-evaluate a candidate policy | store *(req)*, `--policy` *(req)*, `--min-steps N` | promotion gate refuses |
| `loom eval` | replay golden logs vs expectations | `--dir` *(req)* | any golden fails |
| `loom deploy check` | replay logs vs new flow defs | `--logs` *(req)*, `--config` *(req)* | resume-breaking change |
| `loom repair terminal-event` | restore the terminal event a pre-0116 compaction left off a `[0]`+checkpoint execution so it can take a late outcome (ADR 0116) | `--config` (preferred) or `--db` + `--snap`, `--apply` | (refusals are exit `2`) |
| `loom repair blank-stream` | re-home events the pre-0106 compaction bug wrote to `""` (ADR 0107) | `--config` (preferred) or `--db` + `--snap`, `--assign`, `--apply` | (refusals are exit `2`) |
| `loom retention run` | reclaim aged terminal executions | store *(req)*, `--snap` (or `--config`), `--ttl` *(req)*, `--apply` | (refusals are exit `2`) |
| `loom sweep content` | K10.6 pinned blob sweep | store *(req)*, `--content` *(req)*, `--snap`, `--archive-db`, `--archive-snap`, `--compaction-archive`, `--no-compaction-archive`, `--acknowledge-unarchived`, `--pin`, `--ttl`, `--orphans`, `--no-archive`, `--snapshots-touch-content`, `--apply` | (refusals are exit `2`) |
| `loom compliance report` | data-subject inventory | store *(req)*, `--subject-path` *(req)*, `--tenant-path` | (never; a store that cannot enumerate is exit `2`) |
| `loom knowledge sync` | reconcile a directory into a corpus | `--config` *(req)*, `--scope` *(req)*, `--dir` *(req)*, `--ext`, `--max-bytes`, `--source`, `--apply` | (usage errors are exit `2`) |
| `loom knowledge list` | what the corpus holds | `--config` *(req)*, `--scope` *(req)* | (usage errors are exit `2`) |
| `loom knowledge search` | ask the corpus (not recorded) | `--config` *(req)*, `--scope` *(req)*, `--limit` | (usage errors are exit `2`) |
| `loom kernel-manifest` | kernel version + maturity manifest | `--json`, `--emit-docs <dir>` | (never) |
| `loom compat` | validate a deployment's contract versions | `--abi`, `--event-schema`, … | major-version mismatch |
| `loom plugin new` | scaffold a plugin package | `--first-party`, `--dir .` | every file already existed |
| `loom plugin check` | validate a plugin package | `--dir .`, `--publish` | any error-level finding |
| `loom plugin try` | run a store plugin end-to-end | `--module` *(req)*, `--preset`, `--options`, `--verbose` | any smoke assertion fails |
| `loom plugin search` / `seams` | discover plugins / list seams | — | (never) |

A typical loop: `loom new` → write the flow → `loom gen` → `loom doctor` (or `loom check` → `loom verify` individually) → run it → `loom logs` / `loom debug` / `loom profile` / `loom inspect` → `loom eval` and `loom deploy check` in CI before promoting.

---

## Exit codes & scripting

Three exit codes, consistent across commands:

| Code | Meaning | Examples |
|---|---|---|
| `0` | it ran and the answer is fine | a clean `check`, a dry run, a `logs` of a real execution |
| `1` | a **verdict failed**, or the thing you named **does not exist / could not run** | `doctor`/`check`/`verify`/`lint`/`eval`/`deploy check`/`compat`/`learn eval`/`plugin check`/`plugin try` finding a problem; a `--db`/`--snap`/`--content`/`--archive-*` path that is missing or is not a SQLite database (nothing is created or opened); an unknown execution id (not found is a runtime failure, not a usage error); `loom new` / `loom plugin new` that wrote nothing because everything "skipped … (already exists)" |
| `2` | **bad usage or a refusal** — the command declined to act, and changed nothing. Everything refused for bad usage is `2`, in `create-loom-app` too | an unknown command, subcommand or flag (`loom <command> --help` is not an error: it prints that command's help and exits `0`); a value flag given twice; a missing `<directory>`; a missing required flag or positional; a malformed number/duration; `retention run` without `--ttl` or a snapshot store; `recover` with neither `timers.leases` nor `--stale`; `recover --apply` without `--config`; `resume`/`cancel`/`start` with `--db`, without `--config` or `--as`, or refused by your app (authenticator, authorizer, `resumeSchemas`, a live lease); `introspect --graph bogus`; `repair`/`branches` preconditions |

A script can therefore tell a refused `recover --apply` from a successful one. (Before this table, several refusals printed their reason and exited `0`, and the unknown-subcommand cases of `branches`/`repair`/`plugin` exited `1`; only `learn` returned `2`.) `doctor` fails only on a failing check, never on a skipped one. Reports go to stdout, errors to stderr. That makes the gates drop straight into CI:

```bash
npx loom check --manifest loom-manifest.json \
  && npx loom verify --config dist/app.js \
  && npx loom lint claim-check --dir app \
  && npx loom eval --dir evals/ \
  && npx loom deploy check --logs logs/ --config dist/app.js
```

The purely-informational commands (`kernel-manifest`, `plugin seams`, `plugin search`, a `census`, a `logs` of an execution that exists) exit `0` whenever they ran. An **unknown execution id or a missing `--db` file is no longer a quiet `0`** — it exits `1` naming the absolute path / id — so a mistyped path cannot read as "nothing happened". Still, gate on the verdict commands above.

Note that `inspect`/`dev` start a long-lived server and stay in the foreground until Ctrl-C — don't put them in a non-interactive gate.

---

## Programmatic use

The core commands are also exported as functions from `@loom/cli`, so you can build the same checks into your own scripts or tests without shelling out:

```ts
import { cmdLogs, cmdDebug, cmdEval, cmdCheck, cmdGen, cmdNew, cmdAppgen,
         cmdDeployCheck, serveInspector, parseArgs } from "@loom/cli";

// The first argument is the store flags — `{ db }` or `{ config }`, same as the CLI's.
const timeline: string = await cmdLogs({ db: ".data/events.db" }, executionId);
const { report } = cmdEval("evals/");
if (!report.ok) process.exit(1);
```

See the **[API reference → `@loom/cli`](api-reference.org)** for the full export surface (`foldAt`, `formatLog`, `describeState`, `evaluateGoldens`, `discoverFlows`, `buildTrace`, `runDeployCheck`, …).

> The public export surface is a **subset** of the command set. The newer commands — `verify`, `lint claim-check`, `profile`, `introspect`, `optimize`, `learn …`, `kernel-manifest`, `compat`, `plugin …`, `retention run`, `sweep content`, `compliance report` — are reachable through the binary only. Their underlying logic lives in the packages they wrap (`@loom/verify`, `@loom/analytics`, `@loom/learning`, `@loom/spec`, `@loom/compliance`), so import from there rather than from `@loom/cli`.

---

### See also

- **[Getting Started](getting-started.md)** — the 5-minute quickstart (persists to SQLite so the CLI has a log to read).
- **[Usage Guide](usage.md)** — build an app in order; Step 13 puts these commands in context.
- **[User Guide](user-guide.md)** — topic-by-topic reference, including the CLI.
- **[Architecture §5.6](architecture.md)** — where the CLI sits in the DX tooling ring ("lenses on the log, not new infrastructure").
- **ADRs** — [0010 CLI](adr/0010-loom-cli.md), [0011 folder convention](adr/0011-folder-convention-codegen.md), [0012 flow-graph validation](adr/0012-flow-graph-validation.md), [0014 deploy check & inspector](adr/0014-deploy-check-and-inspector.md).
