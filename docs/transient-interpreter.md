# Recipe — the transient manifest interpreter

**When to use.** You have a hot **read path** that walks an immutable,
content-addressed manifest of effect calls (fetch live data, reshape, return),
runs on every request, and mutates nothing — if it fails the caller simply
retries. Read-path hydration for LLM-generated dashboards (GenUI) is the
canonical case.

**The rule.** *Don't make it a run until something durable happens* (ADR 0065).
The manifest walk is **not a loom run**: no `EXECUTION_STARTED`, no `STEP_*`, no
snapshot, no fence. Cross the determinism boundary — `start()` a durable run —
only when a state-changing outcome (drift repair, planning) must be **recorded**.
The mechanism is [`invokeTransient`](adr/0066-transient-effect-invocation-facade.md)
(the supported façade over the non-durable effect path); the rejected alternative
— a "cheap run" durability class — is settled in
[ADR 0065](adr/0065-group-commit-deferred-evidence-gate.md) /
[the DE-series evaluation](requirements/2026-07-19-dynamic-execution-de-series-evaluation.md).

## Shape

```ts
// 1. HOT PATH — transient. Plain code over the immutable plan. Zero events.
async function hydrate(plan: Plan): Promise<States> {
  const raw = await Promise.all(
    plan.nodes.map((n) =>
      runtime.invokeTransient("mcp.invoke", {
        toolName: n.toolName,
        args: n.args,
        expectedSchemaHash: n.schemaPin,   // typed `schemaDrift` failure on mismatch
      })
    )
  );
  return Object.fromEntries(
    await Promise.all(
      plan.nodes.map(async (n, i) => [
        n.projectionId,
        await runtime.invokeTransient("sandbox.eval", {
          scriptRef: n.scriptRef,
          input: raw[i],
          expectedOutputShapeHash: n.shapePin,
        }),
      ])
    )
  );
}

// 2. BOUNDARY — escalate to a durable run ONLY when a repair must be recorded.
async function hydrateOrRepair(executionId: string, plan: Plan): Promise<States> {
  try {
    return await hydrate(plan);                       // common case: nothing written
  } catch (err) {
    if (!(err instanceof TypedFailure) || err.channel !== "schemaDrift") throw err;
    // Something durable happened. Record it.
    const handle = await runtime.start(repairFlow, { plan, drift: err.payload }, { executionId });
    return (await handle.waitForCompletion()).variables._output as States;
  }
}
```

The durable `repairFlow` emits its domain event (`SCHEMA_REPAIRED`), re-walks the
plan under the corrected pin with `ctx.run`, and re-mints the drifted node's id
(`hydrate#i#repair` — a deliberate retry is a NEW identity, ADR 0061). Its events
are the forensic, replay-substitutable, branchable record.

## Contract you can rely on

| Concern | Transient (`invokeTransient`) | Durable (`start`) |
|---|---|---|
| Event store | **untouched** — zero envelopes | full `EXECUTION_STARTED` / `STEP_*` / snapshots |
| Retry/backoff middleware | runs (effect-local) | runs |
| K2 authorizer | enforced (if wired) | enforced |
| Journaling / fold / fence / snapshot | **bypassed** (structurally — none exists at this layer) | applied |
| `ctx.emit` | **dropped** by construction — never buffered, never flushed | folded into the log |
| Cancellation | `opts.signal` → `ctx.signal` | execution-scoped |
| `idempotencyKey` | unset — no cross-call provider dedup | `executionId:stepId` |

### Transient calls from a `ctx.decide` decider (L30)

A decider that needs an effect (an LLM/MCP planner) receives a **scope**:
`ctx.decide("plan", (scope) => scope.invokeTransient("llm.plan", req))`. The
scope's calls are still transient (everything in the table above holds, including
the effect-mode check: a `journaled` effect is refused, undeclared effects are
allowed), but they run **as the deciding execution**: the K2 authorizer and the
middleware chain see its real `workflowId` / `executionId` and its full principal
chain, delegation token and actor included. So flow-scoped grants apply to a
decider's reach and a delegation that does not cover the effect denies it, with no
custom principal attribute. The principal cannot be overridden by the decider. On
replay the recorded decision is served and the decider (hence the scope) is never
invoked. A bare `invokeTransient` outside a decider keeps the throwaway
`transient` identity.

