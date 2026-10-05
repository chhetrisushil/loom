# ADR 0117 — Approvals bound to what the approver saw, a first-party ResumeAuthenticator, and no auto-approve

- Status: **Accepted — implemented** (2026-10-05)
- Date: 2026-10-05
- Closes: R13 (agentic-readiness audit, approvals)
- Builds on: [ADR 0077](0077-typed-resume-payloads.md) (the resume payload is parsed before the
  append), [ADR 0087](0087-durable-agent-loop.md) (`agentLoop$` parks before the tool), the K12.2
  `ResumeAuthenticator` SPI, and R3/R9 (fail-closed execution authz, `security.strict`).
- Placement: **1P** (`@loom/workflow-runtime`, `@loom/agent`, `@loom/app`, `@loom/scaffold`).
  **`KERNEL_ABI` and `EVENT_SCHEMA` are unchanged**: no event type or field is added. The one
  runtime-level addition is a pre-append check in the existing resume ingress gate
  (`assertResumable`), reading a field the suspend condition already carries verbatim. Number
  0117 sits outside the 0109–0116 range reserved for the Wave 2 kernel items.

## Context

Three gaps let an approval mean less than it appears to.

1. **Nothing bound an approval to its proposal.** `resumeSchemas` checks the payload's SHAPE.
   An approver's UI renders proposal A; the execution is parked on proposal B by the time the
   approval arrives (a retry, a re-plan, the next turn of an agent loop); a bare
   `{ approved: true }` approves B unseen. A time-of-check/time-of-use gap on the one decision the
   human step exists to protect.
2. **No first-party `ResumeAuthenticator`.** The SPI, a conformance kit and scaffold templates
   existed; no implementation did. With none wired, ANY caller of `resume()` approves a gate and
   no `APPROVAL_GRANTED { actor, verifiedBy }` evidence is recorded, so each app hand-wrote one
   or shipped without.
3. **`InProcessA2ABus` approved on a human's behalf.** With no `onApproval` it resumed every
   suspended gate with `{ approved: true, approvedBy: "auto" }`: an approval nobody made, recorded
   as if somebody had.

## Decision

### D1 — The gate declares a digest of the proposal; the resume must echo it

`SuspendConfig` / `SuspendCondition` gain an optional `viewDigest`. A parking caller sets it to
`viewDigest(proposal)` (SHA-256 over `canonicalJson`, tagged `v2:`; review round 1 replaced the
64-bit FNV `v1:` of the first cut, which a proposal-choosing adversary could collide). The runtime
compares the echoed string for exact equality, so an execution that parked with a `v1:` digest is
still resumed by echoing it. It is recorded in the existing `EXECUTION_SUSPENDED` condition, which the fold copies into
`suspendedOn` verbatim, so it is durable and fold-visible with no new event. In `assertResumable`,
after the gate-name check: if the parked condition declares a `viewDigest` and the resume payload
does not carry the same `payload.viewDigest`, the resume is refused with
`ResumeRefusedError { reason: "view-digest-mismatch" }` BEFORE the append. A timer wake is exempt
(it is the kernel's, not an approver's; see D5 for what that exemption is allowed to carry). A gate
that declares no digest behaves exactly as before.

`answerApproval(state, decision)` builds the resume event from the parked state, echoing the
digest; keep that state with the UI so "echoed" means "this is what I was shown".

`agentLoop$({ requireApproval })` declares `approvalViewDigest(gateKey, tool, input)` by default
(`gateKey` is the gate's `<executionId>#<loop id>#turn:<n>:tool:<j>` correlation key, which pins
execution, loop and position: two loops in one flow do not share `#turn:0:tool:0`). The proposal
itself is NOT copied into the suspend condition — tool input is model output of arbitrary size and
the condition is folded into every state read, snapshot and replay — so a UI renders the proposal
from the tool call in the log and recomputes `approvalViewDigest(correlationKey, tool, input)`
from exactly what it renders. An input `canonicalJson` refuses (nested past 1024) cannot be shown
to anyone, so the call is refused to the model like any declined call rather than failing the run.
`bindApproval: false` restores the unbound gate.

### D2 — `signedResumeAuthenticator`, the reference ResumeAuthenticator

`signedResumeAuthenticator({ gates, keys, authorize?, requireActor?, now? })` verifies an
HMAC-SHA256 over the whole event — `eventType`, payload (including the echoed `viewDigest`),
`discardLegacyAnswers`, actor, expiry — **and the park it answers**: the SPI gains an additive
optional `verify(event, { executionId, parkedAtSequence, principal })`. The runtime computes
`parkedAtSequence` (the sequence of the parking `EXECUTION_SUSPENDED`) and passes it; authenticators
written before it ignore the argument. The signature therefore holds for exactly one park of one
execution: it is refused at another execution — **including a fork**, which copies the parent's
park but has its own id — and at a later park of the same gate (a loop). Without a context
(or an unparked execution) it rejects. `signResume(event, { actor, secret, exp, executionId,
parkedAtSequence })` is the approver half; `runtime.parkedAtSequence(executionId)` is the value.

- `exp` is required. The park binding, not `exp`, is what stops replay; `exp` bounds how long a
  leaked signature for a still-open park is good for.
