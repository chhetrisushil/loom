# ADR 0144 — Sandbox backend SPI: bring your own sandbox, keep loom's guarantees

- Status: **Accepted** (2026-11-01) — proposed 2026-11-01, implemented and merged (PR #747); accepted by the owner
- Date: 2026-11-01
- Amends: [ADR 0064](0064-sandbox-eval-plugin.md) (the sandbox effect, its channels and its security
  list) and [ADR 0089](0089-sandbox-worker-pool.md) (worker-thread evaluation). Nothing in either is
  withdrawn: QuickJS stays the default engine and the reference backend, with the same limits, the same
  channels and the same security list.
- Related: [ADR 0043](0043-plugin-packaging-and-1p-3p-separation.md) (SPI in `packages/`, adapters as
  plugins, 1P/3P split), [ADR 0083](0083-second-consumer-rule.md) (second-consumer rule),
  [ADR 0060](0060-typed-failure-channels.md) (typed channels), [ADR 0085](0085-untrusted-content-integrity-axis.md)
  (untrusted text), [ADR 0003](0003-cloud-run-worker-runtime.md) (the Cloud Run worker runtime, which this
  is NOT).
- Placement: **SPI = new `@loom/sandbox` package (`packages/sandbox`, listed in `SPI_PACKAGES`);
  reference backend = `@loom/plugin-sandbox` (QuickJS, 1P); every other backend = 3P.** Kernel,
  KERNEL_ABI and EVENT_SCHEMA unchanged. New `SANDBOX_BACKEND_SPI_VERSION 1.0.0`.

## Context

`@loom/plugin-sandbox` runs model-written code in QuickJS-in-WASM. It is the right engine for what it was
built for (reshaping tool output in JavaScript), and it is the only engine loom offers. Two questions came
up together:

1. *Can the Cloud Run plugin run model-written code?* No. `@loom/platform-cloudrun` decides **where**
   trusted, registered flows run (`POST /execute` names a `flowId`, never source), and its worker holds
   the stores, the platform's secrets and identity, and can run as SYSTEM. It is a placement adapter, not
   an isolation boundary.
2. *Should a Cloud Run sandbox be 1P?* No: it is vendor-specific and nothing in loom consumes it. It is
   a 3P plugin (ADR 0043 D4), promotable later.

The question behind both is the one this ADR answers. **Any production deployment that runs model-written
code brings its own isolation boundary**: an organisation that sandboxes untrusted code already has a
mandated one (gVisor on Cloud Run or GKE, Firecracker, E2B, Modal, an internal service), and it will not
adopt the framework's. That is a property of the workload, not a request from one caller. It is the
domain argument that ADR 0083's second-consumer test admits in place of a missing caller (every current
consumer of `sandboxEval$` is in-repo), and it was the owner's ruling on 2026-11-01: users will write their
own sandbox plugins, so loom ships the seam they write against.

