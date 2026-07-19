# ADR 0060 — Typed failure channels: `errors:` contracts + replay substitution

- Status: **Accepted — shipped** (`errors:` on step$/tool$/Effect, `TypedFailure`/
  `fail()` in `@loom/core`, substitution at the execute seam, EVENT_SCHEMA 1.17.0)
- Date: 2026-07-19
- Builds on: [DE-series evaluation](../requirements/2026-07-19-dynamic-execution-de-series-evaluation.md)
  (DE-4), the K9.3 declared-idempotence idiom, the saga precedent (spec capability
  note: `ctx.compensate` + `COMPENSATION_*` proved unnecessary).
- Part of: the GenUI/DE corrected series — **the one kernel change**. KERNEL_ABI
  stays 1.1.0.

## Context

Failures were strings: `STEP_FAILED { error: String(err) }`, and a failed frame
was *re-executed* on replay (retry semantics). Any flow that branches on an
expected failure — GenUI's drift repair, the copilot's probe triage
(ConnectionRefused vs PermissionDenied vs Timeout) — sat on an untyped seam
outside the determinism guarantees: stringly-typed branch, unvalidated payload,
undefined replay of the branch that caught it. Two independent workloads
converging on the same need is the kernel-promotion bar.

## Decisions

### D1 — No syscall. `TypedFailure` is a userspace throw

`fail(channel, payload)` throws `TypedFailure` from an effect/handler body. The
execute seam catches it — exactly how `SuspendError` already crosses the
boundary. The pinned `KERNEL_SYSCALLS` table and `abi.test.ts` are untouched;
that test passing unmodified is the ABI-freeze proof.

### D2 — Declaration: `errors:` map, step wins, registry falls back

`errors: Record<channel, ZodSchema>` on `StepDefinition`/`TaskDefinition`/
`ToolDefinition` and (structurally, zod-free) on `Effect`. Resolution at the
seam: `task.errors ?? effectRuntime.declaredErrors(toolId)` — the K9.3
`declaredIdempotence` idiom. Undeclared ⇒ the channel does not exist for this
invocation.

### D3 — Recording: additive STEP_FAILED payload, validated at emit time

A declared-channel `TypedFailure` logs `STEP_FAILED { stepId, error, channel,
payload }` with `payload` schema-validated **before** the append; the fold puts
`errorChannel`/`errorPayload` on the frame. EVENT_SCHEMA 1.16.0 → 1.17.0 (K5
payload-extension rule; channel-less logs fold byte-identically). Two loud
degradations to legacy untyped STEP_FAILED: an undeclared channel, and a payload
that fails its channel's schema (the validation error becomes the logged error
string) — a contract violation must not smuggle unvalidated data into a
substitutable event.

### D4 — Substitution: the failure twin of the completed short-circuit

At the execute seam, before anything else: a frame with `errorChannel` rethrows
`TypedFailure(channel, payload)` — zero events, zero middleware, zero effect
invocation. The flow re-takes the same catch branch deterministically on replay,
resume, and recovery. **This applies to live re-invocation of the same id too**:
a second `ctx.run` of a typed-failed id is served the recorded outcome. A
deliberate retry must mint a new id (`${id}#retry:N`) — this is the ADR 0061
identity rule enforced by construction, and it is what makes typed failures
*outcomes* rather than transient errors. Untyped failures keep legacy
re-execution (G2), and the EFFECT_INDOUBT operator-verdict "fail" path stays
untyped (operator verdicts are not domain channels).

### D5 — Retry default: a declared outcome is not transient

`retryMiddleware`'s default `isRetryable` now excludes `TypedFailure` — retrying
a deterministic domain outcome burns attempts for nothing. An explicit
`isRetryable` retains full control; in-memory retry of a TypedFailure is legal
(nothing durable has been emitted when middleware sees it).

### D6 — Interactions (verified by test, no code)

`ctx.parallel`: fail-fast join rejects with the TypedFailure; in-flight siblings
run to settlement and log their own terminal events while the run is open;
replay substitutes every recorded frame. Suspension: substitution consumes no
resume passthrough, so catch-then-suspend flows replay gate payloads in order
(ADR 0057 untouched).

## Consequences

- The drift-repair pattern (catch `schemaDrift` → suspend/re-plan) is in-band,
  validated, and replay-deterministic — the mechanism ADR 0063's `mcpInvoke$`
  and ADR 0064's sandbox channels build on.
- Observability gains a channel-level aggregation key on failures without
  parsing error strings.
- Spec capability `typed-failure-channels` (L2); evidence
  `packages/workflow-runtime/src/typedFailure.test.ts` +
  `packages/replay-vm/src/typedFailureFold.test.ts`.
