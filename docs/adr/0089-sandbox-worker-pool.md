# ADR 0089 — `@loom/plugin-sandbox`: worker-thread evaluation and the hard kill

- Status: **Accepted** (opt-in `workers` on `SandboxSpec`; in-process stays the default)
- Date: 2026-09-05
- Amends: ADR 0064 (`@loom/plugin-sandbox` — engine, channels, limits). Nothing
  in 0064 is withdrawn; this adds a second place the same evaluation can run.
- Related: K7 / `@loom/isolate` (the isolation contract 0064 follows), ADR 0060
  (typed channels).
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
guard and this is the backstop. It must leave room for the legitimate work the
clock does not cover: marshalling a `maxOutputBytes`-sized result (~25 ms at
4 MiB).

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
