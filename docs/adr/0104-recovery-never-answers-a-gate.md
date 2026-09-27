# ADR 0104 — A recovery re-drive never answers a gate

- Status: **Accepted — implemented** (2026-09-28)
- Date: 2026-09-28
- Corrects: [ADR 0004](0004-failure-recovery.md) (`EXECUTION_RECOVERED`, and the
  `recoverAbandoned` amendment that re-drives through it) as it interacts with
  [ADR 0057](0057-multi-gate-suspend-passthrough.md) (gate *i* passes with the *i*-th
  recorded resume payload) and [ADR 0077](0077-typed-resume-payloads.md) (a gate's declared
  resume shape).
- Placement: **kernel** (`@loom/workflow-runtime`, the resume path). No 1P or 3P surface could
  hold it: the defect is in what the kernel itself records on a re-drive.
- **KERNEL_ABI unchanged (1.1.0). EVENT_SCHEMA 1.19.0 → 1.20.0** (D3; 1.19.0 is ADR 0102): no
  new event kind. The `EXECUTION_RESUMED` fold learns that a `null` resume answering no suspend
  point is status-only, and a human step's `EXECUTION_SUSPENDED` condition gains the kernel-set
  `stepId` (additive, folded verbatim).

## Context

A gate is `await ctx.suspend({ on })`. A flow re-runs from the top on every resume, and a gate
it already got past must pass through rather than park again. ADR 0057 made that exact: every
`EXECUTION_RESUMED` appends its payload to `variables._resumePayloads`, and the *i*-th
`ctx.suspend` in a re-run returns entry *i*. So an `EXECUTION_RESUMED` in the log is not a
lifecycle note. Its payload is an answer to a gate, and the fold hands it to the next gate that
asks.

Crash recovery re-drives a `running` execution by resuming it with
`EXECUTION_RECOVERED {}` (`LocalWorkerRuntime.resolveHandle`, and `recoverAbandoned`, which
reuses that path). `resume()` recorded every resume the same way: the resume-typed event, then
`EXECUTION_RESUMED` with the same payload. For recovery that meant `EXECUTION_RESUMED {}`, and
the fold added `{}` to `_resumePayloads`.

A crashed execution is parked at no gate, so that `{}` answered nothing when it was written. It
was consumed by the flow's next gate. A flow that crashed in a step before
`await ctx.suspend({ on: "go1" })` was recovered, ran up to go1, and passed it with `{}`:

```
EXECUTION_STARTED c STEP_STARTED  ← crash in step a
EXECUTION_RECOVERED EXECUTION_RESUMED c STEP_STARTED STEP_COMPLETED after{"p":{}} EXECUTION_COMPLETED
```

No resume named go1, no `ResumeAuthenticator` saw an approval, and go1's declared
`resumeSchemas` entry was never consulted: ADR 0077's lookup keys on the resume's event type,
which was `EXECUTION_RECOVERED`, and no flow declares a schema under that name. So recovery did
not trip the shape gate. It skipped it, and the flow received `{}` typed as whatever
`ctx.suspend<T>` claimed. The same happened after a gate legitimately passed: a crash between
go1 and go2 recovered to `[P1, {}]`, and go2 passed with `{}`.

Gates are how people approve consequential work: typed approvals (ADR 0077), fork/promote,
remediation sign-off. A crash anywhere upstream of one opened it.

`resumeAs` had the same flaw by a different route. It checks the kernel namespace only,
because migrating a crashed execution onto fixed code is the documented exit from
`FlowCodeMismatchError`. Its resume payload was recorded as `EXECUTION_RESUMED` whether or not
the execution was parked, so migrating a crashed execution answered its next gate with whatever
payload the operator supplied.

The review of the first fix found the same shape in three more writers, all governed by one
invariant this ADR states: **every `_resumePayloads` entry answers exactly one suspend point.**

- **An in-doubt verdict (K9.3).** A non-idempotent step whose attempt is in doubt parks with
  `on: "EffectInDoubtResolved"`, thrown from `ctx.run`, not from `ctx.suspend`. The verdict was
  recorded as `EXECUTION_RESUMED(verdict)`, so it was ALSO an entry, and the flow's next gate
  consumed it as its approval: `ctx.run(a)` then `ctx.suspend({ on: "go1" })` passed go1 with
  `{ stepId: "a", resolution: … }`. The verdict was read back from the latest `_resumePayload`
  with no check that it still applied. That was hidden by the first bug: recovery overwrote
  the key with `{}`. With the overwrite gone, a "retry-fresh" attempt that itself crashed was
  recovered, re-read the stale verdict, and called the non-idempotent tool a third time with
  no `EFFECT_INDOUBT` (the pre-fix kernel re-parked — correctly).
