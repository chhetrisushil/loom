# ADR 0019 — K7: data-plane isolation & egress control

- Status: Accepted (implemented 2026-07-10 — `@loom/isolate`: `IsolatedToolEffect` runs a
  tool in a pooled child process AT the effect position (the chain's innermost link, so
  K2/K3/K6 stay kernel-side, per amendment A1); scrubbed per-tool env (K7.2/K7.4); network
  only via the marshaled `ctx.fetch`, brokered kernel-side with a static allowlist checked
  BEFORE connection + resolve-and-pin dispatch + durable `EGRESS_DENIED` (schema 1.7.0);
  runner-level ambient-network module deny-list as defense-in-depth; `ctx` shim = ordered
  IPC (emits land before results, A3); abort/timeout → SIGKILL — the kernel's
  non-cooperative kill path (A5). **Honest boundary note:** the deny-list raises the bar
  but hostile-code-grade network confinement additionally needs OS-layer sandboxing
  (netns/seccomp/container egress) — consistent with this ADR's malicious-host non-goal.)
- Date: 2026-07-10
- Requirements: [K7 in the kernel-hardening requirements](../requirements/2026-07-10-kernel-hardening-k7-k12-t1-t2.md#k7--data-plane-isolation--egress-control) — priority **P1**

## Context

The K2 authority ring ([ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md))
governs effects that *voluntarily* flow through `EffectRuntime.execute`. Tool
implementations, however, run in-process with full ambient authority — filesystem, network,
and the event store itself. [ADR 0017](0017-k6-behavioral-safety-ring.md) explicitly
deferred this ("data-plane isolation / sandboxing of untrusted tool code and egress control
… tracked separately"). Until closed, the protection ring is a convention, not a guarantee:
a malicious or buggy tool body can simply bypass the ring.

## Decision

Add an opt-in **isolated executor** seam for tool effects that turns K2's convention into an
enforced boundary:

- An *isolated executor* SPI with at least one reference implementation running a tool in a
  separate failure/authority domain (child process with dropped privileges, or WASM/isolate)
  (K7.1).
- Inside the boundary the tool body cannot reach `EventStore`/`SnapshotStore`, cannot read
  credentials not explicitly injected for its `toolId`, and cannot open network connections
  outside a declared egress allowlist (K7.2).
- Egress policy is declared statically per `toolId` (P5) — e.g.
  `tool$({ egress: ["prometheus.internal:9090"] })`; violations are denied *before*
  connection with a durable **`EGRESS_DENIED`** fact, folded like `EFFECT_DENIED` (K7.3).
- Credential injection is per-tool and unforgeable from userland: an execution cannot name,
  enumerate, or copy credentials — it can only cause a granted tool to run (K7.4).
- Isolation composes with the existing rings unchanged, with the boundary **innermost**:
  authorize (K2) → schedule → meter (K3) → validate input (K6) → **[isolation boundary]** →
  tool → validate output (K6) (K7.5 as amended — see Amendments; the requirement's original
  "isolate → meter" ordering would place metering inside the sandbox, where the isolate
  could forge it).

Per G2, enablement is opt-in — but once a tool is bound to an isolated executor, the
enforcement is unbypassable.

## Acceptance criteria

A deliberately malicious tool (reads `/etc/passwd`, dials an unlisted host, appends directly
to the event log) fails all three actions under the isolated executor, each failure visible
as a durable fact; the same suite passes trivially (no enforcement) when isolation is
unwired, preserving G2.

## Consequences

- The kernel claim's biggest exposure closes: least-privilege becomes a *guarantee* for
  isolated tools, not a request.
- New durable fact `EGRESS_DENIED` enters the K5-governed event schema (additive → MINOR);
  the fold reference must be updated.
- Non-goals: defending against a malicious *host* process; multi-language tool support may
  share this boundary but is tracked under [T2 / ADR 0026](0026-t2-wire-level-kernel-abi.md).

## Amendments (code-grounded evaluation, 2026-07-10)

Adopted per the [K7 evaluation](../requirements/2026-07-10-kernel-hardening-evaluation.md#k7--data-plane-isolation--egress-control--accept-with-amendments)
(verdict: **Accept with amendments**):

- **A1 — ring order corrected** (applied inline above): K2/K3/K6 execute on the kernel side
  of the boundary; the isolation boundary is innermost. `EffectRuntime` needs a new
  *executor seam* at the effect-handler position — middleware is the wrong boundary (it runs
  in-process with ambient authority).
- **A2 — egress enforced kernel-side**: a broker/proxy the isolate's sockets are forced
  through, or WASM host functions — never in-process patching of `fetch`/`net` (bypassable
  = theater). Allowlists use resolve-and-pin semantics (DNS rebinding, IP-literal bypass).
- **A3 — the `ctx` shim**: `EffectContext` closures don't cross a process boundary; the SPI
  defines a marshaled host-function subset (`emit`, `signal`, K9 idempotency key) with
  emit-forwarding semantics specified (no silent fact loss on child death).
- **A4 — reference impl & perf**: child process with dropped privileges first (WASM cannot
  run arbitrary npm tool deps); executors poolable/warm; ships a latency benchmark including
  cold-start-per-tool plus the unwired bench (G2).
- **A5 — cross-reference**: K7 provides K8's only *non-cooperative* kill path
  ([ADR 0020](0020-k8-cancellation-deadlines-bounded-effects.md)); in-process AbortSignal is
  cooperative and ignorable.

## Addendum (L23/L24, 2026-09): cold-start and fetch clocks

- `timeoutMs` opens when the child is READY, not at spawn. The warm phase is two steps: the
  runner boots (`booted`, trusted code) and then loads the tool module (`ready`, the tool's
  UNTRUSTED top-level code). One `coldStartMs` (default 10 000) bounds both, reported as
  `IsolatedToolStartupError.phase` `"spawn"` (environment) or `"load"` (tool fault). Unlike the
  sandbox's trusted compile, this allowance covers untrusted code, so a tool that forces a cold
  start on every call costs each call up to `coldStartMs + timeoutMs`. A module that throws at
  load fails as a tool error in the load phase and is not re-executed by the run.
- Each brokered fetch has a `fetchTimeoutMs` deadline covering DNS, connect and response; the
  slot is released on expiry or when the run ends.
- The child is untrusted, so its IPC channel is too: a disconnect is death (kill, discard, fail
  the run with `IsolatedToolDisconnectedError`), and the parent never sends without a callback
  or leaves the child's `error` event unhandled.

