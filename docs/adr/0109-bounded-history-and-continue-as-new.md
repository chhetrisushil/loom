# ADR 0109 — Bounded history for a long-lived execution: `ctx.continueAsNew`

- Status: **Accepted** (2026-10-07, R1b) — design approved after 4 review rounds (2026-10-05); implemented behind `kernel.features.continueAsNew`; the deviations and residuals are in "Implementation notes (as built)" at the end
- Date: 2026-10-05
- Closes: R1b (agentic-readiness audit, kernel appendix §2a/§6 gap 1)
- Builds on: [ADR 0052](0052-run-chaining-deferred-evidence-gate.md) (the frozen `rotate$` draft
  and its adversarial acceptance criterion, which this ADR adopts unchanged),
  [ADR 0051](0051-perpetual-agents-placement-schedule-remodel.md) (schedules over bounded runs,
  still the recommended model for a sentinel), [ADR 0103](0103-durable-bootstrap-for-caller-chosen-ids.md)
  (a caller-chosen id is a durable idempotent start), [ADR 0106](0106-compaction-integrity.md) and
  [ADR 0107](0107-compacted-fork-points-and-the-blank-stream.md) (what compaction does and does not
  keep), R1a (the quadratic fold and live-commit costs, already fixed).
- Amends on acceptance: ADR 0052 (D1's evidence gate is waived for Part R by the user's 2026-10-05
  ruling that a whitepaper-class workload counts; D2 becomes the specification below; D3 stands).
- Placement: **kernel** for the syscall, the terminal fact and the replay contract;
  **1P** (`@loom/orchestration`, `@loom/analytics`) for chain lineage queries and supervisor
  follow-through. Shares the single Wave 2 bump: **KERNEL_ABI 1.2.0 → 1.3.0**,
  **EVENT_SCHEMA 1.22.0 → 1.23.0** (design document §Version plan).
- Revision: round 3 — the successor-shape bypass is derived (parent log exists) and the successor start is a
  kernel-private method, not a `RunOptions` flag; chain identity is read through the fold. Round 2 — the `~` reservation is now a reserved **successor shape** on the root id segment, so
  supervised children of a continued parent (`chain~1::g#0`) still start (D2); cancel of a chain member
  reaches a started-but-uncommitted successor and a successor checks its predecessor was not cancelled
  (D2); the head is resolved with a successor probe in the start-to-commit window (D4); a fork of a chain
  member leaves the chain (D7). Round 1 (Opus review of PR #495) reversed the commit order of D2 (successor first, then the
  commit), added the `continued` status (D2), reserved `~` in caller ids (D2), and added D5 (children and
  the park barrier). Needs [ADR 0112](0112-structured-concurrency.md) (park barrier) and
  [ADR 0111](0111-durable-principal.md) first.

## Context

R1a removed the super-linear *constants* (decision fold, live commit, whole-log read per resume).
What is left is structural, and measured by `exp.cjs` in
[the readiness experiments](../requirements/2026-10-05-agentic-readiness-experiments/): a flow of
the shape `while (true) { msg = await ctx.suspend(...); await ctx.execute(step#i) }` re-runs its body
from the top on every resume (`WorkflowRuntime.execute` calls the runner; each syscall is served
from the fold), so the cost of turn *n* is O(n) even when every call is a cache hit, and the folded
state grows without bound and rides every snapshot:

- `frames` keeps one entry per step id, with both `input` and `output`
  (`replay-vm/src/eventHandlers.ts`, `STEP_STARTED` / `STEP_COMPLETED`);
- `_decisions`, `_resumePayloads`, `_outcomes`, `_resources` and the `_flowEmits` trie only grow;
- a snapshot is written at every suspend, so a 1.2 MB state at 6,000 turns is written per turn.

Compaction (ADR 0022/0106) truncates the LOG; it cannot truncate the fold, because the re-run needs
every recorded frame to short-circuit. A fold that is allowed to forget a frame is a flow that
re-executes the effect. So bounding history cannot be done by pruning inside one execution: it needs
a point at which the flow *chooses* what it carries and starts over.

ADR 0051/0052 deferred exactly this, on the argument that the blessed model for a sentinel is a
schedule of bounded runs, and that chaining was a primitive justified by a modelling choice the
framework recommends against. That argument holds for a sentinel. It does not hold for a
*conversational* or *multi-party* agent whose natural identity is one long conversation (R2, R17),
which is the Part R workload; and ADR 0052's two walls (stable addressability, an unrotatable
long-lived run) are both hit by it. The userland approximation ADR 0052 required first is
well-defined — deterministic successor id + idempotent start + supervisor + chain inbox — and fails
on one thing a supervisor cannot supply: making "this execution is over and its successor is owed"
a single durable fact.

## Decision

### D1 — One new syscall: `ctx.continueAsNew(carry)`

```ts
return ctx.continueAsNew({ summary, turn: 0 });   // never returns normally
```

