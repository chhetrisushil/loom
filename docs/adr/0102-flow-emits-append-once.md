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
  alternative in D7. **KERNEL_ABI unchanged (1.1.0)**: no syscall added, removed or renamed.
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
2. **The 1P alternative is the vacuous-guard pattern** (D7). A helper fixes only the call sites
   that remember to use it. A forgotten site is a silent duplicate that no check can see: the log
   is well-formed, the fold succeeds, and the surface is just wrong. `ctx.ui` would stay broken
   for every caller unless agent-surface were re-routed through the helper, which would be a
   second, 1P-only replay mechanism beside the kernel's. The layering forbids that. And no layer
   above the kernel can fix it properly: only the kernel knows how many flow-level emits the log
   already holds.
3. **The fix can be exact about what it knows.** The kernel is the only layer that sees both the
   log and every flow-level emit of a re-run, so it can serve precisely the emits the log proves
   were already made, and append everything else. The first design matched emits by ORDINAL, and
   review showed it was wrong (D7). The shipped rule matches by content and never trades an emit
   for a guess.

## Decisions

### D1 — Split the paths: the kernel's facts never count

`WorkflowContextImpl` gains a private `commit(eventType, payload)` with the old behaviour.
Every kernel-internal fact in `WorkflowContext.ts` (`EFFECT_INDOUBT`, `STEP_STARTED`,
`STEP_COMPLETED`, `STEP_FAILED`, `STEP_CANCELLED`, `DECISION_RECORDED`) and
`EffectContext.emit` go through it. Their envelopes are unchanged: never stamped, never counted.
`WorkflowRuntime`'s own `EXECUTION_*` facts already bypass the context and are untouched.

### D2 — The guarantee: served when proven, appended otherwise

The skip decision is a pure function of LOGGED content and of the re-run's own emits. It never
depends on timing, interleaving or position. When the kernel cannot prove an emit replays a
logged one, it APPENDS. A duplicate is acceptable; a lost emit is not. This ruling is binding
(maintainer review, fix round 1).

### D3 — Emits are matched by a content digest

An emit's identity is its content:

- `d = fnv1a64(canonical JSON of [eventType, payload])`, where the canonical form is the
  PERSISTED JSON form (JSON.stringify semantics: `toJSON` applied, function/symbol/undefined
  members dropped) with object keys sorted.
- The run keeps a count of how many emits of each digest it has made so far, whether served or
  appended.
- The *n*-th emit of `d` (from 0) is **served** (nothing is appended) iff the log holds more than
  *n* stamped emits of `d`. Otherwise it is **appended**, and stamped `metadata.flowEmit = d`
  (D4 decides the stamp).

What this buys:

- **Interleaving cannot change the outcome.** Emits of identical content are interchangeable,
  so which one of them is served does not matter. The multiset of skip decisions per digest is
  the same under any ordering of concurrent branches. The reviewer's counterexample to ordinals
  is a committed test: a branch's `b-done` fires in a different place relative to a re-executing
  sibling step on every re-run, and `after` still appears exactly once.
- **Code changes append instead of displacing.**
  - A deploy that ADDS an emit before a gate produces a new digest, and it is appended once.
  - An EDITED emit is new content and is appended once. The old version stays in the log as what
    the old code emitted, which is not a loss.
  - A REMOVED emit simply is not re-made.
  - A REORDERED emit is still served.
- **A payload with no JSON form** (a BigInt, a cycle past the depth cap) has no digest. It is
  appended unstamped, on every re-run. This is a duplicate by design, because nothing can prove it
  was a replay.
- **Collisions.** A 64-bit collision between two different contents could serve one in place of
  the other. The probability is about k²/2^65 for k distinct emits in one execution, which is
  negligible at any realistic k. It is stated here rather than hidden.

Cost, measured on a heavily loaded machine (load average 300–500, so these numbers are upper
bounds):

- the digest of a ~300-byte payload: tens of µs;
- `fnv1a64` itself, after the limb rewrite (D6): ~14 µs per 314 bytes, against ~144 µs for the
  BigInt version it replaces, with bit-identical output.

### D4 — What gets STAMPED: an emit appended while none of the run's own effects or deciders is executing

The stamp decides whether an appended emit can serve a later re-run. That is the only place
in-flight state is consulted, and it can only ever REMOVE a stamp.

- An emit appended while one of this context's effects or deciders is executing may come from
  inside it. The documented case is a closure over `ctx`, such as the
  `chunkDeltas((t) => ctx.stream(...))` sink wired to an effect's `onDelta`.
- Such an emit does not recur when the step or decision is served on a re-run. Had it been
  stamped, it would sit in the log as an unmatched stamp, and a later, genuinely new emit of the
  SAME content would look already-logged. That is a loss, and a committed test pins it with an
  identical `ctx.ui.append` made inside an effect and again after a gate.
- So the emit is appended **unstamped**: it never serves anything.
- An effect counts as executing until the effect ITSELF settles, not until the step's deadline
  wins the race. A timed-out step's zombie effect that emits through the flow `ctx` is therefore
  unstamped too, and the next live emit of the same content is appended, not served. A test
  pins this.

