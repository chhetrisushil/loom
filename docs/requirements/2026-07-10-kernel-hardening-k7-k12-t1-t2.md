# Loom Kernel-Hardening Requirements (K7–K12, T1–T2)

> **Status:** Proposal / gap analysis
> **Evaluated:** 2026-07-10 — every item **accepted with amendments** after a code-grounded
> critical evaluation; the normative deltas (including factual corrections to this document)
> live in the [evaluation & amendments](2026-07-10-kernel-hardening-evaluation.md) and in
> each ADR's Amendments section. This document stays verbatim as the historical record.
> **Recorded:** 2026-07-10 (captured verbatim for record/history)
> **Audience:** Loom maintainers; platform teams evaluating Loom as the execution kernel for autonomous systems
> **Decision records:** each item has a proposal ADR — [K7 → ADR 0019](../adr/0019-k7-data-plane-isolation-and-egress-control.md) ·
> [K8 → ADR 0020](../adr/0020-k8-cancellation-deadlines-bounded-effects.md) ·
> [K9 → ADR 0021](../adr/0021-k9-effect-delivery-contract-idempotency-fencing.md) ·
> [K10 → ADR 0022](../adr/0022-k10-log-lifecycle-retention-redaction-encryption.md) ·
> [K11 → ADR 0023](../adr/0023-k11-flow-code-versioning-in-flight-executions.md) ·
> [K12 → ADR 0024](../adr/0024-k12-identity-tenancy-delegated-authority.md) ·
> [T1 → ADR 0025](../adr/0025-t1-durable-timers-and-scheduled-executions.md) ·
> [T2 → ADR 0026](../adr/0026-t2-wire-level-kernel-abi.md)
> **Prior art:** the implemented rings K1–K6 are documented in
> [04 — Kernel Hardening](../loom-2.0/04-kernel-hardening.md) and ADRs
> [0016](../adr/0016-loom-2.0-execution-runtime-and-decision-seam.md)/[0017](../adr/0017-k6-behavioral-safety-ring.md).
> **Framing:** Each requirement below closes a gap between Loom 2.0's kernel claim and what a production
> execution kernel must guarantee. Requirements use RFC-2119 keywords (MUST / SHOULD / MAY).
> All requirements inherit two global constraints from the existing architecture:
>
> - **(G1)** MUST preserve P2 (deterministic, pure replay) and P9 (non-determinism only when logged).
> - **(G2)** MUST be additive and opt-in (P10): unwired, behavior is byte-identical to Loom 2.0.
>   Where a requirement is inherently mandatory-once-enabled (e.g. isolation), the *enablement*
>   is opt-in but the *enforcement* once enabled must be unbypassable.

Numbering continues the existing kernel-ring series (K1–K6). Two items are new kernel
*services* rather than rings and are numbered T1–T2.

---

## K7 — Data-plane isolation & egress control

**Gap.** The K2 authority ring governs effects that voluntarily flow through
`EffectRuntime.execute`. Tool implementations, however, run in-process with full ambient
authority (filesystem, network, the event store itself). ADR-0017 explicitly defers this.
Until closed, the protection ring is a convention, not a guarantee.

**Requirements.**

- **K7.1** The kernel MUST provide an opt-in *isolated executor* SPI for tool effects, with at
  least one reference implementation that runs a tool in a separate failure/authority domain
  (child process with dropped privileges, or WASM/isolate).
- **K7.2** When an effect is bound to an isolated executor, the tool body MUST NOT be able to
  (a) reach the `EventStore`/`SnapshotStore` interfaces, (b) read credentials not explicitly
  injected for that `toolId`, or (c) open network connections outside a declared egress
  allowlist.
- **K7.3** Egress policy MUST be declared statically per `toolId` (P5) — e.g.
  `tool$({ egress: ["prometheus.internal:9090"] })` — and violations MUST be denied before
  connection, emitting a durable `EGRESS_DENIED` fact (folded like `EFFECT_DENIED`).
- **K7.4** Credential injection MUST be per-tool and unforgeable from userland: an execution
  cannot name, enumerate, or copy credentials; it can only cause a granted tool to run.
- **K7.5** Isolation MUST compose with K2/K3/K6 unchanged (authorize → schedule → isolate →
  meter → validate).

