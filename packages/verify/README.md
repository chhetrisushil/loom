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

### Wired (the two real surfaces)

```ts
// 1. defineConfig — runs at boot, before any execution starts.
const app = defineConfig({
  storage: { kind: "memory" },
  flows,
  authorizer: new GrantTable({ "my-flow": ["metrics-tool"] }),
  verify: "error", // "off" (default) | "warn" | "error"
  //  or the object form to declare metered dimensions / restrict rules:
  //  verify: { mode: "warn", meteredDimensions: ["tokens", "costUsd", "ms"] },
});

// 2. On demand — app.verify() re-runs the same checks (this is what `loom verify` calls).
const report = app.verify();
if (!report.ok) process.exitCode = 1;
```

```sh
loom verify --config ./dist/loom.config.js   # exits non-zero on any error finding
```

`defineConfig` maps the resolved app → `VerifyInput` via the `@loom/app` adapter
(`resolveVerifyInput`): flows + `flowContentHash` + each step's effect capability, the
`GrantTable` projection, and `PlacementDispatcher` targets. `"off"` never even builds the
input (G2).

### Direct (engine)

```ts
import { verify, runVerification } from "@loom/verify";

const report = verify(input); // input: a structural VerifyInput
if (!report.ok) console.error(report.findings);

runVerification(mode, () => buildInput()); // "off" skips buildInput entirely
```

`VerifyInput` is a **structural projection** of a resolved config. The engine is
dependency-free on purpose so the rules stay pure and testable; the config→`VerifyInput`
adapter lives in `@loom/app`.

**Known feed gaps (documented, not silent):** the `@loom/compiler` manifest emits no
non-deterministic-call analysis yet, so the `determinism` rule is inert when fed from config;
suspend-point `correlationKey`/`wakeAt`, per-flow `computeTarget`, and budgets aren't in the
`FlowDefinition` today either. The load-bearing check from config is **capability-compat**.

## Guarantees

- **G1 — determinism untouched.** No event type; nothing on the durable path. `verify` reads
  static config only.
- **G2 — zero overhead when unwired.** `mode: "off"` returns immediately and never calls
  `buildInput`. Proven in `verify.bench.ts` (`off` vs. build-and-verify).
