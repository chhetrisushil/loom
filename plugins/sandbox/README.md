# @loom/plugin-sandbox — run model-written JavaScript in QuickJS

The reference backend for the sandbox seam (ADR 0144). It runs a short JavaScript snippet that a model
wrote, typically one that reshapes raw tool output into a known shape, inside QuickJS compiled to
WebAssembly, and returns the result as step output. Scripts are stored by content hash, have
resource limits, and their result can be checked against a pinned shape hash. Other isolation
boundaries (gVisor, Firecracker, a hosted sandbox) are third-party backends against the `@loom/sandbox`
interface; this package is only the QuickJS one.

```ts
import { defineConfig } from "@loom/app";
import { InMemoryContentStore } from "@loom/plugin-content";
import { registerSandboxEval, sandboxEval$ } from "@loom/plugin-sandbox";

const scripts = new InMemoryContentStore(); // the content store scripts are kept in

export const app = defineConfig({
  storage: { kind: "memory" },
  execution: {
    registerEffects: (effects) => {
      void registerSandboxEval(effects, scripts, { limits: { wallClockMs: 1_000 } }).warm();
    },
  },
});

// A flow step. Its input is { scriptRef, input?, expectedOutputShapeHash? }:
export const reshape = sandboxEval$("reshape");

// The script sees one global, `input`, and returns its last expression:
//   const scriptRef = await scripts.put(new TextEncoder().encode("input.rows.map((r) => r.id)"));
```

## Surface

- **`registerSandboxEval(effects, scripts, spec?)`** registers the effect under `SANDBOX_TOOL_ID` and
  returns a `SandboxEvalEffect` (call `warm()` to precompile the WASM, `close()` at shutdown).
- **`sandboxEval$(id)`** is the step definition. The effect's typed failure channels are
  `SANDBOX_ERRORS`: `scriptMissing`, `limitExceeded` (cpu, memory, wallClock or output),
  `shapeMismatch`, `scriptError`, `inputTooLarge` and `inputNotSerializable`.
- **`SandboxSpec`** takes `limits` (`memoryBytes` 32 MiB, `interruptBudget` 10,000 ticks, `wallClockMs`
  1 s, `maxOutputBytes` 1 MiB, `maxInputBytes` 32 MiB by default) and `workers`.
- **Engine pieces.** `QuickJsSandboxBackend` (the engine as a `SandboxBackend`), `SandboxWorkerPool`,
  and `shapeOf` and `shapeHash` for computing the shape hash to pin.

## What it isolates, and what it does not

- **No ambient I/O.** A fresh QuickJS runtime holds only a JSON `input` global: no filesystem, network,
  process or timers. Reaching for `fetch` or `require` is a `ReferenceError`, reported as `scriptError`.
  This is a property of the engine, not a list of blocked calls.
- **Bounded in the engine.** Memory ceiling, an interrupt budget and a wall clock, plus caps on the
  size of the input and the output, because the output becomes a durable log entry.
- **The wall clock is soft by default.** QuickJS checks it on backward jumps, so a script that never
  loops can overrun it. `workers: { count: n }` moves evaluation onto worker threads that are killed
  when `wallClockMs` plus a grace period (2 s by default) passes (ADR 0089).
- **A worker thread is not a stronger sandbox.** It adds a place to block and a handle to terminate,
  not isolation; the isolation is QuickJS. Without workers, evaluation is synchronous and blocks the
  calling thread for as long as the script runs.
- **Not a boundary for compiled or native code, and not a place to run trusted tools.** It is meant for
  small JavaScript reshaping. `@loom/isolate` runs trusted tool code with brokered egress, and
  `@loom/plugin-cloudrun` places trusted flows; neither is this.
- **A script's error text is untrusted.** The `scriptError` name and message are written by the script
  (often by a model), truncated and stripped of a stack. Treat them as data for a planner or a log,
  never as instructions to a model. Pin `expectedOutputShapeHash` if you need to know the result's shape.

## Status / See also

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override
(see [AGENTS.md](../../AGENTS.md)).

- [ADR 0064](../../docs/adr/0064-sandbox-eval-plugin.md): the engine, limits and failure channels.
- [ADR 0089](../../docs/adr/0089-sandbox-worker-pool.md): the worker pool and the hard kill.
- [ADR 0144](../../docs/adr/0144-sandbox-backend-spi.md): the backend interface and other backends.
- API reference: sections "`@loom/sandbox` — the sandbox backend SPI" and "`@loom/plugin-sandbox` —
  untrusted code as an effect" in [docs/api-reference.org](../../docs/api-reference.org).
- Guides: [docs/user-guide.md](../../docs/user-guide.md), [docs/README.md](../../docs/README.md).
