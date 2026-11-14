# @loomwork/deploy-sim — check a deploy against executions that are still in flight

Before you ship new flow code, replay your stored event logs against the new flow definitions and see
which in-flight executions would break on resume. Nothing runs live: each log is folded
(`replayAsFixture` from `@loomwork/eval`) and compared structurally with the definitions you pass in. Use it
as a CI gate for the "approval sat open for two days and we deployed in the middle" case. The
`loom deploy check` command is a thin wrapper over it.

```ts
import { simulateDeploy } from "@loomwork/deploy-sim";
import type { EventEnvelope } from "@loomwork/core";
import type { WorkflowRuntime } from "@loomwork/workflow-runtime";

declare const logs: EventEnvelope[][]; // one array per execution, e.g. loaded from a store
declare const next: WorkflowRuntime; // booted with the NEW flow code; it has getFlow(flowId)

const report = simulateDeploy(logs, next);
for (const issue of report.issues) {
  console.log(issue.severity, issue.kind, issue.executionId, issue.detail);
}
if (!report.ok) process.exit(1); // ok is true when there is no "breaking" issue
```

## Surface

`simulateDeploy(logs, resolver)` returns `{ checked, issues, ok }`. The resolver is anything with
`getFlow(flowId)` returning `{ definition: { version, steps } }`, and a booted `WorkflowRuntime`
qualifies. Each issue has `executionId`, `workflowId`, `severity`, `kind` and `detail`:

| Kind | Severity | Meaning |
|---|---|---|
| `flow-missing` | breaking | the execution's flow no longer exists in the new deployment |
| `step-removed` | breaking | a step that already ran is gone from the new flow, so its recorded output would be orphaned |
| `flow-code-drift` | breaking | a suspended or running execution was recorded under a different flow-code hash than the new code |
| `suspended-carryover` | warning | a suspended execution will have to resume on the new code; listed so you look at it |

## Behaviour that surprises people

- **It is structural, not behavioural.** It looks at flow ids, step ids and the recorded flow-code hash.
  A change inside a step that keeps its id, or a new step, is not reported unless it changes the hash of
  a live execution.
- **Drift needs a full definition and a recorded hash.** The `flow-code-drift` check runs only for
  suspended or running executions whose log recorded a flow hash, and only when the resolver returns a
  complete `FlowDefinition`. A minimal `{ version, steps }` test double skips it.
- **Empty logs are skipped** and not counted in `checked`.
- **The remedies for drift** are to drain the execution, keep the original version registered, or
  migrate explicitly with `resumeAs` (from the issue text).

## Status / See also

`npm install @loomwork/deploy-sim` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

- [ADR 0014](../../docs/adr/0014-deploy-check-and-inspector.md): deploy check;
  [ADR 0113](../../docs/adr/0113-body-aware-code-fingerprint-and-dynamic-id-migration.md): the flow-code hash.
- CLI: `loom deploy check --logs <dir> --config <module>` ([docs/usage-cli.md](../../docs/usage-cli.md)).
- API reference: section "`@loomwork/deploy-sim` — deploy simulation" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
