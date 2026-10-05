# ADR 0109 — Bounded history for a long-lived execution: `ctx.continueAsNew`

- Status: **Proposed** (2026-10-05)
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

`carry` is the successor's `input` (JSON, same bound and claim-check rules as any start input,
plus a kernel cap `maxCarryBytes`, default 1 MiB, refused with a typed error before anything is
appended). The call unwinds the runner with a kernel-private sentinel (like `SuspendError`), so
nothing after it runs. It is legal only while the execution is running and not inside an open
`ctx.parallel` branch (R6): a scope with in-flight siblings is a park-barrier question, not a
rotation point. Calling it from an effect is impossible by construction (effects have no `ctx`).

There is no `shouldContinueAsNew()`. Temporal's suggestion flag is not replay-deterministic (it
reads the history length at the time of the call, which differs on every re-run); capturing it
would need a `decide`. A flow counts its own turns, which is a pure function of its logged state;
`@loom/agent` ships the 20-line helper (`continueEvery(n)`).

### D2 — One terminal fact: `EXECUTION_CONTINUED`

The kernel appends, in this order, **under the predecessor's fence**:

1. `EXECUTION_CONTINUED { successorId, carry, chainId, generation, inbox? }` to the predecessor.
   It folds to `status: "completed"` with the reserved key `variables._continuedTo = successorId`
   (no new `ExecutionStatus`, so every status switch in the tree stays total). `waitForCompletion`
   resolves with `{ continuedTo }`.
2. Then starts the successor: `EXECUTION_STARTED { input: carry, continuedFrom: { executionId,
   sequence }, chainId, generation, principal }` at the deterministic id
   `successorId = <chainId>~<generation+1>` (the first execution of a chain is generation 0 and its
   id *is* `chainId`). The start is an ADR 0103 durable idempotent start: a second attempt to
   write sequence 0 of that id is a no-op.

Step 1 is the commit point; step 2 is a consequence the kernel owes. A crash between them leaves a
predecessor that says "continued" and no successor. `recoverAbandoned` (and a new
`runtime.recoverContinuations()` sweep, same cursor machinery) finds such predecessors — a terminal
`EXECUTION_CONTINUED` whose `successorId` has no log — and performs step 2. Because the successor
id is deterministic and the start idempotent, **exactly one live successor exists after a crash at
any point**, which is ADR 0052's frozen acceptance criterion; D6 turns it into the DST test.

Cross-stream atomicity is not required of the store, and no `EventStore` SPI changes: the fact that
needs to be atomic (the predecessor ending, naming its successor and carrying its state) is ONE
event in ONE log.

### D3 — The successor is a fresh execution on current code

The successor's `EXECUTION_STARTED` records the flow hash and code fingerprint (ADR 0113) of the
code registered *now*. A continuation is therefore the clean re-versioning point ADR 0052 described:
no months-old run stays pinned to a stale flow hash, no old closure has to ship in the binary
forever, and `resumeAs` + `transformState` is not needed for a deploy. The carry is the state
contract; a flow that changes its carry shape handles both shapes at start (the K11.5 contract
validation on `input` already applies).

The successor inherits, from the predecessor's record and not from the caller: the principal
(ADR 0111; attenuation preserved, never widened), the tenant scope, the tags, and `chainId`. It does
not inherit frames, decisions, resume payloads, outcomes, resources or `_flowEmits` — that is the
point. `RESOURCE_METERED` totals are chain-level budget questions: the kernel carries the running
`_resources` totals inside the continuation (`EXECUTION_CONTINUED.resources`), so a per-chain budget
or quota is not reset by rotating (a rotation that reset a quota would be a quota bypass). The flow
deadline is not carried (D3 open question in the design doc).

### D4 — The chain is addressable; the inbox is chain-scoped