**Acceptance criteria.** A deliberately malicious tool (reads `/etc/passwd`, dials an
unlisted host, appends directly to the event log) fails all three actions under the isolated
executor, each failure visible as a durable fact; the same suite passes trivially (no
enforcement) when isolation is unwired, preserving G2.

**Non-goals.** Defending against a malicious *host* process; multi-language tool support
(see T2) may share the same boundary but is tracked separately.

---

## K8 — Cancellation, deadlines & bounded effects

**Gap.** The scheduler is admission control only; K3 budgets deny the *next* effect, and K4
circuit-breaks a *target*. Nothing can terminate an in-flight effect or execution. A kernel
must be able to reclaim a running process.

**Requirements.**

- **K8.1** Every effect invocation MUST carry an `AbortSignal` (or equivalent) through
  `EffectContext`; built-in effects (`LlmEffect`, `ToolEffect`, `A2AEffect`) MUST honor it.
- **K8.2** `ExecutionRuntime` MUST expose `cancel(executionId, reason)` that (a) aborts the
  in-flight effect, (b) appends a durable `EXECUTION_CANCELLED` fact, and (c) transitions the
  PCB to a terminal `cancelled` status — replay of a cancelled run MUST reconstruct the
  cancellation at the same sequence (G1).
- **K8.3** Effects and executions SHOULD accept declarative deadlines
  (`ExecutionPolicy.deadlineMs`, per-step `timeoutMs`); a deadline breach MUST be enforced by
  the kernel via K8.1/K8.2, not by convention in userland.
- **K8.4** K3 SHOULD gain a mid-flight enforcement hook: a streaming LLM effect that crosses
  its token budget MUST be aborted, not merely have its successor denied.
- **K8.5** Cancellation MUST propagate across the dispatch seam: cancelling on the
  orchestrator MUST cancel the effect on a remote `WorkerRuntime` (best-effort delivery,
  durable-fact settlement).

**Acceptance criteria.** A test effect that sleeps 10 min is cancelled in <1 s locally and
across an HTTP worker; the log shows `EXECUTION_CANCELLED`; replay reproduces the cancelled
state bit-for-bit; an over-budget streaming call is severed mid-stream with a
`QUOTA_EXCEEDED` fact.

---

## K9 — Effect delivery contract: idempotency & fencing

**Gap.** If a worker crashes after performing a side effect but before `STEP_COMPLETED` is
appended, recovery re-executes the effect. Effects are therefore at-least-once, but the
contract is undocumented and unsupported. For mutating infrastructure operations this is the
single most dangerous ambiguity in the system.

**Requirements.**

- **K9.1** The documentation MUST state the delivery contract explicitly: *effects are
  at-least-once; steps are exactly-once only with respect to the log.*
- **K9.2** The kernel MUST supply each effect invocation a deterministic **idempotency key**
  (`executionId:stepId:attempt`-derived, stable across recovery replays of the same attempt)
  via `EffectContext`, so tool authors can deduplicate at the provider.
- **K9.3** Tool definitions SHOULD declare a semantic: `tool$({ idempotent: true | false })`.
  Recovery MUST refuse to automatically re-run a non-idempotent mutating effect whose prior
  attempt is in an unknown state; it MUST instead suspend the execution with a durable
  `EFFECT_INDOUBT` fact for operator resolution (safe-by-default).
- **K9.4** Worker leases MUST carry a monotonic **fencing token**; the journal MUST reject
  appends bearing a stale token, so a network-partitioned "zombie" worker cannot write after
  its execution was re-dispatched (extends D3 single-writer to the failure domain).
- **K9.5** `@loom/testing` SHOULD provide a crash-injection harness (kill between effect
  completion and event append) so applications can prove their tools' idempotency in CI.

**Acceptance criteria.** Under injected crashes, an idempotent tool converges to one logical
mutation; a non-idempotent tool never silently re-runs — the execution parks at
`EFFECT_INDOUBT`; a fenced zombie's append is rejected and logged.

---

## K10 — Log lifecycle: retention, redaction & encryption

**Gap.** The event log is an unbounded, immutable accumulation of every payload — including
secrets and PII — with no retention, archival, redaction, or encryption story. "Replay
forever" collides with GDPR erasure and credential rotation. A kernel reclaims resources.

**Requirements.**