**Identity of a scope call.** `stepId` is the **toolId**, exactly as for a bare
call, so everything keyed by step id (secret-output redaction, per-tool pricing,
per-tool middleware config) matches the same way on both paths. Two calls in one
execution (same decider or different ones, same tool) therefore share
`(executionId, stepId)`; they are told apart by `EffectContext.callKey`
(`decide:<decisionId>:<n>`, `n` an ordinal unique across every decide() of the execution context, so even two live same-id decisions mint distinct keys). Any site that mints
an id from `(executionId, stepId)` must append `callKey` when present: the A2A
peer client (task id) and the redaction middleware (secret-ref id) do. The
`a2ui` `callFunction` effect is `journaled`, so it can never run in a scope.

**Verification (L31).** `@loom/verify`'s runner-body reach analysis counts a
literal-toolId `scope.invokeTransient` as a reached effect and reports a non-literal
toolId, an escaping scope, or an unseen decider as unresolved; a scope call to a
`journaled` effect is a `replay-safety` error (ADR 0086 amendment).

**Cancellation and lifetime.** The call's signal is the composition of the
execution's cancellation, the signal the decider passes (it adds to, never
replaces, the execution's), and the scope's own lifetime: a call started but not
awaited is aborted when the decider settles, and a call made after it settles
throws.

These refusals carry stable names, so a consumer that cannot import
`@loom/workflow-runtime` classifies them by `err.name` rather than by message:
`ExecutionCancelledError` (the abort reason of `cancel()`, and `throwIfCancelled`'s
default, when the canceller supplied no `Error`) and `DecideScopeClosedError` (a call
on a settled scope, and the abort reason of an unawaited call). A caller that passes
its own `Error` as the cancel reason (including the deadline breach's own error) keeps
it: it is the abort reason and the thrown error as-is, never wrapped. A decider that
retries or records on failure should let these, and the other control-plane refusals
(`CapabilityDeniedError`, `QuotaExceededError`, `AbortError`), propagate.

**Budget and denial: what a scope call does NOT do.**

- *Admission applies, the charge does not.* The scope passes the execution's
  running `_resources` totals, so metering / `nestedBudget` refuse an over-budget
  execution's scope call. The call's own spend is dropped by the no-op `emit`
  (R4), so a decider's LLM calls never reach the budget; bound a decider's loop
  yourself.
- *A denial inside a decider is not durable.* `EFFECT_DENIED` goes to the no-op
  sink; a decider that catches `CapabilityDeniedError` leaves no trace in the log.
  Let the error propagate (the execution fails and nothing is recorded) rather
  than swallowing it.

**Wrappers must key on the identity.** `TransientInvokeOptions.as` makes the
identity an authorization input (`GrantTable` keys on `workflowId`). Any wrapper
that memoises or dedupes transient calls MUST key on `as` as well as
`[principal, input]`, and on `label` too: without `as` the synthetic
`executionId` is `transient:<label>`, and an authorizer configured to grant per
execution decides on it. The simplest safe key is every option except `signal`.
Otherwise a result produced under one execution's grants can be served to
another's.

## Guardrails

- **Do not** author a transient effect that relies on emitting durable state —
  the emit is a sink.
- **Do not** feed transient results into a durable run as if they were logged —
  non-durable data must not enter the fold. The repair run re-fetches; that
  double-fetch is paid only on the rare repair path.
- **Do not** try to make a transient call "sometimes durable." That is DE-2,
  rejected on invariants (ADR 0065). Return `Promise<TOut>`; take no store;
  return no handle.
- **Do not** declare `mode` on the effects this pattern uses. `mcp.invoke` and
  `sandbox.eval` are **dual-seam by design** — this page's hot path calls them
  through `invokeTransient`, and the repair run calls the *same* effects through
  `ctx.run`. Pinning either seam (ADR 0073) breaks one of those two paths, at
  runtime, in whichever deployment happened to use the other half.
  `plugins/mcp/src/dualSeam.test.ts` guards this.

  Declare a mode only when the effect's *own contract* depends on the seam — a
  mutation that must be recorded, or a recovery story that needs the journal.
  "Both seams are legitimate" is a real answer, and leaving the marker off is how
  you say it.

## Worked example

`db-observability` (in the sibling [`loom-examples`](./examples.md) repo)
implements exactly this: `src/hydration.ts` hydrates a DB-telemetry dashboard
transiently on every open, and escalates to a durable repair run when a simulated
backend deploy drifts a tool's input schema. Run it with `pnpm --filter
@loom/db-observability start` from `loom-examples`.