`chainId` is the stable identity external parties address (ADR 0052 wall 1). `runtime.resume` and
`runtime.send` (ADR 0110) addressed to a continued execution resolve forward through
`_continuedTo` (bounded walk, `maxChainHops` 8, then a typed refusal naming the head) so a caller
holding an old id is not stranded. ADR 0110's inbox stream is keyed by `chainId`, and the successor
resumes reading it from the cursors the predecessor recorded in `EXECUTION_CONTINUED.inbox`; a
message appended between D2 step 1 and step 2 is delivered to the successor exactly once, never
dropped, never doubled. That is the "chain-scoped inbox" requirement of ADR 0052 D2, satisfied
without a transfer of live suspensions (ADR 0052 D3 stands: identity-preserving suspension transfer
stays rejected). A continuation is legal only when nothing is parked, so there is no suspension to
transfer; the successor re-establishes its waits deterministically from the carry.

### D5 — What stays 1P

- **Chain lineage queries** (`chain(executionId)`, listing generations, "current head"): a
  projection over `continuedFrom` / `_continuedTo`, in `@loom/analytics`. No SPI.
- **Children and the supervisor.** The kernel does not know about children. The supervisor
  (`@loom/orchestration`) follows `_continuedTo` when a child's or a parent's id is continued, and
  a parent may not `awaitChild` across its own continuation: the park is on the predecessor, which
  cannot be parked while it continues (D1).
- **Retention.** The predecessor is an ordinary terminal execution; `LogLifecycle` archives or
  deletes it by the usual policy once its successor's sequence 0 is durable. The
  `EXECUTION_CONTINUED` event is a pinned kind (the same mechanism as ADR 0107's fork points), so a
  compacted predecessor still names its successor.

### D6 — Replay contract and tests

Replay of the predecessor never re-runs the successor start: `EXECUTION_CONTINUED` is terminal in
the fold, and a re-driven predecessor whose log ends in it is "completed" (there is no body to
re-run). Replay of the successor is an ordinary execution. A log with no `EXECUTION_CONTINUED`
replays byte-identically, so in-flight executions are unaffected and nothing needs migrating.

Mixed-version fleets: a pre-1.23.0 kernel's fold ignores the unknown kind, so it would see the
predecessor as still `running`. The syscall therefore throws `ContinueAsNewUnavailableError` unless
the runtime is configured with `kernel.features.continueAsNew: true`, which an operator turns on
only once every node is on 1.23.0 (design document, open question 1).

Tests: (1) the frozen DST criterion — kill the worker between the `EXECUTION_CONTINUED` commit and
the successor start with a message in flight; recover; assert exactly one live successor and exactly
one delivery; (2) `exp.cjs` with `continueEvery(500)`: per-resume latency flat from turn 500 to
turn 20,000, snapshot size bounded; (3) negative: a carry over `maxCarryBytes` refuses before any
append; a call inside an open parallel scope refuses; a second continuation attempt from a
continued predecessor is a no-op; (4) wire-abi fold vectors for the new kind; (5) fold equality of
every pre-existing vector unchanged.

## Rejected

- **Pruning frames inside one execution** (a fold that forgets completed frames): the re-run needs
  them to short-circuit; forgetting one re-executes its effect. A fold that keeps only `output`
  (dropping `input`) saves a constant factor, not the asymptote, and changes snapshot bytes for
  every execution; deferred until measured against this ADR's numbers.
- **A `continueAsNew` that transfers live suspensions** (ADR 0052 D3, unchanged).
- **`EXECUTION_COMPLETED { continuedTo }`** (a payload field instead of a kind): a consumer that
  treats `EXECUTION_COMPLETED` as "the flow returned" (analytics, the supervisor's child-done path)
  would misread a continuation as an output. A distinct kind is the honest signal; it still folds to
  `completed` so status handling is unchanged.
- **A cross-stream transaction in the EventStore SPI**: unnecessary, see D2.

## Consequences

- A perpetual or conversational agent has a bounded fold, a bounded snapshot and an O(carry) restart
  cost, at the price of an explicit carry the author must design.
- The kernel gains one syscall, one event kind, one reserved fold key and one sweep; no SPI change.
- ADR 0052's frozen criterion becomes a standing DST test rather than a paragraph.
