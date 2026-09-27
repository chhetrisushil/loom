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
   review showed it was wrong (D7). So did a pure content match, which a re-run that does not
   reproduce an earlier stamp can fool. The shipped rule serves only what logged facts prove
   (D2), and states its exact residual.

## Decisions

### D1 — Split the paths: the kernel's facts never count

`WorkflowContextImpl` gains a private `commit(eventType, payload)` with the old behaviour.
Every kernel-internal fact in `WorkflowContext.ts` (`EFFECT_INDOUBT`, `STEP_STARTED`,
`STEP_COMPLETED`, `STEP_FAILED`, `STEP_CANCELLED`, `DECISION_RECORDED`) and
`EffectContext.emit` go through it. Their envelopes are unchanged: never stamped, never counted.
`WorkflowRuntime`'s own `EXECUTION_*` facts already bypass the context and are untouched.

### D2 — The guarantee: served only when the log proves it, appended otherwise

The kernel serves an emit (appends nothing) only when LOGGED facts prove it is a replay. When they
don't, it appends: a duplicate is acceptable, and a lost emit is not. This ruling is binding
(maintainer review, fix rounds 1 and 2).

**Proven replay.** On a re-run, the *n*-th emit (counting from 0) of identity
`(segment, eventType, payload)` is served iff BOTH hold:

1. the log holds more than *n* STAMPED emits of that identity; and
2. no syscall of the current segment has been executed LIVE in this run. That means every step
   and every decision so far in the segment was served from the log. Whether a syscall is served
   is decided by the log, not by timing.

**Stamp.** An appended emit is stamped, so that it can serve a later re-run, only when:

- it goes beyond the logged count;
- none of this context's effects or deciders is executing (D4); and
- nothing earlier in THIS run ended unsettled. Unsettled means an outcome a re-run does not serve:
  an untyped failure, a timeout, a cancellation, an in-doubt park, or a decider that threw.

So a stamp exists only for an emit whose path a re-run reproduces from logged facts, and a
stamp can serve only its own re-emission.

**Residual loss condition (exact).** An emit is served in place of a new one only when the
re-run does not reproduce a stamped emit of the same content in the same segment AND no syscall
before it in that segment is live. Under the determinism contract (ADR 0057 gate order, ADR 0061
step identity: the sequence of syscalls is a pure function of logged inputs), that happens only
when:

- (a) **a code change** moves or replaces an emit of identical content within one gate segment
  whose syscalls are all served. The segment's log then already holds that content the number of
  times the new code emits it; a committed test pins this outcome;
- (b) **flow code violates the determinism contract**, for example by branching on a clock or a
  random number before an emit; or
- (c) **a 64-bit digest collision**, with probability about k²/2^65 for k distinct emits.

**Duplicates that remain (bounded, never a loss):**

- an emit in a segment where a step re-executes, or after an unsettled outcome, is appended again
  on each re-run that re-executes it. Declaring the failure channel (ADR 0060) makes such steps
  served, and the emits converge;
- an emit appended while one of the run's own effects or deciders is executing is appended once
  more on the next re-run that makes it outside that window;
- a payload with no JSON form is appended on every re-run;
- a pre-1.19.0 log re-emits its prefix once (D8);
- a deploy that edits an emit appends the new content, and the old content stays in the log.

### D3 — Identity: a content digest scoped by gate segment

`d = fnv1a64(segment | canonical JSON of [eventType, payload])`.

- **The canonical form** is the PERSISTED JSON form (JSON.stringify semantics: `toJSON` applied,
  function, symbol and undefined members dropped) with object keys sorted. A `Map` or `Set` has
  no enumerable keys and canonicalises to `{}`. That is harmless, because it also persists as
  `{}`.
- **The segment** is the number of gate passthroughs the run had consumed at the emit. It is the
  same counter `suspend` uses to match gates ordinally (ADR 0057), so it is a function of the
  log, not of timing. Scoping by segment makes each turn of a long-lived session (ADR 0081)
  independent: a `ui.increment` in turn 3 is never compared with one in turn 1. It also means a
  deploy that removes an emit in one segment and emits the same content in a later segment
  appends the new one.
- **Why content and not position.** Emits of identical content are interchangeable, so the set
  of skip decisions per identity does not depend on how concurrent branches interleave. The
  round-0 ordinal design lost emits on exactly that (D7).
- **A payload with no JSON form** has no digest. It is appended unstamped every time.

