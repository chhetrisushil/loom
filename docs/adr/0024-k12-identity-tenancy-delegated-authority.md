# ADR 0024 — K12: identity, tenancy & delegated authority

- Status: Accepted (implemented 2026-07-10 — K12.1 `CapabilityRequest.principal`
  (`PrincipalChain`, carried opaquely; threaded start→resume via `RunOptions.principal` →
  `EffectContext` → authorizer, A1); K12.2 `ResumeAuthenticator` + durable `APPROVAL_GRANTED`
  fact (event schema 1.9.0, folds `variables._approvals`), a rejected/forged approval refuses
  the resume (`ApprovalRejectedError`, A6); K12.4 verifiable attenuated delegation —
  `signDelegation`/`verifyDelegation`/`attenuateDelegation` (HMAC-bound) + `DelegationAuthorizer`
  that verifies at the callee and authorizes only the intersection of the verified delegation
  and the callee's own grants (A2 — forged tokens denied outright); K12.5 `TenantScopedEventStore`
  + `TenantScopedSnapshotStore` — key-prefixing wrappers (default per A7) with cross-tenant
  isolation **by construction** (a tenant store can only address its own keys; fork stays
  in-tenant); K12.3 `nestedBudgetMiddleware` + `BudgetLedger` — tenant→workflow→execution
  admission control where the broader levels read a cross-execution **projection** and the
  execution level reads the pure fold, most-restrictive wins, `QUOTA_EXCEEDED` attributed to
  its `level` (A5 — the projection/fold category difference stated explicitly). Amendments
  below applied.)
