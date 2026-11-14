# @loomwork/appgen — turn an intent into Loom code you own

Takes a plain-language intent and produces ordinary, static TypeScript: flows, steps, capabilities and
a `defineConfig`, either as a new project or as edits to an existing app. Only one stage reads natural
language, and the rest is deterministic and offline. The output is code you read, edit and commit; it is
generated once, not interpreted at run time. The `loom appgen` command is the usual way to use it. The
library is for building your own front end, or for tests.

```ts
import { applyChanges, planChangesDeterministic, scanApp, typecheck } from "@loomwork/appgen";

const model = scanApp("./my-app"); // flows, steps, gates, and whether each handler is still a stub
const spec = planChangesDeterministic("create a triage flow. step classify. pause for approval.", model);
const plan = applyChanges(spec, model); // pure: nothing is written yet

for (const file of plan.creates) console.log("create", file.path);
for (const edit of plan.edits) console.log("edit", edit.path, edit.notes);
for (const skip of plan.skips) console.log("skip", skip.path, skip.reason);

// Writing the plan (use safeWriteFile), re-running `loom gen` and then:
const result = typecheck("./my-app"); // { ok, skipped, diagnostics }
```

## Surface

- **Scan.** `scanApp(dir)` and `isExistingApp(dir)` summarize an app without returning file contents.
- **Plan.** `planChangesDeterministic(intent, appModel)` returns a `ChangeSpec`, whose capabilities and
  steps are tagged `create`, `extend`, `modify` or `delete`. A model-driven planner is the separate
  `@loomwork/appgen-model` package. `parseIntent(text)` produces an `AppSpec` for a net-new app.
- **Apply.** `applyChanges(spec, appModel)` returns a `FilePlan` (`creates`, `edits`, `deletes`, `skips`,
  `regenRegistration`). `generateProject`, `generateFlows` and `generateApp` build files from an `AppSpec`.
  `FlowEditor` and `wireGrantsIntoConfig` do the surgical edits.
- **Validate and record.** `typecheck(dir)` runs `tsc` in process. `makeLock`, `writeLockfile` and
  `readLockfile` handle the replayable `.loom/appgen/<ts>.spec.json` record.
- **Safe writing.** `safeWriteFile`, `assertNoSymlinkPath` and `containmentRootFor` refuse to write
  through a symbolic link.

The deterministic grammar includes `create a <name>`, `add step <name>`, `delete <name>`,
`grant <tool> to <cap>`, `use <model> first`, `elevate to <model>`, `pause for approval`, `generate ui`
and `deploy on <target>` (the api-reference section below lists the grammar).

## Behaviour that surprises people

- **A handler you edited is not overwritten.** A handler body is replaced only while it still hashes to
  the generated stub; anything you changed is insert-only, and untouched code is preserved byte for byte.
- **`applyChanges` writes nothing.** The caller writes the plan, then re-runs `loom gen` to refresh
  `app/loom.gen.ts` (`regenRegistration`). The CLI does all of this and adds `--dry-run`, `--check` and
  confirmation for destructive edits.
- **Intent text is untrusted.** It can come from a model or a user, so every string that reaches
  generated source goes through the escaping helpers in `emit`, and the scan skips flows that are
  symbolic links.
- **`typecheck` skips quietly.** With no `tsconfig.json` it returns `{ ok: true, skipped: true }`, so
  check `skipped` before treating `ok` as proof.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0042](../../docs/adr/0042-ai-native-brownfield-appgen.md) (the four stages) and
  [ADR 0050](../../docs/adr/0050-appgen-model-provider-agnostic.md) (model-driven planning).
- CLI: `loom appgen` ([docs/usage-cli.md](../../docs/usage-cli.md)).
- API reference: section "`@loomwork/appgen` — AI-native, brownfield-aware codegen *(2.0)*" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
