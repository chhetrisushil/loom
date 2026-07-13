# ADR 0048 — Declarative policy enforcement (`policy$` → the K2 capability ring)

- Status: **Accepted (implemented 2026-07-13)** — `PolicyAuthorizer` in `@loom/effect-runtime`,
  wired by `@loom/app` (PRs #154, #156).
- Date: 2026-07-13
- Builds on: [ADR 0016](0016-loom-2.0-execution-runtime-and-decision-seam.md) (K2 capability
  protection ring / `CapabilityAuthorizer`), P9 (durable facts), P10 (minimal kernel — the kernel
  carries authority opaquely and never interprets a tenant/policy model).

## Context

`policy$` produced a `PolicyDefinition` that **nothing consumed** — an exported builder + a
`policies?` field on `flow$`/`agent$`, tested for shape, but never enforced (dead API). Meanwhile the
K2 ring already had a real enforcement boundary: every side effect flows through
`EffectRuntime.execute`, which consults a `CapabilityAuthorizer` (e.g. the imperative `GrantTable`)
and emits a durable `EFFECT_DENIED` fact on denial. The question was how to make `policy$` a *first
class, enforced* declarative companion to the grant table — and, separately, whether "policy" should
also mean **data-driven** rules (e.g. "deny when `input.cpu > 90`").

## Decision

**1. `policy$` is enforced by a `PolicyAuthorizer` that implements `CapabilityAuthorizer`.** It is
pure + synchronous (deterministic, replay-safe), so it slots into the existing ring with no new
mechanism. `defineConfig` builds it automatically from declared policies; **no policies ⇒ the
authorizer is exactly `config.authorizer`** (byte-identical to before — opt-in).

**2. Rules combine allow/deny lists with rich matchers, deny-wins.** `PolicyDefinition.rules` is
interpreted as `{ allow?: string[]; deny?: string[]; match?: { effect?; tenant?; step?; deny? }[] }`
— effect-id / `principal.tenant` / step-id **globs**. Evaluation: any `deny` (or `deny` match) →
denied; else an allow-list, if present, restricts to matches; else allowed. A principal with no
policy is allowed (policies are purely additive tightening).

**3. Composition is defense-in-depth.** A `PolicyAuthorizer` composes **under** any existing
`config.authorizer` via a `base` option: an effect runs only if **both** allow. Policy can *tighten*
a grant, never *widen* it.

**4. Binding is by `workflowId`, from three sources.** The flow is the unit of authority (matching
`GrantTable`'s default). Policies are collected at boot from: each flow's `policies`
(`flows` + `flowModules`), app-global `defineConfig({ policies })`, and **agent-attached**
`agent$({ policies })` — a capability-bound agent runs a flow via the A2A executor
(`runtime.start(flow)`), so its policies bind to that capability's flow (`capabilityAgents` →
`catalog.get`), merged with the flow's own.

**5. `policy$` is a capability gate, NOT a data-predicate engine — deliberately.** The authorizer
runs *before* the effect and sees only the `CapabilityRequest` (`toolId`, ids, `principal`) — never
effect input/output. So identity-based rules ("may this flow call this effect, in this tenant, at
this step?") are expressible; **value predicates over runtime data ("cpu > 90%") are not, by
design.** Those map to other Loom mechanisms — flow logic / `ctx.decide` for a business reaction, a
`projection$` + subscriber for a threshold alert, or (future) an **admission `policyMiddleware`** in
the effect chain that *does* see input/output (symmetric with K3 metering middleware). We keep the
two mechanisms distinct rather than growing a `when: "input.cpu > 90"` field onto the sync
authorizer, so what a "policy" guarantees stays crisp.

## Consequences

- `policy$` is no longer dead code; least-privilege authority is now declarative *and* imperative,
  composing cleanly. `EFFECT_DENIED` remains the single audit fact for both.
- The `PolicyAuthorizer` is not `loom gen`-discovered — policies ride *inline on the flow/agent
  definition*, not in an `app/policies/*` folder, so there is nothing to generate ([ADR 0011](0011-folder-convention-codegen.md)).
- Not covered: catalog capability flows not reached via `capabilityAgents` use the grant model;
  agents invoked as a step (`agentStep$`) run under the parent flow's authority. A data-predicate
  `policyMiddleware` is left as a separate, opt-in layer to be designed if/when needed.
- Perf: the authorizer is on the per-effect hot path, so exact allow/deny ids are `Set` lookups
  (O(1)) with only genuine globs falling back to a RegExp scan; the two policy groups (global +
  principal) are scanned in place with no per-call array allocation.
