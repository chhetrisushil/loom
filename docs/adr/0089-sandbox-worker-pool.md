# ADR 0089 — `@loom/plugin-sandbox`: worker-thread evaluation and the hard kill

- Status: **Accepted** (opt-in `workers` on `SandboxSpec`; in-process stays the default)
- Date: 2026-09-05
- Amends: ADR 0064 (`@loom/plugin-sandbox` — engine, channels, limits). Nothing
  in 0064 is withdrawn; this adds a second place the same evaluation can run.
- Related: K7 / `@loom/isolate` (the isolation contract 0064 follows), ADR 0060
  (typed channels).
- Amended by: [ADR 0144](0144-sandbox-backend-spi.md) (the worker pool is now part of `QuickJsSandboxBackend`; outcome interpretation moved into the backend).
- No kernel changes.

## Context

ADR 0064 chose QuickJS-in-WASM specifically to avoid a per-eval process spawn:
the VM is capability-empty by construction, so isolation needs no OS boundary.
That decision stands. What it did not address is that `vm.evalCode` is
**synchronous and cannot yield** — so `wallClockMs` is not only the longest a
script may run, it is the longest the calling thread is unavailable.

Two consequences, both measured on a real consumer (GenUI dashboard hydration,
reshaping raw tool output to a canonical shape):

**Concurrency is fictitious.** A `fanout` with `{ limit: 4 }` reads as four
evaluations in flight. They are four *invocations* in flight; the evaluations
run one after another on the one thread. Four CPU-bound reshapes: 1291 ms wall,
with the event loop unavailable for 1287 ms of it.

**The wall clock is a soft bound.** It is checked from the interrupt handler,
which QuickJS invokes on backward jumps — so a script that never loops is never
asked to stop. Measured: `"x".repeat(300000000)` runs **790 ms against a 50 ms
wall clock, having taken exactly one interrupt callback**. Nothing in-engine
bounds that class; the script ends when it ends, or when the memory ceiling
catches it. An earlier attempt to bound the tail by lowering `wallClockMs` does
not touch this at all.

## Decisions

### D1 — An opt-in pool of worker threads, not a process per eval

`SandboxSpec.workers = { count }` moves evaluation onto Node worker threads.
Omitted, or `count: 0`, keeps the in-process engine — every existing consumer is
unaffected, and the default remains the cheapest thing that works.

Threads, not processes, because **this is not an isolation change**. The VM was
already capability-empty; a thread adds nothing to that, and 0064's reasoning
against per-eval process spawn still holds. What a thread adds is a place to
block that is not the caller's event loop, and a handle that can be terminated.

### D2 — One implementation of the guards, shared by both engines

`evalInFreshRuntime` is extracted to `evalCore.ts` and used unchanged by the
in-process path and the worker. Two copies of a memory limit, an interrupt
budget and a wall clock is two things to keep in step, and the copy that drifts
is the one nobody runs the security list against.

The ADR 0064 security list — runaway loop, allocation bomb, wall clock, no
ambient I/O, shape mismatch, erased script, determinism — is therefore
parameterized over both engines rather than duplicated. Worker mode is proven
not to weaken anything by running the same list, not by argument.

### D3 — Outcomes cross the boundary; channels do not

`evalCore` returns an outcome (`ok`, or a message plus which guard tripped). The
effect maps that to a typed channel. A `TypedFailure` cannot cross a worker
boundary, but the deeper reason is K7.5: the kernel side of an isolation
boundary keeps authorize / meter / validate, and deciding what a kill *means* is
the same kind of policy. The worker reports what happened; the effect decides
what it was.

### D4 — A hard kill, bounded by `wallClockMs + hardKillGraceMs`

The pool arms its own deadline. When it fires, the worker is terminated and
replaced — the non-cooperative path, the one `@loom/isolate` spells `SIGKILL`.
This is the only thing that bounds the class in D2's second measurement, and it
is why the pool is worth having even for a caller that does not care about
concurrency.

