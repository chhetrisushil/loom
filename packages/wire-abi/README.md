# @loomwork/wire-abi — drive a Loom execution from a non-TypeScript client

A versioned JSON-RPC description of the kernel, plus a request handler that starts, resumes, reads and
cancels executions over it. Use it when a client written in another language, or a shell script, needs
to talk to a Loom runtime without importing TypeScript. The TypeScript `ctx` surface stays the
authority; the wire method table is generated from `KERNEL_SYSCALLS`, so it cannot drift from it
(ADR 0026). If every caller is TypeScript, you do not need this package.

```ts
import { handleRpc } from "@loomwork/wire-abi";
import type { JsonRpcRequest } from "@loomwork/wire-abi";
import type { WorkflowRuntime } from "@loomwork/workflow-runtime";

declare const runtime: WorkflowRuntime; // booted, with your flows registered

// Call this from whatever transport you mount it on (node:http, a worker, ...).
export async function onRequest(request: JsonRpcRequest) {
  return handleRpc(runtime, request, {
    // Derive the caller from the authenticated connection, never from the body.
    resolvePrincipal: () => ({ actor: "billing-service" }),
  });
}

// Request: { jsonrpc: "2.0", id: 1, method: "execution.start", params: { flowId: "greet", input: {} } }
// Result:  the folded state: { executionId, workflowId, status, sequence, variables, frames, suspendedOn? }
```

## Surface

- **Carrier.** `handleRpc(runtime, request, options?)` answers `execution.start`, `execution.resume`,
  `execution.getState`, `execution.cancel` and `abi.describe`. It does not throw: every failure is a
  JSON-RPC error object. `start` and `resume` wait until the run suspends or finishes, then return that
  state. `CarrierOptions` takes `resolveFlow` (defaults to `runtime.getFlow`) and `resolvePrincipal`.
- **Descriptor.** `WIRE_ABI`, `WIRE_ABI_VERSION`, `WIRE_METHODS`, `CARRIER_METHODS`, `deriveWireMethods`.
  `WIRE_METHODS` marks each syscall `unary` or `channel` (`stream` and `ui` are channels).
- **Framing.** `JsonRpcRequest`, `JsonRpcResponse` and `RPC_ERRORS`. A kernel refusal (denial, quota,
  forged approval, and so on) is `-32000`.
- **Conformance vectors.** `FOLD_VECTORS` is a list of event logs with the state each must fold to, as
  plain JSON. `runFoldVectors()` runs the TypeScript fold over them; another language can load the same
  vectors and run its own fold.

## Behaviour that surprises people

- **It is a function, not a server.** Nothing in the repo mounts `handleRpc` on HTTP; you supply the
  transport and its authentication.
- **`ctx.*` methods are not callable.** A wire client drives executions; individual syscalls such as
  `ctx.execute` are answered with `methodNotFound`.
- **The principal comes from your code.** `resolvePrincipal` is applied to all four `execution.*`
  methods, and any `principal` in the request params is ignored. If you omit it, no principal is
  asserted and the runtime's default identity applies, which `security.strict` refuses.
- **The state view drops settled step inputs.** `frames[..].input` is present only for steps still in
  flight (ADR 0138); read settled inputs from the log.

## Status / See also

`npm install @loomwork/wire-abi` (or pnpm / yarn). Pre-1.0: every `@loomwork/*` package shares one version, so keep them on the same release.
Inside this repo use `workspace:*`; a sibling checkout links it with a `link:` override (see [AGENTS.md](../../AGENTS.md)).

- [ADR 0026](../../docs/adr/0026-t2-wire-level-kernel-abi.md): the design, and what is staged.
- API reference: section "`@loomwork/wire-abi` — wire-level kernel ABI (T2)" in
  [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
