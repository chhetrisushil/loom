# ADR 0150 — Task-scoped authority: grants per task, effect leases that pause when spent, and accounting by lineage, as an opt-in package

- Status: **Accepted** (2026-11-23) — design accepted by the owner; amended 2026-11-23 (slice 1 as built; follow-ups closed, see the end of this ADR); slice 2 designed, see the slice-2 amendment and ADR 0152
- Date: 2026-11-23
- Builds on: [ADR 0024](0024-k12-identity-tenancy-delegated-authority.md) (`PrincipalChain`, signed attenuated
  delegation, nested budgets, `ResumeAuthenticator`), [ADR 0111](0111-durable-principal.md) (the principal is
  recorded at start and rehydrated through a codec/resolver on every execute; tokens are never written to the log),
  [ADR 0077](0077-typed-resume-payloads.md) (typed resume gates), [ADR 0084](0084-effect-classes-static-ceiling-k2-floor.md)
  (effect classes), [ADR 0085](0085-untrusted-content-integrity-axis.md) (taint with an origin label),
  [ADR 0115](0115-open-vocabularies.md) (custom metered dimensions), [ADR 0117](0117-approvals-bound-to-what-the-approver-saw.md)
  (approvals bound to what the approver saw), [ADR 0144](0144-sandbox-backend-spi.md) (sandbox backends declare what they
  enforce), [ADR 0083](0083-second-consumer-rule.md) (second consumer).