Why this does not violate D2: the skip decision (D3) never reads in-flight state. Timing
decides only between "stamped" and "unstamped", and an unstamped emit can only cause a later
DUPLICATE, never a loss. The bounded cost: a flow-code emit caught in the window (made while
one of its own steps is still un-awaited) is appended once more on the next re-run that makes it
outside the window. It repeats on every re-run only if every re-run re-executes an overlapping
step (an untyped failure under legacy re-execution). A test pins the one-extra-copy case.

### D5 — The fold: one generic step, keyed on the stamp (EVENT_SCHEMA 1.19.0)

`foldEvents` gains ONE step outside the per-type handlers. When `event.metadata?.flowEmit` is a
16-hex digest, the fold increments `_flowEmits[d]`, for ANY event type. It has to be generic
because a flow-level emit is usually a domain event with no handler, and `SURFACE_PATCH` has none
either.

- **Structure.** `_flowEmits` is a fixed-depth, 16-way trie: 16-slot arrays indexed by the
  digest's last three hex digits, with `{ [digest]: count }` leaves.
  - A live commit is its own fold pass, so copy-on-write copies only the root-to-leaf path: three
    16-slot arrays and one leaf of about k/4096 entries.
  - A flat `{ [digest]: count }` map costs O(k) per live emit, and that is measured superlinear:
    ~1.9 ms per emit at k = 10 000.
  - Byte-bucketed maps were also measured and rejected, because object spread degrades once an
    object becomes a dictionary.
  - The trie measures flat: ~5 µs per stamped emit at k = 10 000 and k = 50 000.
  - Within a multi-event replay pass, fold-owned nodes are updated in place, which gives O(1)
    amortized (the `appendAudit` ownership rule).
- **Size.** One leaf entry per DISTINCT stamped emit, about 21 bytes of JSON each: roughly 210 KiB
  of snapshot for 10 000 distinct emits. That is less than the events themselves occupy in the
  log.
- A log that never stamps never gains the key, and replays byte-identically.
- The counts live in folded state, so they ride snapshots and survive `truncatePrefix` compaction.
  Committed tests check `fold(snapshot, suffix) == fold(events)` both after compaction and after
  a mid-run snapshot.
- `copyPrefix` (fork) merges fork provenance INTO the copied metadata, so the stamps survive, and
  a forked child serves its inherited prefix.
- `FOLD_VECTORS` gains a vector. A foreign fold that ignores envelope metadata fails it.

### D6 — `fnv1a64` gets its hot-path implementation

`@loom/core`'s `fnv1a64` said a faster formulation was "deferred until a hot-path caller exists".
Digesting every flow-level emit is that caller. It now uses four 16-bit limbs in plain Number
arithmetic, which works because the FNV prime is 2^40 + 0x1b3. The output is bit-identical, pinned
by a randomized differential test against the BigInt definition.

### D7 — Alternatives recorded

- **(rejected) Docs plus a 1P `emitOnce(ctx, key, type, payload)`**, backed by `decide` or a step.
  The ADR 0083 consumers would have been agent-surface, the composed-surfaces recipe and the
  ADR 0051 D4 finding emitters. It fixes only the call sites that remember to use it, leaves
  `ctx.ui` broken for everyone else, and puts a second replay mechanism in 1P beside the kernel's.
- **(rejected, shipped first and withdrawn in review) Ordinal matching**: emit *i* is served while
  *i* < a high-water mark, with in-flight emits left uncounted. Whether an emit was counted
  depended on scheduling, not on logged input. When a step that overlaps a later emit re-executes
  on a re-run, the ordinals shift, and a live emit after the gate was skipped FOREVER while an
  earlier one duplicated on every resume. A timed-out step's zombie and a deploy that added an
  emit lost emits the same way. The reviewer's counterexample is now a committed test.
- **(rejected) Ordinal plus a rolling digest**: keep ordinals, fold a rolling hash of the stamped
  prefix, and stop skipping at the first divergence. It detects divergence but cannot avoid it.
  A branch interleaving that differs on a re-run diverges at its first emit, so every later emit
  of that re-run is appended: a duplicate storm on exactly the concurrent flows the defect hits.
  Content matching has no prefix to diverge from.
- **(rejected) Anchoring each emit to the preceding completed syscall**. That is replay-stable
  only for a single sequential chain. With concurrent branches, the "preceding" syscall of a
  branch's emit is whichever sibling completed last, which is timing again. Making it stable would
  need per-branch causal identity (async context), and that is unavailable in the browser the
  kernel runs in.

### D8 — Legacy logs converge; no migration

Unstamped events do not count. An execution written before 1.19.0 therefore re-emits its
pre-resume emits once more on its next re-run, stamped this time, and is stable from then on.
No migration is needed. A test pins this.

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
- An emit's CONTENT is its identity. A flow that emits identical content more than once gets
  them served by count. A flow whose emits depend on unlogged data (a wall clock, a random
  number) produces new content on each re-run, so those emits are appended again. That flow was
  already non-deterministic under ADR 0057 and ADR 0061, and it now duplicates rather than
  loses.
- Duplicates remain possible and bounded (D3, D4, D8); a lost emit does not, except through a
  64-bit digest collision (D3).
- `KERNEL_ABI_VERSION` stays 1.1.0. `EVENT_SCHEMA_VERSION` 1.18.0 → 1.19.0 (additive: a fold key,
  no event kind, no payload field).
