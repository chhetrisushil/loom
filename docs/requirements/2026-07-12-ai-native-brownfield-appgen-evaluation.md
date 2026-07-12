# Evaluation — AI-native, brownfield-aware `loom appgen`

- Date: 2026-07-12
- Companion to [the requirements](2026-07-12-ai-native-brownfield-appgen.md) and
  [ADR 0042](../adr/0042-ai-native-brownfield-appgen.md).

This doc records the audit of the shipped implementation (PRs #111, #112) against the requirements,
the gaps found, and how the completeness follow-up closes them.

## Status by requirement

| Req | Item | Status after #111/#112 | Closed by follow-up |
| --- | --- | --- | --- |
| R1 | `scanApp → AppModel` | ✅ done | — |
| R2 | delta planning (create/extend/modify) | ✅ done (no `delete`) | **`delete` op added** |
| R3 | safe apply, formatting-preserving edits, stub-hash gate | ✅ done | — |
| R3 | new step **wired into the runner** | ⚠️ registered only, left a note | **auto-wire `ctx.run`** |
| R3 | `step op: "modify"` actioned | ⚠️ silent no-op | **honest handled path + note** |
| R3 | `wireGrants` → `config.ts` | ❌ reserved, never wired | **implemented (grammar + schema + ConfigEditor)** |
| R4 | in-process `tsc` (`--check`) | ✅ done | — |
| R4 | model **self-repair loop** | ❌ not built | **`validateChangeSpec` + repair loop** |
| R5 | `--dry-run` preview | ✅ summary only | **real unified diff** |
| R5 | plan → **confirm** | ⚠️ dry-run then re-run | **interactive confirm (`--yes`, TTY-gated)** |
| R5 | `--check` after apply | ✅ done | — |
| R6 | spec lockfile + `--from-spec` | ✅ done | — |
| R7 | optional local Gemma model | ✅ done (after #112 fixes) | tier/elevation surfaced in CLI |
| R8 | reasoning-ladder-on-itself | ✅ done | self-repair extends it |
| docs | `docs/usage-cli.md` reflects new surface | ❌ stale (old flags only) | **rewritten** |
| docs | ADR for the arc | ❌ none | **ADR 0042** |

## Gaps found in the audit (and resolution)

1. **Docs stale.** `docs/usage-cli.md` still described only `--from`/`--dir`. → Rewritten to cover
   scan → plan → apply → validate, all flags, the safety gate, the lockfile, and `@loom/appgen-model`.
2. **No `delete` op.** Only create/extend/modify. → Added `delete` to the grammar
   (`delete/remove <name>`), the model JSON schema, and `applyChanges` (removes generated flow files
   and steps; tracked in `FilePlan.deletes`; honored by dry-run).
3. **New steps not wired into the runner.** `astEdit.addStep` registered a step but left a "wire it
   yourself" note. → `FlowEditor` now inserts a `ctx.run(<step>, …)` call before the runner's return.
4. **`step op: "modify"` was a silent no-op.** → `applyChanges` now records an explicit, honest note
   (appgen does not rewrite hand-written handler bodies; the model path may, via the stub gate).
5. **`wireGrants` reserved, never implemented.** → Grammar directive `grant <tool> to <cap>`, a
   `wireGrants` field in the model schema, and a `ConfigEditor` that inserts a `GrantTable` authorizer
   (and its import) into `app/config.ts`.
6. **No model self-repair loop.** The `validate.ts` comment promised one; nothing ran it. →
   `validateChangeSpec(spec, appModel)` performs semantic checks; `planChangesModel` re-prompts the
   model with the issues (bounded retries) before falling back to deterministic.
7. **`--dry-run` showed a summary, not a diff.** → A dependency-free unified line-diff renders
   create/edit/delete hunks.
8. **No interactive confirm.** → `cli.ts` shows the plan and prompts `[y/N]` before applying
   (skippable with `--yes`; only prompts on a TTY so scripted/piped runs are unchanged).

## Deliberately not done

- **A runnable `examples/` package.** A brownfield walkthrough is provided as documentation
  (`examples/appgen-brownfield/README.md`, no `package.json`) to avoid adding a build/test target for
  what is a doc-first demonstration.
- **Full `tsc` integration test on a generated project.** A generated project imports `@loom/*`, which
  will not resolve in a bare temp dir without an install, so a real `tsc` run there would only produce
  module-resolution noise. Instead, an integration test asserts that the AST-edited flow **parses with
  zero TypeScript syntax diagnostics** — a hermetic, meaningful check that our surgical edits produce
  valid TypeScript.

## Verification

- Unit + integration tests for every new behavior (delete, runner-wiring, wireGrants, self-repair,
  diff rendering, confirm).
- Full workspace `build` + `typecheck` + `test` + `lint` green.
- Kernel-untouched invariant reconfirmed: touched packages are `@loom/appgen`, `@loom/appgen-model`,
  `@loom/cli`, plus docs.
