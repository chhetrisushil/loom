# @loomwork/effect-runtime

The isolation layer between a flow and the outside world. Everything a flow does that is not pure,
a tool call, an LLM call, a human prompt, an agent-to-agent request, is an `Effect` run through an
`EffectRuntime`, which wraps it in composable middleware (retry, rate limit, telemetry, ...) and
applies the kernel's protection ring: capability authorization (`GrantTable`, `PolicyAuthorizer`,
signed delegation), metering and quotas, deadlines and delivery fencing.

## When to use it

- You are registering the runnable side of a tool or model (`effects.register("id", effect)`), or
  writing middleware or an authorizer.
- Otherwise it is wired for you: `defineConfig` builds the `EffectRuntime`, and
  `execution.registerEffects` is where an app registers its effects.

## Install

`npm install @loomwork/effect-runtime` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep
them on the same release. Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

## Entry points

`@loomwork/effect-runtime` (single entry): `EffectRuntime`, the effect kinds `ToolEffect`, `LlmEffect`,
`HumanEffect` (plus the lazy variant `LazyEffect`), the `Effect` / `EffectMiddleware` types, the
authorization surface (`GrantTable`, `PolicyAuthorizer`, `DelegationAuthorizer`, `signDelegation`,
`verifyDelegation`, `attenuateDelegation`) and `CapabilityDeniedError`.

## Example

```ts
import { defineConfig } from "@loomwork/app";
import { ToolEffect, type Effect } from "@loomwork/effect-runtime";

declare const lookup: Effect; // for example: new ToolEffect(async (input) => ...)

const app = defineConfig({
  storage: { kind: "memory" },
  flows: [],
  execution: {
    registerEffects: (effects) => {
      effects.register("lookup", lookup); // the id a tool$ definition / ctx.run names
    },
  },
});
await app.close();
void ToolEffect;
```

## Key concepts

- **Middleware** is statically ordered and replay-safe: it wraps effect execution only, never the
  fold. Reference middleware (retry, rate limit) lives in [`@loomwork/middleware`](../middleware/README.md);
  see [ADR 0006](../../docs/adr/0006-config-and-effect-middleware.md).
- **Capability grants (K2)**, quotas (K3), cancellation (K8) and delivery guarantees (K9) apply at
  this seam: [kernel guide pages](../../docs/user-guide/grants-and-strict-mode.md),
  [ADR 0021](../../docs/adr/0021-k9-effect-delivery-contract-idempotency-fencing.md).
- **Capabilities and seen origins.** An `Effect` may carry `capabilities` (`ToolEffect` takes `capabilities: { read }`, which marks
  a read with a resource); `EffectContext.seenOrigins?()` returns the run's seen taint origins (absent = untracked), and
  `SEEN_ORIGINS_OVERFLOW` is re-exported from here (ADR 0150, 0152).
- Effects are `journaled` (recorded and replayed) or `ambient`; a transient facade
  (`invokeTransient`) runs one without an execution
  ([ADR 0066](../../docs/adr/0066-transient-effect-invocation-facade.md)).

## See also

- [API reference: Effects](../../docs/api-reference.org) (`@loomwork/effect-runtime`).
- [User guide, section 3: Effects and middleware](../../docs/user-guide.md#3-effects--middleware).
- [`@loomwork/app`](../app/README.md), [`@loomwork/agent`](../agent/README.md),
  [`@loomwork/workflow-runtime`](../workflow-runtime/README.md).
