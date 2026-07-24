# ADR 0070 — A2UI `callFunction` bidirectional RPC

- Status: Accepted (2026-07-24)
- Date: 2026-07-24
- Builds on: the A2UI egress adapter ([ADR 0069](0069-a2ui-egress-adapter.md)),
  the K9 effect-delivery contract ([ADR 0021](0021-k9-effect-delivery-contract-idempotency-fencing.md)),
  the decision seam / "non-determinism only when logged" ([ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md)),
  multi-gate suspend passthrough ([ADR 0057](0057-multi-gate-suspend-passthrough.md)).
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). **KERNEL_ABI unchanged (1.1.0);
  EVENT_SCHEMA unchanged** — no new kernel event type. `callFunction` is a wire-protocol binding in a
  1P plugin; the round-trip rides existing `EXECUTION_SUSPENDED`/`EXECUTION_RESUMED` (gate grain) or
  `STEP_COMPLETED` (delegated-effect grain).

## Context

ADR 0069 shipped `@loom/plugin-a2ui` as egress + inbound-`action` only and **deferred** the A2UI
bidirectional-RPC surface — `callFunction` (the agent asks the client to invoke a named catalog function
and answer with a `functionResponse`) — on the grounds it "requires a synchronous request/response
correlation layer that fights Loom's append-only, replayable event grain," gated on a **"second consumer"
evidence gate**.

A concrete consumer now exists: driving a client-side function (read a selected file / locale, confirm &
submit) from a Loom flow over a remote transport, and asking the natural follow-on question — *to stay
true to determinism, does the client need its own runtime?*

## Key finding — no client-side effect runtime is needed

Loom already runs effects off-process in three shipped patterns — the K7 isolate (child process), the A2A
peer-as-tool (`A2APeerClient`), and the WorkerRuntime placement SPI (HTTP / Cloud Run). In **every** one,
determinism holds the same way: the work runs elsewhere, but only its **recorded result** re-enters the
orchestrator's log (a `STEP_COMPLETED` output, or a resume event); on replay the result is served from the
fold and the remote work is never re-run. A browser `callFunction` is architecturally identical to a human
approving a gate or an A2A peer answering a call.

So the client needs not a replay engine but the **K9 effect-delivery contract projected onto the
transport**: a *deterministic* correlation/idempotency key on the request (`executionId:stepId`, exactly
what `EffectContext.idempotencyKey` mints — never random) plus at-least-once tolerance (same `callId` →
same response, or the flow declares the function non-idempotent so a crash parks at `EFFECT_INDOUBT` for an
operator verdict). The append-only-grain objection dissolves once `callFunction` is **not** modeled as a
blocking sync RPC in the log.

## Decision

Promote `callFunction`/`functionResponse` in `@loom/plugin-a2ui` as **transport-agnostic primitives**, and
build **two consumption grains** on top. Kernel untouched.

### Primitives (the plugin)

- **Protocol types** — `CallFunctionPayload { surfaceId, callId, name, args?, callableFrom? }` on the
  server→client union; the previously untyped `functionResponse` client member is now
  `FunctionResponsePayload { surfaceId, callId, name, result?, error? }`; `isFunctionResponse` narrowing
  helper (twin of `isAction`).
- **Bridge methods** — `A2UISurfaceBridge.callFunction(name, args, { callId, callableFrom })` emits the
  request stamped with this bridge's `surfaceId` and the **caller-supplied deterministic** `callId` (the
  bridge stays clock/random-free); `ingestFunctionResponse(message)` normalizes the reply for this surface
  (twin of `ingestAction` — the plugin creates no Loom event itself).
- **Catalog** — the A2UI `functions` vocabulary (`CatalogFunctionSchema`, `defineFunction`), populating the
  slot ADR 0069 left typed-but-unused.

### Grain A — suspend/resume gate (app-level, no live socket)

Flow: `bridge.callFunction(name, args, { callId })` → send → `ctx.suspend({ on: "A2UIFunctionResult",
correlationKey: callId })`. Client runs the function, sends `functionResponse`; the app calls
`bridge.ingestFunctionResponse(msg)` → `runtime.resume(executionId, { eventType: "A2UIFunctionResult",
payload })`. Reuses the exact machinery the `action` path uses today (multi-gate passthrough, ADR 0057).
The result is a recorded fact; replay is a pure fold. Works over SSE-down + POST-up. **Best for reads /
idempotent calls.**

### Grain B — delegated effect (`registerA2UICallFunction`)

Registers an `a2ui.callFunction` effect whose `execute(input, ctx)` sends the request over an injected
`A2UICallFunctionTransport` and awaits the `functionResponse`, keyed by `callId = ctx.idempotencyKey`
(= `executionId:stepId`). The result becomes the step's `STEP_COMPLETED` output; a flow author writes
`await ctx.execute(callFn, input)`. The effect is declared **`idempotent: false`**, so a crash mid-call
routes through the existing K9 in-doubt guard (`EFFECT_INDOUBT` → operator verdict) instead of silently
re-invoking the client function — the exact "did the client function actually run?" resolution. This is
`A2APeerClient.registerInto` applied to a UI client. **Best for side-effecting calls / where a
sync-looking value is wanted.** Needs a duplex transport (e.g. WebSocket).

### Still out of scope

Continuous two-way **binding sync** (live, ongoing data-model reconciliation between client and agent).
That is a distinct, stateful concern; nothing here depends on it.

## Consequences

- The plugin remains **transport-agnostic** (ADR 0069): it produces/consumes A2UI *message objects* and,
  for grain B, delegates the wire to an injected transport. A single concrete transport is demonstrated in
  the `a2ui-callfunction` example (sibling `loom-examples`), which proves both a read (grain A) and a
  non-idempotent side-effecting call (grain B, with a scripted crash → in-doubt verdict) round-trip and
  replay-deterministically.
- Determinism is preserved by construction: **result-as-recorded-fact + deterministic `callId`**, not a
  sync RPC in the log. No new event types; `EVENT_SCHEMA` and `KERNEL_ABI` unchanged.
- This **supersedes the "Deferred" section of ADR 0069** for `callFunction`/`functionResponse`; the
  "second consumer" gate is satisfied.
- `@loom/plugin-a2ui` gains a `@loom/effect-runtime` dependency (types only) for the grain-B helper.
