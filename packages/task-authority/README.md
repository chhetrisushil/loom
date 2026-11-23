# @loomwork/task-authority — authority scoped to the task

A valid credential does not say whose work is being done. ADR 0150 targets transfer (laundering): one
agent doing another's work with its own, perfectly valid credentials, so a prompt-injected or delegating
agent can spend authority that was never meant for the task. This package binds authority to the task: a
signed per-task grant names the effects an execution may run, side-effect leases count attempts and pause
the run for renewal when exhausted, and a child's lease is carved from its parent's by reservation. The
kernel gains two optional `EffectContext` methods (`flush`, `readResources`) and one composition-time method,
`WorkflowRuntime.reserveEffectDimensions` (ADR 0151); the rest sits behind the existing authorizer, metering and
principal-codec seams. Needs `@loomwork/workflow-runtime` 0.1.5 or later: `installTaskAuthority` throws on a host
without `reserveEffectDimensions`, and the lease middleware throws `LeaseDurabilityError` where `flush` or
`readResources` is absent (the transient seam).

Slice 1 surface (see `docs/api-reference.org`):

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
- Grant fields `reads` and `sandbox: "isolated"` (ADR 0150 S-R4; `reads` is enforced from S6 (see "Read scope" below), `sandbox` from S8):
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
- `@loomwork/task-authority/conformance`: a kit that proves a broker and runtime wiring resist laundering.

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
against it.

Design: [ADR 0150 — task-scoped authority](../../docs/adr/0150-task-scoped-authority.md).
