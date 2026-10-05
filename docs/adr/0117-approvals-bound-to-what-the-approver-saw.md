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
`viewDigest(proposal)` (`fnv1a64` over `canonicalJson`, core's one canonicalization and hash).
It is recorded in the existing `EXECUTION_SUSPENDED` condition, which the fold copies into
`suspendedOn` verbatim, so it is durable and fold-visible with no new event. In `assertResumable`,
after the gate-name check: if the parked condition declares a `viewDigest` and the resume payload
does not carry the same `payload.viewDigest`, the resume is refused with
`ResumeRefusedError { reason: "view-digest-mismatch" }` BEFORE the append. A timer wake is exempt
(it is the kernel's, not an approver's). A gate that declares no digest behaves exactly as before.

`answerApproval(state, decision)` builds the resume event from the parked state, echoing the
digest; keep that state with the UI so "echoed" means "this is what I was shown".

`agentLoop$({ requireApproval })` declares `approvalViewDigest(gateKey, tool, input)` by default
(`gateKey` is the gate's `<executionId>#turn:<n>:tool:<j>` correlation key, which pins execution
and position, so an approval cannot be replayed at another execution's identical call).
`bindApproval: false` restores the unbound gate.

### D2 — `signedResumeAuthenticator`, the reference ResumeAuthenticator

`signedResumeAuthenticator({ gates, keys, authorize?, now? })` verifies an HMAC-SHA256 over the
whole event — `eventType`, payload (including the echoed `viewDigest`), `discardLegacyAnswers`,
actor and expiry — and returns `verified { actor, verifiedBy: "hmac-sha256" }`, so the runtime
records `APPROVAL_GRANTED`. It rejects an actor-less, unsigned, unknown-actor, forged, tampered or
expired approval, and an actor `authorize` does not allow (the role/grant hook). Events for gates
not in `gates` are `not-applicable`. `signResume(event, { actor, secret, exp? })` is the
approver-side half. It passes `runResumeAuthenticatorConformance`.

Limits, stated: the SPI hands `verify` the event only, so a signature is not bound to an
execution id except through the digest (D1), and there is no replay window beyond `exp`.

### D3 — Strict requires one

`security.strict` refuses to compose without `security.resumeAuthenticator` (a config error,
listed with the other strict problems), the R3 pattern: strict cannot default it because it needs
the app's approver keys. `strict: { requireResumeAuthenticator: false }` acknowledges an app with
no approval gates, visibly in the config, the way `requirePrincipal: false` does. The permissive
notice names the gap. The scaffold generates one.

### D4 — The bus leaves a gate parked unless told to approve

With no `onApproval`, `InProcessA2ABus.dispatch` returns `{ status: "working", suspended }` and
the gate stays suspended; `bus.resolveApproval(taskId, decision)` answers it later.
`onApproval` now receives `{ executionId, gate, viewDigest }`, and the bus echoes the digest.
The resume uses the gate's own name (it used to hard-code `"ApprovalGranted"`, which the ingress
gate refuses for any other name). `unsafeAutoApprove` is the loudly named opt-in for demos.

## Consequences

- **BREAKING (agent loops):** a `requireApproval` gate now needs its digest echoed. Build the
  resume with `answerApproval`, or set `bindApproval: false`. A flow's `resumeSchemas` entry for
  that gate must let `viewDigest` through.
- **BREAKING (bus):** callers that relied on implicit auto-approval pass `unsafeAutoApprove` or
  resolve the gate.
- **BREAKING (strict):** strict apps supply `resumeAuthenticator` or acknowledge its absence.
- Executions already parked carry no digest and resume unchanged; replay of an approved execution
  folds identically (the digest lives in a condition the fold already carried).
- The digest detects staleness and accident; it is not a MAC and is not collision-resistant against
  an adversary choosing both proposals. WHO approved is the authenticator's job.

## Rejected

- **A new event field or type for the digest.** The suspend condition already carries it.
- **Defaulting a ResumeAuthenticator under strict.** It needs keys only the app has; a default
  would verify nothing.
