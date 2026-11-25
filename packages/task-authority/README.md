# @loomwork/task-authority — authority scoped to the task

A valid credential does not say whose work is being done. ADR 0150 targets transfer (laundering): one
agent doing another's work with its own, perfectly valid credentials, so a prompt-injected or delegating
agent can spend authority that was never meant for the task. This package binds authority to the task: a
signed per-task grant names the effects an execution may run, side-effect leases count attempts and pause
the run for renewal when exhausted, and a child's lease is carved from its parent's by reservation. The
kernel gains three optional `EffectContext` methods (`flush`, `readResources`, and `seenOrigins`, ADR 0152) and one composition-time method,
`WorkflowRuntime.reserveEffectDimensions` (ADR 0151); the rest sits behind the existing authorizer, metering and
principal-codec seams. Needs `@loomwork/workflow-runtime` 0.1.5 or later for slice 1 and 0.1.7 or later for slice 2 (`seenOrigins`, `principalFor`, the `committed()` principal): `installTaskAuthority` throws on a host
without `reserveEffectDimensions`, and the lease middleware throws `LeaseDurabilityError` where `flush` or
`readResources` is absent (the transient seam).

Core surface (slice 1 plus the signed grant fields; see `docs/api-reference.org`):

- `signTaskGrant` / `verifyTaskGrant` / `taskGrantDigest` / `validateGrantShape`: the HMAC-signed grant token.
- `TaskGrantAuthorizer`: denies effects outside the grant, and a grant held by the wrong principal.
- `InMemoryGrantLedger` / `InMemoryGrantBroker` (`GrantSource`, `GrantBroker`): mint, renew, revoke, claim. The default
  renewal policy tops up each exhausted lease by its minted ceiling, one tranche per renewal, up to 8 renewals; a child
  grant's exhausted lease is denied (it needs a new parent reservation).
- `taskAuthorityPrincipalCodec` / `installTaskAuthority`: carry the grant on the principal as a ref.
- `taskLeaseMiddleware`: counts leased effects on live fold state, durable before the effect runs, with a
  revocation check (only when you pass a `source`).
- `withRenewal` / `answerRenewal`: pause on an exhausted lease and resume on a renewal verdict.
- `childLeaseEffect` / `childGrantMinter` / `reserveChildLease`: carve a child's lease from its parent's. Register the
  effect as `CHILD_LEASE_TOOL` and give the lease middleware `effects: () => effectRuntime`: only the effect
  `childLeaseEffect()` made is exempt from counting, and without the lookup (or with another effect under that id)
  the middleware throws `LeaseChildEffectUnbrandedError`.
- Multi-tenant: `tenant` / `onBehalfOf` are signed into the grant, bound in a `ta2:` ref, denied on mismatch
  (`task-grant:identity`) and inherited by children.
- Grant fields `reads` and `sandbox: "isolated"` (ADR 0150 S-R4; both are enforced: see "Read scope" and "Isolated sandbox" below):
  `reads` is a list of globs (`*` matches any run of characters, bare `*` refused) over `<toolId>:<resource>` read
  capabilities; `sandbox` asks that a sandbox effect be network-less and fresh per run. Both are signed and encoded only
  when present (a grant without them keeps its signature), a child's `reads` must be covered by the parent's (absent
  = none) and a child of an isolated parent must be isolated, and a renewal keeps both. `childGrantMinter` passes the
  parent's through. Each `reads` entry is `<toolId>:<glob>` with a literal tool id (`**`, `*:*`, `:*` are refused), at most 4 `*`, unique,
  16 KB in total. `globCovers` / `widensReadsOrSandbox` are the reference subset check for third-party brokers.
  Upgrade every verifier before minting grants with these fields: an older verifier refuses them (fail closed).
- Key rotation: a secret may be a `GrantKeys` ring (`current`, `previous`, `refOnly`); removing a key strands
  runs started under it, so retire through `refOnly` (see the user guide).