- **A HumanEffect step.** Its effect throws `SuspendError`, so the park also comes from
  `ctx.run`. The answer became an entry the next `ctx.suspend` consumed, while the step itself
  re-ran its effect and parked again — forever. A human step never completed.
- **`resumeAs` onto a terminal execution.** With no `EXECUTION_RESUMED` after the first fix,
  nothing reset a `failed`/`completed` status: the migrated run was live but folded as
  `failed`, and a crash during it was invisible to `recoverAbandoned` (stuck for good). With the
  old `EXECUTION_RESUMED(payload)`, the payload answered the next gate.

## Decisions

### D1 — A resume records a gate answer only when it answers a suspend point

`resume()` and `resumeAs()` record, beside the resume-typed event:

| The execution was… | Recorded | Why |
|---|---|---|
| parked at a gate (`ctx.suspend`, or a human step) | `EXECUTION_RESUMED(payload)` | the payload IS that gate's answer |
| parked in doubt (`EffectInDoubtResolved`) | `DECISION_RECORDED { decisionId: __loom_indoubt__:<step>:<attempts>, choice: verdict, source: "operator" }`, then `EXECUTION_RESUMED(null)` | the verdict answers ONE park, of one attempt of one step |
| crashed (`running`/`pending`) | nothing | already running; parked at no gate |
| terminal (`resumeAs` onto `failed`/`completed`) | `EXECUTION_RESUMED(null)` | re-opens it, so a later crash is recoverable, without answering a gate |

