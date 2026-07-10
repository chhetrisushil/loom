# @loom/verify

Pre-flight **runtime verification** for Loom — a pure, read-only, **off-log** check that runs
*before* an execution starts and catches invariant violations that would otherwise surface as a
diverged replay, a mid-run `CapabilityDeniedError`, or a timer that never fires.

Design: [ADR 0028](../../docs/adr/0028-runtime-verification.md). Rationale & scope:
[Execution-OS evaluation](../../docs/requirements/2026-07-10-execution-operating-system-evaluation.md).

`verify` **advises**; it is not a new enforcement ring. Runtime enforcement stays where it already
lives (K2 authority, K9 delivery, K11 versioning). This package shifts those failures *left*.

## Rules

| Rule | Catches |
|---|---|
| `determinism` | non-deterministic calls (`Date.now`, `Math.random`, bare `fetch`) reachable outside `ctx.decide`/`ctx.execute` → replay diverges (P2) |
| `replay-safety` | missing flow content hash (K11); event-schema major mismatch vs. a prior log (K5) |
| `suspension-safety` | a `suspend()` with no `correlationKey`; a timed suspend with no `wakeAt` (T1); approval flows with no `ResumeAuthenticator` (K12) |
| `capability-compat` | an effect requiring a capability not in the `GrantTable` (K2) |
| `placement-compat` | a `computeTarget` that resolves to no registered dispatcher target; an effect kind a target doesn't support |
| `resource-compat` | a declared budget dimension that nothing meters (K3); a budget with no ceiling |

(`migration-safety` from the requirements folds into `replay-safety` — in the stateless-worker
model, resume *is* migration.)

## Usage

```ts
import { verify, runVerification } from "@loom/verify";

// Direct, for a `loom verify` CLI or a test:
const report = verify(input); // input: a structural projection of your resolved config
if (!report.ok) console.error(report.findings);

// Wired at startup via defineConfig({ verify: "off" | "warn" | "error" }):
runVerification(mode, () => buildInputFromConfig(config));
//  "off"   → returns null, never even builds the input (byte-identical to unwired, G2)
//  "warn"  → logs the report if there are findings
//  "error" → throws VerificationError before the first EXECUTION_STARTED
```

`VerifyInput` is a **structural projection** of a resolved `defineConfig(...)` plus the
`@loom/compiler` manifest (flow hashes + non-deterministic-call analysis). The engine is
dependency-free on purpose; a thin adapter maps real config → `VerifyInput`, so the rules stay
pure and testable. Wiring the `loom verify` CLI command and the `defineConfig` key is the
remaining adapter step (tracked in the accepted-scope issue).

## Guarantees

- **G1 — determinism untouched.** No event type; nothing on the durable path. `verify` reads
  static config only.
- **G2 — zero overhead when unwired.** `mode: "off"` returns immediately and never calls
  `buildInput`. Proven in `verify.bench.ts` (`off` vs. build-and-verify).
