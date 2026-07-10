# ADR 0035 — Kernel Governance Layer (manifest, maturity, fitness, specification)

- Status: Accepted (2026-07-10) — implements the four proposals in the [governance-layer evaluation](../requirements/2026-07-10-kernel-governance-layer-evaluation.md): capability maturity, architectural fitness functions, the Kernel Specification, and the Kernel Compatibility Matrix.
- Date: 2026-07-10
- Builds on: the version constants + conformance kits established by [ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md) (K1), [0033](0033-spi-conformance-contracts.md) (SPI versions/kits), and the K5 event-schema governance.

## Context

Loom now functions as an execution kernel, and needs the governance layers that Linux/Kubernetes/
LLVM have: a per-subsystem **maturity** signal, **fitness functions** enforcing the design
continuously, a **specification** of what is guaranteed (separate from the ADRs' *why*), and a
**compatibility matrix** over its version constants. Today those version constants (9, all
conformance-pinned) exist but are unaggregated; maturity is narrative; fitness checks exist but
aren't unified or fully CI-gated; normative content is scattered.

## Decision

Unify around **one machine-readable source of truth** and layer three views + one enforcer on it.

**`@loom/spec` (the manifest).** A dependency-light package that **imports** the real exported
version constants (never hand-copies them) into `kernelManifest()`, and exposes
`checkCompatibility(deployment)` (same-major ⇒ compatible; MAJOR mismatch ⇒ reject). It also holds
the **capability registry**: each subsystem declares a maturity level `L0–L5` **plus the evidence**
that backs it (version-constant name, conformance-test path, bench path). Adding
`COMPILER_MANIFEST_VERSION` to `@loom/compiler` completes the constant set.

**Maturity is evidence-derived and self-checking.** Levels are objective: `L5` needs a versioned
contract + conformance test; `L4` needs a committed bench; `L2`/`L3` need a test suite.
`spec.test.ts` fails if a capability claims evidence it lacks — so a badge **cannot lie or rot**.
(The proposal's hand-assigned "GPU Worker L1" is corrected to L0 — no package exists.)

**Fitness functions.** Most invariants were already enforced by pinned tests inside `pnpm test`
(K1 `abi.test`, K5 `eventSchema.test`, wire fold-vectors, SPI conformance kits, golden/deploy-sim
replay). The genuine gaps are closed: CI gains `typecheck` + `lint` (it ran only `build`+`test`);
a root `pnpm fitness` aggregates them; a **machine-stable relative-ratio** G2 gate
(`verify/src/g2ratio.test.ts`) proves zero-overhead-when-disabled without a flaky absolute-hz
threshold (absolute baselines stay advisory, per `benchmarks.md`).

**Specification.** `docs/spec/loom-kernel-specification.md` states normatively (RFC-2119) what the
kernel guarantees — execution/replay/event/suspension/placement/SPI/resource/compatibility — every
section anchored to a version constant / conformance test / SPI type / the manifest. ADRs stay the
*why*. `docs/spec/{compatibility-matrix,maturity}.md` are **generated** from the manifest
(`loom kernel-manifest --emit-docs`), never hand-maintained.

**CLI.** `loom kernel-manifest [--json] [--emit-docs <dir>]` and `loom compat …` (deployment gate,
non-zero on mismatch).

## Consequences

- One source of truth: matrix, badges, and spec all derive from the manifest → they cannot drift.
- The maturity model is itself a fitness function (drift-checked evidence).
- CI now gates typecheck + lint (previously ungated); the lint gate required a one-time mechanical
  cleanup of 41 pre-existing violations.
- Determinism/G2 untouched: `@loom/spec` is read-only and off the execution path.
- Honest scope: the compatibility matrix is a single row today (lockstep monorepo); the mechanism
  matters when a MAJOR diverges.

## Verification

- `@loom/spec` `spec.test.ts`: manifest aggregates real semver constants; every claimed evidence
  file exists; L5⇒version+conformance, L4⇒bench, L2/L3⇒test; `checkCompatibility` accepts current +
  same-major, rejects bumped-major. `@loom/cli`: `kernel-manifest` prints/JSON/emits-docs, `compat`
  exits non-zero on mismatch.
- `pnpm fitness` (build→typecheck→lint→test) green; CI runs all four.
- Generated docs match the manifest; the Kernel Specification's anchors resolve to real files.

## Amendments (from the governance-layer evaluation)

- **Unified** the four proposals onto one manifest (not four artifacts).
- **Maturity levels evidence-derived**, not hand-assigned (GPU Worker L0 not L1; Decision Graph L3
  not L4 — no bench).
- **Bench gate is a ratio**, not absolute hz (machine-stable); absolute baselines advisory.
- Compatibility matrix mechanism built; **not oversold** — one compatible row today (lockstep).