The grace (default 2000 ms) exists because the in-VM clock is the *primary*
guard and this is the backstop. The hard-kill clock runs from the instant the
in-VM clock is armed to the moment the worker marks the run finished, so the
grace must leave room only for what sits between the script's last op and that
mark: the in-VM `dump` of the result (which can run the script's own `toJSON`)
and disposing the runtime. Encoding the result for transfer happens after the
mark and is not charged.

**Worker startup is excluded from the deadline**, which is armed only after the
worker acknowledges its WASM module compiled. `wallClockMs` bounds the script;
charging the engine's boot to it turns a slow host into
`limitExceeded { wallClock }` — a resource kill that routes to drift-repair,
where an LLM rewrites a script that was never the problem. This is a live path,
not a first-request edge case: a hard kill leaves a *cold* worker behind, so the
run right after a kill is exactly the one that would pay. The first version of
this ADR got it wrong and CI caught it (25 ms cold start locally, enough more on
a shared runner to eat a 100 ms budget); the guard is now self-calibrating
against the machine it runs on rather than a fixed number that passes anywhere
fast.

**Nor are runtime creation and input seeding** (backlog L13). The budget is
measured from the instant the in-VM wall clock is armed, which the engine reports
itself (`evalInFreshRuntime`'s `onScriptStart`), so the two clocks share one
origin. The worker used to stamp its own start before creating the runtime and
seeding the input, and a 16 MiB input then came back `limitExceeded { wallClock }`
from worker mode for a trivial script in-process mode completed.

#### The uncharged phases are bounded by startup liveness

Excluding a phase from the script's budget does not leave it unbounded. Two
allowances cover the phases before the in-VM clock is armed, and either one
running out terminates and replaces the worker and fails with
`SandboxWorkerStartupError` (its `phase` says which):

- **The cold compile** (`phase: "compile"`) — a worker's spawn and WASM compile
  — has its OWN allowance, `coldStartMs` (default 10 s), measured from when that
  worker starts warming and shared by everything waiting on it (`warm()`, queued
  runs). It is deliberately independent of any run's limits. A hard kill leaves
  a cold worker behind, so a compile judged against the next run's
  `wallClockMs + hardKillGraceMs` would fail that run whenever the window is
  shorter than the host's cold start, replace the worker cold, and repeat — the
  very loop this decision exists to prevent, multiplied by retry middleware.
  `coldStartMs` must be strictly greater than 0 and set above this host's real
  cold spawn + compile time — unlike `hardKillGraceMs`/`startupLivenessMs`, 0
  does not mean "always warmed before use" here (a run's window never judges
  the compile), it means every cold start fails, forever.
- **Starting the script on a ready worker** (`phase: "start"`) — being
  scheduled, parsing the input, creating the runtime, seeding it — is bounded by
  the run's window, which opens once the worker is ready: a run that has not
  *started* within `wallClockMs + hardKillGraceMs + startupLivenessMs` (default
  10 s past the budget) of the eval being posted.

That failure is deliberately **not** a typed
channel. `limitExceeded` is recorded as the script's outcome and routes to
drift-repair, and nothing the script did explains a worker that never started
it. It is a named error class instead, so retry middleware can tell it apart
from a script failure — and because it is not a `TypedFailure`,
`retryMiddleware`'s default already retries it.

**How large an input may be is answered by `maxInputBytes`** (backlog L19), a
ceiling on the CALLER-supplied `input`. Its default is **32 MiB — matching
`memoryBytes`'s default, not `maxOutputBytes`'s**. An earlier draft of this
decision defaulted it to 1 MiB (`maxOutputBytes`'s own default) on the theory
that it would "leave headroom under the 32 MiB heap ceiling" — reviewed and
rejected: there is no such headroom rule, because how much a JSON text
expands once `JSON.parse`d depends on its *shape* (a numeric array parses far
larger than an equally-long string), and real reshaping inputs measured
1.47–30.9 MB all succeed TODAY under the default heap. A 1 MiB default would
have refused every one of them — the fix must not break what already works,
so the default is simply `memoryBytes`'s own default, derived from the same
constant so the two cannot drift apart into a number that (mis)implies a
relationship that does not hold.

Without any such ceiling, an oversized input was bounded only by the
startup-liveness window above: a 200 MB input could hold a worker busy for
~10 s and then fail with the untyped `SandboxWorkerStartupError`, which
default retry middleware then retries — repeatedly, on a call that was never
going to succeed. `maxInputBytes` is checked in `SandboxEvalEffect`, the
caller of both engines, ONCE and BEFORE either is touched (and before the
script is even fetched — a deliberate precedence change: a call with both an
oversized input AND a bad `scriptRef` now reports the input problem, not
`scriptMissing`, since the check needs no store round trip and refusing a
plainly-oversized call should not wait on one): measured in UTF-8 bytes of
the same JSON text the caller already produces to seed the VM in-process or
post to a worker (never serialized twice — `evalInFreshRuntime` and
`SandboxWorkerPool.runJson` both now take that JSON text directly rather than
the raw value, so seeding a worker no longer parses it back out only to
re-stringify it for the VM). That one `JSON.stringify` unavoidably happens on
the CALLER's thread before the size is known — there is no way to measure
"the JSON size" without producing the JSON — so a very large input is fully
serialized before it can be refused; there is no way to check a byte count
that does not yet exist.

An oversized input fails typed, on a **new** channel: `inputTooLarge { bytes,
limit }`. Deliberately **not** `limitExceeded` — reviewed and corrected from
an earlier draft that reused it with `kind: "input"`. `limitExceeded` is
recorded as the SCRIPT's own outcome (D3) and routes to drift-repair, where a
planner re-authors the *script* — the exact backstop this section just
described for the startup-liveness case above. A caller's oversized `input`
is not a script problem, and no script rewrite can shrink it, so folding it
into the script's channel would send drift-repair somewhere it cannot help.
`inputTooLarge` is still, like `limitExceeded`, a `TypedFailure` — and
therefore still non-retryable by `retryMiddleware`'s default — but it says
what actually needs to change: the input, not the script.

Two more caller-input failure modes surfaced in review, both handled the same
way — typed, non-retryable, and reported before either engine runs:

- **`input` cannot become JSON at all.** `JSON.stringify` throws on a BigInt
  or a circular reference, and — less obviously — RETURNS the JS value
  `undefined` (not a string) for a bare function, a bare Symbol, or an object
  whose `toJSON` returns `undefined`, at the top level. Before this was
  handled, the first class threw an untyped `TypeError` straight out of the
  effect (retried three times for nothing by default middleware) and the
  second fed `undefined` into `Buffer.byteLength`, which itself throws an
  unrelated, confusing `TypeError`. Both are now caught and reported as
  `inputNotSerializable { reason }` — a new channel, distinct from
  `inputTooLarge` because the input was never sized at all.
- **An input under `maxInputBytes` can still overflow the VM heap while being
  PARSED.** Parsing a JSON text can expand it well past its own byte length
  (measured: a 64 KiB heap cannot hold a 500 KB string once parsed), so
  passing the pre-flight check does not guarantee the seed succeeds. Before
  this was handled, a seed failure threw an untyped `Error` ("input
  marshalling failed: out of memory") straight out of `evalInFreshRuntime` —
  in EITHER engine, since both share it — and default retry middleware
  retried a call that could never succeed. `evalInFreshRuntime` now returns
  this as an ordinary `EvalOutcome` (`duringSeed: true`) instead of throwing,
  the same "report what happened, let the effect decide what it means" split
  D3 draws for every other outcome; the effect recognises the VM's own
  out-of-memory wording and completes it typed as `inputTooLarge { bytes,
  limit: memoryBytes }` — `limit` names `memoryBytes` here, not
  `maxInputBytes`, because that is the ceiling that actually overflowed, but
  it is the same class of problem (this input does not fit at this
  configuration) against the other ceiling `SandboxLimits` exposes. Any OTHER
  seed failure (none is currently reachable — the caller always hands the VM
  well-formed JSON) stays untyped rather than guess a channel for a shape
  nothing has actually observed.

No worker is ever spawned or occupied for a call refused by any of these
three checks.

One phase is bounded by neither clock: after the worker marks the run finished,
it encodes the result and posts it. That runs no script code — the script's own
`toJSON` ran inside `dump`, before the mark, where the hard kill still covers
it — so it is bounded only by the worker replying, and a worker that dies there
settles the run through the pool's death handling.

### D5 — Payloads cross as transferred JSON bytes, not structured clones

Both directions carry a transferable `Uint8Array`. Measured round trip on a
3.68 MiB reshape output: structured clone **66.5 ms**, JSON + transfer
**24.1 ms**. Structured clone walks the object graph on both threads; a transfer
moves the buffer without copying it. The JSON step is not a tax the pool adds —
the VM is seeded from a JSON string, and `maxOutputBytes` is already measured in
JSON bytes.

This turned out to introduce **no** observable difference: `vm.dump` already
normalizes through JSON on the way out of the VM, so in-process has always
produced `null` for a non-finite number and dropped an undefined-valued key. The
suite asserts the two engines agree by comparing them, rather than by pinning
literals that would rot if `dump` changed.

### D6 — Workers do not inherit the host's `execArgv`

A worker inherits `process.execArgv` by default, so any `--loader` / `--import`
hook the host runs would also execute inside the thread that evaluates untrusted
code. The pool passes `execArgv: []`. Hardening, not a fix — the sandbox brings
its own limits rather than the host's flags.

## Consequences

Measured, four concurrent CPU-bound reshapes:

| | wall | event loop unavailable |
| --- | --- | --- |
| in-process | 1291 ms | 1287 ms |
| 4 workers | 337 ms | 4 ms |

- A host that enables `workers` must call `effect.close()` at shutdown; the pool
  holds live threads. Same contract as `IsolatedToolEffect.close()`.
- `workers` requires the package to have been **built**: the worker entry is
  compiled output, resolved next to the pool module (`../dist` when running from
  source, as `@loom/isolate` resolves its runner). The error says so.
- Worker mode costs a thread spawn and a WASM compile per worker. `warm()` pays
  both at boot; without it the first `count` evaluations each pay one.
- The pool does not make an individual eval faster. A single reshape near the
  4 MiB output ceiling still takes its few hundred milliseconds — it just takes
  them somewhere else, minus ~20 ms of marshalling that lands on the main thread.
- Evidence: `plugins/sandbox/src/workerPool.test.ts`, plus the 0064 list in
  `plugins/sandbox/src/sandbox.test.ts` run against both engines.
