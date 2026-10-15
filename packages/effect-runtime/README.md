# @loom/effect-runtime

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

Not published to npm yet: `"@loom/effect-runtime": "workspace:*"` in this workspace, or a `link:`
override from a sibling checkout (see [AGENTS.md](../../AGENTS.md)).

## Entry points

`@loom/effect-runtime` (single entry): `EffectRuntime`, the effect kinds `ToolEffect`, `LlmEffect`,
`HumanEffect` (plus the lazy variant `LazyEffect`), the `Effect` / `EffectMiddleware` types, the
authorization surface (`GrantTable`, `PolicyAuthorizer`, `DelegationAuthorizer`, `signDelegation`,
`verifyDelegation`, `attenuateDelegation`) and `CapabilityDeniedError`.

## Example

```ts
import { defineConfig } from "@loom/app";
import { ToolEffect, type Effect } from "@loom/effect-runtime";

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
  fold. Reference middleware (retry, rate limit) lives in [`@loom/middleware`](../middleware/README.md);
  see [ADR 0006](../../docs/adr/0006-config-and-effect-middleware.md).
- **Capability grants (K2)**, quotas (K3), cancellation (K8) and delivery guarantees (K9) apply at
  this seam: [kernel guide pages](../../docs/user-guide/grants-and-strict-mode.md),
  [ADR 0021](../../docs/adr/0021-k9-effect-delivery-contract-idempotency-fencing.md).
- Effects are `journaled` (recorded and replayed) or `ambient`; a transient facade
  (`invokeTransient`) runs one without an execution
  ([ADR 0066](../../docs/adr/0066-transient-effect-invocation-facade.md)).

## See also

- [API reference: Effects](../../docs/api-reference.org) (`@loom/effect-runtime`).
- [User guide, section 3: Effects and middleware](../../docs/user-guide.md#3-effects--middleware).
- [`@loom/app`](../app/README.md), [`@loom/agent`](../agent/README.md),
  [`@loom/workflow-runtime`](../workflow-runtime/README.md).