`carry` is the successor's `input` (JSON, same bound and claim-check rules as any start input, plus a
kernel cap `maxCarryBytes`, default **1 MiB** (decided by the user, 2026-10-05; trade-off: the carry rides sequence 0 of the successor and every snapshot), refused with a typed error before anything is appended).
The call unwinds the runner with a kernel-private sentinel (like `SuspendError`), so nothing after it
runs. Preconditions, all refused with a typed error: the execution is running; no `ctx.parallel` scope is
open (R6); **no registered wait is outstanding** (a pending `select` in another branch is a park, not a
rotation point); and the **park barrier** (ADR 0112 D3) has drained every in-flight step, including steps
started outside a scope (a hand-rolled `Promise.all`). The wait is **unbounded and raises no refusal**:
a refusal that depended on how long a step took would be decided by the wall clock, and on a re-run (the
step now a cache hit) the same call would be accepted where the original was refused, so the replay would
diverge. The call waits exactly as `await p` would, and the steps' results are journaled as usual. So a continuation never
commits while a sibling of the predecessor can still append. Calling it from an effect is impossible by
construction (effects have no `ctx`).

There is no `shouldContinueAsNew()`. Temporal's suggestion flag is not replay-deterministic (it reads the
history length at the time of the call, which differs on every re-run); capturing it would need a
`decide`. A flow counts its own turns, which is a pure function of its logged state; `@loom/agent` ships
the 20-line helper (`continueEvery(n)`).

### D2 — Successor first, then the commit: `EXECUTION_CONTINUED`

The order is the reverse of the first draft, because of how recovery finds work. `recoverAbandoned` scans
only `running` / `pending` executions (`recoverAbandoned.ts`, the `state.status !== "running" && ...
"pending"` filter), and a predecessor that has already committed a terminal-looking event is never
revisited, so "commit first, successor second" had a crash window nothing repaired. Now:

1. **Start the successor** with the ADR 0103 durable idempotent start, at the deterministic id
   `successorId = <chainId>~<generation+1>` (the first execution of a chain is generation 0 and its id
   *is* `chainId`): `EXECUTION_STARTED { input: carry, chainId, generation, principal,
   continuedFrom: { executionId, carried } }`, where `carried` holds everything the successor inherits from
   the predecessor's fold (D3): running `_resources` totals, the inbox cursors and the dedupe window
   (ADR 0110 D6), and the absolute chain deadline.
2. **Commit** `EXECUTION_CONTINUED { successorId, chainId, generation }` to the predecessor, under the
   predecessor's fence. It carries no payload beyond the three names (the carry and the carried state are
   in the successor's sequence 0, once, not twice).

