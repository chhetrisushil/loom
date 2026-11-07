# @loom/scaffold — the templates and generators behind `loom new`, `loom gen` and `create-loom-app`

Pure functions that return file contents as strings: single constructs (a flow, tool, agent, skill,
schedule, memory, projection or sentinel), a whole app skeleton, a plugin package for a chosen seam, and
the static registration module `loom.gen.ts`. They write nothing to disk; the CLI and `create-loom-app`
do that. This is tooling that other tools build on, so most apps never import it. Use it when you build
your own generator and want the same output and escaping rules.

```ts
import { generateRegistration, newFiles } from "@loom/scaffold";

// What `loom new flow greet --template approval` would write, as { path, content } pairs:
const files = newFiles("flow", "greet", "approval");
// -> app/flows/greet/flow.ts and app/flows/greet/flow.test.ts

// What `loom gen` writes: static imports of every discovered module, for defineConfig.
const registration = generateRegistration(["./flows/greet/flow"], ["./agents/triage"]);
```

## Surface

- **Constructs.** `newFile(kind, name, template?)` and `newFiles(...)` route to the individual
  generators (`flowFile`, `toolFile`, `agentFile`, `sentinelFile`, `flowTestFile`). A flow `template` is
  one of `FLOW_TEMPLATES`: `echo`, `approval`, `timer` or `saga`.
- **Whole app.** `appFiles(appName)` returns the file map `create-loom-app` writes.
- **Registration.** `generateRegistration(flowPaths, agentPaths?, toolPaths?, skillPaths?,
  schedulePaths?, memoryPaths?, projectionPaths?)` returns the text of `loom.gen.ts`.
- **Plugins.** `pluginFiles(seamKey, name, { firstParty })`, `pluginNextSteps`, `listSeams` and
  `SEAM_KEYS` back `loom plugin new`.
- **Names and escaping.** `pascal`, `pascalIdent`, `kebab`, `constructNameProblem`, `isValidPackageName`,
  and the emit helpers `tsStringLiteral`, `commentText`, `blockCommentText`, `templateLiteralText`,
  `markdownText` and `hasUnsafeChars`.

## Behaviour that surprises people

- **The registration is static on purpose.** `loom.gen.ts` imports modules at build time, so the set of
  flows is the same on every resume and on every remote worker, rather than found at run time.
- **Names are validated before they reach generated code.** `pascalIdent` throws for a name that does not
  derive a plain ASCII identifier, `constructNameProblem` rejects paths and `..`, and `pluginFiles`
  rejects a name with a slash, dot or leading hyphen.
- **Generated text is escaped at the sink.** Intent text can come from a model, so the emit helpers
  exist to be the only way such text enters generated source. They escape or replace control, bidi and
  zero-width characters, and `hasUnsafeChars` lets a caller refuse them instead.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0011](../../docs/adr/0011-folder-convention-codegen.md): the folder convention these follow;
  [docs/plugins.md](../../docs/plugins.md): plugin authoring.
- CLI: `loom new`, `loom gen`, `loom plugin new` ([docs/usage-cli.md](../../docs/usage-cli.md)).
- API reference: section "`@loom/scaffold` — codegen & templates" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
