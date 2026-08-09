# ADR 0077 — Typed resume payloads: per-gate contracts, enforced before the append

- Status: **Accepted** (2026-08-09)
- Date: 2026-08-09
- Promotes: [issue #230](https://github.com/chhetrisushil/loom/issues/230) (TR, filed deferred
  under the demand-gate discipline of [ADR 0071](0071-read-only-replay-inspector.md)).
- Builds on: ADR 0051 D7 (`validateInput` — the same principle at the other entry point),
  K12.2 (`ResumeAuthenticator` — the identity half of the same boundary),
  [ADR 0056](0056-k11-5-state-migration-on-resume.md) (`resumeAs`).
- Part of: the kernel/1P/3P triage discipline (P10). **KERNEL_ABI unchanged (1.1.0);
  EVENT_SCHEMA unchanged (1.17.0)** — no new syscall, no new event type. One optional field on
  `FlowDefinition` and a parse at two existing entry points.

## Context

loom typed every boundary except one. `flow$` and `step$` carry Zod schemas; `start()` has
opt-in `validateInput`, whose own comment states the principle:

> the PARSED value (Zod defaults/transforms applied) is what runs and is recorded; invalid
> input refuses BEFORE anything is appended.

Resume had none of it. `SuspendConfig.on` is a bare string and `ResumeEvent.payload` is
`unknown`. The only gate was `verifyApproval` (K12.2), which authenticates **who** sent the
event, never **what** they sent. The payload went into the log unvalidated — and a resume
payload cannot be rejected retroactively. Once appended it is a permanent fold input.

### Why now — the honest version

Issue #230 was filed *deferred*, with three named promotion conditions. **None of them
landed.** There is still no incident artifact, no multi-gate flow (checked: no runner anywhere
in `loom` or `loom-examples` contains two `ctx.suspend` calls), and no integration that
hand-rolls payload validation.

What did accumulate is the issue's fourth evidence item, now quantified: across the examples
there are **11 gate sites and 3 distinct payload types, every one discharged with an
`as unknown as` cast**:

```ts
const decision = (await ctx.suspend({ on: "ApprovalGranted", ... })) as unknown as ApprovalDecision;
```

A cast is not a check. Each of those sites asserts a shape that nothing verified. Alongside
them, `LoomAgentExecutor.provideInput` (`plugins/a2a`) forwards a **network-supplied**
`ResumeEvent` straight to `runtime.resume` with no shape validation at all — a remote agent
chooses both the event type and the payload that enter another execution's durable log.

This ADR records that the gate was met **in spirit, not by its letter**, and that the decision
to build was the maintainer's call on that basis. Written down because the demand-gate
discipline is only worth anything if departures from it are visible.

## Decision

A static `on → schema` map on `flow$`, parsed at ingress before anything is appended:

```ts
flow$({
  id: "remediate-lag",
  // …
  resumeSchemas: {
    ApprovalGranted: z.object({ approved: z.boolean(), approvedBy: z.string() }),
    RemediationDecision: z.object({ approved: z.boolean(), strategy: z.string() }),
  },
})
```

### D1 — declared per FLOW, not at the `ctx.suspend` call site

This is the load-bearing choice. Refuse-before-append requires resolving the gate's schema
**without executing the flow body** — and at `resume()` the registered definition is already in
hand. Inline-at-the-gate would require putting a schema reference in `EXECUTION_SUSPENDED` and
looking it up through a registry: more machinery, less static visibility, and a durable log
that now carries a pointer into code.

It also settles the multi-gate ambiguity that [ADR 0057](0057-multi-gate-suspend-passthrough.md)
found the hard way: two gates sharing an `on` name resolve the same schema, necessarily,
because there is one map.

### D2 — presence is the opt-in (no runtime flag)

`validateInput` is a `WorkflowRuntimeDeps` boolean because `inputSchema` is **mandatory** on
`flow$` — it exists on every flow whether or not the author wanted enforcement, so enforcement
needed its own switch. `resumeSchemas` is itself optional and new. Declaring one can only mean
"enforce it", so a second switch would be ceremony. An absent map, or an event type with no
entry, is today's behaviour byte-identically (G2).

### D3 — shape is checked AFTER identity

