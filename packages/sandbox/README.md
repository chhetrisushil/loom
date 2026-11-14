# @loomwork/sandbox

The seam for running **model-written code** inside an isolation boundary you choose (ADR 0144). A
`SandboxBackend` is only the engine: it runs one verified script against one bounded input and reports
what happened. `SandboxEffect` wraps any backend and supplies everything around it, so a Cloud Run,
Firecracker, E2B or in-house backend gets the same limits, content-address check, typed failure
channels and replay form as the default. Use this package to write or wire a backend; for the default
engine, install `@loomwork/plugin-sandbox`. It is not for trusted tool code: that is `@loomwork/isolate`.

```ts
import { EffectRuntime } from "@loomwork/effect-runtime";
import { type SandboxBackend, registerSandboxBackend, sandboxEval$ } from "@loomwork/sandbox";

const backend: SandboxBackend = {
  // Declare the truth: the effect checks these claims and the conformance kit tests them.
  capabilities: { language: "javascript", network: "none", wallClock: "hard", memory: true, cpu: true, freshPerRun: true },
  async evaluate({ script, inputJson, limits, signal }) {
    // Hand the script and input to your boundary; map what happened to one outcome kind.
    return { ok: true, value: null };
  },
};

const scripts = { get: async (_ref: { __loomContent: string }) => null as Uint8Array | null }; // your content store
const effects = new EffectRuntime();
const effect = registerSandboxBackend(effects, scripts, backend, { limits: { wallClockMs: 2_000 } });
export const reshape = sandboxEval$("reshape"); // step input: { scriptRef, input?, expectedOutputShapeHash? }
```

Call `effect.warm()` at boot and `effect.close()` at shutdown.

## Surface

- **Backend SPI** (`SANDBOX_BACKEND_SPI_VERSION` 1.0.0): `SandboxBackend`, `SandboxRequest`,
  `SandboxBackendCapabilities`, and `SandboxOutcome`, which is one of `ok`, `limit`, `threw`,
  `inputTooLarge` or `infrastructure`.
- **The effect.** `SandboxEffect`, `registerSandboxBackend`, `sandboxEval$`, `SandboxEvalInput`.
- **Failure channels.** `SANDBOX_ERRORS`: `scriptMissing`, `limitExceeded`, `shapeMismatch`,
  `scriptError`, `inputTooLarge`, `inputNotSerializable`.
- **Helpers.** `shapeOf` / `shapeHash`, `boundText`, `validateOutcome`.
- **Proof.** `runSandboxBackendConformance` in `@loomwork/conformance`; `loom plugin new sandbox <name>`
  scaffolds a backend with the most conservative capability claims.

## What the default backend does and does not isolate

`@loomwork/plugin-sandbox` runs QuickJS compiled to WASM. A fresh runtime holds only what is injected: no
filesystem, network, process or timers exist in it, so there is no scrub list to keep complete. It
sets a memory limit and an interrupt-based CPU budget, and it gives every run a fresh runtime. That is
isolation from ambient authority, not an operating-system boundary:

- Run in-process, it executes on the calling thread. The wall clock is checked only when the engine
  calls its interrupt handler, so it is a **soft** bound: a script that never loops can outlive it (ADR
  0089 measured `"x".repeat(300000000)` running 790 ms against a 50 ms clock). While it runs, the event
  loop is blocked, and concurrent calls run one after another.
- The opt-in worker pool (`workers`) adds a hard kill by terminating the thread. A thread is not a
  security boundary either: ADR 0089 says it is not an isolation change.
- It shares the host process, so a flaw in the engine or the WASM runtime is not contained by it. If
  you must contain that, bring a backend whose boundary does.

## Behaviour that surprises people

- **The effect refuses what it cannot vouch for.** Construction throws if a backend declares
  `network` other than `"none"` (pass `allowNetwork: true`) or `freshPerRun: false` (pass
  `allowReusedEnvironment: true`). `idempotent` is true only for `network: "none"` with a fresh
  environment. The capabilities are read once and frozen.
- **A thrown error is never a channel.** What `evaluate` throws is rethrown as an untyped error with
  bounded text, an `infrastructure` outcome is untyped and retryable, and a malformed outcome fails
  untyped. Only what the script itself did (`threw`, `limit`) becomes a typed channel.
- **Cancellation wins.** An aborted signal throws the cancellation whatever the backend reported. A
  backend that never settles loses to a deadline of `wallClockMs + backendGraceMs` (default 60 s).
- **Defaults.** 1 s wall clock, 32 MiB memory, 32 MiB input ceiling, 1 MiB output ceiling.
- **The value is its JSON round-trip.** The first run returns the parsed JSON form, which is what a
  replay returns, so `NaN` is `null` both times.
- **Scripts are re-hashed against their content address** before they run.

## See also

- API reference: section "`@loomwork/sandbox` — the sandbox backend SPI" in
  [docs/api-reference.org](../../docs/api-reference.org).
- ADRs: [0144 backend SPI](../../docs/adr/0144-sandbox-backend-spi.md),
  [0064 sandbox effect](../../docs/adr/0064-sandbox-eval-plugin.md),
  [0089 worker pool](../../docs/adr/0089-sandbox-worker-pool.md).

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).
