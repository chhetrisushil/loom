# ADR 0150 — Task-scoped authority: grants per task, effect leases that pause when spent, and accounting by lineage, as an opt-in package

- Status: **Accepted** (2026-11-23) — design accepted by the owner; implementation (slice 1, then slice 2) pending
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
  `@loomwork/agent`, `@loomwork/orchestration` and `@loomwork/verify`. **Kernel change: zero.** Every piece sits
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

**Does not:** add a syscall, an event type, a fold key or an `EffectContext` field. The rejected alternative
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
  reads?: string[];      // D8: Loom namespaces this task may read across lineages
  ambient?: "none" | "declared"; // D10
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

`LeaseExhaustedError`, `GrantExpiredError` and `GrantRevokedError` share the marker `renewable: true`.

- **`withRenewal(ctx, id, fn)`** for plain flows. When `fn` throws a renewable error, it suspends on the typed gate
  `task-authority:renew` (ADR 0077) carrying a `RenewalRequest`:
  `{ taskId, epoch, spent, renewals, effectClassesCaused, justification? }`. The broker resumes it with a
  `RenewalVerdict { granted, epoch, digest }`, authenticated by the app's `ResumeAuthenticator`, so the durable
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
child completes, its unused amount travels in the `CHILD_DONE` payload. The parent meters
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
