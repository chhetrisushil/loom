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
