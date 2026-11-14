# @loomwork/isolate — your own tool code in a child process

`IsolatedToolEffect` runs a tool you wrote and trust in a separate child process, instead of in the
kernel's process with ambient authority. The child gets a scrubbed environment (only the credentials you
declare for that tool, plus `PATH`), and its network goes through a kernel-side broker that checks a static
`host:port` allowlist before any connection. It is **hardening, not OS confinement**: ADR 0019 and ADR 0144
are explicit that a hostile tool can defeat the runner's guards, and that real confinement needs an
OS-level layer. **Model-written code does not belong here.** Run that through `@loomwork/sandbox` (and
`@loomwork/plugin-sandbox`), which is built for untrusted scripts. Use this package to keep a trusted tool off
your process's secrets and off the open network.

```ts
import { IsolatedToolEffect } from "@loomwork/isolate";
import { app } from "./config"; // your defineConfig result

app.effectRuntime.register(
  "enrich",
  new IsolatedToolEffect({
    id: "enrich",
    modulePath: "/abs/path/to/enrich.js", // the child loads this module; it is never a parent closure
    egress: ["api.internal:443"], // explicit host:port, even for 443; omit for no network at all
    env: { API_TOKEN: process.env.ENRICH_TOKEN ?? "" }, // only this tool's credentials
    timeoutMs: 5_000, // exceeding it SIGKILLs the child
    idempotent: true,
  })
);
```

The module the child loads is CommonJS and exports `(input, ctx)`, as `default` or as the module itself
(or the name in `exportName`):

```js
// /abs/path/to/enrich.js
module.exports = async (input, ctx) => {
  const res = await ctx.fetch("https://api.internal:443/enrich", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return res.json();
};
```

## Surface

- **`IsolatedToolEffect(spec)`** implements `Effect`, so authorization, metering and validation run on the
  kernel side of the boundary. `warm()` and `close()` manage the child. `IsolatedToolSpec` has `id`,
  `modulePath`, `exportName`, `egress`, `env`, `timeoutMs`, `idempotent`, `warm`, `coldStartMs`,
  `fetchTimeoutMs` and `maxConcurrentFetches`.
- **What the tool receives.** `IsolatedToolContext`: `executionId`, `stepId`, `workflowId`, `attempt`,
  `idempotencyKey`, `emit`, `signal` and the brokered `fetch` (`IsolatedFetchInit`, `IsolatedFetchResponse`).
- **Egress broker.** `brokeredFetch` and `EgressDeniedError`; a refusal is also recorded as a durable
  `EGRESS_DENIED` event.
- **Errors.** `IsolatedToolStartupError` (with a `phase` of `spawn` or `load`),
  `IsolatedToolDisconnectedError`, `IsolatedToolInputError`.

## Behaviour that surprises people

- **Not confinement.** The runner blocks ambient network modules and exits when its parent disconnects, but
  a tool can override those handlers. Do not treat it as a sandbox for code you do not trust.
- **Egress entries need an explicit port.** `https://api.internal/...` is checked as `api.internal:443`, so
  `"api.internal"` alone matches nothing. An IP literal must itself be listed. The broker resolves the name
  once and connects to that address, so a DNS rebind cannot redirect the request.
- **One run at a time per child.** The process stays warm across calls and is respawned if it dies. A cold
  start is bounded by `coldStartMs` (default 10 s), and that window covers the tool's own top-level code.
- **A tool may emit application events only.** Emitting a kernel event type kills the run with an error;
  kernel facts such as `EGRESS_DENIED` are written by the parent.
- **The input must be JSON-serializable**, since it crosses an IPC channel. A disconnect counts as the
  child's death: it is killed and the run fails.
- **Abort or `timeoutMs` SIGKILLs the child**, the kernel's only non-cooperative termination. A fetch
  already in DNS lookup answers the tool at once but holds its concurrency slot until the lookup returns.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loomwork/isolate` — data-plane isolation & brokered egress (K7)" in [docs/api-reference.org](../../docs/api-reference.org).
- Guide: [isolation and untrusted content](../../docs/user-guide/isolation-and-untrusted-content.md).
- ADRs: [0019 K7 data-plane isolation and egress control](../../docs/adr/0019-k7-data-plane-isolation-and-egress-control.md), [0144 sandbox backend SPI](../../docs/adr/0144-sandbox-backend-spi.md) (why this stays separate from the sandbox), [0104](../../docs/adr/0104-recovery-never-answers-a-gate.md) (application events only).
- Source: `packages/isolate/src`. For model-written code: `packages/sandbox` and `plugins/sandbox`.
