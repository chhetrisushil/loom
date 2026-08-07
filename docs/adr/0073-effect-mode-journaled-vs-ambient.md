# ADR 0073 — Effect mode: journaled vs ambient as a declaration + boundary check

- Status: **Accepted** (2026-08-08)
- Date: 2026-08-08
- Builds on: the transient effect invocation façade ([ADR 0066](0066-transient-effect-invocation-facade.md)),
  the DE-2 durability-class rejection ([DE-series evaluation](../requirements/2026-07-19-dynamic-execution-de-series-evaluation.md)),
  execution-lifecycle authz ([ADR 0039](0039-execution-lifecycle-authz.md)),
  typed failure channels ([ADR 0060](0060-typed-failure-channels.md)),
  K10-R1 data classification (`@loom/classify`).
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). **KERNEL_ABI unchanged
  (1.1.0); EVENT_SCHEMA unchanged** — no syscall, no event type, no fold change. This is a
  boundary check at the execute seam, the ADR 0039 shape.

## Context

A surface that can invoke arbitrary tools must decide, per call, whether the call appends to
the event log. Two kinds arrive through the same door:

- **Resumptions / state transitions** — an approval, a submit. These must be journaled: the
  durable fact is the point.
- **Enrichment reads** — a rendered View paginating a table, drilling into a row, refetching a
  surface. These must *not* be journaled. Their count and order are driven by a human clicking,
  so recording them makes the log a function of user behaviour and replay stops being a fold of
  facts.

MCP Apps makes this concrete — a View can call any tool the host proxies for it — but the
tension is not MCP's. It is the same one that shows up wherever a read path and a write path
share a tool namespace.

### What already exists, and what does not

The **mechanism** is built. `invokeTransient` (ADR 0066) is the ambient path, and its D2 is
emphatic that "zero durable footprint is structural, not conventional... by construction, not by
a flag": the `EffectRuntime` holds no event store, journal, or fence, so a transient invocation
produces no envelopes at all. `@loom/live-query` and `@loom/plugin-read-model` (ADR 0058) cover
the read-model half.

The **declaration** does not exist. Which side of the boundary a tool belongs on is decided
entirely by *the caller's entry point* — nothing on the tool says. So every invocation surface
must hand-wire the routing, and the discipline is documentation rather than enforcement.

That is precisely the problem K10-R1 solved for data sensitivity: "a field's sensitivity is
authored ONCE, at its schema, instead of hand-wired as dot-paths at every store/middleware
seam." The same argument applies to journaling mode, and there is already a three-instance
precedent for the shape — `idempotent` (K9), `egress` (K7.3), and `errors` (ADR 0060) are all
declarations on `tool$` whose enforced copy lives on the registered effect.

## Decision

### D1 — `mode: "journaled" | "ambient"` on `tool$`, enforced on the effect

`EffectMode` in `@loom/core`; `tool$({ mode })` carries the declaration; `new ToolEffect(fn,
{ mode })` carries the enforced copy. Undeclared is a true no-op — existing effects behave
byte-identically on both seams (G2), so nothing defaults into a boundary.

### D2 — Enforcement is a boundary check, not a journaling mode

`EffectRuntime.execute` refuses an `ambient` effect; `invokeTransient` refuses a `journaled`
one. Both throw `EffectModeViolationError`, carrying `toolId`/`declared`/`attempted` so a
routing surface can branch on it.

It is thrown plainly rather than recorded as `EFFECT_DENIED`: this is a wrong-entry-point
programming error, not a lack of authority, and the two should not be conflated in an audit log.

**The rejected alternative matters more than the accepted one.** The obvious design —
`ambient` means "skip the journal for this `ctx.execute`" — is DE-2's durability class in new
clothing. A non-journaled effect *inside* an execution has no recorded result to substitute, so
replay re-invokes it and the execution acquires a second replay model. The DE-2 verdict already
ruled that "two durability classes is precisely the second semantic model the submission's own
invariant forbids." An `ambient` tool is therefore not an effect that skips its journal; it is
one that **may not enter an execution at all**. There remains exactly one replay model.

### D3 — The seam is the entry point, never the context's contents

Both paths funnel through one private `runSeam(toolId, input, ctx, seam)`; `execute` passes
`"journaled"` and `invokeTransient` passes `"ambient"`. The check reads that parameter, not the
context.

This is load-bearing. `invokeTransient` synthesises a context with `executionId:
"transient:<label>"` and `workflowId: "transient"` (ADR 0066 D1), and inferring the seam from
those strings would make the boundary spoofable by any caller who hand-builds a context that
merely *looks* transient. Tested explicitly.

