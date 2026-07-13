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
  loom appgen <intent> [--dir .] [--dry-run] [--check] [--model <gguf>]  NL → new project or brownfield edits
  loom check --manifest <path>                    static flow-graph checks (compiler manifest)
  loom verify --config <module>                   pre-flight runtime verification (@loom/verify)
  loom logs  --db <path> <executionId> [--redact a,b]   print the event timeline
  loom debug --db <path> <executionId> [--at N] [--redact a,b]   time-travel: state at sequence N
  loom profile --db <path> <executionId>          flame graph + latency breakdown
  loom introspect --db <path> <executionId> [--graph N]  execution/task/decision/resource graphs
  loom optimize --db <path> <executionId>         advisory optimization report
  loom eval  --dir <path>                         replay golden logs vs expectations
  loom deploy check --logs <dir> --config <mod>   simulate deploy vs new flow defs
  loom retention run --db <path> --snap <path> [--ttl ms] [--apply]  reclaim aged terminal executions
  loom compliance report --db <path> --subject-path <p> [--tenant-path <p>]  data-subject inventory
  loom inspect --db <path> [--port N]             web inspector (timeline + slider)
```

> Data-protection commands: `--redact a,b` masks output dot-paths from `logs`/`debug` (K10-R6);
> `retention run` (dry-run by default, `--apply` to reclaim) and `compliance report` (subject
> inventory) sweep the store via the `listExecutions` SPI. `kernel-manifest` and `compat`
> (deployment-contract tooling) and `plugin …` (plugin authoring) have their own sections below.

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

### `loom appgen <intent> | --from <file> | --from-spec <file> [--dir .] [flags]`

Turns a **natural-language intent** into a change to a Loom app, following the **[folder convention](#scaffold--wire-new-gen-appgen)**. It is **brownfield-aware**: it scans what already exists and applies a *delta* rather than only scaffolding from scratch. Four stages, with **NL understanding isolated to exactly one** and everything else deterministic and offline ([`@loom/appgen`](../tools/appgen)); the generated output is ordinary, statically-wired Loom code with `TODO` handlers you own (P5, P11):

1. **scan** — `scanApp(dir)` summarizes the app (flows, steps, gates, and whether each handler is still a generated stub or hand-edited). Never raw file contents.
2. **plan** — the intent is parsed into a `ChangeSpec` that tags each capability/step `create | extend | modify | delete`. This is the only stage that reads NL. Deterministic by default; a **local model** can drive it (see `--model`).
3. **apply** — new flows come from the templates; existing flows are edited **surgically** (a new step is inserted, registered, and wired into the runner; approval/UI gates and grants are added) while untouched code is preserved byte-for-byte. A handler body is overwritten **only if it still hashes to the generated stub** — anything you have edited is insert-only.
4. **validate** — with `--check`, the app is typechecked in-process (`tsc`) after applying.

`appgen` **adapts to the target directory**: a new/empty dir gets a full runnable project (`package.json`, `tsconfig.json`, `app/config.ts`, `app/main.ts`, `app/loom.gen.ts`, one `app/flows/<id>/flow.ts` per capability); an existing app gets new flow files + surgical edits, then `app/loom.gen.ts` is regenerated.

| Argument / flag | Meaning |
|---|---|
| `<intent>` | the intent as a quoted positional string |
| `--from <file>` | read the intent from a text file (takes precedence over the positional) |
| `--from-spec <file>` | replay a `.loom/appgen/<ts>.spec.json` lockfile verbatim — no NL, no model |
| `--dir <path>` | the project root (default `.`) |
| `--dry-run` | render the plan as a unified diff and write nothing |
| `--yes` | apply without the interactive confirmation prompt |
| `--check` | typecheck the app (`tsc`) after applying |
| `--model <gguf>` | plan with a local Gemma model (needs [`@loom/appgen-model`](../tools/appgen-model) + `node-llama-cpp`) |
| `--model-big <gguf>` | a stronger model tier to elevate to on low confidence |
| `--model-tier <e2b\|e4b\|12b>` | the tier label for `--model` (default `e4b`) |
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

**Local model (`--model`).** Optional and offline: install `@loom/appgen-model` + `node-llama-cpp` in your project and point `--model` at a local `.gguf`. Planning runs through a cheap-first elevation ladder; if the model is missing, too weak, or produces an invalid plan, `appgen` **falls back to the deterministic parser** — it is never left without a valid `ChangeSpec`. See the [`@loom/appgen-model` README](../tools/appgen-model/README.md) for tiers and requirements.

**Which planner ran.** The plan header (and `--dry-run` output) is tagged `[deterministic]` or `[model]` (with any `[model, elevated e4b→12b]` ladder steps), and the spec lockfile records `changeSpec.planner`. When you pass `--model` but the model can't produce a usable plan, `appgen` prints a loud warning and falls back — so a `[deterministic]` tag after `--model` means the model bailed (try a stronger tier / Node LTS, or name steps explicitly). The generated *code* is identical either way; provenance lives in the header and lockfile, not the files.

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

## Data protection: `retention run`, `compliance report`

Operator sweeps over a stored log, both built on the `listExecutions` store-SPI (1.1.0). Reserved
control streams (`__loom_*`) are filtered automatically. See [data classification](data-classification.md) and [compliance](compliance.md).

### `loom retention run --db <events.db> --snap <snap.db> [--ttl <ms>] [--apply]`

Reclaim terminal executions older than the TTL (K10.1). **Dry run by default** — it reports
`would-reclaim` / `kept` / `not-terminal` per execution; `--apply` performs the deletion via
`LogLifecycle` (branch-integrity guard + `EXECUTION_ARCHIVED`/`EXECUTION_DELETED` control facts
included) and reports `reclaimed` / `blocked-by-branch` / … Nothing prunes on a timer — the
operator drives it.

```bash
npx loom retention run --db .loom/events.db --snap .loom/snapshots.db --ttl 7776000000   # dry run (90 days)
npx loom retention run --db .loom/events.db --snap .loom/snapshots.db --ttl 7776000000 --apply
```

### `loom compliance report --db <path> --subject-path <dotpath> [--tenant-path <dotpath>]`

A data-subject inventory (T3): folds every execution's `EXECUTION_STARTED`, attributing it to a
subject (and optional tenant) read from a dot-path off the input — a cold log has no flow code,
so you name the path, e.g. `--subject-path input.userId --tenant-path input.tenant`. Reports
subject → execution counts, per tenant.

```bash
npx loom compliance report --db .loom/events.db --subject-path input.userId
```

---

## Cheat sheet

| Command | Purpose | Key flags | Exit `1` when |
|---|---|---|---|
| `loom new <kind> <name>` | scaffold a flow/agent/tool file | `--dir app` | file already exists |
| `loom gen` | regenerate `loom.gen.ts` | `--dir app` | (write failure) |
| `loom appgen <intent>` | brownfield-aware NL → new project or surgical edits (scan→plan→apply→validate) | `--dry-run`, `--yes`, `--check`, `--from <file>`, `--from-spec <file>`, `--model <gguf>`, `--offline`, `--dir .` | no intent supplied |
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