- Date: 2026-07-10
- Requirements: [K12 in the kernel-hardening requirements](../requirements/2026-07-10-kernel-hardening-k7-k12-t1-t2.md#k12--identity-tenancy--delegated-authority) — priority **P2**

## Context

K2's `GrantTable` principals are workflow ids; `approvedBy` on an approval resume is an
unverified string in the payload. There is no tenant model, no quota hierarchy, no
attenuated delegation. Kernels have *users*; Loom currently has only *workflows*. Required
for platform/multi-team use — single-team pilots can defer, hence P2.

## Decision

Extend the authority ring from "which workflow" to "which tenant, actor, and delegation
chain," keeping every verdict a durable fact:

- `CapabilityRequest` becomes extensible with an authenticated principal chain
  (`tenant / actor / onBehalfOf`), populated at the trust boundary (A2A server, resume API)
  and propagated immutably through dispatch (K12.1).
- Resume events that gate authority (approvals) support verification: a pluggable
  `ResumeAuthenticator` whose verdict is recorded in the durable fact
  (`APPROVAL_GRANTED { actor, verifiedBy }`), so "who approved" is evidence, not a claim
  (K12.2).
- K3 budgets nest (tenant → workflow → execution), with the most restrictive bound enforced
  and each trip attributed to its level (K12.3).
- Capability grants support **attenuated delegation**: an A2A callee receives at most the
  intersection of its own grants and the caller-delegated set — never ambient escalation
  (K12.4).
- Multi-tenant stores scope reads/subscriptions by tenant (Postgres row-level security or
  key-prefixing), conformance-tested against cross-tenant leakage (K12.5).

## Acceptance criteria

A forged approval without a valid authenticator verdict does not resume the execution; a
delegated A2A call cannot invoke an effect the delegator lacked; tenant A cannot read or
subscribe to tenant B's executions; nested budgets trip at the correct level with correct
attribution.

## Consequences

- Loom becomes deployable as a *platform* kernel (many teams, many tenants) rather than a
  single-team runtime; approvals become auditable evidence.
- `CapabilityRequest`, the K3 budget model, and the store SPIs all grow tenant awareness —
  the widest-touching item in the series, which is why it trails the P0/P1 work.
- Attenuated delegation (K12.4) composes with K7's per-tool credentials
  ([ADR 0019](0019-k7-data-plane-isolation-and-egress-control.md)): together they bound what
  a compromised or over-eager agent chain can reach.
- Unwired (no authenticator, single tenant, flat budgets), authorization behavior is
  byte-identical to today's `GrantTable` (G2).

## Amendments (code-grounded evaluation, 2026-07-10)

Adopted per the [K12 evaluation](../requirements/2026-07-10-kernel-hardening-evaluation.md#k12--identity-tenancy--delegated-authority--accept-with-amendments)
(verdict: **Accept with amendments**):

- **A1 — opaque principal chain**: `CapabilityRequest` (today a closed 4-field interface)
  gains an optional `principal?: PrincipalChain` that the kernel **carries opaquely and
  never interprets** — authorizers, budget scopes, and stores interpret it. The kernel gets
  no tenant model of its own; that preserves genericity (P10).
- **A2 — verifiable delegation (closes a forgeability hole in K12.4)**: an attenuated grant
  set carried as a plain request field is forgeable by any caller or middlebox. Delegation
  must be verifiable at the callee's trust boundary (signed grant sets / macaroon-style
  attenuation caveats), verified *before* the intersection is computed.
- **A3 — identity × K10**: principal chains in durable payloads are PII. Tenant/actor
  identifiers in events are **opaque pseudonymous IDs** (needed forever for K12.5 scoping —
  never shredded); human-readable identity lives in payload fields eligible for
  K10.2/K10.3 erasure ([ADR 0022](0022-k10-log-lifecycle-retention-redaction-encryption.md)).
- **A4 — tenancy × fork**: `fork()`/`copyPrefix` across tenants is denied or explicitly
  re-scoped, covered by the cross-tenant leakage conformance suite.
- **A5 — nested budgets are projections**: a tenant-level budget aggregates across many
  executions' logs — admission control over a *projection* (eventually consistent), not a
  replay-pure per-execution fold like K3. This category change is explicit: the verdict is
  still durable and logged (P9-admissible), but it must not be contorted into a pure fold
  (impossible) or left unlogged (unauditable).
- **A6 — facts**: `APPROVAL_GRANTED { actor, verifiedBy }` is a **new durable fact** (today
  approval is a custom `"ApprovalGranted"` resume event carrying an unverified string) —
  see the corrected fact list in the evaluation doc. Unwired remains today's spoofable
  behavior, documented as such.
- **A7 — store scoping perf**: tenant-column + index (or key-prefixing) is the default;
  Postgres row-level security is an optional hardening layer, benchmarked before it is
  recommended (RLS predicates tax every query).

---

## Amendment (2026-09-14) — A2's trust model, made explicit

A2 above requires delegation to be "verifiable at the callee's trust boundary". The shipped
primitive (`signDelegation`/`verifyDelegation`, HMAC-SHA256) delivers a **narrower** property
than that phrasing suggests, and the difference was never written down. It is now.

**What the signature does.** It stops a *third* party — a caller, a middlebox, anything in
transit — forging or tampering with a grant set. That is the hole A2 identified and it is
closed.

**What it cannot do.** The secret is **symmetric**: the party that verifies is also a party
that can mint. A callee can sign itself `{ grants: ["*"] }`, and that token is *genuine* —
`verifyDelegation` returns `true` and no signature check can reject it. So a verified
delegation cannot, on its own, bound the authority of the party verifying it.

**Why the design is nevertheless sound.** Authority over the callee comes from the
**intersection** with `base` (the callee's own grants), never from the token. With `base`
set, self-minting buys a callee nothing it did not already hold. `DelegationAuthorizer`'s
`base` is therefore **load-bearing for security, not a convenience**.

**What changed.** `base` was optional, documented as *"omit to allow the full verified
delegated set (the callee delegates all of its authority decisions upstream)"*. That mode
could not deliver what it claimed — upstream cannot retain authority over a callee holding
the minting key — and an absent `base` silently reduced the intersection to a no-op while
still reading as a working gate (the vacuous-check pattern). `base` is now **required**, with
a constructor guard because the type alone is not enforcement for JS callers, and two tests
pin the reasoning: one asserts construction without `base` throws, the other asserts a
*self-minted, validly signed* wildcard token still cannot exceed the callee's own grants.

Blast radius at the time of the change: no production construction sites in this repo or any
sibling — only tests.

**Scope boundary.** Delegation **across** organisations, where the verifier must not be able
to mint, is **out of scope** for this primitive. It needs asymmetric signatures (and the key
distribution and rotation that come with them). If a second, unrelated consumer appears that
genuinely spans trust domains, that is the trigger to revisit — not before ([ADR 0083](0083-second-consumer-rule.md)).

> The same symmetry applies to the `sig` field of the tamper-evident audit chain
> ([ADR 0037](0037-tamper-evident-audit-chain.md)): an auditor handed the HMAC secret to
> verify history can also rewrite it. That chain's guarantee is tamper-**evidence** against
> third parties, not third-party **verifiability**.
