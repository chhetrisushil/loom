# ADR 0102 — Flow-level `emit` / `stream` / `ui` append once per execution (EVENT_SCHEMA 1.19.0)

- Status: **Accepted — implemented** (2026-09-27)
- Date: 2026-09-27
- Found by: the [Ambient Experience Projection evaluation](../requirements/2026-09-27-ambient-experience-projection-evaluation.md)
  §1.1, by running code (a runner that emits, suspends and is resumed appends the emit twice).
- Builds on: [ADR 0057](0057-multi-gate-suspend-passthrough.md) (a flow re-runs from the top on
  resume, and gates are matched ORDINALLY against the fold — the precedent this ADR copies),
  [ADR 0061](0061-step-identity-interpreter-guardrails.md) (the sequence of step ids is a pure
  function of logged inputs), [ADR 0081](0081-long-lived-suspensions-no-promotion.md) (a
  long-lived execution parked on a gate is the recommended "session").
- Placement: **kernel, as a bug fix** — approved by the maintainer (2026-09-27) over the 1P
  alternative in D6. **KERNEL_ABI unchanged (1.1.0)**: no syscall added, removed or renamed.
  **EVENT_SCHEMA 1.18.0 → 1.19.0**: one additive fold key from an additive envelope stamp; no new
  event kind, no payload change.

## Context — the defect

A flow re-runs from the top on resume and on crash recovery (ADR 0057). On that re-run
`ctx.execute`, `ctx.decide` and `ctx.suspend` are served from the fold: a completed step returns
its recorded output, a recorded decision returns its recorded choice, a resumed gate passes
through with its recorded payload. `ctx.emit` was not. `WorkflowContextImpl.emit` was a straight
`journal.commit` with no replay check, and `stream` and `ui` are both `emit`.

So every flow-level emit before a resume point was appended again on every resume:

```
EXECUTION_STARTED response.committed EXECUTION_SUSPENDED go EXECUTION_RESUMED response.committed EXECUTION_COMPLETED
```

and a surface built with `ctx.ui.append("timeline", "x")` before a gate folded to `["x", "x"]`
after one resume — deterministically wrong, on every resume, for every caller. A conversation
modelled the way loom recommends (a long-lived execution parked on a gate, ADR 0081) emitted
turn 1's commit N times by turn N.

Kernel facts were not affected. `STEP_*`, `DECISION_RECORDED` and `EFFECT_INDOUBT` also went
through `this.emit`, but their callers short-circuit first. `EffectContext.emit` was also
safe: an effect runs only when its step runs, and a completed step is served from the log.

## The argument — why the kernel, against the P10 bias

1. **The documented meaning is the fixed behaviour.** The ABI's own table says `ui` drives
   "durable, **replayable** UI surfaces". `docs/usage.md` said `ctx.emit` is "durable, folded on
   replay" and `ctx.ui` is "durable per patch". The ABI header makes "changing its meaning" a
   MAJOR break. Restoring the meaning the table already states is a bug fix, not a change of
   meaning. `KERNEL_ABI_VERSION` stays 1.1.0 and the syscall names are untouched.
2. **The 1P alternative is the vacuous-guard pattern** (D6). A helper fixes only the call sites
   that remember to use it. A forgotten site is a silent duplicate that no check can see: the log
   is well-formed, the fold succeeds, and the surface is just wrong. `ctx.ui` would stay broken
   for every caller unless agent-surface were re-routed through the helper, which would be a
   second, 1P-only replay mechanism beside the kernel's. The layering forbids that. And no layer
   above the kernel can fix it properly: only the kernel knows how many flow-level emits the log
   already holds.
3. **"Ordinal matching is fragile under branching" is already the kernel's contract.** `suspend`
   matches gates ordinally against `_resumePayloads` (ADR 0057), and ADR 0061 requires the
   sequence of step ids to be a pure function of logged inputs. A flow whose pre-resume emit
   COUNT depends on unlogged data is already non-deterministic under both rules.

## Decisions

### D1 — Split the paths: the kernel's facts never count

`WorkflowContextImpl` gains a private `commit(eventType, payload)` with the old behaviour.
Every kernel-internal fact in `WorkflowContext.ts` (`EFFECT_INDOUBT`, `STEP_STARTED`,
`STEP_COMPLETED`, `STEP_FAILED`, `STEP_CANCELLED`, `DECISION_RECORDED`) and
`EffectContext.emit` go through it. Their envelopes are unchanged: no stamp, no ordinal consumed.
`WorkflowRuntime`'s own `EXECUTION_*` facts already bypass the context and are untouched.

### D2 — Public `emit` is matched ordinally against the log

`emit` — and so `stream` and `ui`, which call it — works like this:

```ts
emit(eventType: string, payload: unknown): void {
  if (this.liveOnlyDepth > 0) { this.commit(eventType, payload); return; } // D4
  const ordinal = this.flowEmitsIssued++;
  if (ordinal < ((this.vm.getState().variables._flowEmits as number | undefined) ?? 0)) return;
  this.journal.commit(eventType, payload, { metadata: { flowEmit: ordinal } });
}
```

The *i*-th flow-level emit of a run is stamped `metadata.flowEmit = i`. A re-run serves emit *i*
from the log (appends nothing) while `i < _flowEmits`. An emit past the recorded count is live and
is appended, stamped. The check is O(1): one counter and one folded number.