- **K10.1** Stores MUST support **terminal-execution retention policies** (archive/delete
  completed executions after N days), exposed through `defineConfig({ retention })`; replay
  of an archived execution MAY require rehydration but MUST remain byte-identical.
- **K10.2** The kernel MUST support **crypto-shredding**: payload fields marked sensitive in
  a step/tool schema are encrypted per-execution (or per-subject) at append; destroying the
  key satisfies erasure while leaving the log structurally intact. Replay of a shredded
  execution MUST fail *explicitly* (`PAYLOAD_SHREDDED`), never silently diverge (G1).
- **K10.3** Schemas SHOULD support field-level redaction markers
  (`z.string().brand("secret")` or equivalent) that keep secrets out of the log entirely,
  substituting a deterministic reference resolved only inside the K7 boundary.
- **K10.4** Snapshot + prefix-truncation ("compaction") SHOULD be supported for very long
  executions, with the invariant that `fold(snapshot, suffix) === fold(events)` is
  conformance-tested.
- **K10.5** Encryption-at-rest configuration MUST be documented for both SQLite and Postgres
  backends.

**Acceptance criteria.** A conformance suite proves: retention removes eligible executions
and only those; a shredded field is unrecoverable from disk; replay of shredded/compacted
logs either reconstructs identically or fails loudly with the designated fact — never a
third behavior.

---

## K11 — Flow-code versioning for in-flight executions

**Gap.** K5 pins the event schema and `deploy-sim` *detects* divergence, but nothing
*remediates* it: an execution suspended for three days is stranded when new flow code
deploys. Long-lived executions are Loom's raison d'être, so this is a kernel obligation,
not an application concern.

**Requirements.**

- **K11.1** `RUN_STARTED` MUST record the flow's content hash (the `@loom/compiler` manifest
  hash already exists); resume MUST compare recorded vs. registered hash and MUST NOT
  silently resume across a mismatch.
- **K11.2** The kernel MUST support **pinned resumption**: a registry MAY hold multiple
  versions of a flow (`flow$({ id, version })` already exists); an in-flight execution
  resumes on the version it started with.
- **K11.3** Where pinning is impossible, the kernel MUST offer an explicit migration verdict
  API: `resumeAs(executionId, newFlowId, { strategy: "replay-check" | "operator-ack" })`,
  where `replay-check` proves the new code folds the existing log identically (reusing the
  `deploy-sim` engine) before resuming, and any migration is a durable
  `EXECUTION_MIGRATED` fact.
- **K11.4** `loom deploy check` SHOULD enumerate live suspended executions whose flow hash
  would change, making "drain or pin before deploy" a CI-enforceable gate.

**Acceptance criteria.** Deploying changed flow code with a suspended execution in flight:
(a) resume without pinning fails loudly; (b) pinned resume completes on old code; (c)
`replay-check` migration succeeds when the change is fold-compatible and refuses when not.

---

## K12 — Identity, tenancy & delegated authority

**Gap.** `GrantTable` principals are workflow ids; `approvedBy` is an unverified string in a
resume payload. There is no tenant model, no quota hierarchy, no attenuated delegation.
Kernels have users.

**Requirements.**

- **K12.1** `CapabilityRequest` MUST be extensible with an authenticated principal chain
  (`tenant / actor / onBehalfOf`), populated at the trust boundary (A2A server, resume API)
  and propagated immutably through dispatch.
- **K12.2** Resume events that gate authority (approvals) MUST support verification: a
  pluggable `ResumeAuthenticator` whose verdict is recorded in the durable fact
  (`APPROVAL_GRANTED { actor, verifiedBy }`), so "who approved" is evidence, not a claim.
- **K12.3** K3 budgets SHOULD nest (tenant → workflow → execution), with the most restrictive
  bound enforced and each trip attributed to its level.
- **K12.4** Capability grants SHOULD support **attenuated delegation**: an A2A callee
  receives at most the intersection of its own grants and the caller-delegated set, never
  ambient escalation.
- **K12.5** Multi-tenant stores MUST scope reads/subscriptions by tenant (Postgres row-level
  security or key-prefixing), conformance-tested against cross-tenant leakage.