Cost, measured on a heavily loaded machine (so upper bounds): tens of µs for the digest of a
~300-byte payload; `fnv1a64` itself ~14 µs per 314 bytes after the D6 rewrite, against ~144 µs
for BigInt.

### D4 — Two run-local guards, both decided by the log, and the in-flight window

- **The live guard** (`segmentLive`) is set when a step is NOT served (it passes the completed
  and typed-failure short-circuits) or when a decider is actually invoked. It is reset at the
  next gate passthrough.
  - Once it is set, nothing later in the segment is served, because the run has left what the
    log proves.
  - Under concurrency it can only add duplicates: an emit that races ahead of the live syscall is
    still served only if condition 1 of D2 proves it.
- **The unsettled flag** is set when a step or decider of this run ends in an outcome a re-run
  does not serve. It is sticky for the rest of the run, across segments, because a later
  segment's path may depend on that outcome, and the next re-run can re-execute the step and take
  a different path. Every emit appended after it is left unstamped.
  - This is what closes the reviewer's round-2 counterexample: an untyped transient failure's
    `ui.increment` used to be stamped and then absorbed a later, genuinely new increment.
- **The in-flight window.** An emit appended while this context's effects or deciders are
  executing is appended unstamped. It may come from inside them, as a closure over `ctx` does
  (the `chunkDeltas((t) => ctx.stream(...))` + `onDelta` pattern), and such an emit does not recur
  when the step is served.
  - An effect counts as executing until the effect ITSELF settles, not until its deadline wins
    the race, so a timed-out step's zombie is covered.
  - Timing therefore decides only between "stamped" and "unstamped", and an unstamped emit can
    only cause a later duplicate.
- **Mutation-checked.** Each guard has a committed test that fails without it:
  - live guard: a deploy inserts a live step before identical content;
  - unsettled flag: the reviewer's P2, and the timeout zombie;
  - segment scope: a deploy removes an emit and re-emits the content in a later segment;
  - in-flight window: identical content emitted inside an effect and inside a decider.

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
- **Size.** One leaf entry per DISTINCT stamped identity, about 21 bytes of JSON each, summed
  over segments: roughly 210 KiB of snapshot for 10 000.
  - Growth is driven by how many distinct flow-level emits a flow makes, which in practice means
    the granularity of flow-level `ctx.stream` chunks. Emits made inside effects are never
    stamped, so they add nothing.
  - Segment scoping adds one entry per turn for content repeated every turn.
  - Old segments' counts CANNOT be dropped: a re-run starts from the top and replays every
    segment, and each segment's emits must still be served. Dropping them would re-append a whole
    session's history on the next resume. The bound is the log itself: the counts are never
    larger than the stamped emits they describe.
- A log that never stamps never gains the key, and replays byte-identically.
- The counts live in folded state, so they ride snapshots and survive `truncatePrefix`
  compaction. Committed tests check `fold(snapshot, suffix) == fold(events)` both after
  compaction and after a mid-run snapshot.
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
- **(rejected, shipped in fix round 1 and tightened in round 2) Pure content matching**,
  global and unscoped. A stamp the re-run does not reproduce absorbs a later, genuinely new emit
  of the same content. The reviewer's P2 shows it: an untyped transient failure's
  `ui.increment` swallowed a later step's increment on every resume. It is fixed by D2's gate
  segment, live guard and unsettled rule, each pinned by a test that fails without it.
- **(rejected) Ordinal plus a rolling digest**: keep ordinals, fold a rolling hash of the stamped
  prefix, and stop skipping at the first divergence. It detects divergence but cannot avoid it.
  A branch interleaving that differs on a re-run diverges at its first emit, so every later emit
  of that re-run is appended: a duplicate storm on exactly the concurrent flows the defect hits.
  D2's live guard is the part of this idea that survives, keyed on served-versus-live syscalls
  (a fact of the log) instead of on emit order (a fact of timing).
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
- An emit's CONTENT, within its gate segment, is its identity. A flow that emits identical
  content more than once in a segment gets them served by count. A flow whose emits depend on unlogged data (a wall clock, a random
  number) produces new content on each re-run, so those emits are appended again. That flow was
  already non-deterministic under ADR 0057 and ADR 0061, and it now duplicates rather than
  loses.
- Duplicates remain possible and bounded (D2). The exact residual loss conditions are D2 (a),
  (b) and (c).
- `KERNEL_ABI_VERSION` stays 1.1.0. `EVENT_SCHEMA_VERSION` 1.18.0 → 1.19.0 (additive: a fold key,
  no event kind, no payload field).