- Strict leases: `taskLeaseMiddleware` defaults to `strictLeases: true`, so an in-scope effect that no lease counts is
  refused when called (`LeaseUnmappedError`).
- `@loomwork/task-authority/conformance`: a kit that proves a broker and runtime wiring resist laundering. It no longer skips `laundering.uncovered.a2a`: pass `a2a: A2ATransport` on the subject (an in-process hop; build it on `LoomAgentExecutor` from `@loomwork/plugin-a2a`, see `plugins/a2a/src/kitLaundering.test.ts`) and the kit has A ask B for a step B's own authority does not cover and requires a `task-grant` refusal. Without a transport the check is reported `skipped: no A2A transport supplied`, never passed.

## Isolated sandbox (`sandbox: "isolated"`, ADR 0150 D10)

`sandboxRequirement({ secret, effects: () => effectRuntime })` refuses (terminal, `task-grant:sandbox`), per call, a sandbox
effect under an isolated grant unless its backend declares `network: "none"` and `freshPerRun: true`. A sandbox effect is
one whose `capabilities` has `language`, `network` or `freshPerRun` (the `read` marker is not one; a partial declaration is
refused). Caps are read once per registered effect. Effects without a sandbox declaration are not refused (D10 names no
rule for ambient tools), a grant without `sandbox` is unchanged, and a run with no task grant is not governed. Kit check: `sandbox.isolated`.

## Read scope (`reads`, ADR 0150 D8)

An effect that declares `capabilities: { read: true }` is a READ. The runtime marks its authorization request `read: true`, and
`TaskGrantAuthorizer` denies it (`task-grant:read-scope`) unless `<toolId>:<resource>` is covered by one of the grant's `reads`
globs (`globCovers`); a grant with no `reads` covers nothing. EVERY declared read is checked: own-lineage reads are not exempt, so
the minter lists the task's own namespace. Cross-lineage CONTENT is attributed by `directedBy`, not here. `memoryRecallEffect(memory)`
(resource = the recall scope; use it with `agentLoop$({ recall: { toolId } })`) and durable-state `load` (resource = the key)
self-declare. Residual: an app must mark its OWN read tools (`new ToolEffect(fn, { resourceOf, capabilities: { read: true } })`); an
unmarked read is not checked, and a run with no task grant has no `reads` check. Conversation-id reads are not built. The kit check `reads.read-scope` guards the reference authorizer and the broker's `reads` at mint, not a third-party authorizer. A spawn may narrow (leased children only: `reads` without a `lease` is refused) a child with `awaitChild({ reads })`; inheritance stays the default and the broker
refuses a widening.

## Covered laundering (`directedBy`)

`directedBy({ secret, action?, appliesTo?, foreign?, foreignPrefixes? })` is a per-effect middleware (after `taskLeaseMiddleware`) that
acts when a foreign lineage directed a leased effect: `attribute` (default, records `task-authority:directed-by`), `park`, or `deny`
(`task-grant:cross-lineage`). Foreign: another `lineage:`, the overflow marker, any `unknown:` label, and `foreignPrefixes` (added to the default
`a2a-inbound:`; `defaultForeignPrefixes: false` drops it). Park approval is the signed grant field `approvedLineages`, written only by a broker built with
`approveCrossLineage`. Needs `kernel.features.seenOrigins`; an untracked run fails closed (`task-grant:untracked`).

Only these channels are attributed: `lineageSend`, `memoryWriteBackEffect(memory, { originOf: ctx => lineageOrigin(secret)(ctx.principal) })`,
A2A `taintInbound` + `lineageOf`, and `CHILD_DONE`. Raw `runtime.send`, other memory writes, durable state, conversations and `mcp:`
read as clean unless you list their prefix; a grant-holder on a raw path can label content with any lineage. See the user guide.

## Scheduled agents (ADR 0150 D12)