- Found by: evaluation of the whitepaper [*Task-Scoped Authority for Autonomous Agents*](../spec/task-scoped-authority-whitepaper.md) (2026-11-23).
- Gate: second-consumer claim, see [Second consumers](#second-consumers).
- Placement verdict: **first-party package `@loomwork/task-authority`**, plus additive opt-in options in
  `@loomwork/agent`, `@loomwork/orchestration` and `@loomwork/verify`. **Kernel change: zero.** *(Corrected 2026-11-23: slice 1 as built needed the three kernel seams of [ADR 0151](0151-effect-context-flush.md): two optional `EffectContext` methods and `WorkflowRuntime.reserveEffectDimensions`; "zero" holds only for the package's own logic. No `@loomwork/verify` option shipped.)* Every piece sits
  behind a seam that already exists: the `CapabilityAuthorizer`, `EffectMiddleware`, the `PrincipalCodec`,
  typed resume gates and the userspace-emittable events.
- Version/compat impact: new package. `@loomwork/agent`, `@loomwork/orchestration`, `@loomwork/verify`: additive
  options, default off, behaviour byte-identical when unset. KERNEL_ABI, EVENT_SCHEMA, DISPATCHER_SPI, the
  MemoryStore SPI and the sandbox backend SPI unchanged. No new event type: the package writes only
  `RESOURCE_METERED`, `QUOTA_EXCEEDED`, `EFFECT_DENIED` and `DECISION_RECORDED`, which
  `USERSPACE_KERNEL_EVENTS` already admits.

## Context

### The problem

The whitepaper argues that an agent should hold authority **for a task**, not for an identity. A grant says what
a task may do, a lease counts how much, and a lineage records where the task came from. The failure it targets is
**transfer** (it also calls it laundering): agent A gets agent B to do a step of A's task. B uses its own valid
authority, so every per-agent check passes. Short-lived tokens do not help, because nothing was stolen.

### What Loom already provides (measured against the paper's four rules)

| Paper's rule | Shipped today |
|---|---|
| 1. Check at the call | `EffectRuntime` asks the authorizer before every live effect (`packages/effect-runtime/src/EffectRuntime.ts:121`). A denial is the durable `EFFECT_DENIED`, and deny-by-default comes from `GrantTable` / `PolicyAuthorizer`. R12 adds per-resource ids (`<toolId>:<resource>`). |
| 2. Charge to the lineage | Every effect is in the log of the execution that ran it. A child's id is `<parentId>::<key>` (`childIdFor`). The principal is recorded on `EXECUTION_STARTED` and rehydrated on every execute (ADR 0111). |
| 3. Children narrow | `signDelegation` / `attenuateDelegation` / `DelegationAuthorizer`, with `base` required (ADR 0024, 2026-09-14 amendment). Orchestration `grants` gives a child a subset. `superviseChildren` re-mints the delegation after a crash. |
| 4. Running out pauses | **Not shipped.** An exhausted K3 budget throws `QuotaExceededError`, and `agentLoop$` treats that as terminal (`packages/agent/src/agentLoop$.ts:288`). `ctx.negotiateBudget` records `min(request, ceiling − spent)`, but it is advisory and does not pause. |

The A2A laundering case from the paper is already refused when B's grants do not cover the step: the callee
authorizes only the intersection of the token and its own `base`.

### The gaps

1. **Pause instead of fail.** No path turns "authority ran out" into a park and a renewal.
2. **Per-task, time-bound grants.** `GrantTable` is fixed at boot and keyed by workflow, and the delegation token
   names effects only. Nothing names a task, its root or its parent, and nothing carries a counted allowance.
3. **Counting side effects.** K3 meters tokens, cost, time and count. "Three writes to this table" has no meter.
4. **Carving a child's lease from its parent's.** Nothing does this.
5. **Which grant authorised an allowed effect.** Only denials are recorded.

Thinking past the paper's four rules, Loom can also help with problems the paper lists as limits or open questions:

6. **The July 2026 mechanism was a message, not a credential.** An agent "left a request where the peer would see
   it". Loom owns several of the places such a request can be left: memory, inboxes, conversations, A2A messages
   and the content store. `agentLoop$` already tracks which untrusted origin a run was shown (`sawTaintFrom`,
   `agentLoop$.ts:1247`). Following that provenance from the request to the effect it caused is a sharper laundering
   signal than accounting alone.
7. **Covert channels in Loom's own namespaces.** The paper says channels "can be narrowed by deployment". The
   shared namespaces Loom itself owns can be narrowed by the grant.
8. **Tools with ambient authority.** Sandbox backends already declare `network` and `freshPerRun` (ADR 0144). A
   grant can require them.
9. **Describing intent** (open problem). Loom knows statically which effects a flow can reach (`effectClass`,
   `@loomwork/verify`) and which tools an `agentLoop$` can call. A grant can be derived from that and checked
   against it.
10. **Root authority for scheduled runs** (open problem), **refusal disclosure** (open problem) and
    **measurement** (open problem). Each has a small, concrete answer below.

### What the paper says about Loom that is not accurate

These are recorded so the paper can be corrected:

- "The event log is the ledger … in Postgres." Postgres is one store among several (SQLite, in-memory, 3P stores).
- "Decrements a lease in the same transaction that appends the effect." That is right for one execution, because a
  fenced single writer folds its own log. It is wrong for a lineage: no transaction spans two executions' logs. D6
  replaces it with reservations, which are exact.
- "Grant decisions are recorded as effects." Today only denials are. D3 records grant epochs, which makes every
  allowed effect attributable by its position in the log.
- The section presents the whole runtime half as proposed. Rules 1–3 already ship.

## Decision

`@loomwork/task-authority` gives an execution a **signed task grant** with scope, expiry and lease ceilings. The
grant is held by an app-owned broker and restored through the existing principal codec. A **lease middleware**
counts side effects into the execution's own fold. Authority errors are **renewable**: opted-in flows and
`agentLoop$` park on a typed renewal gate instead of failing. Children **reserve** their lease from the parent's.
Provenance taint across lineages turns "B did A's work" into a recorded fact. The broker, the credential vault and
isolation between agents stay outside Loom, behind one small SPI.

Slice 1 (the paper's model) is D1–D6 and D13–D14. Slice 2 (what Loom adds beyond the paper) is D7–D12. Each slice
ships separately. Slice 2 may be cut without affecting slice 1.

### D1 — One opt-in package, no kernel change

`@loomwork/task-authority` exports `TaskGrantAuthorizer`, `taskLeaseMiddleware`, `taskAuthorityPrincipalCodec`,
`withRenewal`, the `GrantBroker` / `GrantSource` SPI with an in-memory reference broker, and
`checkTaskAuthorityConformance`. Wiring it is one `defineConfig` composition. An app that does not wire it sees no
change.

**Does not:** add a syscall, an event type, a fold key or an `EffectContext` field. *(Corrected 2026-11-23: the `EffectContext` clause is superseded. Slice 1 added `flush` and `readResources` to `EffectContext` and `reserveEffectDimensions` to `WorkflowRuntime`, under [ADR 0151](0151-effect-context-flush.md); the fold-key and event-type clauses stand.)* The rejected alternative
(a kernel `_authority` fold key) is below.

### D2 — The task grant: a signed token that names a task

```ts
interface TaskGrant {
  taskId: string;        // this task
  rootId: string;        // the lineage root (== taskId for a root)
  parentId?: string;     // the task this one was carved from
  issuedTo: string;      // holder binding, as DelegatedGrant (principal.actor must match)
  effects: string[];     // capability ids, incl. R12 "<toolId>:<resource>"; "*" refused at mint
  leases: Record<string, { ceiling: number; effects: string[] }>; // see D4
  reads?: string[];      // D8: Loom namespaces this task may read across lineages (slice 2, NOT built: `validateGrantShape` rejects it as an unexpected key)
  ambient?: "none" | "declared"; // D10 (slice 2, NOT built: rejected the same way)
  exp: number;           // absolute expiry (epoch ms), REQUIRED; a task grant never lives forever
  epoch: number;         // 0 at mint, +1 per renewal (D5)
  sig: string;           // HMAC-SHA256 over the canonical encoding, same scheme as signDelegation
}
```

The token is carried as `principal.taskGrant`. `PrincipalChain` already admits extra fields, and the kernel carries
it without interpreting it (ADR 0024 A1). `TaskGrantAuthorizer` checks, in order: `principalBlocked`, the
signature, the expiry, the holder binding, scope membership, and then **intersection with a required `base`**.
That is the same reasoning as ADR 0024's amendment: the secret is symmetric, so the token can never be the only
bound.

Expiry uses wall-clock `now` (injectable). That is replay-safe for the same reason as `DelegatedGrant.exp`:
authorization runs only on live calls, and a replayed step returns its recorded result without being
re-authorized.

**Does not:** constrain arguments beyond the R12 resource (rejected below), or cross trust domains (ADR 0024 scope
boundary: asymmetric signatures stay deferred).

### D3 — The broker holds the grant; the log records its digest

The token is never written to the log (ADR 0111). `taskAuthorityPrincipalCodec` stores `{ v: 1, ref: taskId }` in
the principal record. On every execute, `fromRef` asks the app's `GrantSource` for the task's **current** token.
It composes with `orchestrationPrincipalCodec`, so a supervised child keeps both its delegation and its grant.

Before the first effect of each step under a grant epoch, the lease middleware emits
`DECISION_RECORDED { decisionId: "task-authority:grant:<epoch>", choice: { digest, exp, epoch } }`. The kernel scopes
an effect-emitted decision id to its step and attempt (`effectDecisionId`), so this is one small event per step, not
per effect. **For any effect, the grant that authorised it is the latest grant digest before the effect's position in
the log.** That is a pure
projection over facts already present, and it closes gap 5 with no new event.

A codec that returns nothing for a ref yields `principalUnresolved`, and the kernel denies every effect before any
authorizer runs (ADR 0111 D4). A revoked or missing grant therefore fails closed.

### D4 — Leases count side effects in the execution's own fold

`taskLeaseMiddleware` maps each effect, or `<effect>:<resource>`, to a lease named in `grant.leases`. Before
dispatch it reads the spend from `ctx.resources.custom["lease.<name>"]`, which is the pure per-execution fold
(K3 / ADR 0115). If the spend is below the ceiling, it emits `RESOURCE_METERED { custom: { "lease.<name>": 1 } }`
and calls `next`. Otherwise it emits `QUOTA_EXCEEDED { level: "lease", reason }` and throws `LeaseExhaustedError`.

- **It counts attempts, not successes.** A write that threw may still have happened, and a side-effect bound must
  not undercount.
- **Concurrent calls** (`parallelTools`) read the same fold snapshot. The middleware keeps an in-process
  reservation per `executionId`, seeded from the fold. That is exact because the execution has a single fenced
  writer.
- **Compute** (tokens, cost) stays with the existing metering / `nestedBudgetMiddleware`, which give loose bounds
  (the paper's "count side effects before compute").
- **The ADR 0115 cap** of 32 custom dimensions bounds a grant to **10 leases** (D6 uses three dimensions per
  lease). The broker refuses a larger grant when it mints one.

### D5 — Running out pauses: renewable authority errors and a typed renewal gate

`LeaseExhaustedError`, `GrantExpiredError` and `GrantRevokedError` share the marker `renewable: true`. *(As built there is no `GrantExpiredError` class: an expired grant is a `CapabilityDeniedError` with reason `task-grant:expired`, which `isRenewable` recognises.)*

- **`withRenewal(ctx, id, fn)`** for plain flows. When `fn` throws a renewable error, it suspends on the typed gate
  `task-authority:renew` (ADR 0077) carrying a `RenewalRequest`:
  `{ taskId, epoch, spent, renewals, effectClassesCaused, justification? }`. The broker resumes it with a
  `RenewalVerdict { granted, epoch, digest }`, authenticated by the app's `ResumeAuthenticator` (optional as built: without one the resume still works and only the `_approvals` record naming the approver is missing), so the durable
  approval names who renewed. On resume the codec rehydrates the new token (D3) and `fn` is retried under a fresh
  step id. The denied attempt stays in the log as evidence. A refused renewal fails the run with
  `RenewalDeniedError`.
- **`agentLoop$({ authority: { onExhausted: "park" } })`** does the same around tool dispatch, reusing the
  `needsApproval` park machinery. It re-dispatches the call after renewal. The model never sees a failed tool
  result for an attempt that was renewed. Default `"fail"` keeps today's terminal behaviour.
- **The justification is model-written**, so it is stored tainted (ADR 0085). An approval of a renewal is bound to
  the request the approver saw (ADR 0117).
- **Revocation.** A grant can be revoked mid-run. If the `GrantSource` reports it revoked, the middleware throws
  `GrantRevokedError` on the next effect. The check is optional, async and cached per epoch. Revocation therefore
  pauses the task rather than killing it, and the broker can renew with a narrower grant.

### D6 — Children narrow; leases are carved by reservation, not by transaction

Orchestration's spawn options gain `lease?: Record<string, number>`. At spawn, the parent meters
`lease.<name>.reserved += n` in **its own** log, and the child's grant is minted with `ceiling = n`,
`parentId = parent.taskId` and `rootId = parent.rootId`. Scope is the subset `grants` already enforces. When the
child completes, its unused amount travels in the `CHILD_DONE` payload *(as built it is recorded at the broker through `settleChild` and taken once through `takeReturn`; see the amendment)*. The parent meters
`lease.<name>.returned += unused`.

The parent's available lease is `ceiling − spent − reserved + returned`. Every term is additive and comes from
the parent's own fold, so the result is **exact with no cross-log transaction**. A spawn that asks for more than is
available is refused before anything durable happens (the existing child-start gate). Under `withRenewal`, it
parks the parent for renewal instead. Children can therefore never exceed the parent in total, and only the root
grant needs an estimate.

**As built (T8, R25/R26).** The bound is structural, not left to flow code. The reserve is one recorded step keyed
by the child; the minter refuses a spawn unless the parent's live fold shows `reserved` at least the sum of its
children's high-water ceilings (this child included). The `returned` amount is not passed by the flow: the
supervisor records a COMPLETED child's unused amount at the broker (`settleChild`) and the parent's return step
takes it once (`takeReturn`); failed and cancelled children return nothing. A child's renewal never exceeds its
minted ceiling. `installTaskAuthority` reserves the `lease.` meter prefix (ADR 0151 D7), so only effects and
middleware write these counters. In-doubt outcomes: a crash inside the reserve step parks it in doubt and the
operator adopts with output `{ taskId, lease }` (a wrong value changes the spawn ceiling, still checked against
the fold); an in-doubt return step is lost, never doubled.

### D7 — Instruction provenance across lineages (Loom's addition to the paper)

Content that crosses a lineage boundary through a channel Loom owns is tainted with origin
`lineage:<rootId>`. That covers memory recall of an entry written by another lineage, an inbox send, an A2A
inbound message and a shared conversation turn. Each of these seams already taints third-party content (ADR 0085).
D7 only sets the origin label.

`agentLoop$` already records the first untrusted origin a run was shown (`sawTaintFrom`). Under task authority it
keeps the **set** of `lineage:*` origins (bounded, `TAINT_ORIGIN_LABEL_MAX`). Because the taint applies to the whole
run, a model that paraphrases the request does not escape it.

When an effect whose `effectClass` is at or above a configured floor (default: `write`) runs in a run that has seen
a foreign lineage, the policy `crossLineage` applies:

- `"attribute"` (default) — emit `DECISION_RECORDED { decisionId: "task-authority:directed-by", choice: { lineages } }`
  before the effect. The effect is charged to B's lineage **and** recorded as directed by A's lineage.
- `"park"` — the D5 renewal gate, with reason `cross-lineage`. A human or the broker decides.
- `"deny"` — `EFFECT_DENIED` with reason `cross-lineage direction`.

This is what makes the paper's laundering test pass in the case it cannot handle: **B's grant happens to cover the
step**. The paper only offers "work with no origin in B's task", which an auditor must infer. D7 records the origin.

**Does not:** see channels outside Loom (a file in a shared bucket, timing). Those stay deployment concerns, as the
paper says.

### D8 — Loom's own shared namespaces are scoped by the grant

`grant.reads` lists the namespaces the task may read across lineages (memory scopes, conversation ids, durable-state
keys), as globs. The package ships wrappers (`scopedMemoryStore`, and the equivalent for durable state) that refuse
a cross-lineage read outside `reads`. Writes are stamped with the writer's `rootId`, which is what D7 reads. Content
refs already refuse foreign references (`acceptContentRefParam`, ADR 0120). This narrows the covert channels Loom
owns. It gives the paper's "a channel is worth little when the receiver has nothing spare to lend" a reader-side
counterpart: a receiver cannot read what it was not granted.

### D9 — Grants derived from what a flow can statically reach

`deriveGrant(flow | agentLoopConfig)` returns the effect ids a flow can reach (its declared effects and `effectClass`)
or an agent loop can call (its own tools plus the `toolSearch` catalogue). A broker uses it as the upper bound for a
mint. A new `@loomwork/verify` rule, `task-grant-reach`, warns when a grant names an effect outside the reach of the
flow it is issued for, which means the grant is broader than the code. This turns "describe the task before it runs"
into a check for flows. Exploratory agents still get grants bounded by their menu, which is the honest limit the
paper names.

### D10 — Tools with ambient authority must run in an enforcing sandbox

`grant.ambient = "none"` makes `sandboxEval$` refuse a backend whose declared capabilities are not
`network: "none"` and `freshPerRun: true` (ADR 0144 D4 already refuses what a backend cannot vouch for; this adds the
grant as a reason). This is the paper's "one agent per sandbox, no shared writable namespace", enforced from
capabilities that already exist. A per-task host allowlist would need the sandbox SPI to carry one. That is deferred
(see Rejected alternatives).

### D11 — Refusal disclosure is a policy

`disclosure: "reason" | "opaque"`. With `"opaque"`, the model sees `"not authorized for this task"` (plus
`"renewal requested"` when D5 parks), and the full reason exists only in the log. The default is `"reason"`, which
is today's behaviour. This answers the paper's open problem with a setting, not a verdict: the operator chooses.

### D12 — Root authority for scheduled runs

A schedule may carry a **schedule grant**, approved once through the existing approval path. The recorded
`APPROVAL_GRANTED { actor, verifiedBy }` is who answers for every tick. Each tick's root grant is minted as a D6
child of the schedule grant, with its lease carved per period. That gives the paper's open problem a concrete
answer for the scheduled-agent case: the root derives from a recorded human approval of the schedule, not from the
agent's identity.

### D13 — The broker is an SPI, and its inputs are untrusted

```ts
interface GrantBroker {
  mint(req: MintRequest): Promise<TaskGrant>;     // req.parent present => subset + carve enforced (D6)
  renew(req: RenewalRequest): Promise<RenewalVerdict>;
  revoke(taskId: string, reason: string): Promise<void>;
}
interface GrantSource {                          // what the codec and middleware read
  current(taskId: string): Promise<TaskGrant | undefined>;
  revoked?(digest: string): Promise<boolean>;
}
```

Loom ships `InMemoryGrantBroker` (decides from facts only: spend, renewals so far, effect classes caused) as the
reference and the conformance subject. Production brokers (IAM, OPA, a vault) are app- or 3P-owned. Every
`RenewalRequest` field the agent influenced is bounded and tainted. The paper names the broker "the most valuable
target", and Loom never trusts what an agent writes to it.

### D14 — Measurement: a conformance kit with the laundering test as its acceptance bar

`checkTaskAuthorityConformance({ broker, runtime })` runs:

1. **Laundering, uncovered:** A asks B (over A2A and over shared memory) to perform a step outside B's grant →
   refused.
2. **Laundering, covered:** B's grant covers the step → the effect is recorded with `directed-by: lineage:<A>` (D7).
3. **Carve:** children's total spend never exceeds the parent's ceiling, including across a parent crash.
4. **Pause and renew:** exhaustion parks the run, renewal resumes it in a fresh runtime, and the effect count
   matches the grant.
5. **Replay:** replaying a completed run makes **zero** broker calls.
6. **Revocation:** a revoked grant pauses the next effect and never runs it.

A `task-authority-laundering` example in `loom-examples` runs the kit against the reference broker. The paper says
no accepted benchmark exists. This kit is a reproducible one others can run against their own broker.

## Second consumers

- **`agentLoop$` (in repo):** `QuotaExceededError` is terminal today. D5's park-and-renew is the first way an agent
  can survive an underestimated budget.
- **Perpetual agents / `sentinelPreset` (in repo, `db-sentinel`):** a scheduled agent has no human per run. D12
  gives it a recorded root of authority.
- **`@loomwork/orchestration` (in repo, `child-orchestration`, `agent-swarm`):** fan-out has no total bound across
  children. D6 is that bound.
- **A2A mesh (in repo, `a2a-mesh`, `agent-network`):** the laundering scenario is exactly a mesh scenario. D7 is
  the signal the mesh lacks.

These are four unrelated workloads. The domain argument also holds independently: any deployment where two agents
with side-effecting tools share a namespace has the transfer gap.

## Consequences

- Teams that adopt the paper's model get its runtime half from Loom and keep the policy half (the broker) where
  identity and access already live.
- **Default behaviour is unchanged.** Every option is off until wired; `agentLoop$` stays terminal on quota unless
  `onExhausted: "park"`.
- **Residuals**, recorded rather than hidden:
  - D3 makes the broker, not the log, the source of the *current* grant. The log holds digests, so an auditor can
    check the broker's history against it but cannot rebuild a token from the log. ADR 0111 chose the same.
  - D7 sees only Loom-owned channels.
  - D4 depends on correct effect-to-lease mapping. An unmapped effect is governed by scope only; the broker can
    refuse to mint a grant whose effects are not all mapped (`strictLeases`).
  - A paused task holds its children's reservations until it resumes or is cancelled. The cancel cascade
    (ADR 0112) returns them.
- **Follow-ups:** a sandbox SPI field for a per-task egress allowlist (D10, deferred); asymmetric task grants for
  cross-organisation delegation (deferred, ADR 0024); `loom authority explain <execution> <seq>` CLI over the D3
  projection.

## Rejected alternatives

| Alternative | Why rejected | What would reopen it |
|---|---|---|
| A kernel fold key `_authority` plus an `EffectContext.authority` field, so the grant lives in the log | The codec (D3) and middleware already reach the grant without kernel change. The kernel has a size budget and a bias against new state. Putting tokens in the log contradicts ADR 0111. | A consumer that needs the grant restorable with **no** broker reachable (fully offline replay **with** re-authorization). |
| Calling the broker from inside `authorize()` on every effect | `CapabilityAuthorizer` is pure and synchronous by contract (deterministic, replay-safe). A per-effect network call couples every effect to broker availability. | Nothing: the contract is an invariant. Live revocation uses the optional cached check in middleware (D5). |
| An argument-constraint language in grants ("amount < 100") | A vocabulary with no second consumer. R12's `resourceOf` already lets an effect expose what it targets, and the paper itself calls describing intent unsolved. | Two unrelated consumers whose constraints cannot be expressed as a resource id. |
| Decrementing a lineage lease "in the same transaction as the append" (the paper's wording) | No transaction spans two executions' logs. Reservations (D6) are exact without one. | Nothing: reservations dominate. |
| Lineage budgets through `BudgetLedger` (the K12.3 projection) | Eventually consistent: two nodes can briefly overspend. D6 is exact. | Not needed; `nestedBudgetMiddleware` stays for tenant-level compute caps. |
| Making `agentLoop$` park on quota by default | Changes behaviour for every existing app, and a park without a broker hangs. | Nothing: opt-in by design. |
| Asymmetric signatures now | ADR 0024's deferral holds: no consumer spans trust domains yet. | A second, unrelated consumer that delegates across organisations. |
| A per-task egress host allowlist in this ADR | Needs a sandbox backend SPI change, and no backend implements one today. | A backend that can enforce a per-request allowlist, plus a consumer that needs more than `network: "none"`. |
| Shipping a production broker (OPA / IAM adapters) in loom | Policy is the organisation's half of the model, and adapters are 3P by the plugin rule (ADR 0043). | A 3P adapter that wants to become 1P under the usual rules. |

## Amendment (2026-11-23) — slice 1 as built

Slice 1 is implemented (`@loomwork/task-authority`, with the kernel seams of [ADR 0151](0151-effect-context-flush.md)). The sections
above are unchanged; this amendment records where the build departs from or narrows them. Rulings are numbered R1–R29 in the slice's
ledger; each item cites the decision it changes.

- **D1 and the header's "Kernel change: zero" are superseded** *(corrected 2026-11-23)*. Slice 1 needs the kernel seams of ADR 0151 (`EffectContext.flush`, `readResources`, `WorkflowRuntime.reserveEffectDimensions`); the placement verdict holds only for the package's own logic.

### D2/D3 — one grant backs exactly one execution, and the holder is bound in the ref

- **R16.** One task grant backs exactly one execution. `GrantSource.claim(taskId, executionId)` is an atomic compare-and-set: the first
  claim wins and is idempotent for the same execution. `fromRef` refuses a `ta1:` ref claimed by another execution, so a fork cannot
  act as the task. Leases are counted per execution fold (D4); sharing a grant would multiply the ceiling.
- **R15.** The ref binds the holder: `ta1:<taskId>.<hmac(secret, taskId \n issuedTo)>`. `fromRef` refuses a current grant whose
  `issuedTo` does not match, so reusing a `taskId` or reissuing it to another agent cannot change who a run acts as.
- **R17.** A task-governed run cannot `continueAsNew` under the same grant, and a fork of a task-held run is denied in either mode
  (fail closed, pinned by test). A new generation must be started with a NEW child grant (a D6 mint). The kernel's `fromRef` context
  carries only the execution id, so a lineage-aware claim would need a kernel hook; perpetual task runs pay one mint per generation.

### D3 — a supervised child no longer keeps both its delegation and its grant (retracted)

- **R13.** The claim "a supervised child keeps both its delegation and its grant" is retracted. A chain that carries a `taskGrant`
  together with `tenant`, `onBehalfOf` or a `delegation` is REFUSED at start (`toRef` throws, before the append), as is a grant that
  fails `verify`, holder or expiry checks. `orchestrationPrincipalCodec.toRef` returns `undefined` for any chain with a `taskGrant`.
  Under task authority a child is narrowed by its own task grant (D6), not a delegation. Failing closed beats a silent drop to base
  authority. (Corrected: the `tenant` / `onBehalfOf` refusal was REVERSED by R30/R34, see the later amendment; only
  `delegation` together with a task grant is still refused.)
- **R14.** A failed restore answers EVERY `ta1:` ref with an unresolved principal (`{ principalUnresolved }`, never `undefined`),
  so no other codec or resolver can answer a ref this one owns.
- **R4.** `verifyTaskGrant` is verify-and-snapshot: it returns a frozen plain copy (strict key allowlist, at most 64 KiB) or
  `undefined`, and all later code uses only the copy. A boolean over a caller-held object was a time-of-check hole.

### D4 — lease counting needs the ADR 0151 seams, and leases are narrower

- **R19.** Lease-governed effects need `EffectContext.flush()` and `readResources()` ([ADR 0151](0151-effect-context-flush.md) D1/D6). The
  middleware works on live reads: a synchronous live read, a ceiling check, an emit of the digest and meter, a live re-read asserting
  that `lease.<n>` advanced (else `LeaseDimensionDroppedError`, not renewable, fail closed), then `await flush()`, then `next()`. It
  refuses to run when `readResources` is absent (`LeaseDurabilityError`). There is no reservation map. This closes the crash window in
  which an effect ran and its count was never stored (owner decision: a kernel seam, not a documented gap).
- **R21.** `strictLeases` defaults to TRUE. Slice 1 refuses, at grant shape, leases that overlap (an effect in two leases) and lease
  entries naming a resource-qualified effect (`toolId:resource`): the effect context carries no resource.
- **R22.** The lease middleware must sit INSIDE (after) any retry middleware, and `TaskGrantAuthorizer` is required alongside it.
  `QUOTA_EXCEEDED`'s `_resources.exceeded` is sticky across a renewal.
- **R26.** The `lease.*` dimensions are reserved against flow emits: `installTaskAuthority` calls
  `WorkflowRuntime.reserveEffectDimensions("lease.")` (ADR 0151 D7), and a flow-scope `RESOURCE_METERED` whose custom dimension starts
  with a reserved prefix is refused; effect and middleware scope is unchanged. The kernel names no 1P vocabulary.
- **Trust line.** Grants bound the model and flow code. App-registered effects and middleware are trusted: an effect can still emit
  any dimension and a hostile middleware can bypass the lease.

### D5 — renewal

- **R23.** `withRenewal` records EVERY attempt's outcome as a normal decision (`{ ok: true }` or `{ request }`), with no sentinel
  throw. On `{ ok: true }` it calls `fn(attemptId)` again outside the decider, so the value is read back from completed frames. `fn`
  MUST be replay-pure (only durable `ctx` calls) and MUST NOT park; steps keyed by the attempt id re-run after a renewal, and the id
  must be unique per call site per execution.
- **R24.** The expired-grant reason has one formatter/parser pair, internal to the package (`formatExpiredReason` / `parseExpiredReason` in `authorizer.ts`; not exported from the package index).
  `answerRenewal` overwrites `request.epoch` from `broker.current(taskId)` when available and recomputes the view digest as a tamper
  check. `withRenewal` treats any verdict other than `granted === true` as denied.
- **R12/R8.** An expired grant may be renewed (expiry pauses, renewal resumes); `renew` refuses a result whose clamped `exp` is not in
  the future.
- **R20.** Revocation is checked against `GrantSource.revoked` with a TTL cache (`revocationCacheMs`, default 1000 ms; revoked is
  sticky; a non-boolean answer counts as revoked). A revocation therefore bites within the TTL, not instantly.
- **R27.** Agent park (`authority.onExhausted: "park"`) keeps the feedback log. The first attempt's decision id is `${id}:outcome`
  in both modes; a renewable error returns `{ request }`, mirrored at `renewalDecisionId(id, 0)`. A cause-chain walk stops at the first
  terminal layer, so a safety, kill-switch or divergence error never parks.

### D6 — the lineage bound is structural

- **R25.** The bound holds whatever the flow code passes. (1) A reservation is a recorded step keyed by the child id, and the
  minter checks the parent's live fold: it refuses unless `lease.<n>.reserved` is at least the sum of the children's high-water
  ceilings including the new one. (2) Returns go through the broker: the supervisor records the child's unused amount with
  `settleChild(childTaskId, unused)` (once, completed children only, clamped to `[0, high]`) and the return effect takes only the
  child id and does a one-time `takeReturn`. (3) A child's renewal never raises its ceiling above the one minted; a top-up is a new
  parent reservation. (4) `holder(taskId)` is a side-effect-free read; the minter requires `holder(parentTask) === parentExecutionId`
  and never claims. `holder()` replaces the earlier `claim`-based check.
- **R7/R11.** The broker never releases a child's reservation (revocation included): it promises only that the sum of every child's
  high-water ceiling ever minted stays at or below the parent's ceiling. A child may renew down but never frees capacity.
- **In-doubt outcomes (operator action).** The child-lease effect is not idempotent: a crash inside its step parks the step in doubt
  and an operator resolves it. For a RESERVE the operator adopts the step with output `{ taskId, lease }`; a wrong value changes the
  spawn ceiling the minter then checks against the parent's fold, so it cannot exceed what was metered. An in-doubt RETURN is lost,
  never doubled (the broker's one-time `takeReturn` has already run or not).
- **Known residual.** A child that never starts loses its reservation: nothing observes the never-started child to settle it. (closed, see the later amendment: R33)

### D13 — the `GrantSource` SPI grew

`GrantSource` is `current`, `revoked?`, **`claim`** (atomic CAS, R16) and **`holder`** (R25). `GrantBroker` adds `mint`, `renew`,
`revoke`, **`settleChild`** and **`takeReturn`**. `RenewalVerdict` is a discriminated union (R9). A lease name matches
`/^[a-z][a-z0-9_-]{0,48}$/` (R5, so `a` and `a.reserved` cannot collide). `InMemoryGrantBroker` is the reference; a durable broker
passes the conformance kit.

### D14 — the replay property and the kit

- **R29.** The replay property is "replay adds no broker calls per replayed effect". Principal restoration on each execute is by
  design (D3: the codec restores the grant from the broker), so zero calls overall is impossible; "no broker calls per replayed
  effect" is what the kit asserts.
- Covered laundering (which needs the D7 provenance taint, slice 2) and A2A laundering are reported by the kit as **skipped**, not
  as passed.
- The kit lives at `@loomwork/task-authority/conformance` (`checkTaskAuthorityConformance`: broker contract, runtime wiring,
  laundering, forged meters, revocation, carve, pause-and-renew, replay), each check with a fail-proof.

### Pull requests

Draft stack, in order: #801/#802 (this ADR accepted); #803 to #807 (T1 to T4b: grant shape and signing, the authorizer, the broker and
ledger, landed via #807); #808 to #818 (T5 to T11a, landed via #818): #808 principal codec and `installTaskAuthority` (D3), #809
`EffectContext.flush()` (ADR 0151), #810 `taskLeaseMiddleware` (D3/D4/D5), #811 `withRenewal` (D5), #812 orchestration child-lease
spawn hook (D6), #813 child lease reservation (D6), #814 `agentLoop$` park on exhausted authority (D5), #815 conformance kit, #816
runtime-level conformance checks, #817 carve, pause-renew and replay checks, #818 slice-1 minors wave; #819 (T11b) this amendment;
#820 to #824 (T12 to T15) the follow-ups below; T16 the later amendment.

### Follow-ups

- Key rotation for parked runs (a run parked across a secret rotation cannot restore its grant). (closed, see the later amendment: R31/R35)
- Multi-tenant chains: a `taskGrant` together with `tenant`, `onBehalfOf` or a delegation (R13). (closed for `tenant` / `onBehalfOf`, see the later amendment: R30/R34; a delegation together with a grant stays refused)
- A never-started child's reservation (D6 residual). (closed, see the later amendment: R33)
- Branding the child-lease tool id (`CHILD_LEASE_TOOL`), so an app effect cannot shadow it. (closed, see the later amendment: R33)
- Cancelling the other group members when a mint is refused. (closed, see the later amendment: R33)
- A pre-existing kernel issue: `ctx.resources` exposes the fold-owned object, not a copy (the `readResources()` seam returns a copy). (closed, see the later amendment: R32)
- Slice 2: provenance taint across lineages (D7) and covered laundering.

## Amendment (2026-11-23, later) — follow-ups closed

The slice-1 follow-ups are built. The sections above and the first amendment stand, except where an item below says it reverses one.
Rulings R30 to R35 are in the slice's ledger.

### D3 — multi-tenant grants (R30, R34; T13, #821). This REVERSES the first amendment's "tenant / onBehalfOf refused"

- `tenant` and `onBehalfOf` are part of the signed `TaskGrant` (and of `MintRequest`). The principal codec restores them from the
  VERIFIED grant only, so under strict/compliance (ADR 0111) the log still holds only the ref.
- A grant that carries either field is referenced as `ta2:<taskId>.<mac>`, the MAC also binding `tenant` and `onBehalfOf` (the
  encoding is a JSON array of the four fields, so no field can be shifted into another). A grant with neither keeps the `ta1:` ref
  unchanged. `fromRef` refuses a downgrade (a `ta1:` ref naming a grant that has identity, and a `ta2:` ref naming one that has
  none), so a ref cannot be replayed under a weaker identity.
- A chain whose `tenant` / `onBehalfOf` differ from the grant's is refused at start (`toRef`), in both directions: a chain without
  them is refused for a grant that has them.
- `TaskGrantAuthorizer` enforces the same rule on the TRANSIENT path (`invokeTransient`, which has no codec): it denies with a
  reason starting `task-grant:identity` when `req.principal.tenant` / `onBehalfOf` differ from the verified grant's. Without this an
  acme grant presented with `tenant: "globex"` would be judged under globex's policy.
- A child INHERITS identity: `MintRequest` naming a different `tenant` / `onBehalfOf` than the parent's (or one the parent lacks)
  is refused, and `childGrantMinter` returns the grant's `tenant` / `onBehalfOf` on the child chain, so the child start passes `toRef`.
- The broker holds identity. Erasing `onBehalfOf` or `tenant` there (re-sign, strip or delete the grant) makes the task PERMANENTLY
  unrestorable: the MAC no longer matches, `fromRef` answers `{ principalUnresolved }`, the kernel denies and the execution
  access policy sees an unknown owner. That is fail-closed erasure, by design.
- Still refused: a `delegation` together with a task grant (R13). A delegating child is narrowed by its own grant (D6 mint), so
  delegation users mint child grants.
- The kit gains `broker.identity-fixed` (with a broken broker as its fail-proof).

### D3/D13 — key ring (R31, R35; T14, #822)

- Wherever a grant secret is accepted (`signTaskGrant` / `verifyTaskGrant`, `InMemoryGrantBroker`, `TaskGrantAuthorizer`,
  `taskLeaseMiddleware`, `taskAuthorityPrincipalCodec` / `installTaskAuthority`, `childLeaseEffect`, `childGrantMinter`) it may be
  a `GrantKeys`: a string, or `{ current, previous?, refOnly? }`. Signing and the ref MAC use `current`. Grants verify against
  `current` then `previous`. `refOnly` keys verify a recorded REF MAC (`fromRef`) and are NEVER accepted for a grant signature.
- The ring is read once and sealed (a later mutation of the caller's object changes nothing); at most 8 keys per list; empty keys
  and duplicates across `current`, `previous` and `refOnly` are refused. Verification is constant-time over the whole ring.
- **Retirement procedure.** (1) Add the new key as `current` and move the old one to `previous`: live grants verify and renew onto
  the new key. (2) Once its grants have renewed onto `current` (or the longest grant TTL has passed), move the old key from
  `previous` to `refOnly` and keep it there for the lifetime of the longest-lived run started under it. (3) Remove it only when no such
  run can still resume.
- **Removing a key strands runs.** A run started under a removed key (its recorded ref MAC no longer verifies) can never restore
  its principal: `fromRef` answers `{ principalUnresolved }` and the kernel denies. That is terminal. There is no seam to re-record
  a ref under a new key, and making `fromRef` throw so the run merely pauses was rejected (it breaks the codec contract and can
  double a renewal's side effect).
- **Why `refOnly`.** Keeping the old key as `previous` for the sake of old runs would keep a possibly-leaked key able to sign
  grants. As `refOnly` a leaked old key can only restore an EXISTING grant to its own holder, not mint or widen authority. That
  limits the exposure of the retirement window to "resume what was already granted".
- The kit gains `broker.signs-current-key`.

### D4 — `ctx.resources` is a copy (R32; T12, #820)

`EffectContext.resources` (and the `resources` handed to a decide scope's transient call) was the fold-owned object. It is now a copy,
built by the same helper as `readResources()` ([ADR 0151](0151-effect-context-flush.md) D6), `custom` included. Code that wrote
`ctx.resources.x` to affect the fold stops working; meter with `ctx.emit("RESOURCE_METERED", ...)`.

### D6 — child lease follow-ups (R33; T15, #823 and #824)

- **A never-started child returns its reservation (#823).** `GrantBroker` records the reservation the parent made in its fold:
  `reserve(parentTaskId, childId, lease)` (called by the reserve step after the fold meters it). If the child will never start (its mint
  was refused, or the supervisor gave up), `settleUnstarted(childId, parentTaskId)` makes the WHOLE reservation takeable once through
  `takeReturn`, and revokes a grant minted for it but never claimed. A child is EITHER started (`settleChild`, or already claimed) OR
  unstarted, never both: whichever comes first wins and the other changes nothing. This closes the first amendment's known residual.
  The kit gains `broker.unstarted-return`.
  **Lineage stays within the root ceiling (R36).** The broker compares the parent's fold `lease.<n>.reserved` (a gross counter) against a
  NEVER-DECREASING per-parent `carved[n]` (each minted ceiling, plus an unminted child's reservation once it settles unstarted), not
  against the live high-water sum, which a returned reservation lowers: otherwise a flow could spawn an unreserved child on top of the
  refilled parent lease and reach twice the ceiling. The released high-water serves only the ceiling headroom check. `settleUnstarted`
  MUST be atomic with `claim` (check-unclaimed and revoke are one compare-and-set); the kit has a non-atomic mutant and a concurrent case.
  The reserve step refuses a `child` that does not start with `<executionId>::` (a flow cannot squat another execution's child id). A
  transient failure that makes the supervisor call `settleUnstarted` becomes a permanent "unstarted" outcome (the child is not retried);
  a `broker.reserve` throw after the flush leaks the fold reservation (the safe direction).
- **A refused group mint cancels started members (#824).** When a mint for one member of a spawn group is refused, the supervisor
  cancels the members that already started (`cascadeCancel`), instead of leaving them running beside a refused sibling. A `detached`
  member is skipped, matching the ADR 0112 cascade.
- **The child-lease effect is branded (#824).** `childLeaseEffect()` is recognised by a module-private brand (`isChildLeaseEffect`), not by
  its tool id, so an app effect registered under `CHILD_LEASE_TOOL` cannot shadow the exemption.
  **Breaking:** the lease middleware can only see which effect is registered through `effects: () => effectRuntime` (a getter, since
  the runtime is built after its middleware). Wiring that registers `CHILD_LEASE_TOOL` and does not pass `effects` loses the exemption:
  the middleware throws `LeaseChildEffectUnbrandedError` (naming both causes: no `effects` lookup, or two copies of the package) and the
  effect never runs.
- **`GrantBroker` gained required methods.** A broker written against slice 1 must add `reserve`, `settleUnstarted` and (from the first
  amendment) `claim`, `holder`, `settleChild` and `takeReturn`; the conformance kit fails a broker that lacks or mis-implements them.

### Still open

Slice 2, none of it built: provenance taint across lineages (D7), `reads` scoping (D8), grant derivation (D9), `ambient` and the enforcing sandbox (D10), the schedule root (D11) and disclosure (D12); and covered laundering, which the kit reports as skipped. The `@loomwork/verify` options the header promised did not ship with slice 1.

## Amendment (2026-11-23, slice 2 design)

Slice 2 (D7–D12) was designed against the code at main 7409550f. The kernel seams it needs are decided in
[ADR 0152](0152-seen-origins-and-schedule-principal.md) (Proposed). Earlier text above is kept unchanged. Where research showed a premise to be wrong, the correction is marked "(corrected)".

### Owner decisions (2026-11-23)

- **D7 (changed):** the "seen origins" set is a KERNEL field, `EffectContext.seenOrigins` (ADR 0152 D1), so the policy covers every flow, not only agent loops. The text above has `agentLoop$` keep the set; `sawTaintFrom` stays a prompt-fencing local there.
- **D8 (changed):** reads are made checkable by turning memory recall into an EFFECT (`agentLoop$` `recall.toolId`), with the resource being the scope, so a `reads` grant can be enforced by the existing authorizer path instead of by wrapper stores alone.
- **D12 (changed):** a small `TimerService` principal hook, `principalFor` (ADR 0152 D2), plus a one-off approval run that mints the schedule grant, because approvals are park-bound and a schedule has no park.
- **D11 (changed):** disclosure is an opt-in `agentLoop$ authority.onDenied: "fail" | "opaque" | "reason"`. The default `"fail"` keeps today's behaviour.

### Controller rulings

- **S-R1 (D7, D8): writer tagging is content-level.** Writers wrap shared content as `tainted(value, "lineage:<rootId>")` using their verified task grant (memory write-back effect, an inbox-send helper, A2A). Memory and inbox already round-trip taint wrappers, so no store SPI change; re-tainting keeps the original origin, so an `inbox:<topic>` delivery keeps `lineage:A`. This replaces "writes are stamped with the writer's `rootId`" in D8.
- **S-R2 (D7): the write-class floor is app-supplied.** `directedBy({ appliesTo: (toolId, resource?) => boolean })` (or a set); no `Effect.effectClass` runtime field, which would be a second kernel change. Default: every leased effect. This replaces D7's "`effectClass` at or above a floor (default `write`)".
- **S-R3 (D7): foreign** means a `lineage:` origin whose rootId differs from the acting grant's rootId. Non-lineage untrusted origins (`mcp:`, `inbox:` without lineage) are reported but do not trigger the policy unless `foreign: "any-untrusted"`. The kernel overflow marker counts as foreign.
- **S-R4 (D8, D10): grant fields** `reads?: string[]` (globs over `<toolId>:<resource>` read capabilities) and `sandbox?: "isolated"`. `sandbox` is the rename of D10's `ambient` (and of the `grant.ambient = "none"` form), which collides with `EffectMode "ambient"`. Both are signed, encoded only when present (the T13 pattern), children are subsets of the parent, and renewal preserves them.
- **S-R5 (D9): placement.** `reachOf(runtime, flowId)` lives in `@loomwork/app`, which already builds reach; `deriveGrant(reach)` is structural in task-authority; the rule `task-grant-reach` in `@loomwork/verify` reads app-supplied grant templates (`checks.verify.taskGrants`), since grants are minted at runtime. An `agentLoop$` reach is its tools plus its skills' tools plus the `toolSearch` catalog, documented as wide. This replaces `deriveGrant(flow | agentLoopConfig)` taking the flow directly.
- **S-R6 (D10): enforcement** is a per-call middleware that reads the registered effect's `capabilities` through the `effects` getter; `sandbox: "isolated"` refuses a sandbox effect whose backend is not `network: "none"` plus `freshPerRun`. It is not a `sandboxEval$` change.
- **S-R7 (D7): A2A ingress** gets a taint in `plugins/a2a` (`a2a-inbound:<peer>`), plus a lineage origin when the caller's principal carries a grant.

- **S-R8 (D7): the seen-origins bounds are configurable and recorded per run.** `maxOrigins` and `maxScanNodes` are set through runtime options and stamped on `EXECUTION_STARTED`, so replay uses the recorded limits and never the current config; a run started before EVENT_SCHEMA 1.27.0 uses the defaults. A pre-1.27 snapshot is rescanned once at upgrade (ADR 0152 D1).

### Corrected premises

- **D7 "each of these seams already taints third-party content" is partly false (corrected).** Only the inbox is tainted at ingress (`deliveredValue`, `inbox:<topic>`). Memory recall, durable state and A2A-inbound are not tainted at ingress, and no store records a writer. Hence S-R1 (tag at write, content-level) and S-R7 (A2A ingress taint). "D7 only sets the origin label" is therefore wrong: D7 also adds the tainting at those seams.
- **D8 "content refs already refuse foreign references (`acceptContentRefParam`, ADR 0120)" (corrected):** `acceptContentRefParam` does not exist in the code. Do not rely on it; any content-ref refusal is a separate piece of work if wanted.
- **D11 "`"reason"` ... is today's behaviour" is false (corrected).** A capability denial is TERMINAL: `isTerminalToolError` throws it out of the turn and it never reaches the model (R4, R10; `AgentRunner` and `agentLoop$`). So the model sees neither a reason nor an opaque string today. `"fail"` (default, unchanged) names today's behaviour; `"opaque"` and `"reason"` are NEW modes that hand the model a refusal result instead of ending the run.
- **D11 and D12 labels are swapped in "Still open" (corrected).** That paragraph says "the schedule root (D11) and disclosure (D12)". The decisions are D11 = refusal disclosure and D12 = root authority for scheduled runs, as in the headings above.
- **D12 "recorded `APPROVAL_GRANTED` ... answers for every tick" needs a run to hang on (corrected):** approvals are park-bound (`verifyApproval` on resume), so the schedule grant is approved in a one-off run that parks, and `TimerService` starts ticks with no principal today (`startOccurrence`), which ADR 0152 D2 fixes.