- The proof's actor must equal the calling principal's `actor` when the call carries one
  (`requireActor` overrides; no principal means the proof is the only identity). The recorded
  actor is the signer, and under the default it is also the caller.
- Secrets under 16 bytes (empty included) are refused: at construction for a record, at lookup for
  a function; `signResume` refuses them too. `keys` may return `string | string[]` for rotation.
- It rejects actor-less, unsigned, unknown-actor, forged, tampered and expired approvals and an
  actor `authorize` does not allow. Gates not in `gates` are `not-applicable`. It passes
  `runResumeAuthenticatorConformance`, which gains a case that the optional context is tolerated.

What a signature does NOT do: the secret store and role model are the app's, and a proof is a
bearer artefact until its park is answered or `exp` passes — an approver who signs for a park
authorises it for anyone who can submit that exact event.

### D3 — Strict requires one

`security.strict` refuses to compose without `security.resumeAuthenticator` (a config error,
listed with the other strict problems), the R3 pattern: strict cannot default it because it needs
the app's approver keys. `strict: { requireResumeAuthenticator: false }` acknowledges an app with
no approval gates, visibly in the config, the way `requirePrincipal: false` does. The permissive
notice names the gap. The scaffold generates one.

### D4 — The bus leaves a gate parked unless told to approve

With no `onApproval`, `InProcessA2ABus.dispatch` returns `{ status: "working", suspended }` and
the gate stays suspended; `bus.resolveApproval(taskId, decision)` answers it later.
`onApproval` now receives `{ executionId, gate, viewDigest, parkedAtSequence }`, and the bus
echoes the digest. A decision may carry a typed `proof`; `approvalPayload(request, decision)` is the
exact payload the bus will send, so an approver can sign it — a strict app with a
`signedResumeAuthenticator` approves through the bus this way (a bare bus approval is refused).
`resolveApproval` on a task the bus does not remember (answered, or evicted past `maxTasks`) throws
an error naming `runtime.resume` + `answerApproval` as the direct path.
The resume uses the gate's own name (it used to hard-code `"ApprovalGranted"`, which the ingress
gate refuses for any other name). `unsafeAutoApprove` is the loudly named opt-in for demos and logs a warning once per process.

### D5 — `TIMER_FIRED` is the kernel's wake, not a caller's answer

A timed approval gate (`suspend({ on: "Approval", timeout, viewDigest })`) has two legitimate
wakes. The digest exemption for the timer wake had a hole: a caller-supplied
`TIMER_FIRED { approved: true }` answered the gate past the digest check and the authenticator
(`not-applicable`), and the flow received `{ approved: true }`. Now (a) on a runtime that fails
closed (`requirePrincipal`, i.e. `security.strict`) a `TIMER_FIRED` resume without the runtime's
system grant is refused before the append (`ResumeRefusedError`, `timer-wake-not-system`);
`TimerService` already passes `systemOptions()`; and (b) on every runtime the recorded payload is
normalised to exactly `{ wakeAt }` from the parked condition, so no caller field reaches the flow.
A non-strict runtime cannot tell a caller from the timer (it has no system grant), so there an early
manual wake is still possible but is a timeout, never an approval.

## Consequences

- **BREAKING (agent loops):** a `requireApproval` gate now needs its digest echoed. Build the
  resume with `answerApproval`, or set `bindApproval: false`. A flow's `resumeSchemas` entry for
  that gate must let `viewDigest` through.
- **BREAKING (bus):** callers that relied on implicit auto-approval pass `unsafeAutoApprove` or
  resolve the gate.
- **BREAKING (strict):** strict apps supply `resumeAuthenticator` or acknowledge its absence.
- Executions already parked carry no digest and resume unchanged; replay of an approved execution
  folds identically (the digest lives in a condition the fold already carried).
- The digest detects staleness and accident (SHA-256, so also a crafted collision); it is not a MAC.
  WHO approved, and for which park, is the authenticator's job (D2).
- **BREAKING (`signResume`).** It now requires `exp`, `executionId` and `parkedAtSequence`;
  `signedResumeAuthenticator` rejects an event it is given no park context for.
- `agentLoop$` gate correlation keys gain the loop id: `<executionId>#<loop id>#turn:<n>:tool:<j>`.
  Executions already parked keep the key (and digest) they recorded.

- **Round 2 — locating the park.** The park is not the folded tip (denials and parallel siblings
  trail it), and no state field records it (adding one would change the fold, out of scope). The
  runtime finds it exactly: the newest `EXECUTION_SUSPENDED` among the events in hand, else a
  walk back from the snapshot in 64-event indexed range reads, with no whole-log read and no bound
  on how many events trail it. If it is gone from the log (compacted away) the approval is refused
  as `park-not-located`; the tip is never bound. `restoreFromState` and the bus use the same lookup.
  Remote approvers obtain `parkedAtSequence` from `runtime.parkedAtSequence(id)` or the bus
  `ApprovalRequest` (not `state.sequence`) to sign.
- `agentLoop$`'s deep-input refusal could change replay of a main-era execution whose approved
  tool call had input nested more than 1024 levels deep; negligible, noted for completeness.

## Rejected

- **A new event field or type for the digest.** The suspend condition already carries it.
- **Defaulting a ResumeAuthenticator under strict.** It needs keys only the app has; a default
  would verify nothing.
