# ADR 0017 — K6: the behavioral-safety ring

- Status: Accepted (implemented — `safetyMiddleware` + `SAFETY_BLOCKED`, event schema 1.1.0)
- Date: 2026-07-09

## Context

Loom 2.0 earned "kernel" by providing five enforcement rings no application can bypass
(K1 ABI, K2 authority, K3 resource accounting, K4 fault supervision, K5 event-schema
governance — see [ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md) and
[04 — Kernel Hardening](../loom-2.0/04-kernel-hardening.md)). Those are the guarantees
*ordinary durable software* needs.

But loom's own framing of a kernel is "trusted to run **untrusted**, long-lived,
resource-hungry work." For an execution kernel meant to run *autonomous intelligent*
systems, a gap follows directly from that framing: the existing rings govern **who may
act** (K2) and **how much it costs** (K3) — nothing governs **whether the action or its
output is safe**. Intelligent systems emit non-deterministic outputs (hallucination,
prompt-injection, PII leakage) and take autonomous actions; a schema is *declared* on
step definitions but never enforced at runtime; and K4 supervises *faults*, not *unsafe
behavior*. There is no kill-switch for "stop doing the unsafe thing."

Safety is therefore the guarantee an intelligent-systems kernel most needs and loom did
not yet provide.

## Decision

Add **K6 — a behavioral-safety ring** as an opt-in effect middleware, mirroring K3's
metering exactly so it composes into the existing chain and inherits its replay
semantics.

- **`safetyMiddleware({ validators })`** (`@loom/middleware`). `EffectMiddleware` sees an
  effect's `input` before `next()` and its `result` after, so validators run in two phases:
  - **input** validators block *before* the effect runs (admission control, like K3);
  - **output** validators block the *result* from propagating.
  On failure it emits a durable **`SAFETY_BLOCKED`** fact and throws `SafetyViolationError`,
  which fails the step via the normal `STEP_FAILED` path — identical to a K3 quota trip.
- **Built-in validators**: `schemaValidator(schema)` (runtime-enforce an output schema —
  the defined-but-unchecked case), `denyPatterns(regexes)` (jailbreak/policy), `piiValidator()`,
  and `killSwitch(isTripped)` (a real emergency stop, distinct from K4 fault supervision).
- **`SAFETY_BLOCKED`** is governed under K5: it has a pinned fold handler that appends to a
  reserved `variables._safety` audit list (mirroring `EFFECT_DENIED`'s `_denials`); it is a
  pure audit fact that does not itself change status. `EVENT_SCHEMA_VERSION` is bumped
  `1.0.0 → 1.1.0` (additive = MINOR).

### Kernel properties preserved

- **Opt-in / P10.** Unwired, effects run byte-identically to before; you pay for the ring
  only where you wire it.
- **Replay-safe / P9.** A block is a logged fact; on replay the blocked step is served from
  the log (`SAFETY_BLOCKED` + `STEP_FAILED`) and the validator is never re-invoked — a
  blocked run reconstructs identically, exactly as K2/K3 verdicts do.
- **K1 ABI untouched.** The ring rides on `emit` + middleware; the eight syscalls are unchanged.

### Determinism note

Validators run only on live execution (replay serves completed/failed steps from the log),
so a non-pure validator is not a replay hazard — but keep them cheap and pure for latency
and auditability. A validator whose verdict comes from an ML/LLM classifier must route that
verdict through the decision seam (`ctx.decide`, P9) if it must be reproduced independently.

## Consequences

- Loom can now *contain* what agents emit and do, not just *authorize* and *meter* it — the
  missing kernel guarantee for autonomous intelligent systems.
- Platform layers (e.g. AetherOS Sentinel) supply the concrete *policies* (which patterns,
  which schemas, when to trip the kill-switch); the kernel supplies the *ring* they plug into.
  This respects P10 — the kernel stays minimal; policy content lives above it.
- Deliberately **not** in scope here: data-plane isolation / sandboxing of untrusted tool
  code (WASM/process), and egress control. Those deepen K2 and are tracked separately; K6 is
  the behavioral/output-safety half.
