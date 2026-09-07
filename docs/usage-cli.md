# Loom — CLI Usage Guide

`loom` is the project-local command line for a Loom app. Every command is a **lens on the same durable event log** — it adds no infrastructure, holds no state of its own, and runs no live effects. You use it to scaffold code, validate a flow graph before it runs, observe an execution after it ran, and gate a deploy on replay.

> New here? Follow the **[Getting Started](getting-started.md)** quickstart first, then the **[Usage Guide](usage.md)** (Step 13 introduces the CLI in context). This doc is the command-by-command reference.

The binary ships in `@loom/cli`. Run it with `npx loom …`, a package script (`"scripts": { "loom": "loom" }` → `pnpm loom …`), or the local `node_modules/.bin/loom`. Starting a brand-new project? `npm create loom-app`.

> **Working in the Loom monorepo?** The dev-tooling bins (`loom`, `loom-compile`, `create-loom-app`) live under `tools/`. Expose them globally against your local build with **`pnpm link:global`** (and `pnpm unlink:global` to remove) — a root script that re-links all three from `tools/*`. Run it after a fresh clone, or any time the tooling packages move (a stale global link left over from an old path is what breaks `loom` otherwise).

**Contents**

1. [The command set](#the-command-set)
2. [Scaffold & wire: `new`, `gen`, `appgen`](#scaffold--wire-new-gen-appgen)
3. [Validate before you run: `doctor`, `check`, `verify`, `lint`](#validate-before-you-run-doctor-check-verify-lint)
4. [Observe a run: `logs`, `debug`, `inspect`](#observe-a-run-logs-debug-inspect)
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

  loom gen   [--dir app]                          regenerate loom.gen.ts from app/flows
  loom new   <flow|agent|tool|skill|schedule|memory|projection|sentinel> <name> [--dir app] scaffold a file
  loom plugin new <seam> <name> [--first-party] [--dir .]  scaffold a plugin package
  loom plugin check [--dir .] [--publish]         validate a plugin (--publish adds npm-readiness)
  loom plugin try --module <path> [--preset <name>] [--options <json>]  run a store plugin end-to-end
  loom plugin search <term>                       find plugins on npm (keyword loom-plugin)
  loom plugin seams                               list the seams a plugin can target
  loom appgen <intent> | --from <file> [--dir .] [--dry-run] [--check]  NL → new project or edits
                                                  (--dry-run previews; --check typechecks after apply)
  loom appgen ... --model <spec> [--model-big <spec>]  plan with a model of your choice
                                                  (anthropic:<m> / openai:<m> / gemini:<m> / a .gguf path)
  loom appgen --from-spec <file> [--dir .]        replay a .loom/appgen/<ts>.spec.json (no model)
  loom doctor [--dir .] [--config <module>] [--manifest <path>]  run every pre-flight check that
                                                  can run, and report which ones could NOT
  loom check --manifest <path>                    static flow-graph checks (compiler manifest)
  loom lint claim-check [--dir .]                 CC-5: flag claim-check reach-through inside flows
  loom verify --config <module> [--manifest <path>]  pre-flight runtime verification (@loom/verify)
                                                  (auto-reads loom-manifest.json loopIdentity findings, ADR 0061)
  loom logs  --db <path> <executionId> [--redact a,b]   print the event timeline
  loom profile --db <path> <executionId>          flame graph + latency breakdown
  loom introspect --db <path> <executionId> [--graph N]  execution/task/decision/resource graphs
  loom optimize --db <path> <executionId>         advisory optimization report (recommendations)
  loom learn report --db <path> [executionId]     trajectories, per-arm rewards, learning coverage
  loom learn eval --db <path> --policy <module> [--min-steps N] [executionId]
                                                  shadow-evaluate a candidate policy on real logs
  loom knowledge sync --config <mod> --scope <s> --dir <path> [--ext md,txt] [--apply]
                                                  reconcile a directory into a corpus
                                                  (dry run by default; --apply also REMOVES
                                                   documents the directory no longer has)
  loom knowledge list --config <mod> --scope <s>  what the corpus holds
  loom knowledge search --config <mod> --scope <s> "<query>" [--limit N]
                                                  ask the corpus (operator query — not recorded)
  loom kernel-manifest [--json] [--emit-docs <dir>]  kernel version + maturity manifest
  loom compat --abi <v> --event-schema <v> [...]  validate a deployment's contract versions
  loom debug --db <path> <executionId> [--at N] [--redact a,b]   time-travel: state at sequence N
  loom eval  --dir <path>                         replay golden logs vs expectations
  loom deploy check --logs <dir> --config <mod>   simulate deploy vs new flow defs
  loom retention run --db <path> --snap <path> [--ttl ms] [--apply]  reclaim aged terminal executions
  loom sweep content --db <path> --content <path> [--archive-db <path>] [--pin KIND,KIND] [--ttl ms] [--apply]  K10.6 pinned blob sweep
  loom compliance report --db <path> --subject-path <p> [--tenant-path <p>]  data-subject inventory
  loom inspect --db <path> [--port N]             web inspector (timeline + slider)

New project?  →  npm create loom-app
```

> Data-protection commands: `--redact a,b` masks output dot-paths from `logs`/`debug` (K10-R6);
> `retention run`, `sweep content` (both dry-run by default, `--apply` to reclaim) and
> `compliance report` (subject inventory) sweep the store via the `listExecutions` SPI.

There are no global flags — each command declares its own. The recurring ones are `--db <path>` (a SQLite event-store file), `--dir <path>` (a directory, defaulting to `app` for `gen`/`new` and `.` elsewhere), and `--at <N>` (a sequence number). An unknown command prints the usage to stderr and exits `1`.

Several commands are **two words** — the first positional selects the subcommand: `deploy check`, `lint claim-check`, `retention run`, `sweep content`, `compliance report`, `learn report|eval`, and `plugin new|check|try|search|seams`.

> **The `--db` commands need SQLite storage.** `logs`, `debug`, and `inspect` read a durable log, so your app must persist one. Wire `storage: { kind: "sqlite", dir: ".loom" }` in [`defineConfig`](usage.md#step-3--wire-the-app-with-defineconfig) — the event store is then at `.loom/events.db`. In-memory apps leave nothing to inspect.

---

## Scaffold & wire: `new`, `gen`, `appgen`

These follow the **folder convention** — flows live at `app/flows/<name>/flow.ts` (folder); agents, tools, skills, schedules, memories, and projections are flat files at `app/agents/<name>.ts`, `app/tools/<name>.ts`, `app/skills/<name>.ts`, `app/schedules/<name>.ts`, `app/memories/<name>.ts`, `app/projections/<name>.ts` ([ADR 0011](adr/0011-folder-convention-codegen.md)).

### `loom new <flow|agent|tool|skill|schedule|memory|projection|sentinel> <name> [--dir app]`

Scaffolds a single file from a template.

| Argument / flag | Required | Default | Meaning |
|---|---|---|---|
| `<kind>` | yes | — | `flow`, `agent`, `tool`, `skill`, `schedule`, `memory`, `projection`, or `sentinel` (any other kind is an error) |
| `<name>` | yes | — | the human name, e.g. `greet` |
| `--dir` | no | `app` | base directory the subfolders go under |

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

It **never overwrites** an existing file: it prints `created <path>` (exit `0`) or `skipped <path> (already exists)` (exit `1`).

### `loom gen [--dir app]`

Scans the seven convention folders and writes `<dir>/loom.gen.ts` — a static, alphabetically-sorted registration module. Wiring is build-time and replay-safe (P5), so discovery is codegen, not runtime globbing:

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

Re-run `loom gen` whenever you add or remove any construct. Exit `0` on a successful write.

**Projections load their fold code on demand** ([ADR 0049](adr/0049-projection-on-demand-fold-code.md)). When the `@loom/compiler` plugin builds a `projection$`, it extracts the whole `handlers` fold map into its own `import()` chunk (exactly like `handler$`/`instructions$`) and records the handled event-type keys. At runtime the projection stays **code-dormant** until an event whose type it folds first fires — then it imports the chunk once (buffering until ready) and folds normally after. A projection whose events never fire never loads its code. Uncompiled (dev), the handlers are inline and eager.

> `policy$` is **not** `loom gen`-discovered: it **is** enforced (a `PolicyAuthorizer` reads each flow's `policies` + `defineConfig({ security: { policies } })` — see the [user guide](user-guide.md#7-agents-tools--a2a)), but it's carried *inline on the flow definition*, not from an `app/policies/*` folder, so there's no separate module to generate. Discovery stays gated on "a runtime consumes a discovered *file*."

### `loom appgen <intent> | --from <file> | --from-spec <file> [--dir .] [flags]`

Turns a **natural-language intent** into a change to a Loom app, following the **[folder convention](#scaffold--wire-new-gen-appgen)**. It is **brownfield-aware**: it scans what already exists and applies a *delta* rather than only scaffolding from scratch. Four stages, with **NL understanding isolated to exactly one** and everything else deterministic and offline ([`@loom/appgen`](../tools/appgen)); the generated output is ordinary, statically-wired Loom code with `TODO` handlers you own (P5, P11):

1. **scan** — `scanApp(dir)` summarizes the app (flows, steps, gates, and whether each handler is still a generated stub or hand-edited). Never raw file contents.
2. **plan** — the intent is parsed into a `ChangeSpec` that tags each capability/step `create | extend | modify | delete`. This is the only stage that reads NL. Deterministic by default; a **model of your choice** can drive it (see `--model`).
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

### `loom doctor [--dir .] [--config <module>] [--manifest <path>]`

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
  – runtime verification (loom verify)
      no built config module found — pass --config <module> exporting a LoomApp (build to JS first, or run under tsx)
  – memory store (durability + relevance recall)
      no built config module found — pass --config <module> exporting a LoomApp
  ✓ claim-check reach-through (loom lint)
      .

passed, but 2 check(s) could not run — coverage is partial
```

A **skipped check never fails the run**, but it never reads as a pass either: `all checks passed` and `passed, but N check(s) could not run — coverage is partial` are deliberately different strings, so a green `doctor` can't be cited as evidence for a check that never ran. Exit `1` only when a check actually **fails**.

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

> If the config's own `defineConfig` sets `checks: { verify: "error" }`, requiring the module throws at boot; the CLI catches that and prints it. This command exists for on-demand verification **independent** of the config's own mode.

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

## Analyze a run: `profile`, `introspect`, `optimize`

Three read-only lenses from [`@loom/analytics`](../packages/analytics), all with the same shape: `--db <path>` plus a positional `<executionId>`. They fold one execution's log and print — nothing is mutated, no effect re-runs. An unknown id prints `(no execution "<id>")` and still exits `0`.

### `loom profile --db <path> <executionId>`

A flame graph plus latency breakdown for one execution — "DevTools for Loom" in the terminal ([ADR 0029](adr/0029-runtime-observability-profiler.md)). Use it to find which step actually owns the wall clock.

```bash
npx loom profile --db .loom/events.db 01J8…
```

### `loom introspect --db <path> <executionId> [--graph <name>]`

The runtime introspection facade ([ADR 0031](adr/0031-runtime-introspection-facade.md)): the **execution**, **task**, **decision**, and **resource** graphs folded from the log. `--graph <name>` prints just one; omit it for all four.

```bash
npx loom introspect --db .loom/events.db 01J8…
npx loom introspect --db .loom/events.db 01J8… --graph decision
```

### `loom optimize --db <path> <executionId>`

The advisory optimization report ([ADR 0034](adr/0034-advisory-optimization-pipeline.md)) — observe → analyze → recommend → evaluate → learn over one execution's log. **Advisory only**: it emits recommendations and mutates nothing. Adopting one is an explicit `ctx.decide` you write in app code, so the choice stays on the log.

```bash
npx loom optimize --db .loom/events.db 01J8…
```

---

## Learn from the log: `learn report`, `learn eval`

The offline half of the learning loop ([ADR 0080](adr/0080-learning-substrate.md), [`@loom/learning`](../packages/learning)). Both are read-only over the log and run out of band — neither touches a live execution, and adopting a policy remains an explicit wiring change in application code.

Both take `--db <path>` and an **optional positional `<executionId>`**. Omit it to sweep every execution — which requires the store to implement the optional `listExecutions` SPI (1.1.0); a store without it errors and asks for an explicit id.

### `loom learn report --db <path> [executionId]`

What the log can — and cannot — teach. Folds `DECISION_RECORDED` into trajectories and reports decision-step coverage (how many steps carry a `context`, how many carry a `policy.propensity`), reward attribution (`direct` / `terminal` / `none`), and per-arm evidence best-first — the same shape `@loom/reasoning`'s `ucb1` consumes.

It also prints **blocking gaps** — e.g. no outcome naming a `decisionId`, meaning rewards are aggregated globally rather than per decision. Read this before you write a policy: it tells you whether off-policy evaluation is even possible on the log you have.

```bash
npx loom learn report --db .loom/events.db            # every execution
npx loom learn report --db .loom/events.db 01J8…      # just one
```

Prints `(no events)` or `(no decisions recorded — nothing to learn from)` when there's nothing to fold. Always exits `0`.

### `loom learn eval --db <path> --policy <module> [--min-steps N] [executionId]`

Shadow-evaluate a **candidate policy** against historical traffic — SNIPS off-policy evaluation, then the promotion gate. Nothing is promoted; the exit code *is* the verdict.

| Flag | Required | Meaning |
|---|---|---|
| `--policy` | yes | module exporting a `Policy` as `policy` or as the default export (needs `id`, `version`, `select`) |
| `--min-steps` | no | the promotion gate's minimum decision-step evidence |

The module path may be relative (resolved against the cwd) or absolute. A module that doesn't export a usable `Policy` fails with a message and exit `1`.

```bash
npx loom learn eval --db .loom/events.db --policy dist/policies/linucb.js --min-steps 500
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

### `loom retention run --db <events.db> --snap <snap.db> [--ttl <ms>] [--apply]`

Reclaim terminal executions older than the TTL (K10.1). **Dry run by default** — it reports
`would-reclaim` / `kept` / `not-terminal` per execution; `--apply` performs the deletion via
`LogLifecycle` (branch-integrity guard + `EXECUTION_ARCHIVED`/`EXECUTION_DELETED` control facts
included) and reports `reclaimed` / `blocked-by-branch` / …

> **`--ttl` defaults to `0`**, which makes *every* terminal execution eligible. Unlike
> `sweep content` (30 days), there is no grace period here — always pass an explicit TTL
> before `--apply`.

```bash
npx loom retention run --db .loom/events.db --snap .loom/snapshots.db --ttl 7776000000   # dry run (90 days)
npx loom retention run --db .loom/events.db --snap .loom/snapshots.db --ttl 7776000000 --apply
```

### `loom sweep content --db <events.db> --content <content.db> [--archive-db <path>] [--pin KIND,KIND] [--ttl <ms>] [--apply]`

The operator surface for the K10.6 **pinned blob sweep** ([ADR 0055](adr/0055-k10-6-pin-seam-content-gc.md)) — content-store garbage collection for claim-check payloads whose log references have aged out.

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--db` | yes | — | the event store — pins are re-derived from it every sweep (mark-and-sweep) |
| `--content` | yes | — | the content store being reclaimed |
| `--archive-db` | no | — | also scan an archived event store, so evidence cited by findings in archived runs stays pinned |
| `--pin` | no | — | comma-separated event **kinds** to treat as pinning |
| `--ttl` | no | `2592000000` (30 days) | age threshold in ms |
| `--apply` | no | dry run | actually erase |

```bash
npx loom sweep content --db .loom/events.db --content .loom/content.db          # dry run, 30-day ttl
npx loom sweep content --db .loom/events.db --content .loom/content.db --apply
```

```text
content sweep DRY RUN (pass --apply to erase) — ttl 2592000000ms — pins: (none)
  executions scanned: 412
  refs seen: 1180   pinned: 934
  would-reclaim (246):
    sha256:9f2c…
    … +226 more
```

At most 20 addresses are listed, then `… +N more`. Pins are recomputed from the log on **every** sweep, so a run that becomes pinned between sweeps is protected without any bookkeeping.

### `loom compliance report --db <path> --subject-path <dotpath> [--tenant-path <dotpath>]`

A data-subject inventory (T3): folds every execution's `EXECUTION_STARTED`, attributing it to a
subject (and optional tenant) read from a dot-path off the input — a cold log has no flow code,
so you name the path, e.g. `--subject-path input.userId --tenant-path input.tenant`. Reports
subject → execution counts, per tenant.

```bash
npx loom compliance report --db .loom/events.db --subject-path input.userId
```

---

## Operate a corpus: `knowledge sync`, `list`, `search`

A document corpus ([`@loom/knowledge`](adr/0091-corpus-lifecycle-and-the-knowledge-package.md))
lives in the app's `memoryStore`, so operating one needs the built config module — the same
input `verify` and `deploy check` take. All three subcommands **refuse an app with no
configured `memoryStore`**: that app's corpus lives in the in-memory default, so this process
would ingest into a store it throws away on exit and print a successful-looking summary.

### `loom knowledge sync --config <mod> --scope <s> --dir <path> [--ext md,txt] [--max-bytes N] [--apply]`

Reconciles a directory of documents into the corpus: write what changed, leave what did not,
**remove what the directory no longer contains**. That last clause is why it is a dry run by
default — `--apply` deletes as well as writes.

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
  kernel ABI      1.1.0   (10 syscalls)
  event schema    1.18.0  (29 event types)
  wire ABI        1.0.0
  event store SPI 1.3.0
  snapshot SPI    1.0.0
  branch SPI      1.0.0
  dispatcher SPI  1.0.0
  memory SPI      2.0.0
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
npx loom compat --abi 1.1.0 --event-schema 1.18.0 --event-store-spi 1.3.0
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

  store       Durable storage backend (EventStore + SnapshotStore [+ BranchRegistry]) (conformance ✓)
              wire: storage: <name>Storage({ /* … */ })
  dispatcher  Compute placement (ExecutionDispatcher) (conformance ✓)
              wire: execution: { dispatcher: new <Name>Dispatcher({ /* … */ }) }
  …
```

The current seams are **`store`**, **`dispatcher`**, **`telemetry`**, **`middleware`**, **`timer`**, **`memory`**, **`projection`**, **`worker`**, **`llm`**, **`authorizer`**, and **`policy`**. Note that `policy` is wired in **flow code** (`decideWithPolicy(ctx, id, policy, context, actions)`), not in `defineConfig`.

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

### `loom plugin try --module <path> [--preset <name>] [--options <json>]`

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
| `loom gen` | regenerate `loom.gen.ts` | `--dir app` | (write failure) |
| `loom appgen <intent>` | brownfield-aware NL → new project or surgical edits (scan→plan→apply→validate) | `--dry-run`, `--yes`, `--check`, `--from <file>`, `--from-spec <file>`, `--model <spec>`, `--offline`, `--dir .` | no intent supplied; `--check` typecheck fails |
| `loom doctor` | run every pre-flight check whose input it can find, and name the ones it skipped | `--dir .`, `--config`, `--manifest` | any check fails (never for a skip) |
| `loom check` | static flow-graph validation | `--manifest` *(req)* | issues found |
| `loom verify` | pre-flight runtime verification over a built app | `--config` *(req)*, `--manifest` | any error-severity finding |
| `loom lint claim-check` | claim-check reach-through lint (CC-5) | `--dir .` | any finding |
| `loom logs` | print the event timeline | `--db` *(req)*, `--redact` | error |
| `loom debug` | folded state at / after a sequence | `--db` *(req)*, `--at N`, `--redact` | error |
| `loom inspect` (`dev`) | web timeline + time-travel slider | `--db` *(req)*, `--port 0` | error |
| `loom profile` | flame graph + latency breakdown | `--db` *(req)* | error |
| `loom introspect` | execution/task/decision/resource graphs | `--db` *(req)*, `--graph <name>` | error |
| `loom optimize` | advisory optimization report | `--db` *(req)* | error |
| `loom learn report` | decision coverage + per-arm rewards | `--db` *(req)* | error |
| `loom learn eval` | shadow-evaluate a candidate policy | `--db` *(req)*, `--policy` *(req)*, `--min-steps N` | promotion gate refuses |
| `loom eval` | replay golden logs vs expectations | `--dir` *(req)* | any golden fails |
| `loom deploy check` | replay logs vs new flow defs | `--logs` *(req)*, `--config` *(req)* | resume-breaking change |
| `loom retention run` | reclaim aged terminal executions | `--db` *(req)*, `--snap` *(req)*, `--ttl`, `--apply` | error |
| `loom sweep content` | K10.6 pinned blob sweep | `--db` *(req)*, `--content` *(req)*, `--archive-db`, `--pin`, `--ttl`, `--apply` | error |
| `loom compliance report` | data-subject inventory | `--db` *(req)*, `--subject-path` *(req)*, `--tenant-path` | error |
| `loom knowledge sync` | reconcile a directory into a corpus | `--config` *(req)*, `--scope` *(req)*, `--dir` *(req)*, `--ext`, `--max-bytes`, `--apply` | error |
| `loom knowledge list` | what the corpus holds | `--config` *(req)*, `--scope` *(req)* | error |
| `loom knowledge search` | ask the corpus (not recorded) | `--config` *(req)*, `--scope` *(req)*, `--limit` | error |
| `loom kernel-manifest` | kernel version + maturity manifest | `--json`, `--emit-docs <dir>` | (never) |
| `loom compat` | validate a deployment's contract versions | `--abi`, `--event-schema`, … | major-version mismatch |
| `loom plugin new` | scaffold a plugin package | `--first-party`, `--dir .` | every file already existed |
| `loom plugin check` | validate a plugin package | `--dir .`, `--publish` | any error-level finding |
| `loom plugin try` | run a store plugin end-to-end | `--module` *(req)*, `--preset`, `--options` | any smoke assertion fails |
| `loom plugin search` / `seams` | discover plugins / list seams | — | (never) |

A typical loop: `loom new` → write the flow → `loom gen` → `loom doctor` (or `loom check` → `loom verify` individually) → run it → `loom logs` / `loom debug` / `loom profile` / `loom inspect` → `loom eval` and `loom deploy check` in CI before promoting.

---

## Exit codes & scripting

Commands return `0` on success and `1` on failure (missing required flag, unreadable input, unknown command, or a "not clean" verdict from `doctor`/`check`/`verify`/`lint`/`eval`/`deploy check`/`compat`/`learn eval`/`plugin check`/`plugin try` — note `doctor` fails only on a failing check, never on a skipped one). The one other code is `2`, returned by `loom learn` when the subcommand is neither `report` nor `eval`. Reports go to stdout, errors to stderr. That makes the gates drop straight into CI:

```bash
npx loom check --manifest loom-manifest.json \
  && npx loom verify --config dist/app.js \
  && npx loom lint claim-check --dir app \
  && npx loom eval --dir evals/ \
  && npx loom deploy check --logs logs/ --config dist/app.js
```

The purely-informational commands (`logs`, `debug`, `profile`, `introspect`, `optimize`, `learn report`, `kernel-manifest`, `plugin seams`, `plugin search`) exit `0` whenever they ran — including when the execution id doesn't exist. Don't gate on them; gate on the verdict commands above.

Note that `inspect`/`dev` start a long-lived server and stay in the foreground until Ctrl-C — don't put them in a non-interactive gate.

---

## Programmatic use

The core commands are also exported as functions from `@loom/cli`, so you can build the same checks into your own scripts or tests without shelling out:

```ts
import { cmdLogs, cmdDebug, cmdEval, cmdCheck, cmdGen, cmdNew, cmdAppgen,
         cmdDeployCheck, serveInspector, parseArgs } from "@loom/cli";

const timeline = await cmdLogs(".loom/events.db", executionId);
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
