# ADR 0047 — First-party dev-tooling lives in `tools/*`, not a separate repo

- Status: **Accepted (implemented 2026-07-13)** — 9 tooling packages relocated `packages/*` → `tools/*` (PR #145).
- Date: 2026-07-13
- Builds on: [ADR 0043](0043-plugin-packaging-and-1p-3p-separation.md) (the `packages/ | plugins/`
  tier boundary + 1P/3P plugin split), [ADR 0044](0044-no-compiler-plugin-api-manifest-as-output-contract.md)
  (the compiler's manifest output contract), P10 (minimal kernel).
- Part of: keeping the workspace legible as it grows. Purely organizational — no runtime, ABI, or
  API change.

## Context

`packages/` had grown to ~49 packages, mixing three very different things: the runtime **kernel /
SPI**, the **advisory** modules, and first-party **dev-tooling** (the `loom` CLI, the build-time
compiler, `appgen`, `eval`, `deploy-sim`, …). The proposal on the table was to **extract the CLI and
compiler into their own repository** to reduce that bloat.

Three source-verified audits showed a repo split is **not feasible today and would not help**:

1. **No release model.** Every package is `version: "0.0.1"`, root `private`, and every dependency is
   `workspace:*`. There is **no changesets config, no npm-publish CI, no registry setup**. A separate
   repo *cannot consume `@loom/*`* until a full versioning + publish pipeline is built first — a large,
   standalone project. (Notably, ADR 0043's own community `loom-plugins` 3P repo is blocked on this
   exact missing piece and remains unbuilt.)
2. **The CLI is the worst split candidate.** It's a clean leaf (nothing depends on it) but a
   **top-of-stack consumer with ~16 `@loom/*` deps**. Extracting it would force a cross-repo publish
   cycle on *every* kernel API change, for a ~2% LOC reduction — and it **doesn't shrink the kernel**
   (its 16 deps stay in the kernel repo). The minimal-kernel principle (P10) doesn't apply: the CLI is
   a *tool*, not an adapter.
3. **The compiler is cleaner** (zero `@loom/*` runtime deps; its manifest is a versioned public
   contract, ADR 0044) but even it would need publishing (in-repo examples + `@loom/spec` consume it),
   so it trips the same publish prerequisite, with no independent-release-cadence pressure to justify it.

The felt pain was real — *too many things in one folder* — but its cause was **legibility**, not a
missing repo boundary.

## Decision

Introduce a **third first-party tier, `tools/*`**, for dev-tooling — **leaf packages consumed only at
build / test / authoring time** — alongside the runtime `packages/` and the adapter `plugins/` tiers
(ADR 0043). No repo split; no publish pipeline; fully reversible.

**Rule for membership.** A package belongs in `tools/` **iff nothing in the runtime graph (kernel /
SPI / advisory / `app` / plugins / example runtime bundles) depends on it** — i.e. it is a leaf whose
only consumers are other tooling, tests, or authoring flows.

**Moved (9):** `cli`, `compiler`, `appgen`, `appgen-model`, `deploy-sim`, `scaffold`, `eval`,
`testing`, `dst` (joining `create-loom-app`, already there).

**Kept in `packages/` (not leaves):** `verify` (a runtime dep of `@loom/app` for boot-time
`defineConfig({ verify })`), `spec` (kernel governance — layering guard, compat matrix, kernel
manifest), `conformance` (SPI-conformance kits paired with the SPI they validate).

## Consequences

- **Legibility.** `packages/` now reads as runtime + governance only; `tools/` collects the dev-facing
  surface. Mirrors the tiered mental model of ADR 0043 with a third honest category.
- **Zero functional change.** pnpm resolves workspace deps by **package name**, not path, so every
  `workspace:*` dependency, `@loom/*` import, `bin`, and `exports` is untouched — the migration was
  **entirely relative-path fixes** (tsconfig `references` recomputed by basename; the lone
  `spec → compiler` edge and root references updated; `@loom/spec`'s maturity-manifest *evidence file
  paths* re-pointed so the "evidence exists" governance test still passes; a docs path sweep).
- **Turbo caching + one-PR changes preserved.** A cross-cutting kernel-API change still lands in a
  single PR with incremental builds — the main thing a repo split would have cost.
- **Reversible.** A `git mv` back restores the prior layout.
- **Governance intact.** The layering guard (`@loom/spec`, ADR 0043) keys on package **names**, so the
  kernel/SPI protection is unaffected by the folder move.

## Alternatives considered

- **Extract CLI + compiler to a separate repo (the original ask).** Rejected — requires a publish
  pipeline that doesn't exist, and the CLI is the least-suitable extraction (see Context). Deferred
  behind the publish-pipeline investment, not this reorg.
- **Do nothing / leave in `packages/`.** Rejected — the mixed folder was the actual complaint, and the
  `tools/` split resolves it at near-zero cost/risk.
- **A publish pipeline now.** Out of scope here, but recorded as the **real** future unlock: standing
  up versioning + npm-publish for the SPI/kernel packages would enable *both* the ADR 0043 `loom-plugins`
  3P repo *and* any later tooling extraction — one investment, done deliberately when the need is
  concrete, rather than a premature repo split.

## Follow-ups

- If/when independent release cadence or external tooling contribution becomes a real need, revisit a
  repo split — but **build the publish pipeline first**; `tools/*` membership makes the extraction
  boundary obvious when that day comes.