The predecessor therefore stays `running` until the commit. A crash after step 1 and before step 2 leaves
a running predecessor with a live successor; the existing `recoverAbandoned` re-drives the predecessor
(an in-flight execution replays under its pinned flow hash, K11), the replay reaches the same
`continueAsNew` with the same carry (everything it reads is in its own fold), the start is a no-op, and the
commit lands. **No new sweep and no `recoverContinuations()`**: the repair is the recovery that already
exists. Exactly one live successor exists after a crash at any point (ADR 0052's frozen criterion).

**Successor-id squatting.** ADR 0103 D2 treats any existing sequence 0 as a successful idempotent start, so
a caller who started `foo~1` first would be adopted as the successor. Two guards:

(a) **The successor SHAPE is reserved, not the character.** A caller-chosen id whose **LAST `::` segment**
matches `^.+~[0-9]+$` is refused at creation for every caller, whether or not any log exists: that is the id of
a chain's next generation, including a `::`-derived chain's (an orchestration child `parent::g#0` rotates to
`parent::g#0~1`, so `a::b~1` and `parent::g#0~1` are reserved; the first draft checked only the root segment and
left those squattable). A caller-chosen id whose **root segment** (the text before the first `::`, `SEP` in
`orchestration.ts:64-66`) matches the shape, and whose last segment does not, is the derived case below. Reserving `~` anywhere (the first draft) would have broken supervised children of a continued
generation: the successor `chain~1` spawns `awaitChild` children whose ids are `<parentId>::<key>#i` =
`chain~1::g#0`, and the supervisor starts them through `start()`, where `assertNotReserved` runs
(`WorkflowRuntime.ts:1570`, the id at 1569). Those ids have root segment `chain~1`, which is the successor
shape; so the check cannot be a blanket refusal. **It is derived, not flagged**: an id whose root segment has the
successor shape is accepted by `start` only if it contains `::`, the call is **trusted** (the supervisor's lineage grant, or the
system grant: an ordinary caller is refused without any read, so the refusal is the same whether or not the
parent exists and gives no existence oracle) **and its parent (the id up to the last `::`) already exists as a log**
(a point read of the parent's sequence 0). A bare `foo~1` has no parent, so
`start` always refuses it; `foo~1::x` is refused unless a `foo~1` log exists (which only the kernel can have
created); `chain~1::g#0` starts because `chain~1` exists. The kernel's own continuation start goes through
a **kernel-private method** (not `start`, not reachable from a `RunOptions`, the wire ABI, or a dispatcher
payload; no option or flag exists that a caller could set, so there is nothing to forge). The children of a
continued parent therefore need no bypass at all, and a caller's own `start("chain~1", …)` or
`start("chain~1::x", …)` with no such log is refused. (If the parent log has since been retention-deleted
the child start is refused, which fails closed.) A `~` that is not `~<digits>` at the end of the root segment (`a~b`, `a~1x`,
`a::b~x`) stays legal, so existing ids are not collateral. `assertNotReserved` (`WorkflowRuntime.ts:277`,
today refusing the `__loom_` prefix and the blank id) is called on resume paths too (`restoreFromState`
1448, `resume` 1765, `resumeAs` 2013), so the shape refusal is a creation-only variant applied where a
caller names a NEW id (`start`, line 1570; the fork child id, line 2324), never on resume of an existing one
(existing logs stay resumable; `cancel` at 1382 is unaffected). `chainId` is itself a caller id whose root
segment may not match the shape, so `<chainId>~<n>` is unambiguous. A caller starting `foo~1::x` under an
existing `foo~1` is not a new hazard: it is the same as a caller starting `foo::g#0` under `foo` today (the
supervisor adopts it idempotently, and `start` is authorized exactly as today). The parent-exists read is not
atomic with the child append; the worst case is a child of a later-deleted log, which is benign. The fork
child id (`WorkflowRuntime.ts` ~2324) goes through the same derived check, so `fork(…, "foo~3")` is refused.
(b) The continuation start verifies that an *existing* sequence 0 carries
`continuedFrom.executionId === predecessor`, and otherwise raises a typed `ContinuationConflictError`
instead of treating it as success.

**Cancel races the start-to-commit window.** Between step 1 and step 2 a successor exists while the
predecessor is still `running`. A cancel of the predecessor in that window would append
`EXECUTION_CANCELLED` (terminal; `recoverAbandoned` skips it), `EXECUTION_CONTINUED` would never commit, and
the successor would be an orphan that keeps running. Two closures, either sufficient and both required:
(i) **`cancel` of a chain member checks for a started successor** (a point read of `<chainId>~<gen+1>`
sequence 0, accepted only if its `continuedFrom.executionId` is this execution) and cancels it too, walking
forward to the newest verified generation (routed, D4), under the same authorization (one chain, one owner, ADR 0111, re-checked against the resolved head); (ii) **the
successor checks its predecessor on its first run** (and on every recovery re-drive before its first
effect): if the fold's chain identity (`continuedFrom.executionId`, read **through the fold**, which
prefers a fork's `forkChain` and so yields no `continuedFrom` for a fork) is `cancelled` it appends its own `EXECUTION_CANCELLED` with
`reason { kind: "cascade", parent: <predecessor> }` and stops. (ii) covers a cancel that lands after (i)'s
probe. Together a cancelled chain has no live generation. **Both checks and the head probe read chain identity
through the fold, never raw sequence 0:** a fork copies sequence 0 verbatim, and `forkChain` rides every
copied envelope's metadata (`forkMeta`, `WorkflowRuntime.ts:2441`), so a raw `continuedFrom` read would see
the original's predecessor on a fork of a chain successor and cascade-cancel the fork when that
predecessor is cancelled. Test: fork `chain~2`, cancel `chain~1`; the fork is not cancelled, and a head
probe of the fork resolves to the fork.

**Status.** `EXECUTION_CONTINUED` folds to a **new** `ExecutionStatus` value, `"continued"`, with the
reserved key `variables._continuedTo = successorId`. The first draft folded it to `completed`; that was
wrong, because several consumers read `completed` as "the flow returned an output" and would take the
absent output for the result. The consumers that must learn the value (all in this ADR's PR, found by
grep over `"completed"`/`"cancelled"` switches): `core/src/types/execution.ts` (`ExecutionStatus`);
`replay-vm` handlers; `workflow-runtime` (`WorkflowRuntime` `waitForCompletion` resolves `{ continuedTo }`,
`assertResumable` forwards, `LogLifecycle`'s `TERMINAL` set, `strayPassthroughs`, `blankStream`);
`orchestration` (its `TERMINAL` event set, `settle` and the status checks that return `"gone"`: a
continued child is *followed* to its head, not settled, D6); `analytics` (`analyze`, `introspect`,
`profile`), `learning` (`trajectories`, `types`), `compliance/eraseSubject`, `app/InProcessA2ABus`,
`worker-runtime-local`, `graph-executor`. `"continued"` is terminal for retention, and the predecessor may
be archived only because the successor's sequence 0 is durable *before* the commit. Widening a core union
is a source-level break for exhaustive switches over `ExecutionStatus`, so it is listed in the CHANGELOG
for the 1.23.0 bump.

**W2-0 (EVENT_SCHEMA 1.23.0) reserves the handler.** `EXECUTION_CONTINUED` folds only a
kernel-stamped envelope (`metadata.kernel: true`, stamped by the journal); an unstamped one is the no-op
an unknown kind always was, so a log in which an app already emitted that name replays byte-identically.
Chain identity is folded to `_chain = { chainId, generation, continuedFrom? }` (and `parent` to
`_parent`) from `EXECUTION_STARTED`, so "read through the fold" has a key to read. In W2-0 every consumer
above treats `continued` as terminal and not completed; a `continued` child is deliberately never
settled by the supervisor and `waitForCompletion { continuedTo }` is not yet implemented: following a
chain to its head lands with the writer (R1b).

Cross-stream atomicity is not required of the store, and no `EventStore` SPI changes: the fact that must
be atomic (the predecessor ending and naming its successor) is ONE event in ONE log, and the successor
start is made idempotent and *earlier*, so a crash can only leave a state the existing recovery repairs.

### D3 — The successor is a fresh execution on current code

The successor's `EXECUTION_STARTED` records the flow hash and code fingerprint (ADR 0113) of the code
registered *now*. A continuation is therefore the clean re-versioning point ADR 0052 described: no
months-old run stays pinned to a stale flow hash, no old closure has to ship in the binary forever, and
`resumeAs` + `transformState` is not needed for a deploy. The carry is the state contract; a flow that
changes its carry shape handles both shapes at start (the K11.5 contract validation on `input` applies).

**The fold applies the carry.** The successor's `EXECUTION_STARTED` handler seeds `_resources` and
`_inbox` from a **validated** `continuedFrom.carried` (so replay needs no runtime help), except when a
`forkChain` stamp is present (a fork starts a fresh chain, D7). *Validated* means each part is read
defensively: `resources` takes only finite non-negative numbers for the known dimensions and a valid
`custom` map (ADR 0115 rules); `inbox.cursors` takes only non-negative safe integers under non-reserved
topic names; `inbox.dedupe` takes only strings, last 1,024; `resources` also carries `exceeded`
(only `true`) and `reason` (only a string, only when `exceeded`), so a rotation cannot reset a quota; anything malformed is **ignored
deterministically and never thrown**, so every replica folds the same state from a log it did not
write. `chainDeadline` is not folded into a key of its own: it stays in `_chain.continuedFrom.carried`.

The successor inherits, from the predecessor's record and not from the caller: the principal (ADR 0111;
attenuation preserved, never widened), the tenant scope, the tags, `chainId`, and the `carried` block
(all inside the successor's own start event, D2). It does not inherit frames, decisions, resume payloads,
outcomes or `_flowEmits` — that is the point. Chain-level budgets are carried: `_resources` totals ride in
`continuedFrom.carried.resources`, so a rotation cannot reset a quota (a rotation that reset a quota
would be a quota bypass). The **flow deadline is absolute and carried**: the chain's deadline is fixed at
generation 0 (`carried.chainDeadline`, epoch ms) and every generation's own deadline is
`min(its flow deadline, chainDeadline)`, so continuing is not a way to outlive a deadline.

### D4 — The chain is addressable; the inbox is chain-scoped

`chainId` is the stable identity external parties address (ADR 0052 wall 1). `runtime.resume` and
`runtime.send` (ADR 0110) addressed to a continued execution resolve forward through `_continuedTo`
(ROUTED to the newest generation, see below), so a caller holding an old id is
not stranded; the authorization is judged against the **chain's owner** (ADR 0111), which every
generation inherits. ADR 0110's inbox stream is keyed by `chainId`; the successor resumes reading from the
cursors in `continuedFrom.carried.inbox`. The predecessor is quiescent at the commit point (D1: no
outstanding wait, barrier drained), so it cannot consume a message after the cursor snapshot: a message
appended at any time after the predecessor's last consumption is past the carried cursor and is delivered
to the successor exactly once, never dropped, never doubled. The **dedupe window** (the last
1,024 consumed message keys, ADR 0110 D6) is carried in the same block, so a sender retry
after a rotation is still deduplicated; it is bounded by the window size and is not counted against
`maxCarryBytes`. This satisfies ADR 0052 D2's chain-scoped inbox without a transfer of live suspensions
(ADR 0052 D3 stands). A continuation is legal only when nothing is parked, so there is no suspension to
transfer; the successor re-establishes its waits deterministically from the carry.

**The head in the start-to-commit window.** `_continuedTo` is set only when `EXECUTION_CONTINUED` commits, so
for the window between D2's step 1 and step 2 a walk of `_continuedTo` still ends at the *running*
predecessor, and a `send` (or ADR 0110's due-now notify row) would target a body that is about to stop and
will not consume it. Head resolution therefore does one more step at each hop whose target is `running` and
has no `_continuedTo`: **probe `<chainId>~<gen+1>` sequence 0** (O(1)) and follow it if present and its
`continuedFrom.executionId` matches. The residual is bounded: a message that still reaches the predecessor
is never lost, because it is in the chain's inbox stream (keyed by `chainId`, ADR 0110), the carried cursors
are snapshotted at the quiescence commit and the successor reads past them; and the successor's own
park-time re-read (ADR 0110 D5.2) catches anything that arrived after its start. Resolving to the
predecessor costs a wake, never a message.

### D5 — Outstanding children at the commit

A parent that continues cannot leave a child parked-on: the `CHILD_DONE` park belongs to the predecessor.
The default, in `@loom/orchestration`, is the R9k cascade: on `EXECUTION_CONTINUED` the supervisor cancels
the predecessor's non-terminal, non-`detached` children with `reason { kind: "cascade", parent }`, exactly
as for `EXECUTION_CANCELLED` (ADR 0112 D5). A child that must outlive the rotation is spawned `detached`
and its id travels in the `carry` (the successor then holds the handle and may `awaitChild` it, since the
supervisor follows `_continuedTo` for a continued child, D6). A flow that wants neither must finish its
children before calling `continueAsNew`.

### D6 — What stays 1P

- **Chain lineage queries** (`chain(executionId)`, generations, "current head"): a projection over
  `continuedFrom` / `_continuedTo`, in `@loom/analytics`. No SPI.
- **The supervisor** (`@loom/orchestration`) follows `_continuedTo` when a child's or a parent's id is
  continued (a `"continued"` status is "look at the head", never a settled result), and cascades per D5.
- **Retention.** The predecessor is an ordinary terminal execution; `LogLifecycle` archives or deletes it
  by the usual policy. `EXECUTION_CONTINUED` is a pinned kind (as ADR 0107's fork points), so a compacted
  predecessor still names its successor.

### D7 — Fork of a chain member leaves the chain

A fork copies the prefix `[0..atSequence]` verbatim (`copyPrefix`, `WorkflowRuntime.ts:2446`), sequence 0
included, so a fork of a chain member would inherit `chainId`, `generation` and `continuedFrom`. That makes
the fork a **second reader of the owner's chain inbox** (double consumption and cursor interference), lets a
caller with only `query` on the member and `start` obtain the owner's inbox payloads (a confidentiality
leak: ADR 0110 D5 copies payloads into the log), and, when the fork point is at or after
`EXECUTION_CONTINUED`, folds the fork to `continued` pointing at the real successor. So:

- A fork stamps `forkChain: { chainId: <the fork's own id>, generation: 0 }` into `forkMeta` (the channel
  that already carries `forkedFrom`, and ADR 0111 D7's `forkedBy`). The fold prefers it over the copied
  sequence-0 payload and **ignores `continuedFrom`** (so inherited `carried` cursors, dedupe window, chain
  deadline are not applied: the fork starts a fresh chain with an empty inbox). Rewriting sequence 0's
  payload is not needed and `copyPrefix` is unchanged.
- The fold reads `forkChain` from the **`EXECUTION_STARTED` envelope's metadata** (every copied envelope
  carries it, sequence 0 included) and folds `_chain = { chainId, generation }` from it, with no
  `continuedFrom` and no seeding from `carried`.
- A fork point **at or after `EXECUTION_CONTINUED`** is refused with a typed `ForkPastContinuationError`
  naming the successor (the caller can fork the successor instead); before it, the fork is ordinary and,
  when it re-runs to `continueAsNew`, starts `<fork-id>~1`.
- The fork's inbox is not the owner's: `send` to the fork's chain id reaches the fork alone.

### D8 — Replay contract, mixed fleets, tests

Replay of the predecessor never re-runs the successor start: a predecessor whose log ends in
`EXECUTION_CONTINUED` is `continued` (no body to re-run), and one that does not is re-driven by recovery
as in D2. Replay of the successor is an ordinary execution. A log with no `EXECUTION_CONTINUED` replays
byte-identically; nothing needs migrating.

Mixed-version fleets: a pre-1.23.0 kernel ignores the unknown kind and the new status, so it would see the
predecessor as still `running` (and, worse, re-drive it, which re-executes `continueAsNew` against an
existing successor: harmless under D2, but it would run effects it should not). The syscall therefore
throws `ContinueAsNewUnavailableError` unless `kernel.features.continueAsNew: true`, which an operator
turns on only once every node is on 1.23.0 (design document §3). A fleet rolling forward also meets
**mixed effect identity**: a node that predates R6 derives step ids for scoped branches differently from
one that has it; the flag covers this for continuations because the flag is the fleet-wide marker.

Tests: (1) the frozen DST criterion, in both crash points — kill between the successor start and the
commit, and before the start, with a message in flight; recover; assert exactly one live successor and
exactly one delivery; (2) `exp.cjs` with `continueEvery(500)`: per-resume latency flat from turn 500 to
20,000, snapshot size bounded; (3) negatives: a carry over `maxCarryBytes` refuses before any append; a
call inside an open scope, or with an outstanding wait, refuses (an in-flight step is awaited, never refused); **a caller cannot create `foo~1` or `foo~1::x` when no `foo~1` log exists (and no `RunOptions` field,
wire field or dispatcher payload field can change that), while a continued parent's children (`foo~1::x`
with `foo~1` present) start, and
`a~b` and `a::b~x` still start, `a::b~1` and `parent::g#0~1` are refused, and a pre-existing seq 0 whose `continuedFrom` names another execution raises
`ContinuationConflictError`; a continued parent (`chain~1`) spawning `awaitChild` children (`chain~1::g#0`)
works**; **cancel of the predecessor after the successor started (kill between start and commit, then
cancel) leaves no live successor (probe path), and a cancel that lands after the probe is caught by the
successor's first-run predecessor check**; **a `send` in the start-to-commit window resolves to the
successor and is delivered once**; **fork × chain: a fork of a chain member gets a fresh `chainId`,
generation 0 and no `continuedFrom`, does not consume the owner's inbox (a message sent to the owner is
delivered to the owner only, cursors unchanged), and cannot read the owner's inbox payloads; a fork point at
or after `EXECUTION_CONTINUED` is refused**; a second continuation
from a continued predecessor is a no-op; (4) children: non-detached cancelled on commit, detached
survives and its id in the carry is awaitable; (5) a chain deadline survives rotation; the dedupe window
survives rotation (a duplicate send after rotation is skipped); (6) every status consumer listed in D2
handles `continued` (a test per consumer, plus a type-level exhaustiveness check); (7) wire-abi fold
vectors for the new kind and status; (8) fold equality of every pre-existing vector unchanged.

## Rejected

- **Committing `EXECUTION_CONTINUED` first, then starting the successor** (the first draft): the
  predecessor is terminal-looking, so `recoverAbandoned` never revisits it, and it needed a new sweep to
  repair a crash window the reversed order does not have.
- **Folding `EXECUTION_CONTINUED` to `completed`**: consumers read `completed` as "returned an output".
- **Pruning frames inside one execution** (a fold that forgets completed frames): the re-run needs them to
  short-circuit; forgetting one re-executes its effect. A fold that keeps only `output` saves a constant
  factor, not the asymptote, and changes snapshot bytes for every execution; deferred until measured.
- **A `continueAsNew` that transfers live suspensions** (ADR 0052 D3, unchanged).
- **`EXECUTION_COMPLETED { continuedTo }`** (a payload field instead of a kind): a consumer that treats
  `EXECUTION_COMPLETED` as "the flow returned" would misread a continuation as an output.
- **A cross-stream transaction in the EventStore SPI**: unnecessary, see D2.
- **`continuedFrom.sequence`**: with the reversed order there is no commit sequence to point at.

## Consequences

- A perpetual or conversational agent has a bounded fold, a bounded snapshot and an O(carry) restart cost,
  at the price of an explicit carry the author must design.
- The kernel gains one syscall, one event kind, one status value, one reserved fold key and a reserved id
  shape; no SPI change and no new sweep. Recovery is the existing `recoverAbandoned`.
- ADR 0052's frozen criterion becomes a standing DST test rather than a paragraph.
- Ordering: R6 (barrier) and R3k (principal) land first; R2 (the inbox cursors) before the first
  inbox-using chain, though the syscall itself works without it.

## Implementation notes (as built, R1b, 2026-10-07)

What landed matches D1–D8; these are the places the build made a choice the text left open, or went beyond it.

**Placement of the pieces.** `packages/workflow-runtime/src/continuation.ts` holds the pure pieces (the sentinel,
the typed errors, `successorIdOf`, `chainOfState`, `carriedOf`, the successor-shape test). `ctx.continueAsNew` is
in `WorkflowContext`; the rotation (`rotate`), the kernel-private `startSuccessor`, head resolution
(`walkToHead`, `followToHead`), the cancel probe and the fork changes are in `WorkflowRuntime`. No `EventStore`,
`SnapshotStore`, dispatcher or wire change; EVENT_SCHEMA stays 1.23.0 (every shape was frozen at W2-0) and
KERNEL_ABI stays 1.3.0 with `continueAsNew` now in `KERNEL_SYSCALLS`.

**D1.** Every refusal (flag off, open `parallel` scope, outstanding wait, a
carry with no JSON form, over `maxCarryBytes`, a carry failing `validateInput`) is raised BEFORE anything is
frozen or appended, so the flow may catch it and carry on (an in-flight step is not a refusal: the call awaits the set to drain, unbounded, and does not freeze until it has; fix round 1). An accepted call freezes new step starts, rejects a second
kernel promise (`continueSignal`, raced beside `parkSignal` in `run`), then throws the sentinel: a flow that
swallows the sentinel still rotates, and a second call is the same rotation. The carry is JSON-normalised once
(what the predecessor's re-drive computes is what the successor starts with). A **tainted** value in the carry
keeps its taint (the wrapper is plain JSON), so untrusted content does not launder through a rotation. A
`parallel` call counts as open from its first await to its last (a hand-rolled `Promise.all([ctx.parallel(..),
ctx.continueAsNew(..)])` is refused), and a call from inside a branch is refused through its scope.

**D2.** The order is as specified. The successor start (`startSuccessor`) is `writeBootstrap` (ADR 0103) at the
deterministic id; an existing sequence 0 is adopted iff its `continuedFrom.executionId` is the predecessor,
else `ContinuationConflictError`, which FAILS the predecessor (`EXECUTION_FAILED`) with the typed error. A storage
failure before the successor is durable leaves the predecessor `running` and rejects its handle: recovery
re-drives it. **Head resolution is ROUTED** (user decision, round 2): `resume`, `send`, `cancel`, `followToHead` and the 1P
followers (supervisor, `LocalWorkerRuntime`) resolve ANY generation's id to the chain's newest generation, so the
first id stays addressable forever. `routeToDeepest` gallops + bisects over the deterministic ids
`<chainId>~<n>` (O(log n) point reads, measured: a 200-generation chain resolves in under 60 store reads), then
VERIFIES the candidate: its sequence 0 is the verified successor of generation n-1 (`isVerifiedSuccessor`: the
deterministic id, names its predecessor, next generation of the same chain, same parent and principal) and records
the same lineage and owner as the addressed id. A candidate that fails verification (a squatter written straight to
the store) is never routed to: the walk falls back to stepping VERIFIED links from the addressed id. The caller is
authorized against the ADDRESSED id first (an unauthorized caller causes no chain read) and again against the
resolved head's recorded owner before acting. `maxChainHops` (default 8, config unchanged) now bounds only the
RESIDUAL forward stepping after the jump (the start-to-commit window, or the fallback walk); past it the refusal is
`ChainHopLimitError` naming the furthest id reached. There is no `unbounded` option: system followers use the same routing. The start-to-commit probe (`<chainId>~<generation+1>` sequence 0, accepted only when
its `continuedFrom` names the id) runs in `send`, `walkToHead` and `cancel` and only with the flag on. The
successor-shape reservation (`assertCreatable`: `start` with a caller id, `fork`'s child id) applies **whether
or not the flag is on** (an app that used `task~1` as an id must rename it: CHANGELOG); resume paths and
`cancel` of an existing id are unaffected. **Cancel:** `cancel(id)` of a live or stored chain member also
cancels a successor started in the window (probe), `cancel` of a `continued` member cancels the chain's live
generation (it is no longer a no-op: the one-chain, one-owner rule authorizes it once), a live predecessor
whose commit is already journaled ignores a late cancel (`rotated`) so nothing follows `EXECUTION_CONTINUED` in
its log (the successor is cancelled instead), and `rotate` re-checks `cancelled` after the start and cancels the
successor it just started. The successor's first-run check (`predecessorCancelled`) runs on a fresh start and on
a recovery re-drive (entry status `pending` / `running`), never on a resume from a park.

**D3.** `chainDeadline` is fixed at generation 0 (`startedAt + deadlineMs`, from the option or the flow
definition) and carried unchanged; each generation arms `min(its flow deadline, chainDeadline - its startedAt)`. A
parked execution holds no deadline timer (it re-arms on resume, "resuming past the deadline cancels
immediately", an existing rule), so a parked successor is cancelled at its next resume, not at the instant.
`validateInput` applies to the carry as the successor's input, before anything is appended. The kernel has no
`tags`, so there is nothing to inherit; tenant scoping rides the store decorator both generations share.
The successor also inherits `parent` (lineage) and the placement hint `computeTarget` from the predecessor's
sequence 0.

**D4.** `resume` addressed to a continued id resolves forward (after the authorization against that id's owner,
which every generation inherits) and re-enters itself on the head; the head authorizes again against the same
owner. `ResumeEvent` is unchanged.

**D5.** The cascade on `EXECUTION_CONTINUED` was built with R6 (`@loom/orchestration`); R1b adds its tests: an
attached child is cancelled with a `{ kind: "cascade", parent }` reason and a detached one survives. A parked
parent cannot continue, so the case is a child whose park the operator answered by hand. **D6:** the supervisor
keeps a `followed` map (successor id -> the child id the parent's park names); a continued child's successor's
terminal event settles the ORIGINAL slot, any number of rotations, live; `settledOf` (`adopt`, `recover`,
`reconcileGroup`) follows the chain to its newest generation (`followToHead`, routed) and registers the furthest running head. `LocalWorkerRuntime`
follows to the head (a live handle when the runtime drives it, else the log) and reports the HEAD's outcome under
the dispatched id; `ExecutionOutcome` is NOT widened (no dispatcher or worker SPI change), the follow is routed (a flow that rotates
ten times and completes is a `completed` dispatch), and an unreadable or unverifiable chain stays the fail-safe
`failed`, never `completed`. `@loom/analytics` gains `chainLineage(events, id)` (a pure
projection; chain identity read through the fold's rules, a fork is its own chain). `@loom/agent` gains
`continueEvery(n)` (the turn counter; created inside the flow body, per generation).

**D7.** A fork of a chain member is detected from the parent's FOLDED `_chain` (the snapshot, no read) or its
sequence 0 (when there is no snapshot the window starts at 0 anyway). It stamps
`forkChain: { chainId: <fork id>, generation: 0 }` on every copied envelope, and folds its seed state from the
RESTAMPED prefix read from sequence 0 (a parent snapshot carries the seeded carry, which the fork must not have),
so a compacted chain member refuses with `CompactedForkPointError`. A fork of an ordinary execution is
byte-identical to before (no stamp, no extra read; the E5 read-count tests are unchanged).
`ForkPastContinuationError` is decided from what the fork already reads (the window, or the snapshot's folded
status): it costs no extra read, and names the successor.

**D8.** The frozen DST criterion is a sweep (`r1b-crash.test.ts`): a kill at EVERY append of a two-generation
conversation, a reboot, the existing `recoverAbandoned` and `TimerService`, and the same end state each time (one
successor, one `EXECUTION_CONTINUED`, both messages exactly once). Each consumer of the `continued` status has a
test beside its code: replay-vm (the fold), workflow-runtime (`LogLifecycle` retention, `strayPassthroughs`,
`blankStream`, `resume`/`send`/`cancel`/`fork`, `waitForCompletion`), orchestration, `LocalWorkerRuntime`,
`InProcessA2ABus`, analytics (`analyze`, `introspect`, `chainLineage`), learning, compliance (`eraseSubject`),
audit-chain (the head cache), telemetry, DST invariants and the CLI timeline. The `ExecutionStatus` union is
pinned by a test (a type-level exhaustiveness check cannot run in vitest).

**Fix round 1 (first adversarial review).**
(1) **`restoreFromState` cannot forge a successor.** The successor's principal, `parent`, chain identity, chain
deadline, resource totals and inbox seed are read by `startSuccessor` from the predecessor's DURABLE log (sequence 0
folded through the fold's own rules, plus the durable fold for the running totals), after `journal.drain()`, never
from the running execution's fold (which, under `restoreFromState`, began as caller-supplied). And
`restoreFromState` overwrites the reserved IDENTITY keys of the supplied state (`_principal`, `_chain`, `_parent`,
`_continuedTo`) with what sequence 0 records (dropped when it records nothing). `_resources` / `_inbox` are NOT
overwritten there (they legitimately move with the run, and a rotation no longer reads them from the vm).
(2) **Every follower walks VERIFIED links only** (`isVerifiedSuccessor`, shared by `walkToHead`, `cancelForward`,
`sendTarget` and the start-to-commit probe): the successor's sequence 0 must sit at `<chainId>~<generation+1>`, name
the hop it came from, be the next generation of the same chain, and record the same `parent` and principal. A
pointer at a foreign or squatted id ends the walk at the last verified member (nothing is resumed, cancelled or
leaked across it).
(3) **The last `::` segment is reserved** (D2 (a)); only the supervisor (lineage / system grant) may start a
`::`-child of a successor-shaped ROOT, and an untrusted caller causes no read (no existence oracle).
(4) **Every walk is routed to the newest generation (round 2 supersedes round 1's `unbounded` option).** See D2's
"Head resolution is ROUTED". The supervisor registers the FURTHEST id reached so a later rotation advances it.
(5) **`continueAsNew` never refuses on timing**: the drain is unbounded and `parkDrainMs` no longer applies to a
continuation (it still bounds a PARK). (6) `send` authorizes against the addressed id's owner before any walk, and
names the head of a hop-limit refusal lazily, after authorization. (7) A fork of a chain member keeps the carried
`_resources` seed (a carried `exceeded` quota is not shed by forking); only chain membership and the inbox are dropped.

**R11 carry-over.** `recordOutcome` accepts `continued` (ADR 0116 D1, amended): the decision lives in THAT
generation's own log, so the outcome is attached to the id the caller named, never to the head. **Fixed on the
way:** a run whose cancel landed before its flow returned (a deadline already past when a parked execution is
resumed, with a flow that returns without a step) appended `EXECUTION_COMPLETED` AFTER `EXECUTION_CANCELLED`; the
cancel now owns the outcome.

**Measured acceptance** (`docs/requirements/2026-10-05-agentic-readiness-experiments/exp-r1b.cjs`, the
`exp.cjs` message loop; this machine, in-memory stores, `snapshotEvery: 50`):

| turns | rotate every | per-resume at the last turn | total | head state (JSON) | log events of the head |
|---|---|---|---|---|---|
| 6 000 | never | 4.6-6.0 ms (0.5 ms at turn 1 000) | 8.3 s | 1 272 768 bytes | 30 002 |
| 6 000 | 500 | 0.04 ms flat (0.3 ms on a rotating turn) | 0.74 s | at most 85 KB (one generation) | 2 |
| 20 000 | 500 | 0.034-0.046 ms flat from turn 1 000 to 19 000 | 2.4 s | at most 86 KB | 2 |

Per-turn cost and folded state are bounded by the rotation interval, whatever the turn number; the runner
re-runs once per turn in both cases (the re-run is over one generation).

**Residuals.** (1) If the deepest log fails verification AND the chain is longer than `maxChainHops` beyond the
addressed id, the fallback verified walk refuses with `ChainHopLimitError` (it never routes to an unverified log). (2) The kernel has
no rate limit on rotation: a flow that calls `continueAsNew` without ever consuming anything is a runaway chain
(one successor per call, immediately); a flow rotates on a count or a size. (3) A parked successor is not
cancelled at its chain deadline until it next resumes (the existing rule for any parked execution). (4) A
compacted chain member cannot be forked (its prefix is read from sequence 0). (5) The mixed-fleet rule is the
flag: turn `kernel.features.continueAsNew` on only once every node folds `EXECUTION_CONTINUED`.
