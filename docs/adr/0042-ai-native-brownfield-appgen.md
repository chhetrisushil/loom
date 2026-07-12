# ADR 0042 — AI-native, brownfield-aware `loom appgen`

- Status: Accepted (2026-07-12)
- Date: 2026-07-12
- Builds on: the P11 offline codegen (`parseIntent → AppSpec → generate`), `@loom/reasoning`'s
  elevation ladder, and the folder convention (`discoverFlows`, `loom gen`).
- Part of: the AI-native developer-experience line. **DX layer only — the framework kernel is not
  modified.**
- Related: [requirements](../requirements/2026-07-12-ai-native-brownfield-appgen.md),
  [evaluation](../requirements/2026-07-12-ai-native-brownfield-appgen-evaluation.md).

## Context

`loom appgen` was a one-shot greenfield scaffolder driven by a fixed keyword grammar. It could not
reason about an existing app, preview a change, replay a generation, or use a real model. The design
had always intended `parseIntent` to be swappable — provided any replacement still emits a structured
spec and codegen never sees raw NL.

## Decision

Restructure `loom appgen` into **four stages, with AI isolated to exactly one**, and keep the whole
thing in the DX layer (`@loom/appgen` + an optional `@loom/appgen-model` + the CLI). Nothing in
`@loom/core`, `@loom/compiler`, `@loom/workflow-runtime`, `@loom/effect-runtime`, `@loom/app`, or
`@loom/reasoning` changes.

1. **scan** — `scanApp(dir) → AppModel`: deterministic TS-AST summary of flows/steps/gates and
   per-step handler state (`stub | edited | external`). Never raw file contents.
2. **plan** — `planChanges(intent, appModel) → ChangeSpec`: the one NL stage. Tags each capability and
   step `create | extend | modify | delete`. Deterministic by default (wraps the grammar parser +
   diffs the scan); a model planner emits the same `ChangeSpec`.
3. **apply** — `applyChanges(changeSpec, appModel) → FilePlan`: creates from templates; surgical,
   formatting-preserving edits via a self-contained `FlowEditor` (TS-AST reader + offset-splice
   buffer); grant wiring via a `ConfigEditor`; deletes remove generated files/steps.
4. **validate** — in-process `tsc` (`--check`); the model path adds a semantic self-repair loop.

### Key choices and why

- **Own AST toolkit, not `ts-morph` or the compiler's pass.** Surgical `magic-string`-style splices
  into the original source preserve untouched human formatting/comments byte-for-byte, which keeps the
  `--dry-run` diff honest and the compiler untouched.
- **Content-hash safety gate, not the compiler's step hash.** The compiler hashes *location*; appgen
  needs to know whether a handler *body* is still the generated stub, so it keeps its own content hash
  with a single source of truth for the stub text.
- **`tsc`, not `loom check`, for validation.** `loom check` needs a post-build compiler manifest that
  fresh source lacks; `ts.createProgram` gives structured diagnostics with no build.
- **Optional model as a separate package.** `@loom/appgen-model` holds the Gemma/node-llama-cpp
  integration so `@loom/appgen` stays offline and near-zero-dep. The native runtime is an
  `optionalDependency`, genuinely dynamically imported, and the CLI resolves the package **from the
  target project** — so neither the framework nor default CLI users carry it.
- **Reasoning-ladder-on-itself.** The default path is free (deterministic). Elevate to a model only
  when asked; the model path uses `@loom/reasoning`'s cheap-first ladder with a *validator* confidence
  signal and a bounded self-repair loop, logging elevations into the spec lockfile (a DX-layer echo of
  `DECISION_RECORDED`).

## Consequences

- `loom appgen` becomes a plan → diff → confirm tool that works on net-new *and* existing apps, is
  replayable without a model (`--from-spec`), and never clobbers human-edited code.
- The model is strictly a quality upgrade: every failure mode (weak output, missing native dep, crash)
  degrades to the deterministic parser and still yields a valid `ChangeSpec`.
- New surface: `--dry-run`, `--apply`, `--check`, `--from-spec`, `--model`/`--model-big`/`--model-tier`,
  `--offline`, `--yes`. New package `@loom/appgen-model`. New convention `.loom/appgen/<ts>.spec.json`.
- Kernel ABI and event schema unchanged.

## Notes

Real end-to-end testing against a Gemma GGUF fixed four integration bugs (ESM dynamic-import lowering,
the node-llama-cpp v3 grammar API, project-dir peer resolution, a `minItems` grammar segfault) and set
the footprint/stability defaults (bounded generation, small context). Environment guidance (Node LTS,
RAM per tier) lives in the `@loom/appgen-model` README.
