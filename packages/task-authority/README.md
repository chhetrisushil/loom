# @loomwork/task-authority — authority scoped to the task

A valid credential does not say whose work is being done. ADR 0150 targets transfer (laundering): one
agent doing another's work with its own, perfectly valid credentials, so a prompt-injected or delegating
agent can spend authority that was never meant for the task. This package binds authority to the task: a
signed per-task grant names the effects an execution may run, side-effect leases count attempts and pause
the run for renewal when exhausted, and a child's lease is carved from its parent's by reservation. The
kernel is untouched; everything sits behind the existing authorizer and metering seams.

Slice 1 surface (see `docs/api-reference.org`):

- `signTaskGrant` / `verifyTaskGrant` / `taskGrantDigest` / `validateGrantShape`: the HMAC-signed grant token.
- `TaskGrantAuthorizer`: denies effects outside the grant, and a grant held by the wrong principal.
- `InMemoryGrantLedger` / `InMemoryGrantBroker` (`GrantSource`, `GrantBroker`): mint, renew, revoke, claim.
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
- Key rotation: a secret may be a `GrantKeys` ring (`current`, `previous`, `refOnly`); removing a key strands
  runs started under it, so retire through `refOnly` (see the user guide).
- `@loomwork/task-authority/conformance`: a kit that proves a broker and runtime wiring resist laundering.

Design: [ADR 0150 — task-scoped authority](../../docs/adr/0150-task-scoped-authority.md).
