# ADR 0045 — Deferred security hardening (HTTP auth seam, delegation binding, lockfile validation)

- Status: Accepted (2026-07-13)
- Date: 2026-07-13
- Builds on: the [codebase audit](../requirements/2026-07-13-codebase-audit.md) (deferred items
  S1–S6), K2/K12 (capability + delegation authority), K7 (isolation).
- Part of: closing the audit's deferred *security* findings. Additive/opt-in (G2) — byte-identical
  when unwired.

## Context

The audit found the classic sinks clean but flagged real gaps it did not fix in-pass because they
were design-level. This ADR records the decisions taken for the ones that are cleanly, safely
implementable now, and why the rest stay deferred.

## Decisions

### D1 — HTTP servers get an opt-in `authorize` seam, not a baked-in scheme

`plugins/worker-server` (`POST /execute` + `/cancel`) and `plugins/a2a` (`/tasks/*`) were
unauthenticated: a caller could run any registered flow and inject resume/approval events into any
execution (S1/S2/S3, HIGH). Rather than impose a scheme, both servers gain an optional
**`authorize?: (req) => boolean | Promise<boolean>`** hook. When wired it gates the mutating routes
(401 otherwise); the health/agent-card routes stay open. Unwired, behaviour is unchanged.

Rationale (G3 — the ring supplies the gate, policy supplies the content): the kernel/plugin cannot
know the deployment's trust fabric (shared secret, mTLS via `req.socket`, a signed dispatch token,
a gateway that already authenticated). A hook lets the integrator bring exactly their scheme in a
few lines; a baked-in `authToken` would privilege one scheme and still not cover mTLS. The option's
docstring states plainly that **unwired = unauthenticated, run only behind a trusted boundary.**
A2A additionally now rejects a non-string `task.id` (it becomes the executionId verbatim).

**Still deferred:** threading an authenticated **principal** from the HTTP layer through
`WorkerRequest`→runtime so the *fine-grained* `executionAuthorizer` (K12) engages per request. The
`authorize` gate already stops unauthenticated arbitrary execution (the HIGH impact); principal
threading is a smaller, additive follow-up (map the gate's identity into `pkg.metadata` → runtime
`options.principal`).

### D2 — Delegation tokens are bound to their holder *and* may carry a signature-bound expiry

Extends the confused-deputy fix already shipped (a token minted for `issuedTo` is honored only when
presented by `req.principal.actor`). Now `DelegatedGrant` may carry an optional **`exp`** (epoch
ms), appended into the signed payload *only when present* (so tokens without it sign the exact prior
payload — backward-compatible) and therefore tamper-proof. `DelegationAuthorizer` rejects an expired
token via an injectable clock (`now`, default `Date.now`). A token without `exp` never expires, as
before. (S4.)

### D3 — `--from-spec` lockfiles re-assert the id slug shape on read

The live NL path guarantees safe ids by construction (`slug()`); the `--from-spec` path read the
`ChangeSpec` verbatim, so a crafted/shared `.spec.json` could traverse the output dir (`cap.id =
"../.."`) or inject a non-identifier id into codegen. `readLockfile` now asserts every
capability/step id matches `^[a-z0-9]+(-[a-z0-9]+)*$`, rejecting otherwise. (S5.)

## Still deferred (recorded, lower value)

- **S6 — path-containment guard** on codegen output writes (appgen/scaffold/cli). Trusted CLI args;
  a shared `assertWithin(root, candidate)` is cheap hardening but not load-bearing given the trust
  boundary. Template-level escaping of interpolated `name`/`intent` (comment/string breakout) is the
  companion follow-up.
- **S7 — egress private-IP recheck** post-resolve in `isolate/src/broker.ts` (metadata-SSRF
  hardening). Resolve-and-pin already defeats DNS rebind; the allowlist is trusted config.
- **Delegation revocation** (`jti` + revocation set) — only relevant once delegation is wired into a
  production flow (it is opt-in/test-only in-tree today).

## Consequences

Every change is opt-in and byte-identical when unwired (G2). New tests: worker-server authorize
gate, delegation expiry + tamper, lockfile id validation. Full suite green.