## Consequences

- **Routing is read off the declaration.** `servedEffect(effectRuntime, toolId, …)` in
  `@loom/plugin-mcp` dispatches `ambient` tools through `invokeTransient` and everything else
  through the caller's journaled path — no hardcoded allowlist per surface. A new invocation
  surface cannot accidentally journal an enrichment read.
- **ADR 0066's structural guarantee becomes a declared one.** Before this, nothing stopped a
  pagination read being `ctx.execute`d; the correct architecture was convention. Now it is
  refused. This is the K7.3 `egress` pattern — "In-process ToolEffects have ambient authority —
  isolation is what turns this from convention into guarantee."
- **Kernel growth is zero.** No syscall, no event type, no fold change; `ToolDefinition` gains
  one optional field, the same additive move `idempotent` and `errors` made without an ABI bump.
- **Cost when undeclared.** The marker is opt-in, so the guarantee is opt-in too: an unmarked
  enrichment tool is still journalable. Declaring modes across existing tools is follow-on work,
  and the honest statement today is that this makes the boundary *expressible and enforceable*,
  not yet universally enforced.

## Rollout (addendum, 2026-08-08) — most tools stay undeclared, deliberately

The obvious follow-on — "now declare modes on the remaining tools" — was surveyed and largely
**declined**. Treating the marker as a form to fill in would have broken shipped architecture.

**Declared `journaled` (3):**

| Effect | Why the seam is pinned |
|---|---|
| `a2ui.callFunction` | Its recovery story *is* the journal: `idempotent: false` parks a crashed call at EFFECT_INDOUBT, and the deterministic `callId` is `ctx.idempotencyKey`. Transiently there is no journal to park in, no fence, and no stable key. (Grain A is unaffected — it is `ctx.suspend`/`resume`, not this effect.) |
| durable-state `save` | ADR 0053's contract is "RECORDED effects — replay folds the recorded value, never the store". A transient write moves the store while the log learns nothing, so replay folds a state the run never produced. |
| durable-state `clear` | Same. |

**Left undeclared, on purpose:**

- **`mcp.invoke` and `sandbox.eval` are dual-seam by documented design.** The
  transient-interpreter pattern (`docs/transient-interpreter.md`, the DE-2 verdict) hydrates a
  read path with `invokeTransient("mcp.invoke", …)` / `invokeTransient("sandbox.eval", …)` and
  then starts a **durable repair run** that calls the same effects through `ctx.run(mcpInvoke$(…))`.
  Pinning either seam breaks one of those paths. `plugins/mcp/src/dualSeam.test.ts` asserts this,
  so a later sweep argues with a failing test rather than a comment.
- **durable-state `load`.** Journaled inside a flow; a perfectly reasonable ambient read outside
  one (an operator dashboard peeking at a sentinel's carry state should not have to start an
  execution). Pinning it would forbid a legitimate caller.
- **Tools discovered from a remote MCP server** (`McpClient.mapTool`) and **A2A peers**
  (`A2APeerClient`). Both wrap someone else's system; whether a given remote tool is a read or a
  mutation is unknowable here, and a guessed seam has teeth.
- **Step handlers** auto-registered by the interpreter (`LazyEffect`). Declaring a seam inside
  kernel auto-registration would change behaviour for every step in every app to buy nothing —
  the interpreter is already the only caller.

**The general rule this establishes.** Declare a mode when the effect's *own contract* depends on
the seam — when being on the wrong side would corrupt recovery, replay, or durability. Leave it
undeclared when both seams are legitimate. The marker is opt-in because "unknown" and "both" are
real answers, and G2 makes them the safe default.

The cost stated in Consequences therefore stands and is now deliberate rather than pending: an
unmarked tool is still invocable on either seam. That is not a gap to be closed by sweeping; it
is the design.

## Notes

The framing that prompted this — "if `tool$`'s digest declaration doesn't already carry an
effect classification, that's your one real kernel/SPI requirement" — was right about the gap and
about it being worth adding on its own merits, with two corrections worth recording:

1. **There is no `digest` declaration on `tool$`.** The digest is CC-2 —
   `ClaimCheckOptions.digests` (`toolId → fn`) on the claim-check middleware (ADR 0054),
   deliberately not on the tool. `tool$`'s declaration bundle is `idempotent`/`egress`/`errors`,
   which is what `mode` joins.
2. **It is not a kernel requirement.** Under D2 it is a check at the execute seam —
   `@loom/core` for the declaration, `@loom/effect-runtime` for the enforcement — so
   KERNEL_ABI stays 1.1.0. It would only have been a kernel change under the design D2 rejects.
