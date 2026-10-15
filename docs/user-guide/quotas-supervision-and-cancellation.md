# Quotas, supervision, cancellation & pre-warming

> Part of the [Loom User Guide](../user-guide.md), [section 17](../user-guide.md#17-kernel-grants-quotas--supervision) (Loom 2.0 kernel hardening). Bounding and supervising a running execution: resource accounting and quotas (K3), fault supervision (K4), cancellation and deadlines (K8), and the advisory pre-warming hint.

## Resource accounting & quotas (K3)

`meteringMiddleware` meters each effect (tokens/$/latency) onto the log and enforces a budget by admission control.

```ts
import { meteringMiddleware, llmUsageTokens } from "@loom/middleware";

const metering = meteringMiddleware({
  pricing: ({ result, ms }) => ({ tokens: llmUsageTokens(result), costUsd: llmUsageTokens(result) * 3e-6, ms }),
  budget: { maxCostUsd: 5 },   // once spent, the next effect is denied (QUOTA_EXCEEDED)
});
const effectRuntime = new EffectRuntime([metering]);
// Running totals live in state.variables._resources (tokens / costUsd / ms / count / exceeded).
```

## Fault supervision (K4)

Wrap any dispatcher with `SupervisingDispatcher` for restart/backoff + a **circuit breaker** that fails fast when a target is consistently down.

```ts
import { SupervisingDispatcher } from "@loom/dispatcher";

const dispatcher = new SupervisingDispatcher(childDispatcher, {
  policy: { maxRestarts: 2, backoffMs: 200, circuit: { threshold: 5, cooldownMs: 30_000 } },
});
```

## Cancellation & deadlines (K8)

The kernel can reclaim running work — cooperatively where effects honor the signal, and by
durable settlement everywhere else (the guarantee is the logged fact, not physical
termination of third-party I/O).

```ts
// Kill an execution BY ID, wherever it stands:
await runtime.cancel(executionId, "operator kill");
// - live in this runtime → aborts the in-flight effect + durable EXECUTION_CANCELLED
// - suspended / on a presumed-dead node → FENCE-THEN-CANCEL: acquires a newer fence
//   token first (K9.4), so a zombie worker can no longer write, then appends the fact.
// Cancelled is terminal: resume() refuses, a second cancel returns false.

// Declarative deadlines — enforced by the kernel, anchored to LOGGED timestamps
// (a crash/recovery never resets the clock):
step$({ id: "call-api", …, timeoutMs: 30_000 });       // per step, anchored to its first STEP_STARTED
flow$({ id: "audit", …, deadlineMs: 10 * 60_000 });    // per run, anchored to EXECUTION_STARTED
await runtime.start(flow, input, { deadlineMs: 5_000 }); // per-dispatch override
```

A step timeout fails the step (`STEP_FAILED`, retriable by your flow logic); an execution
deadline cancels the run (`EXECUTION_CANCELLED`). Effects receive the abort via `ctx.signal`
(LLM effects forward it to the provider's HTTP call automatically); effects that ignore it
are settled durably anyway. Aborted effects are still **metered** (wall-time at minimum), so
cancel-before-completion cannot evade a K3 budget, and the retry middleware treats abort as
terminally non-retryable. Deadlines fire while a process is actively running the execution;
durable firing across idle suspension arrives with T1's timer service.

**Across the compute seam (K8.5):** cancellation follows the execution wherever it runs —
`dispatcher.cancel(executionId)` forwards the kill through the placement seam, and a remote
HTTP worker exposes `POST /cancel` (`RemoteWorkerRuntime.cancel`). Delivery is best-effort by
contract (an unreachable worker returns `false`, never throws); the *settlement* is durable
either way — the orchestrator's own `runtime.cancel()` fences-then-appends on the shared
store, so even an undeliverable zombie ends fenced out with `EXECUTION_CANCELLED` on the log.
A cancelled dispatch settles as a normal terminal result, never a retryable transport error.

## Pre-warming (latency, advisory)

Cold starts live at I/O boundaries — a K7 child-process fork (~50ms), an LLM provider's
first HTTPS handshake, a Cloud Run cold instance. Pre-warming spins those up *before* the
call, strictly in the **advisory plane**: it is latency-only, never emits or touches the
fold (P10), and a failed warm silently falls back to a cold call. It cannot change what
happens — only how fast.

```ts
// K7 — pre-spawn the isolated child at boot so the first call skips the fork:
new IsolatedToolEffect({ id: "fetch-metrics", modulePath, warm: true }); // ~54ms → ~2ms first call
// or call effect.warm() / runtime's effectRuntime.warm(toolId) at boot.

// LLM — keep the provider connection/model cache hot (provider implements warm()):
const provider = { async complete(req) { … }, async warm() { await this.keepAlive(); } };
// createLlmEffect wires effect.warm() → provider.warm().

// Scheduled flows — the occurrence time is deterministic, so warm the flow's first
// step just before it fires (hides cold-start behind the wait you already know is coming):
defineConfig({
  timers: { store, schedules: [nightlyAudit], warmLeadMs: 10_000 }, // warm 10s ahead
});
```

Use it only where the hidden latency is large and real (K7 children, LLM/remote connections,
cloud workers) — warming the in-process hot paths (the fold, local stores, middleware) buys
nothing. Mispredicted warming spends resources (an idle child, a needless connection), so it
is **opt-in** and belongs on high-probability boundaries: a scheduled fire, or a tool you know
every request hits. Loom deliberately keeps speculation out of the durable core — pre-warming
rides the advisory `Warmer`/`Effect.warm()` seam, never the log.

---

Back to [User Guide section 17](../user-guide.md#17-kernel-grants-quotas--supervision).
