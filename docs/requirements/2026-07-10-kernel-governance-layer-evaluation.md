# Kernel Governance Layer — Critical Evaluation & Delivery Record

> **Status:** Adopted — evaluates the [governance-layer proposals](2026-07-10-kernel-governance-layer.md)
> and drives [ADR 0035](../adr/0035-kernel-governance-layer.md). All four accepted and **shipped**.
> **Date:** 2026-07-10
> **Stance:** strict-gatekeeper — separate "already there / needs consolidation" from genuinely new,
> and refuse artifacts that could lie (a maturity badge with no evidence behind it).

## The finding that shaped the design

**All four proposals read from the same source of truth** — the version constants, conformance
coverage, and per-subsystem evidence that already exist. Verified against source: 9 version
constants (`KERNEL_ABI_VERSION`, `EVENT_SCHEMA_VERSION`, `WIRE_ABI_VERSION`, four `*_SPI_VERSION`,
`COMPILER_MANIFEST_VERSION`), all conformance-pinned; maturity was **narrative only** (ADR status
lines / verdict tables); most fitness checks already existed as pinned tests but weren't unified;
normative spec content existed scattered across `architecture.md` + `docs/loom-2.0/*`.

So instead of four disconnected artifacts, the delivered design is **one machine-readable kernel
manifest** (`@loom/spec`) that imports the real constants + a curated capability registry, with
**three views + one enforcer** over it: the compatibility matrix (view), the maturity badges
(view), the spec (normative prose citing it), and the fitness suite (keeps it honest). The
unification is the substantive amendment to the proposal.

## Verdict summary

| # | Proposal | Verdict | Shipped |
|---|---|---|---|
| 1 | Capability Maturity Model | **ACCEPT — with a correctness upgrade** | `@loom/spec` capability registry with **evidence-derived, drift-checked** levels (`spec.test.ts` fails if a badge claims a version constant / conformance test / bench it lacks). Generated `docs/spec/maturity.md`. |
| 2 | Architectural Fitness Functions | **ACCEPT — consolidation + 2 real gaps** | Added `typecheck` + `lint` to CI (were missing) + a root `pnpm fitness`; a machine-stable **relative-ratio** G2 gate (`verify/src/g2ratio.test.ts`); `docs/spec/fitness-functions.md` mapping each of the 7 invariants to its enforcement site. |
| 3 | Loom Kernel Specification | **ACCEPT — consolidation + binding narrative** | `docs/spec/loom-kernel-specification.md` — normative "what is guaranteed", every section anchored to a version constant / conformance test / SPI type / the manifest. |
| 4 | Kernel Compatibility Matrix | **ACCEPT — build the mechanism; honest about lockstep** | `kernelManifest()` + `checkCompatibility()` in `@loom/spec`; `loom kernel-manifest --json` + `loom compat` (deployment gate); generated `docs/spec/compatibility-matrix.md`. |

**None violate the invariants** — all read-only / derived / advisory or CI-gating; nothing touches
execution semantics.

## The corrections that mattered (strict-gatekeeper)

- **The maturity model must not be able to lie.** The proposal's *hand-assigned* example table
  listed **"GPU Worker — L1"**, but there is **no GPU-worker package** (it's demand-driven #72). A
  self-assessed badge rots. So levels are **evidence-derived**: `L5` requires a `*_VERSION` constant
  pinned by a conformance test; `L4` requires a committed bench; `L2`/`L3` require a passing test
  suite. `spec.test.ts` asserts the claimed evidence exists — making the maturity model *itself* a
  fitness function. (GPU Worker is recorded at **L0**, not L1.) Similarly "Decision Graph" was
  proposed L4 but has no bench → evidence-derived **L3**.
- **Most fitness functions already existed** as pinned tests run by `pnpm test` (ABI/schema pins,
  conformance kits, wire fold-vectors, golden/deploy-sim replay). The genuine gaps were: CI ran only
  `build`+`test` (no `typecheck`/`lint`), and there was no bench gate. Enabling the lint gate
  required a one-time mechanical lint cleanup (the repo had 41 pre-existing violations).
- **The bench gate must be machine-stable.** `benchmarks.md` states numbers are machine-relative
  ("compare relative movement, not absolute hz"). So the gate is a **ratio** assertion (verify
  `off ≫ warn` — both sides scale with machine speed), not an absolute-hz threshold; absolute
  baselines stay advisory.
- **The compatibility matrix is trivial today, honestly.** Loom is a lockstep monorepo — every
  contract is `1.x` and mutually compatible, so the "matrix" is a **single row**. The value is the
  *mechanism* (`checkCompatibility`, same-major rule), which becomes meaningful when a MAJOR
  diverges. Built the mechanism; didn't oversell a big matrix.

## Delivered artifacts

- **`@loom/spec`** — `kernelManifest()`, `checkCompatibility()`, the capability registry, render
  functions; `spec.test.ts` (drift-checked badges + compat).
- **`@loom/cli`** — `loom kernel-manifest [--json] [--emit-docs]`, `loom compat …`.
- **CI + fitness** — `.github/workflows/ci.yml` gains `typecheck`+`lint`; root `pnpm fitness`;
  `verify/src/g2ratio.test.ts`.
- **Docs** — `docs/spec/loom-kernel-specification.md`, `docs/spec/fitness-functions.md`, generated
  `docs/spec/{compatibility-matrix,maturity}.md`.

## Bottom line

Accepted and shipped, unified around a single source of truth. The kernel now has the three
governance layers the reviewer identified — maturity, fitness, specification — plus a compatibility
mechanism, and every one of them is anchored to executable code so it cannot drift from reality.
