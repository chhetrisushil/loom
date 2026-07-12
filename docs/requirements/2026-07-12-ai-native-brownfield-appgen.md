# Requirements — AI-native, brownfield-aware `loom appgen`

- Date: 2026-07-12
- Status: Accepted; implemented across PRs #111, #112, and the completeness follow-up.
- Owner: DX / `@loom/appgen`
- Related: [ADR 0042](../adr/0042-ai-native-brownfield-appgen.md), evaluation doc
  [`2026-07-12-ai-native-brownfield-appgen-evaluation.md`](2026-07-12-ai-native-brownfield-appgen-evaluation.md)

## Problem

`loom appgen` began as a one-shot **greenfield** scaffolder: it parsed a natural-language intent
into an `AppSpec` and generated a whole project. It could not reason about an app that already
existed, so the only way to use it on a real project was to hand-merge its output. The intelligence
was a fixed keyword grammar, and there was no way to preview, replay, or use a real model — even
though the design explicitly left `parseIntent` swappable ("a model-backed parser can be swapped in
later, but it must still emit an `AppSpec`; codegen never sees raw NL").

## Goal

Turn `loom appgen` into an iterative **"describe the delta"** tool that understands the current app,
plans a change against it, previews the change, and applies it safely — optionally driven by a
**local model** at zero token cost — without ever compromising the framework kernel.

## Non-negotiable constraints

1. **DX layer only.** No edits to `@loom/core`, `@loom/compiler`, `@loom/workflow-runtime`,
   `@loom/effect-runtime`, `@loom/app`, `@loom/reasoning`, or any runtime/kernel package. All work
   lives in `@loom/appgen` (offline, near-zero-dep), a new optional `@loom/appgen-model`, and the CLI.
2. **NL understanding in exactly one stage.** Only the *plan* stage interprets natural language, and
   it emits a structured `ChangeSpec`. Codegen never sees raw NL (P5, P11).
3. **Deterministic and offline by default.** The default path uses no model and is reproducible.
   A model is a quality upgrade, never a hard dependency.
4. **Never clobber human code.** Generated code may be edited only while it is provably still a
   generated stub; anything a human has touched is insert-only.

## Functional requirements

### R1 — Brownfield awareness (scan)
`scanApp(dir) → AppModel`: a deterministic, compact summary of the existing app — flows, their step
ids, per-step handler state (`stub | edited | external`), approval/UI gates, and whether each file is
still appgen-generated. Never raw file contents. A net-new directory yields an empty model.

### R2 — Delta planning (plan)
`planChanges(intent, appModel) → ChangeSpec`: tag every capability and step with an operation
(`create | extend | modify | delete`). The deterministic planner wraps the grammar parser and diffs
against the scan; a model-backed planner emits the same `ChangeSpec`.

### R3 — Safe application (apply)
`applyChanges(changeSpec, appModel) → FilePlan`: creates via the existing templates; **surgical,
formatting-preserving edits** to existing flows (insert a step, register it, wire it into the runner,
add approval/UI gates, wire grants); deletes remove generated flow files/steps. A handler body may be
overwritten only if it still hashes to the generated stub.

### R4 — Validation and self-repair (validate)
In-process `tsc` diagnostics after apply (`--check`). The model planner runs a **self-repair loop**:
a produced `ChangeSpec` is semantically validated against the `AppModel`, and on any issue the model
is re-prompted with the issues (bounded retries) before falling back to deterministic.

### R5 — Plan → diff → confirm DX
- `--dry-run` renders a **real unified diff** (create/edit/delete hunks) and writes nothing.
- Interactive apply shows the plan and asks for confirmation (skippable with `--yes`; TTY-gated so
  scripted/piped use is unaffected).
- `--check` typechecks after applying.

### R6 — Replayable spec lockfile
Every apply records the accepted `ChangeSpec` to `.loom/appgen/<timestamp>.spec.json`;
`--from-spec <file>` replays it byte-for-byte with no model (the appgen equivalent of a golden log).

### R7 — Optional local model
`@loom/appgen-model` swaps a small on-device Gemma model into the plan stage:
- Grammar-constrained JSON (constrained to the `ChangeSpec` JSON schema) via node-llama-cpp.
- The cheap-first **elevation ladder** from `@loom/reasoning` with a *validator* confidence signal,
  logging elevations (P9) into the lockfile.
- Loaded/disposed per invocation (transient footprint); prompt carries only the compact `AppModel`
  summary; bounded generation.
- `node-llama-cpp` is an `optionalDependency`, lazily and genuinely dynamically imported; the CLI
  resolves the package **from the target project**, so neither the framework nor default CLI users
  carry the native runtime.

### R8 — Reasoning-ladder-on-itself
The default path stays free (deterministic parse). Elevate to a model only when needed; log each
elevation, mirroring `DECISION_RECORDED` at the DX layer.

## Out of scope

- Conversational, multi-turn appgen (the plan → diff → confirm loop delivers the value without the
  state-management complexity).
- Any change to the runtime interpretation of NL — the output is always plain, static TypeScript.
- Server-side / hosted model inference (local-only, by design).

## Acceptance

- All four stages deterministic except plan; kernel untouched (verified by touched-package review).
- `--dry-run`, `--apply`, `--check`, `--from-spec`, `--model`, `--offline`, `--yes` all functional.
- Safety gate proven: a hand-edited handler is never overwritten.
- `--from-spec` reproduces byte-identical output with no model.
- Local model verified end-to-end against a real GGUF; graceful deterministic fallback in every
  failure mode.
- Full workspace `build` + `typecheck` + `test` + `lint` green.