### D3 — The fold: one generic step, keyed on the stamp (EVENT_SCHEMA 1.19.0)

`foldEvents` gains ONE step outside the per-type handlers. When `event.metadata?.flowEmit` is a
non-negative integer, `variables._flowEmits = max(prev, flowEmit + 1)`. It is copy-on-write,
like the other `_`-prefixed kernel variables. It is generic over the event type, because a
flow-level emit is usually a domain event with no handler, and `SURFACE_PATCH` has none either.

- A log that never stamps never gains the key and replays byte-identically.
- The counter lives in folded state, so it survives snapshots and `truncatePrefix` compaction.
- `copyPrefix` (fork) merges fork provenance INTO the copied metadata, so the stamps survive. A
  forked child therefore skips its inherited prefix.
- `FOLD_VECTORS` gains a vector (stamped emits of two handler-less types plus an unstamped one
  → `_flowEmits: 2`). A foreign fold that ignores envelope metadata fails it.

### D4 — An emit made inside one of the run's own effects or deciders takes the effect path

This is an addition to the design as first specified, found while testing it. A flow-level emit
can run inside an effect: a closure over `ctx`, such as the documented
`chunkDeltas((t) => ctx.stream("answer", t))` sink wired to an effect's `onDelta`. It can also
run inside a `ctx.decide` decider. Either way it happens only when that step or decision runs. On
a re-run the step is served and the emit never happens. If it had consumed an ordinal, every
later ordinal would shift DOWN by one, and the first live emit after the resume point would be
skipped. That is a silent LOSS, worse than the duplicate this ADR fixes.

So the context counts how many of its own effects and deciders are running (`liveOnlyDepth`,
raised around `effectRuntime.execute` and around `decider()`). While that count is non-zero, a
flow-level emit goes through `commit`: appended, unstamped, uncounted, exactly like
`EffectContext.emit`. This keeps the rule deterministic and portable. The kernel runs in a
browser tab (`docs/architecture.md`), so an `AsyncLocalStorage` attribution was rejected.

It also removes the limit the first design carried. That design stamped an emit from inside a
crashed step's effect, so the re-executed attempt's emit was skipped. Here that emit is appended
again with the attempt, which is the at-least-once rule every effect emit already follows.

### D5 — The cost of D4, bounded and pinned

The one case D4 cannot tell apart is flow code emitting while a step it started is still in
flight (`const p = ctx.run(s); ctx.emit(...); await p`). That emit looks like an effect's, so it
is appended unstamped. On the first re-run the step is served, the emit is stamped, and the
ordinals after it shift UP. Some emits already in the log are then appended once more. Nothing is
ever lost: a re-run stamps a superset of the calls the original run stamped, so live emits
always get ordinals at or above the recorded count. There is at most one extra copy per such
emit, and the log is stable after that re-run. A test pins this (`emitReplayOnce.test.ts`). The
advice in `docs/usage.md` is to await the step before emitting.

### D6 — Alternative recorded (rejected): docs plus a 1P `emitOnce`

An `emitOnce(ctx, key, type, payload)` helper in `@loom/workflow-runtime`, backed by `decide`
or a step. The ADR 0083 second consumers would have been agent-surface's `append`/`increment`,
the `BLUEPRINT_COMPOSED` emitters in the composed-surfaces recipe, and the ADR 0051 D4 finding
emitters. Rejected for reason 2 above: it fixes only the call sites that remember to use it,
leaves `ctx.ui` broken for everyone else, and puts a second replay mechanism in 1P beside the
kernel's.

### D7 — Legacy logs converge; no migration

Unstamped events do not count. An execution written before 1.19.0 therefore re-emits its
pre-resume prefix once more on its next re-run, stamped this time, and is stable from then on.
That is strictly better than the old "every resume", and needs no migration. A test pins it.

## Consequences

- `ctx.emit` / `ctx.stream` / `ctx.ui` mean what `docs/usage.md` and the ABI table said:
  durable and replayable, appended once per execution. `docs/usage.md`, the cheatsheet, the
  kernel specification (§3, §4), the event-schema reference, the agent-surface emitter header and
  `docs/architecture.md` say so.
- Flow-level emit envelopes carry `metadata.flowEmit`. Envelope metadata was operational and
  unfolded until now; the fold reads this one key. A consumer that compares whole envelopes will
  see the stamp. No suite in this repository needed a change.
- Consumers that asserted the duplicate count were asserting the bug. Across `loom-examples` and
  `loom-plugins`, one did: `db-sentinel`'s "replays a month-3 finding" test counted the re-appended
  `FINDING_RECORDED`. Its property is now observed at the retrieval, in `loom-examples`' own change.
- An emit's position is now load-bearing, as a gate's already was. A flow whose number of
  pre-resume emits depends on unlogged data (a wall clock, a random number, an unrecorded fetch)
  may have an emit served in place of a different one. That flow was already non-deterministic
  under ADR 0057 and ADR 0061.
- `KERNEL_ABI_VERSION` stays 1.1.0. `EVENT_SCHEMA_VERSION` 1.18.0 → 1.19.0 (additive: a fold key,
  no event kind, no payload field).
