# ADR 0109 — Bounded history for a long-lived execution: `ctx.continueAsNew`

- Status: **Proposed** (2026-10-05) — design approved after 4 review rounds; Accepted per item at implementation
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
started outside a scope (a hand-rolled `Promise.all`), bounded by `parkDrainMs`. So a continuation never
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

(a) **The successor SHAPE is reserved, not the character.** A caller-chosen id whose **root segment**
(the text before the first `::`, `SEP` in `orchestration.ts:64-66`) matches `^.+~[0-9]+$` is refused at
creation. Reserving `~` anywhere (the first draft) would have broken supervised children of a continued
generation: the successor `chain~1` spawns `awaitChild` children whose ids are `<parentId>::<key>#i` =
`chain~1::g#0`, and the supervisor starts them through `start()`, where `assertNotReserved` runs
(`WorkflowRuntime.ts:1570`, the id at 1569). Those ids have root segment `chain~1`, which is the successor
shape; so the check cannot be a blanket refusal. **It is derived, not flagged**: an id whose root segment has the
successor shape is accepted by `start` only if it contains `::` **and its parent (the id up to the last
`::`) already exists as a log** (a point read of the parent's sequence 0). A bare `foo~1` has no parent, so
`start` always refuses it; `foo~1::x` is refused unless a `foo~1` log exists (which only the kernel can have
created); `chain~1::g#0` starts because `chain~1` exists. The kernel's own continuation start goes through
a **kernel-private method** (not `start`, not reachable from a `RunOptions`, the wire ABI, or a dispatcher
payload; no option or flag exists that a caller could set, so there is nothing to forge). The children of a
continued parent therefore need no bypass at all, and a caller's own `start("chain~1", …)` or
`start("chain~1::x", …)` with no such log is refused. (If the parent log has since been retention-deleted
the child start is refused, which fails closed.) A `~` that is not `~<digits>` at the end of the root segment (`a~b`, `a~1x`,
`a::b~1`) stays legal, so existing ids are not collateral. `assertNotReserved` (`WorkflowRuntime.ts:277`,
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
forward at most `maxChainHops`, under the same authorization (one chain, one owner, ADR 0111); (ii) **the
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

Cross-stream atomicity is not required of the store, and no `EventStore` SPI changes: the fact that must
be atomic (the predecessor ending and naming its successor) is ONE event in ONE log, and the successor
start is made idempotent and *earlier*, so a crash can only leave a state the existing recovery repairs.

### D3 — The successor is a fresh execution on current code

The successor's `EXECUTION_STARTED` records the flow hash and code fingerprint (ADR 0113) of the code
registered *now*. A continuation is therefore the clean re-versioning point ADR 0052 described: no
months-old run stays pinned to a stale flow hash, no old closure has to ship in the binary forever, and
`resumeAs` + `transformState` is not needed for a deploy. The carry is the state contract; a flow that
changes its carry shape handles both shapes at start (the K11.5 contract validation on `input` applies).

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
(bounded walk, `maxChainHops` 8, then a typed refusal naming the head), so a caller holding an old id is
not stranded; the authorization is judged against the **chain's owner** (ADR 0111), which every
generation inherits. ADR 0110's inbox stream is keyed by `chainId`; the successor resumes reading from the
cursors in `continuedFrom.carried.inbox`. The predecessor is quiescent at the commit point (D1: no
outstanding wait, barrier drained), so it cannot consume a message after the cursor snapshot: a message
appended at any time after the predecessor's last consumption is past the carried cursor and is delivered
to the successor exactly once, never dropped, never doubled. The **dedupe window** (the last
`inboxDedupeWindow` consumed message ids, ADR 0110 D6) is carried in the same block, so a sender retry
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
call inside an open scope, or with an outstanding wait, or with an in-flight step past `parkDrainMs`
refuses; **a caller cannot create `foo~1` or `foo~1::x` when no `foo~1` log exists (and no `RunOptions` field,
wire field or dispatcher payload field can change that), while a continued parent's children (`foo~1::x`
with `foo~1` present) start, and
`a~b` and `a::b~1` still start, and a pre-existing seq 0 whose `continuedFrom` names another execution raises
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