**Acceptance criteria.** A forged approval without a valid authenticator verdict does not
resume the execution; a delegated A2A call cannot invoke an effect the delegator lacked;
tenant A cannot read or subscribe to tenant B's executions; nested budgets trip at the
correct level with correct attribution.

---

## T1 — Durable timers & scheduled executions (kernel service)

**Gap.** `ctx.suspend` supports a timeout, but there is no durable "wake me at T" /
cron-style service. Autonomous operations are substantially timer-driven; today this is an
external bolt-on.

**Requirements.**

- **T1.1** `ctx.sleepUntil(ts)` / `ctx.sleep(ms)` MUST be durable suspensions: the wake is a
  logged fact (`TIMER_FIRED`), survives restarts, and replays deterministically (G1 — the
  *scheduled* time is in the log; wall-clock drift never enters the fold).
- **T1.2** The kernel MUST provide a durable schedule registry (`schedule$({ cron, flow,
  input })`, statically wired per P5) with at-least-once firing and idempotent start
  semantics (a fired occurrence that already started is not double-started — reuses K9 keys).
- **T1.3** Timer storage MUST live in the same store family as events (SQLite/Postgres) so a
  single backup captures the full kernel state; firing across nodes MUST tolerate node loss
  (lease + fencing, per K9.4).

**Acceptance criteria.** A flow sleeping 48 h survives process kill and store failover, waking
exactly once; a cron schedule fires across a node crash without duplicate starts; replay of a
timer-bearing execution is bit-identical regardless of when it is replayed.

---

## T2 — Wire-level kernel ABI (language neutrality)

**Gap.** K1's syscall ABI is a set of TypeScript interfaces; real kernel ABIs are wire-level.
Until then, "userland" means "TypeScript userland," which caps the platform ambition.

**Requirements.**

- **T2.1** The eight K1 syscalls (`execute/run/decide/parallel/suspend/emit/stream/ui`)
  SHOULD be specified as a versioned wire protocol (JSON-RPC or gRPC), with the TS interfaces
  re-derived from that spec rather than the reverse.
- **T2.2** A remote tool/agent speaking the wire ABI MUST be subject to the same rings
  (K2 authorize, K3 meter, K6 validate, K7 egress) as an in-process one — the rings live on
  the kernel side of the wire.
- **T2.3** Conformance MUST be executable: a language-agnostic test-vector suite (event-log
  fixtures in, expected folds out) that any client implementation can run, extending the
  existing K1/K5 conformance pins.
- **T2.4** MAY be staged: the A2A server is the natural first carrier (it already speaks
  HTTP + agent cards); the ABI generalizes it from "tasks" to the full syscall set.

**Acceptance criteria.** A minimal non-TypeScript client (even a shell script against
JSON-RPC) starts, suspends, resumes, and replays an execution, with all ring verdicts
enforced kernel-side and the fold byte-identical to the TS client's.

---

## Priority & sequencing recommendation

| Priority | Requirement | Why this order |
|---|---|---|
| **P0** | K9 (idempotency & fencing) | Cheapest to specify, most dangerous to leave ambiguous; blocks safe *mutating* autonomy. |
| **P0** | K8 (cancellation & deadlines) | Autonomy without a kill path is not deployable; also a K3 prerequisite (mid-flight budget). |
| **P1** | K7 (isolation & egress) | The kernel claim's biggest exposure; ADR-0017 already reserves the slot. |
| **P1** | K11 (code versioning) | Long-lived executions + continuous deploy collide immediately in production. |
| **P1** | T1 (durable timers) | Small surface, disproportionate value for ops workloads. |
| **P2** | K10 (log lifecycle) | Must be answered before regulated/production data, but designable in parallel. |
| **P2** | K12 (identity & tenancy) | Required for platform/multi-team use; single-team pilots can defer. |
| **P3** | T2 (wire ABI) | Strategic, not blocking; stage via the A2A server. |

**Cross-cutting definition of done (applies to every item):** conformance tests pinned like
K1/K5; benchmarks within the committed zero-overhead baselines when unwired (G2); an ADR
recording the decision; and the fold reference (`10-event-schema-reference.md`) updated for
every new durable fact introduced (`EGRESS_DENIED`, `EXECUTION_CANCELLED`, `EFFECT_INDOUBT`,
`PAYLOAD_SHREDDED`, `EXECUTION_MIGRATED`, `TIMER_FIRED`).
