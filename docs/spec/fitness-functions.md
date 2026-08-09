# Loom Architectural Fitness Functions

> **Status:** Normative. These are the kernel's design invariants, made **executable** — every PR
> proves them, so the architecture is enforced continuously rather than by reviewer memory. They
> complement the [Kernel Specification](loom-kernel-specification.md) (the *what*) by pinning *that
> it stays true*. Gated in CI and by `pnpm fitness`.

## How they run

- **`pnpm fitness`** (root) = `build → typecheck → lint → test`. The ABI/schema pins, SPI
  conformance kits, replay/golden checks, and the G2 ratio gate all run **inside `pnpm test`** as
  ordinary tests, so there is one command and one CI gate.
- **CI** (`.github/workflows/ci.yml`) runs `build`, `typecheck`, `lint`, `test` on every PR.
- Absolute benchmark numbers (`pnpm bench`, [benchmarks.md](../benchmarks.md)) stay **advisory** —
  they are machine-relative, so they are not a hard gate; the machine-stable checks below are.

## The invariants

| # | Fitness function | What it proves | Where it is enforced |
|---|---|---|---|
| 1 | **Replay unchanged** | Folding a stored log reconstructs identical state; a code change can't silently re-fold historical logs differently. | `@loom/eval` (`replayAsFixture`/`diffRuns`), `@loom/deploy-sim` (`simulateDeploy`), golden fixtures (`captureGolden`), wire fold-vectors (`packages/wire-abi/src/wire-abi.test.ts`). |
| 2 | **ABI unchanged** | The K1 syscall surface can't drift silently (add = MINOR, remove = MAJOR). | `packages/workflow-runtime/src/abi.test.ts` (pins `KERNEL_SYSCALLS` + version). |
| 3 | **Event schema compatible** | The K5 event-type set can't change without bumping the version + pin; stored logs stay foldable. | `packages/replay-vm/src/eventSchema.test.ts` (pins `knownEventTypes()` + `EVENT_SCHEMA_VERSION`); `@loom/verify` `replay-safety` rule for cross-version resume. |
| 4 | **Zero-overhead when disabled (G2)** | An unwired optional capability adds no work. | Behavioural: disabled-path tests (e.g. verify `mode=off` never builds input, `verify.test.ts`; scheduler `Infinity` fast-path). Relative-ratio canary: `packages/verify/src/g2ratio.test.ts` (off ≫ warn). |
| 5 | **Benchmarks passed** | Perf is measured, not assumed; key hot paths don't regress. | Machine-stable **ratio** assertions (#4) are gated. Absolute baselines in [benchmarks.md](../benchmarks.md) are advisory (`pnpm bench`). |
| 6 | **Conformance passed** | A storage/dispatch SPI implementation honours its contract. | `run<Spi>Conformance` kits (`@loom/conformance`). Each implementation runs the kit against itself — in-memory (`packages/conformance/src/index.test.ts`, which also pins the per-SPI version constants), SQLite (`plugins/sqlite/src/conformance.test.ts`), and the `durable-state`/`read-model`/`content`/`crypto`/`worker-runtime-local` packages in kind. `loom plugin check` enforces that a 3P plugin wires a kit too. |
| 7 | **Compiler validation passed** | Flows are structurally valid and non-determinism is caught pre-dispatch. | `@loom/compiler` (`analyzeNonDeterminism`), `@loom/verify` (`loom verify`), `validateFlowGraph` (`@loom/app`), `loom check`. |
| + | **Maturity is self-checking** | A capability's badge can't claim evidence it lacks. | `@loom/spec` `spec.test.ts` (asserts each capability's version constant / conformance test / bench actually exists). |
| + | **Maturity is complete** | Shipped work can't skip declaring a badge — the converse of the row above. Every accepted ADR is a declared capability or is explicitly listed as grading nothing. | `@loom/spec` `spec.test.ts` (`capability coverage`). Added after ADRs 0074–0077 landed in one day with no entry, making four shipped capabilities invisible in the generated docs. |

## Adding a capability

An additive capability (a K/T ring, an SPI, a runtime) MUST, before merge:

1. Preserve replay (#1) and, if it touches the schema/ABI, bump the version **and** the pin (#2/#3).
2. Be opt-in with a disabled-path test and — for a hot path — a ratio canary (#4/#5).
3. If it's an SPI, ship a conformance kit and a version constant (#6), and register a capability in
   `@loom/spec` at the level its evidence supports (the maturity check, `+`).
4. Surface through an existing idiom (one `defineConfig` key / `ctx.*` method / `flow$`/`tool$`
   option) — the DX bar.