`verifyApproval` runs first. Two reasons, both concrete: the authenticator must see the exact
event the caller signed (a Zod transform could reshape a payload out from under a signature),
and an unauthenticated caller should not learn the gate's contract from an error message.
Neither appends, so both refuse cleanly.

### D4 — `resumeAs` validates against the TARGET flow

The execution is being resumed **onto** the new code, so the new code's declared shape is the
one that must hold. The parse happens before the `EXECUTION_MIGRATED` append, so a rejected
payload leaves no half-migrated execution behind.

### D5 — `restoreFromState` is deliberately NOT validated

It is a rehydration/branching primitive: callers hand it a folded state and an app-constructed
event, not network input. Validating there would risk double-applying a non-idempotent Zod
transform to a payload `resume()` already parsed. The boundary is the two public *ingress*
entry points.

## A prototype-chain bug this surfaced

Writing the hostile-input test for `resumeSchemas` (`eventType` is caller-controlled, so it
reaches the map as a key) found a **pre-existing, unrelated** defect in the kernel's fold:

```ts
export function getHandler(eventType: string): Handler | undefined {
  return handlers[eventType];   // handlers["__proto__"] → Object.prototype
}
```

`foldEvents` guards with `if (handler)` — and `Object.prototype` is **truthy**, so the fold
called a non-function. `runtime.resume(id, { eventType: "__proto__", … })` threw
`TypeError: handler is not a function` out of the most load-bearing function in the kernel,
reachable from the A2A ingress by a remote caller.

Severity is bounded: the crash happens during the pre-append fold, so nothing is written and
the execution stays clean and foldable. It is a caller-triggered error, not log poisoning.

The same shape existed in three more places, all indexing a config map with a caller-controlled
event type: `InMemoryProjectionRuntime` (same truthy-`Object.prototype` defeat of a `!handler`
guard), `EncryptingEventStore` and `ContentResolvingEventStore` (both would pass
`Object.prototype` into code expecting a path array). All four now use `Object.hasOwn`.
`replay-inspector` already had the guard from an earlier audit — the pattern was known, and
`getHandler` had simply been missed.

## Alternatives rejected

- **A runtime-wide `validateResume` flag.** See D2 — a second switch for a field that is
  already optional.
- **Schema at the `ctx.suspend` call site.** See D1 — cannot be resolved before append without
  putting a code pointer in the log.
- **A closed vocabulary of resume event types** (the withdrawn `sub$` / standing-wake-source
  series, ADRs 0051/0052). That put a real idea on a primitive that does not exist.
  `ctx.suspend` does exist and is used today.
- **Validating in `restoreFromState` too.** See D5 — double-transform risk on a non-ingress
  path.

## Consequences

An app that declares a gate contract gets malformed payloads refused at the door, with the
offending field named, and the execution left suspended and resumable. The parsed value is what
is recorded, so defaults and transforms are durable rather than re-derived on every fold.

Apps that declare nothing are unchanged, byte for byte.

**The sharp edge, found while applying this across the examples:** "the parsed value is what is
recorded" means a strict `z.object` **strips** keys it does not name, so declaring a contract
also decides what is *persisted*. A field omitted from the schema is dropped from the durable
log permanently, with nothing to warn you and no way to repair it afterwards — the events are
already folded. Two payloads in the examples legitimately carry an open envelope (an A2UI
`functionResponse`, and a bridge-normalized client action alongside the app's own field), and a
naive schema would have silently erased it. Modelling the extra fields is preferred, since it
buys validation as well as retention; `.passthrough()` is the escape hatch for envelopes the
app does not own. Documented in the user guide and in the `flow$` JSDoc, and pinned by tests
asserting both behaviours against the durable log.

A second, softer trap: gate names are not evidence of gate payloads. Across the examples a gate
called `ApprovalGranted` turned out to receive `{ approvedBy, approvedAt }` with no `approved`
field, and another received a bare `{ approved }` from one caller. The casts had asserted a
shape nobody was sending. Writing the schema is what surfaced it — which is the point, but it
means the first schema must be derived from the real `resume` call sites, not from the name.

The `as unknown as` casts at the 11 example gate sites can now be replaced by a declaration
that is actually enforced. That migration is not part of this ADR — the examples live in a
sibling repo — but it is the reason this exists.
