# Loom — CLI Usage Guide

`loom` is the project-local command line for a Loom app. Every command is a **lens on the same durable event log** — it adds no infrastructure, holds no state of its own, and runs no live effects. You use it to scaffold code, validate a flow graph before it runs, observe an execution after it ran, and gate a deploy on replay.

> New here? Follow the **[Getting Started](getting-started.md)** quickstart first, then the **[Usage Guide](usage.md)** (Step 13 introduces the CLI in context). This doc is the command-by-command reference.

The binary ships in `@loom/cli`. Run it with `npx loom …`, a package script (`"scripts": { "loom": "loom" }` → `pnpm loom …`), or the local `node_modules/.bin/loom`. Starting a brand-new project? `npm create loom-app`.

**Contents**

1. [The command set](#the-command-set)
2. [Scaffold & wire: `new`, `gen`, `appgen`](#scaffold--wire-new-gen-appgen)
3. [Validate before you run: `check`](#validate-before-you-run-check)
4. [Observe a run: `logs`, `debug`, `inspect`](#observe-a-run-logs-debug-inspect)
5. [Ship safely: `eval`, `deploy check`](#ship-safely-eval-deploy-check)
6. [Cheat sheet](#cheat-sheet)
7. [Exit codes & scripting](#exit-codes--scripting)
8. [Programmatic use](#programmatic-use)

---

## The command set

`loom`, `loom help`, or `loom --help` prints the usage summary:

```text
loom — project-local commands for a Loom app

  loom gen   [--dir app]                          regenerate loom.gen.ts from app/flows
  loom new   <flow|agent|tool> <name> [--dir app] scaffold a file (folder convention)
  loom appgen <intent> | --from <file> [--dir .]  NL → full project (new dir) or flows (existing app)
  loom check --manifest <path>                    static flow-graph checks (compiler manifest)
  loom logs  --db <path> <executionId>            print the event timeline
  loom debug --db <path> <executionId> [--at N]   time-travel: state at sequence N
  loom eval  --dir <path>                         replay golden logs vs expectations
  loom deploy check --logs <dir> --config <mod>   simulate deploy vs new flow defs
  loom inspect --db <path> [--port N]             web inspector (timeline + slider)
```

There are no global flags — each command declares its own. The recurring ones are `--db <path>` (a SQLite event-store file), `--dir <path>` (a directory, defaulting to `app` for `gen`/`new`), and `--at <N>` (a sequence number). An unknown command prints the usage to stderr and exits `1`.

> **The `--db` commands need SQLite storage.** `logs`, `debug`, and `inspect` read a durable log, so your app must persist one. Wire `storage: { kind: "sqlite", dir: ".loom" }` in [`defineConfig`](usage.md#step-3--wire-the-app-with-defineconfig) — the event store is then at `.loom/events.db`. In-memory apps leave nothing to inspect.

---

## Scaffold & wire: `new`, `gen`, `appgen`

These follow the **folder convention** — flows live at `app/flows/<name>/flow.ts`, agents at `app/agents/<name>/agent.ts`, tools at `app/tools/<name>/tool.ts` ([ADR 0011](adr/0011-folder-convention-codegen.md)).

### `loom new <flow|agent|tool> <name> [--dir app]`

Scaffolds a single file from a template.

| Argument / flag | Required | Default | Meaning |
|---|---|---|---|
| `<kind>` | yes | — | `flow`, `agent`, or `tool` |
| `<name>` | yes | — | the human name, e.g. `greet` |
| `--dir` | no | `app` | base directory the subfolders go under |

```bash
npx loom new flow greet          # → creates app/flows/greet/flow.ts
npx loom new agent triager       # → creates app/agents/triager/agent.ts
npx loom new tool lookup --dir src
```

It **never overwrites** an existing file: it prints `created <path>` (exit `0`) or `skipped <path> (already exists)` (exit `1`).

### `loom gen [--dir app]`

Scans `<dir>/flows/<name>/flow.{ts,tsx}` and writes `<dir>/loom.gen.ts` — a static, alphabetically-sorted registration module. Wiring is build-time and replay-safe (P5), so discovery is codegen, not runtime globbing.

```bash
npx loom gen            # scans app/flows/**, writes app/loom.gen.ts
# → "wrote app/loom.gen.ts (2 flows)"
```

```ts
// app/loom.gen.ts (generated — do not edit)
import * as _f0 from "./flows/greet/flow";
import * as _f1 from "./flows/report/flow";

export const flowModules = [_f0, _f1];
```

Feed the generated `flowModules` to `defineConfig({ flowModules })` and every flow-shaped export registers itself. Re-run `loom gen` whenever you add or remove a flow. Exit `0` on a successful write.

### `loom appgen <intent> | --from <file> [--dir .]`

Turns a **natural-language intent** into a Loom app following the **[folder convention](#scaffold--wire-new-gen-appgen)** — the same shape `create-loom-app` / `loom new` / `loom gen` produce — by parsing the sentence into an `AppSpec` and generating plain, static TypeScript ([`@loom/appgen`](../packages/appgen)). Parsing and codegen are **deterministic and offline — no model call at generate time and none in the output** (P5). The generated files are ordinary Loom code with `TODO` handlers you own and edit.

`appgen` **adapts to the target directory** (the project root):

- **New / empty dir** → a full runnable project: `package.json`, `tsconfig.json`, `app/config.ts` (`defineConfig({ flowModules })`), `app/main.ts`, `app/loom.gen.ts`, and one `app/flows/<id>/flow.ts` per capability — so `pnpm install && pnpm start` runs out of the box.
- **Existing Loom app** (a `package.json` / `app/loom.gen.ts` / `app/config.ts` is present) → just the `app/flows/<id>/flow.ts` files, then `app/loom.gen.ts` is regenerated from the filesystem (the `loom gen` step) so pre-existing flows stay wired.

| Argument / flag | Required | Default | Meaning |
|---|---|---|---|
| `<intent>` | one of the two | — | the intent as a quoted positional string |
| `--from <file>` | one of the two | — | read the intent from a text file (takes precedence over the positional) |
| `--dir` | no | `.` | the project root (a new dir → full project; an existing app → flows only) |

The intent is a small directive grammar: `create a <name>` (a capability), `use <model> first` / `elevate to <model>`, `pause for approval`, `generate ui`, `step <name>`, `deploy on <target>`. Reasoning / approval / UI wiring is emitted only when asked for.

```bash
npx loom appgen "Create a planner. Use Gemma first. Pause for approval. Generate UI." --dir ./planner
# → appgen: planner → ./planner
#     wrote ./planner/package.json
#     wrote ./planner/app/config.ts
#     wrote ./planner/app/flows/planner/flow.ts
#     … (full project)

npx loom appgen "Create a summarizer." --dir ./planner   # existing app: adds a flow + regenerates loom.gen.ts
```

Each file is written **directly when its target path is free**. On a collision it prompts interactively, per file — `app/flows/planner/flow.ts exists — [r]ename / [s]kip / [o]verwrite?` — where `r` asks for a new name (and re-checks it), `s` leaves the existing file untouched, and `o` replaces it. Exit `0`; the summary lists what was written, overwritten, and skipped.

---

## Validate before you run: `check`

### `loom check --manifest <path>`

Static flow-graph validation from a **compiler manifest** — no app is loaded and nothing executes. It catches issues the type system can't: a step whose `toolId` has no registered effect, a capability routed to a missing agent, and similar graph defects. This is the same engine `defineConfig({ validate })` runs at boot ([ADR 0012](adr/0012-flow-graph-validation.md)).

```bash
npx loom check --manifest loom-manifest.json
```

Output is either `✓ no issues` (exit `0`) or one line per problem followed by a count (exit `1`):

```text
  ✗ flow "investigate": step "triage" references unknown effect "triage-llm"

1 issue(s)
```

---

## Observe a run: `logs`, `debug`, `inspect`

All three fold the durable log deterministically — they replay events, they never re-run effects.

### `loom logs --db <path> <executionId>`

Prints the event timeline, one line per event: a `⏸` marker on `EXECUTION_SUSPENDED`, the sequence `#N`, the event type, and a per-type detail (the step id, the suspension target, a truncated output, or an error message).

```bash
npx loom logs --db .loom/events.db 01J8…
```

```text
   #0  EXECUTION_STARTED
   #1  STEP_STARTED        collect-metrics
   #2  STEP_COMPLETED      collect-metrics
 ⏸ #3  EXECUTION_SUSPENDED on ApprovalGranted
   #4  STEP_STARTED        remediate
   #5  EXECUTION_COMPLETED {"summary":"…"}
```

### `loom debug --db <path> <executionId> [--at N]`

Time-travel inspection. With `--at N` it prints the **folded state at sequence `N`**; without `--at` it prints the full timeline followed by the final folded state.

```bash
npx loom debug --db .loom/events.db 01J8… --at 3   # state as of sequence 3
npx loom debug --db .loom/events.db 01J8…          # timeline + final state
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

### `loom inspect --db <path> [--port N]`  ·  alias `loom dev`

Launches a local **web inspector**: a timeline with a time-travel slider that fetches the folded state at each sequence. `--port` defaults to `0`, letting the OS pick a free port; the chosen URL is printed. The server runs until you stop it with Ctrl-C ([ADR 0014](adr/0014-deploy-check-and-inspector.md)).

```bash
npx loom inspect --db .loom/events.db
# → loom inspector on http://localhost:53812  (Ctrl-C to stop)
```

Enter an execution id in the page, then drag the slider to walk the run. Under the hood it serves `/api/trace/:executionId` (the timeline render model) and `/api/state/:executionId/:sequence` (the same folded state as `loom debug --at`). `loom dev` is an identical alias.

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

## Cheat sheet

| Command | Purpose | Key flags | Exit `1` when |
|---|---|---|---|
| `loom new <kind> <name>` | scaffold a flow/agent/tool file | `--dir app` | file already exists |
| `loom gen` | regenerate `loom.gen.ts` | `--dir app` | (write failure) |
| `loom appgen <intent>` | generate a Loom app from NL (folder convention) | `--from <file>`, `--dir .` | no intent supplied |
| `loom check` | static flow-graph validation | `--manifest` *(req)* | issues found |
| `loom logs` | print the event timeline | `--db` *(req)* | error |
| `loom debug` | folded state at / after a sequence | `--db` *(req)*, `--at N` | error |
| `loom inspect` (`dev`) | web timeline + time-travel slider | `--db` *(req)*, `--port 0` | error |
| `loom eval` | replay golden logs vs expectations | `--dir` *(req)* | any golden fails |
| `loom deploy check` | replay logs vs new flow defs | `--logs` *(req)*, `--config` *(req)* | resume-breaking change |

A typical loop: `loom new` → write the flow → `loom gen` → `loom check` → run it → `loom logs` / `loom debug` / `loom inspect` → `loom eval` and `loom deploy check` in CI before promoting.

---

## Exit codes & scripting

Every command returns `0` on success and `1` on failure (missing required flag, unreadable input, unknown command, or a "not clean" verdict from `check`/`eval`/`deploy check`). `logs`/`debug` write to stdout, errors to stderr. That makes the gates drop straight into CI:

```bash
npx loom check --manifest loom-manifest.json \
  && npx loom eval --dir evals/ \
  && npx loom deploy check --logs logs/ --config dist/app.js
```

Note that `inspect`/`dev` start a long-lived server and stay in the foreground until Ctrl-C — don't put them in a non-interactive gate.

---

## Programmatic use

Every command is also a pure function exported from `@loom/cli`, so you can build the same checks into your own scripts or tests without shelling out:

```ts
import { cmdLogs, cmdDebug, cmdEval, cmdCheck, cmdGen, cmdNew, cmdAppgen,
         cmdDeployCheck, serveInspector, parseArgs } from "@loom/cli";

const timeline = await cmdLogs(".loom/events.db", executionId);
const { report } = cmdEval("evals/");
if (!report.ok) process.exit(1);
```

See the **[API reference → `@loom/cli`](api-reference.org)** for the full export surface (`foldAt`, `formatLog`, `describeState`, `evaluateGoldens`, `discoverFlows`, `runDeployCheck`, …).

---

### See also

- **[Getting Started](getting-started.md)** — the 5-minute quickstart (persists to SQLite so the CLI has a log to read).
- **[Usage Guide](usage.md)** — build an app in order; Step 13 puts these commands in context.
- **[User Guide](user-guide.md)** — topic-by-topic reference, including the CLI.
- **[Architecture §5.6](architecture.md)** — where the CLI sits in the DX tooling ring ("lenses on the log, not new infrastructure").
- **ADRs** — [0010 CLI](adr/0010-loom-cli.md), [0011 folder convention](adr/0011-folder-convention-codegen.md), [0012 flow-graph validation](adr/0012-flow-graph-validation.md), [0014 deploy check & inspector](adr/0014-deploy-check-and-inspector.md).