For recovery that leaves `EXECUTION_RECOVERED {}` alone, which has no fold handler and folds to
a no-op. The re-driven flow parks at the first gate it has no recorded answer for. There it
waits for a resume that names the gate, passing the ingress gate (#304/#305), the authenticator
(K12.2) and the gate's `resumeSchemas` entry (ADR 0077) like any other.

**Parked at a gate, via `resumeAs`.** A `resumeAs` onto an execution parked at a gate answers
that gate, so it runs every check `resume` runs:

- the gate name (it must name the RECORDED gate, which the operator can read even if the target
  flow renamed it);
- the gate's `resumeSchemas` entry in the target flow;
- the `ResumeAuthenticator`;
- the execution authorizer.

Before this ADR, any event name answered the gate unchecked. `resumeAs` onto a crashed or
terminal execution still checks the kernel namespace only, because nothing is parked.

**In doubt.** Keying the verdict by attempt is what makes it go stale correctly: after a
"retry-fresh" attempt crashes, the step is in doubt at a new attempt no verdict has answered, so
it records a fresh `EFFECT_INDOUBT` and parks. `ctx.run` reads the verdict for its CURRENT
attempt only. A pre-0104 verdict (the latest `_resumePayload`) is still honoured, but only while
the step's latest `EFFECT_INDOUBT` fact is for the current attempt. A payload at an in-doubt park
that is not a verdict for the parked step is now **refused** (`ResumePayloadValidationError`,
nothing appended). The old kernel appended it and re-parked. Refusing means every recorded
answer to an in-doubt park is a verdict decision, which is what keeps the pre-0104 fallback from
ever re-reading a stale verdict.

**Flow and effect code cannot write kernel state.** `ctx.emit`, and so `ctx.stream` and
`ctx.ui`, which are emits, used to accept any event type, and so did `EffectContext.emit`. The
fold folds by name, so flow code could forge kernel state. It could append `EXECUTION_RESUMED` to
answer its own next gate with no schema or authenticator. It could also append `STEP_STARTED`,
then `EFFECT_INDOUBT`, then `EXECUTION_RESUMED(verdict)`, and crash: recovery then adopted a
non-idempotent step's output through the pre-0104 verdict fallback, with zero tool calls.

Both emit paths now refuse every kernel event type (the K5 set, `knownEventTypes()`), apart
from an explicit allow-list of facts first-party code records from inside an effect. Each
allowed type is ALSO validated, because an allowed type still folds into state:

- `RESOURCE_METERED` (`@loom/middleware`) folds into `_resources`, which budgets, quotas and
  `negotiateBudget` read. Every meter field present must be a finite number in `[0, ceiling]`.
  The ceilings are sanity bounds no single effect reaches (tokens 1e12, costUsd 1e9, ms and
  wallMs 1e10, memBytes and netBytes 1e15). A negative, non-finite or non-numeric increment is
  refused: a meter only ever adds.
- `QUOTA_EXCEEDED` (`@loom/middleware`) marks `_resources.exceeded`. That only restricts, and
  `reason` must be a string of at most 1024 characters.
- `SAFETY_BLOCKED`, `EGRESS_DENIED` (`@loom/isolate`), `EFFECT_DENIED` (`@loom/effect-runtime`)
  and `OUTCOME_RECORDED` (`@loom/analytics`, and one loom-examples app) are audit lists.
- `DECISION_RECORDED` (`AgentRunner`) folds into `_decisions`, which `ctx.decide` SERVES. The
  rule has three parts:
  - A `__loom_` id is refused.
  - An EFFECT-written id is rewritten into its step's namespace,
    `effect:<stepId>#<attempt>:<id>`, so an effect can never pre-empt the flow's own
    `ctx.decide`. The attempt keeps a crash re-run of the step from colliding with its crashed
    attempt.
  - An id already recorded with a DIFFERENT choice is refused, so a decision is never
    overwritten. Re-emitting the identical fact is allowed, because a flow's emit re-runs on
    replay (ADR 0102).

  A FLOW-level `ctx.emit("DECISION_RECORDED")` keeps the flow's own ids: flow code writing a
  decision its own later `ctx.decide` reads is the flow deciding, in one trust domain.

The isolate relay forwards APPLICATION events only. An isolated tool is untrusted code, and a
kernel fact relayed from it would be the tool attesting to its own conduct. The parent writes
`EGRESS_DENIED` and metering itself, and a child that emits a kernel type fails its run.

This is the userspace counterpart of #304, which closed the kernel namespace to a
caller-supplied resume. Kernel-internal writes (`STEP_*`, `EFFECT_INDOUBT`, the runtime's
bootstrap events) go through the context's private commit path and the journal, never through
the guard. A grep of loom, loom-plugins and loom-examples found no other userspace writer of a
kernel type.

**The verdict cannot be forged.** Decision ids beginning `__loom_` are reserved for the kernel's
own records. `ctx.decide` refuses them before its replay lookup, and so does
`ctx.emit("DECISION_RECORDED", …)`. The emitted payload is copied to plain data before the check,
so the id that is checked is the id that is folded: a getter cannot pass the check and then
fold a reserved id.

The reader also requires the park itself: a verdict counts only beside the kernel's own
`EFFECT_INDOUBT` fact for the same step and attempt. With the kernel types closed to userspace,
that fact can only come from the kernel.

What is NOT covered is a writer with direct store access, who can forge any event, including
`STEP_COMPLETED`. Integrity against the store itself is the audit chain's job (ADR 0037).

**Human steps.** A `kind: "human"` step is a suspend point. `ctx.run` consumes the next entry for
it in order with every `ctx.suspend`: live, to complete the step with the answer
(`STEP_COMPLETED { output: answer }`), and on replay past the completed step, so the entry is
never served to a later gate. A human step now completes with its answer. It takes an answer
only once it has PARKED (its frame exists). An answer is always recorded after the park, so an
entry available to a human step that never started is not its answer; it is a pre-0104 stray,
and a human approval must never be one (D2).

**Parallel suspend points.** Answers are consumed in CALL order: the synchronous prefix of
`ctx.run`/`ctx.suspend` takes the next entry.

Human steps in one `ctx.parallel` work. They park one at a time: the first called is the one
whose park is recorded, and after it completes the next one parks.

Mixing a human step and a `ctx.suspend` in one `Promise.all` does not. Both throw, only one
condition is recorded, and on the re-run the answer to it may be taken by the other. Do not
mix them. This hazard is pre-existing (ADR 0057) and unchanged here; it is documented because
human steps now count as suspend points.

**Why `null`, not an absent payload.** SQLite's payload column is `NOT NULL`, so an absent
payload cannot be written, and every store round-trips `null` (the EventStore conformance kit
now asserts it, for InMemory, SQLite and Postgres). A `null` resume is still an ordinary answer
when it answers a gate: the fold keys on the state being answered, not on `null` alone (D3).

Alternatives rejected:

- **Tag each payload with the gate it answers, and have `ctx.suspend` match by name.** It would
  change the fold's shape and add a second identity axis to a list whose order is already the
  identity (ADR 0057). The defect is that non-answers were recorded as answers. Not recording
  them fixes that.
- **Give `EXECUTION_RECOVERED` a fold handler.** That would add a kernel event type, which moves
  it into the namespace the ingress gate refuses, and buy nothing.
- **Make the `EXECUTION_RESUMED` handler skip every append when the execution is not parked at a
  gate.** It would guard every writer, but it would change the fold for logs already written.
  See D2. D3 narrows the fold change to the `null` the old kernel never wrote in those positions.
- **Have the in-doubt branch consume a passthrough slot.** It would reorder replay of every
  pre-0104 in-doubt log, and a step that later short-circuits as completed cannot tell how many
  parks it went through.

### D2 — Logs written before this ADR are replayed as written, and flagged

A pre-0104 log can hold entries that answered no suspend point:

- a recovery (`EXECUTION_RECOVERED` then `EXECUTION_RESUMED {}`);
- an in-doubt verdict;
- a `resumeAs` onto an unparked execution.

The fold still serves each one to the gate at its index, and it has to stay that way. If the
entry was already spent, the gate it passed is behind recorded steps, and a legitimate later
resume answered the gate after it. Dropping the entry would re-park the flow at a gate its log
shows it past, or shift every later payload one gate early (go1 would receive go2's approval).
The first is nondeterministic. The second is exactly the bug ADR 0057 fixed.

So the runtime replays them and says so. On `resume()`/`resumeAs()` it walks the retained log
once and mirrors the fold's rule, so it counts exactly the entries `_resumePayloads` holds. It
classifies each entry that answered no suspend point:

- **passed** — a gate park (an `EXECUTION_SUSPENDED` not on `EffectInDoubtResolved`) follows
  it. A park means the flow reached a suspend point with no entry left, so every entry before it
  was consumed. The entry has already passed some gate. Audit it.
- **at-risk** — no gate park follows it and the execution is not terminal. The flow's next gate
  WILL pass with it. Act now: cancel or inspect.
- **harmless** — the execution has since completed, failed or been cancelled. Nothing is said.
- **unverifiable** — the prefix was retained away, but the snapshot still holds entries the
  retained log does not explain. If a gate park in the retained tail proves them spent, nothing
  is said. Otherwise the ones equal to `{}` (exactly what the old recovery wrote) are flagged.

The warning goes through `onWarn`, once per execution and verdict per runtime. The memory of
what was said is bounded (FIFO, 4096 entries), so a long-lived execution does not warn on every
resume forever.

**Which step a human park belongs to.** Since this ADR, the kernel records it: a human step's
park carries `condition.stepId` (additive in `EXECUTION_SUSPENDED`, 1.20.0). `ctx.suspend` strips
a caller-supplied one, so only the kernel can set it. A pre-0104 park has no such field. It is
attributed to the step whose `STEP_STARTED` immediately precedes it, because a human effect
throws synchronously after its step starts, unless that step is known to run a non-human effect.
A dynamic step the runtime cannot resolve to an effect kind is treated as possibly human (fail
closed).

The first version of this rule credited every park to the most recently started open human
step. It refused a perfectly valid 0104 log: two human steps in one `ctx.parallel`, where the
first park belonged to the first step.

**Pre-0104 human steps are refused, not guessed, and an operator can resolve them.** On the old
kernel no human step ever completed. It re-ran its effect and re-parked, and its answers were
entries nothing consumed. A human park also consumed nothing, so a stray before it stayed
unconsumed. That does NOT prove it spent, and the classifier treats a human park as proving
nothing: strays survive it.

Two shapes make a human step's answer impossible to tell apart from another entry:

- a pre-0104 (unattributed) park of the step after it was already answered, so every answer
  after the first would reach a later gate;
- an unspent stray before the step's first start, so the step would take the stray as its
  approval.

Either one refuses the resume (`ResumeRefusedError`, reason `ambiguous-legacy-answers`, nothing
appended), recovery included. The classifier reports those answers as at-risk.

**The operator override.** After inspecting the log, the operator resumes with an event that
carries `discardLegacyAnswers: { stepId, count }` (`ResumeEvent`, on `resume` or `resumeAs`).
The override decides what a human step accepts as its approval, so it is itself an approval.
It is honoured only when the configured `ResumeAuthenticator` VERIFIES the event. The
authenticator is handed the whole event, and it **MUST** cover `discardLegacyAnswers`, not just
`payload`. An authenticator that signs `payload` alone would let a caller attach or alter the
override under a valid signature, so the `ResumeAuthenticator` contract now states this
requirement. It is
refused on an unverified event, on a runtime with no authenticator, and on any resume the kernel
raises itself (`EXECUTION_RECOVERED`, `TIMER_FIRED`).

The kernel records it as `DECISION_RECORDED { decisionId: "__loom_discard__:<stepId>", choice:
count, source: "operator", rationale: { approval: { actor, verifiedBy } } }`, in the reserved
namespace. At that step, `ctx.run` then discards `count` entries before taking its answer, live
and on every replay. The override is refused when the log holds no such ambiguity for that step.

**Why this preserves determinism.** No recorded behaviour exists past a pre-0104 human park,
because the old kernel never got past one. Refusing appends nothing, and the override is a
durable fact every re-run reads. Assigning answers by provenance automatically would need to
know, per entry, which park it answered. The fold does not keep that, and deriving it from the
log breaks once retention truncates the prefix, so two re-runs could disagree.

One false positive is known: a pre-0104 stray that a gate passthrough already consumed with no
park after it, in an execution whose human step is first reached on the new kernel. It is
refused too, and the operator resolves it with `count: 0` ("discard nothing": the step's next
entry is its answer). The acknowledgement is recorded like any other count.

**Re-opening a terminal execution.** A terminal execution's unspent stray is harmless until
`resumeAs` re-opens it. The re-open is judged as live, so the stray is reported at-risk (or the
resume refused, per the rule above) at the moment it becomes dangerous.

**Rolling deploys.** Until every node runs this kernel, an old-kernel worker keeps writing
entries that answered no suspend point (the recovery pair, in-doubt verdicts as entries). They
are flagged like any other pre-0104 entry.

The reverse direction is worse. An OLD node that recovers or resumes an execution after a new
node wrote `EXECUTION_RESUMED(null)` folds that `null` as a gate answer and serves it to the next
gate. It also finds no verdict it can read: the old reader looks at the latest resume payload,
not at the decision. So **hold in-doubt verdicts and `resumeAs` onto terminal executions until
every node runs this kernel.**

A recovery on a new node is safe to mix: it writes nothing an old node misreads.

**Downgrade** follows from that. It is safe for recovery, which only stops writing an event. It is NOT safe for a log
holding a 0104 `null` resume (an in-doubt verdict, or a `resumeAs` onto a terminal execution):
an old kernel folds that `null` as a gate answer, and does not find a verdict it can read.
Settle or cancel such executions before rolling back.

### D3 — EVENT_SCHEMA 1.20.0: a `null` resume answering no suspend point is status-only

`EXECUTION_RESUMED` still sets `status → "running"` and clears `suspendedOn`. It no longer
touches `_resumePayload(s)` when its payload is `null` AND the execution was either not parked or
parked on `EffectInDoubtResolved`. There is no new event kind and no new payload field. That is a
MINOR bump: logs with no such resume fold byte-identically.

The only pre-0104 logs it changes are ones where a caller resumed `null` into one of those
positions. Such an entry answered no suspend point and would have been served to the next gate
as `null`, which is exactly the stray this ADR removes.

### D4 — What this does not change

- **Typed resume gates (ADR 0077).** A declared schema is enforced on every resume that answers
  a gate. That is now every payload a gate receives, so recovery and in-doubt verdicts are no
  longer ways around it.
- **Recovery of a parked execution.** It is still refused (`ResumeRefusedError`,
  `not-suspended`), and `recoverAbandoned` still skips `suspended` executions. The same refusal
  answers a resume that arrives BEFORE the execution parks: nothing is appended and the caller
  retries once it is parked. Recording it would make it an answer to whatever gate came next.
- **Analytics and telemetry.** A recovery no longer counts as a resume, and no longer fires
  `onFlowResume`, since nothing was resumed from suspension. An in-doubt verdict now also appears
  as one `DECISION_RECORDED` with `source: "operator"`.
- **In-doubt re-parking after a stale verdict** is correct behaviour, not a regression. The
  pre-0104 kernel re-parked a crashed "retry-fresh" attempt only because its recovery happened to
  overwrite the verdict with `{}`. Keying the verdict by attempt makes that re-park a rule rather
  than an accident.

## Consequences

- A gate passes only when a resume addresses it while it is parked. A crash upstream of it, an
  in-doubt verdict before it, a human step's answer and a migration no longer open it.
- A human step completes with its answer. It used to re-park forever.
- A `resumeAs` onto a failed execution re-opens it, and a crash during the migrated run is
  recoverable.
- **Known related gap, not fixed here (L14).** `STEP_FAILED` folds the EXECUTION's status to
  `failed` even when the flow catches the failure and continues. A crash after such a catch
  leaves an execution `recoverAbandoned` refuses as terminal, and it also makes a live execution
  read as `failed`. The cause is in the fold, and fixing it changes the folded status of existing
  logs, so it needs its own decision.