A schedule has no human per run, so its root authority is a **schedule grant** approved once.
1. In a one-off flow call `await requestScheduleApproval(ctx, { scheduleId, issuedTo, effects, leases, ttlMs })` (it parks);
   an operator answers with `answerScheduleApproval(runtime, broker, executionId, { approved: true }, resumeOpts, { expect: { issuedTo } })` (`expect.issuedTo` is REQUIRED, and `expect` is required in the types), which mints the grant
   (`taskId` = `scheduleId`) only after the runtime accepted the approval. Its `leases` are the TOTAL budget over all ticks.
2. Give the `TimerService` (or `defineConfig({ timers: { principalFor } })`) `principalFor: schedulePrincipalFor(broker, { lease: { calls: 50 } })`.
   Each occurrence runs under its own child grant `<scheduleId>@<occurrence>`; a missing, expired, revoked or exhausted schedule grant skips that occurrence
   (`SchedulePrincipalError`), never an anonymous run. Under `requirePrincipal`, `committed()` receives that principal.
   The tick grant inherits the schedule's `reads` and `sandbox`. The hook reserves and mints one grant per occurrence;
   a tick that minted but never started is released by `reclaimScheduledTick(broker, scheduleId, occurrence)` (grant unclaimed and expired
   by `RECLAIM_MARGIN_MS`, 60 s), which revokes it and frees the headroom: run it from a periodic sweep over skipped occurrences.
   `answerScheduleApproval(..., resumeOpts, { expect: { issuedTo, tenant, onBehalfOf }, onMinted, requireVerifiedApproval })`: `expect.issuedTo` is REQUIRED (an approver is
   not the service it approves) and the spec's tenant / onBehalfOf must equal `expect`'s and the approval run's principal's (a codec-encoded principal hides it: `expect` binds).
   Crash recovery (re-answering a completed run) needs the marker `requestScheduleApproval` writes only after an approval, and with `requireVerifiedApproval` (set it when the runtime has a
   `resumeAuthenticator`) the kernel-written `APPROVAL_GRANTED`; a denied-then-caught run or a hand-written decision mints nothing. a tick cannot `continueAsNew` (R17).
3. After a completed tick, `settleScheduledTick(runtime, broker, scheduleId, occurrence)` records its unused lease (`broker.takeReturn` takes it once).
   A completed tick's unused lease is REFUNDED to the schedule grant's headroom (a parent no execution holds has no fold; broker contract, ADR 0150 D12), so a ceiling of 100 and 10 per tick runs well past 10 ticks.

## Child leases

1. List `task-authority:child-lease` (`CHILD_LEASE_TOOL`) in the parent grant's `effects`: with `TaskGrantAuthorizer`
   wired, the reserve step is otherwise denied `task-grant:scope`. A child inherits the parent's `effects` unless the
   spawn passes `grants`, and a narrowed `grants` must list it too if the child reserves.
2. Register `effects.register(CHILD_LEASE_TOOL, childLeaseEffect({ secret, broker }))` and give the lease middleware
   `effects: () => effectRuntime`.
3. In the parent flow, reserve, spawn, then settle after a completed child:
   `const r = await reserveChildLease(ctx, "k1", { writes: 3 }); await awaitChild(ctx, { key: "k1", flowId, input, ...r.spawn }); await r.settle();`
   The child's execution id is `<parentExecutionId>::<key>` and the reserve step refuses any other.
4. Give the supervisor the minter: `superviseChildren({ ..., taskAuthority: childGrantMinter(broker, { ttlMs }) })`. A spawn
   with a `lease` and no `taskAuthority` hook fails closed.

A custom `GrantBroker` must implement `mint`, `renew`, `revoke`, `claim`, `holder`, `settleChild`, `takeReturn`,
`reserve` and `settleUnstarted` (plus `current`, and optionally `revoked`); run `@loomwork/task-authority/conformance`
against it. Guide: [Write your own grant broker](../../docs/custom-grant-broker.md).

Design: [ADR 0150 — task-scoped authority](../../docs/adr/0150-task-scoped-authority.md).