What a third party must **not** have to rewrite is everything around the engine. `SandboxEvalEffect` is
already split that way: `evaluate()` is the only engine-specific step. Around it sit the input ceiling and
serialisability check, the content-address check on the script bytes, the output ceiling, the shape check,
bounded and storable error text, cancellation precedence, and the outcome → channel mapping. Those took
many review rounds (ADR 0064's 2026-09-27 amendment, `inputLimit.test.ts`, `outputLimit.test.ts`,
`scriptIntegrity.test.ts`). A backend author who re-implements them gets them subtly wrong, and the copy
that drifts is the one nobody runs the security list against (ADR 0089 D2's argument, one level up).

`@loom/isolate` stays separate (owner ruling, 2026-11-01). It runs TRUSTED tool code with brokered egress;
this seam runs UNTRUSTED, model-written scripts. The two have different trust models, and one interface
over both would blur the line that matters most.

## Decisions

### D1 — The SPI is the engine, and only the engine

`@loom/sandbox` defines:

```ts
interface SandboxBackend {
  readonly capabilities: SandboxBackendCapabilities;
  evaluate(request: SandboxRequest): Promise<SandboxOutcome>;
  warm?(): Promise<void>;   // advisory pre-warm (M6)
  close?(): Promise<void>;  // release pools, connections, instances
}

interface SandboxRequest {
  script: string;           // verified source text (D3)
  inputJson: string;        // the caller's input, already JSON text, already bounded (D3)
  limits: { wallClockMs: number; memoryBytes: number };
  signal?: AbortSignal;
}
```

The script contract is language-neutral: the backend exposes `input` (the parsed `inputJson`) to the
script and returns the script's result as a JSON value. How a given language spells "input" and "result"
is the backend's documented convention; QuickJS's is ADR 0064's (a global `input`, the completion value).

Engine-specific knobs (QuickJS's `interruptBudget`, a worker pool, a Cloud Run service URL, a VM image)
are the backend's constructor options, never fields of the SPI.

### D2 — The backend reports what happened in a closed vocabulary; loom decides what it means

```ts
type SandboxOutcome =
  | { ok: true; value: unknown }
  | { ok: false; kind: "limit"; limit: "cpu" | "memory" | "wallClock" }
  | { ok: false; kind: "threw"; name?: string; message: string }
  | { ok: false; kind: "inputTooLarge" }        // the input overflowed memory while being parsed, before the script ran
  | { ok: false; kind: "infrastructure"; message: string };
```

This is ADR 0089 D3 ("outcomes cross the boundary; channels do not") made a contract. Interpreting the
engine's own error text (QuickJS's `InternalError: out of memory`) is engine knowledge, so it moves into
the QuickJS backend. Mapping to channels, the order between them and every bound stays in the effect:

- The effect validates the outcome at run time. A malformed outcome from a third-party backend fails
  UNTYPED, never as a guessed channel.
- `threw.name` / `threw.message` are bounded and made storable by the effect (`boundText`), whatever the
  backend already did. A backend is not trusted to bound text that lands in an append-only log.
- `infrastructure` is untyped and retryable, like the worker pool's failures today. Only what the script
  itself did is typed.
- Cancellation wins over everything: an aborted signal throws the kernel's cancellation, whatever outcome
  the backend reported, threw, or failed to report.
- **A backend that never settles loses.** The effect RACES `backend.evaluate` against the caller's abort
  and against a deadline of `wallClockMs + backendGraceMs` (`SandboxEffectOptions.backendGraceMs`, default
  60 000, a finite number >= 0, validated at construction; it must cover what the backend does outside the
  script's clock: cold start, queueing, a hard-kill grace). The backend receives a COMBINED signal, aborted
  on the caller's abort or the deadline, so a well-behaved one stops. An abort throws the kernel's
  cancellation; a deadline miss throws an UNTYPED `sandbox backend did not settle within …`. Timers and
  listeners are released on every path. A synchronous in-process engine (QuickJS without workers) cannot
  be preempted by any race; the race does not break it, and its own wall clock remains the bound.
  `SandboxEvalEffect` passes a grace that covers the worker pool's configured cold start, liveness wait
  and hard-kill grace (never below the default).
- **A thrown error is never a channel, and its text is bounded.** Whatever `evaluate` throws or rejects
  with (or a getter on the outcome throws) is classified: with the signal aborted, the cancellation; a
  `TypedFailure`, rewrapped as an UNTYPED `Error` (only the effect decides what the script did); an
  `Error` whose `String(err)` is already within 2048 units and storable, rethrown as is (so a backend's
  own error class, such as `SandboxWorkerStartupError`, stays `instanceof`-checkable); anything else, a
  new `Error` carrying the bounded, scrubbed text with the original as `cause`. The kernel records
  `String(err)` in an append-only log, so the bound is the effect's job.
- Every outcome field is read ONCE and the locals are validated and used: a getter that answers
  differently the second time cannot pass a check and deliver something else.

### D3 — One effect owns the guarantees; it is the only way to use a backend

`SandboxEffect` (in `@loom/sandbox`) takes `(scripts: ScriptReader, backend, options)` and does,
unchanged from ADR 0064/0089:

- parse `SandboxEvalInput`;
- serialise and bound the input (`inputNotSerializable`, `inputTooLarge`), before the script is fetched;
- fetch the script and verify its bytes against the content address (untyped on mismatch);
- call `backend.evaluate`;
- map the outcome (D2);
- bound the output (`limitExceeded { kind: "output" }`);
- check the shape (`shapeMismatch`).

`SANDBOX_ERRORS`, `SandboxEvalInput`, `sandboxEval$`, `shapeHash` and `boundText` move to `@loom/sandbox`.
`@loom/plugin-sandbox` re-exports them, and its `SandboxEvalEffect` and `registerSandboxEval` keep their
signatures (QuickJS backend preconfigured), so no existing consumer changes a line.

**New: the success value is returned as its JSON round-trip.** The effect already serialises the value to
measure it; it now returns `JSON.parse` of that text. A durable store keeps the step's output as JSON, so
on replay the flow receives the JSON form. Returning the live object on the first run let the two runs
differ (a `NaN` is `NaN` live and `null` on replay; a third-party backend's object could carry a prototype
or a getter). Same value both times is the invariant; the cost is one parse of at most `maxOutputBytes`.

### D4 — Backends declare what they enforce; the effect refuses what it cannot vouch for

```ts
interface SandboxBackendCapabilities {
  language: string;                      // "javascript", "python", …
  network: "none" | "allowlist" | "open";
  wallClock: "hard" | "soft";            // "hard": the run is killed at the deadline (+ grace)
  memory: boolean;                       // memoryBytes is enforced
  cpu: boolean;                          // a CPU budget is enforced
  freshPerRun: boolean;                  // no state survives from one run to the next
}
```

- **Network is opt-in.** By default the effect refuses at construction a backend whose `network` is not
  `"none"`. An operator who wants egress passes `allowNetwork: true`, which is the same shape as
  `trustDescriptions` (ADR 0125 D14).
- **Idempotency follows the declaration.** `idempotent` is `true` only when `network === "none"` AND
  `freshPerRun === true`: a script that can reach the network, or that sees state left by an earlier run,
  is no longer a pure function of (script, input), so an at-least-once re-run is not safe by construction.
- **`freshPerRun: false` is refused by default.** A reused environment lets one model-written script
  leave state for the next run, which may be another tenant's. Opt in with `allowReusedEnvironment: true`.
- **The declaration is snapshotted.** The effect reads `backend.capabilities` once, validates it, and
  keeps a frozen copy (`effect.capabilities`); the opt-in checks, `idempotent` and anything reading the
  capabilities later see that vetted copy. Mutating the backend's object or a getter that flips after
  construction changes nothing.
- The conformance kit (D5) checks each declaration against behaviour. A declaration that nothing
  verifies is a guarantee in name only.

### D5 — The security list becomes a conformance kit

`runSandboxBackendConformance(factory, { fixtures? })` in `@loom/conformance` runs ADR 0064's list against
any backend, through `SandboxEffect`, so it proves the composition a user actually deploys:

| Case | Asserted |
|---|---|
| echo | `input` round-trips as the result |
| throw | `scriptError` with the thrown message |
| syntax error | `scriptError` |
| runaway loop | `limitExceeded` `cpu` or `wallClock`; finishing inside the test timeout is the proof (no timing ratio) |
| allocation bomb | `limitExceeded` `memory` (when `memory: true`) |
| rich value | unicode, escapes, integers past 2^31 and nesting come back exactly (backend evidence, not the effect's round-trip) |
| no network, no escape | the network probe AND an escape probe cannot reach the host: `this.constructor.constructor("return this")()`, `Function("return this")()`, indirect `eval`, … must not yield `process`, `require`, `fetch`, `XMLHttpRequest`, `WebSocket`, `Deno` or `Bun` (when `network: "none"`). A `node:vm` "sandbox" fails here |
| fresh per run | the stateful probe runs 16 times in sequence and then as a concurrent batch of 8; every run sees no earlier state (when `freshPerRun: true`). A pool of reused contexts fails on the third run |
| abort | an already-aborted signal yields cancellation, not a channel |
| abort mid-run | a runaway script with a very long wall clock is aborted once the backend has been called; the effect settles as a cancellation AND the backend's own call settles (it stopped) inside the timeout (when `wallClock: "hard"`; a soft clock cannot be preempted) |
| composition | an oversized `threw.message` reaches the log bounded and storable. This checks the effect around the backend, not the backend |

Scripts are language-specific, so the kit takes `fixtures` (one script per case). `JAVASCRIPT_FIXTURES`
ships as the default. A backend for another language must supply its own; the kit refuses to run a
non-JavaScript backend without them rather than pass vacuously. QuickJS (in-process and worker mode) runs
the kit in loom CI.

### D6 — `loom plugin new sandbox <name>` scaffolds a backend

A new `sandbox` seam in `@loom/scaffold`. It emits a package with:

- a `SandboxBackend` stub whose capabilities are the most conservative honest claims, the WORST case:
  `network: "open"`, `freshPerRun: false`, `wallClock: "soft"`, `memory: false`, `cpu: false`. Each
  stronger value must be earned by the kit passing with it (the kit passes the effect
  `allowNetwork` / `allowReusedEnvironment` exactly when the declaration needs them, and skips the gated
  cases);
- a test wired to `runSandboxBackendConformance`;
- a README carrying the remote-backend checklist: no service account or credentials, egress denied at the
  network layer, one request per instance, the request timeout as the hard kill, memory and CPU caps, no
  shared writable state. It says plainly that `memory: false` / `cpu: false` mean an in-process backend
  can exhaust the host.

The seam is consumed from flow code (`registerSandboxEval`), like `policy`, not from `defineConfig`, so its
wiring line says so (`seamDocs.test.ts`). `loom plugin check` holds a sandbox plugin to the peer-dependency
rule through `SPI_PACKAGES`.

## Consequences

- A Cloud Run, Firecracker, E2B or in-house sandbox is a 3P package of one class, which proves itself with
  the same kit QuickJS passes, and inherits every channel, bound and replay rule without copying them.
- QuickJS-specific error interpretation moves from the effect into the QuickJS backend. The ADR 0064
  security tests keep running, unchanged, against `@loom/plugin-sandbox`.
- Behaviour change, D3: the first run returns the JSON form of the value, which is what replay already
  returned. Covered by a test.
- Behaviour changes against the pre-0144 `SandboxEvalEffect`: (a) a success outcome that arrives after the
  signal aborted now throws the cancellation (before, it returned the value); (b) a non-`Error` abort
  reason throws `sandbox: cancelled`. A non-OOM seed failure still reads
  `sandbox: input marshalling failed: …` (now behind `sandbox backend failed:`).
- Not in scope: a 1P Cloud Run backend (3P, `loom-plugins`), multi-file scripts or package installs, and
  streaming output. Each is an additive SPI version if a backend needs it.

## Verification

- `packages/sandbox`: `SandboxEffect` tests run against a fake backend that returns every outcome kind,
  including malformed ones; the capability refusals (network, reused environment) and idempotency
  derivation; a backend that never settles loses to abort and to the deadline; a thrown `TypedFailure`,
  a 5 MB message and lone surrogates arrive untyped and bounded; the capabilities snapshot.
- `plugins/sandbox`: the existing suites unchanged and green; `runSandboxBackendConformance` over both
  QuickJS modes.
- `tools/scaffold` / `tools/cli`: the `sandbox` seam's template type-checks (`templateTypes.test.ts`) and
  its docs rows exist (`seamDocs.test.ts`).
