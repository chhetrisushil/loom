// ── ADR 0064 — sandbox contract types ────────────────────────────────────────
//
// The contract SHAPE follows @loom/isolate's IsolatedToolSpec (static spec,
// scalar-marshaled context, no closures over parent state) — but the engine is
// QuickJS-in-WASM: capability-EMPTY by construction. Nothing exists inside the
// VM except what is injected (a JSON-marshaled `input`), so no-I/O is a
// property, not a scrub list.

export interface SandboxLimits {
  /** QuickJS heap ceiling. Default 32 MiB. */
  memoryBytes?: number;
  /**
   * CPU budget as interrupt-handler ticks (QuickJS invokes the handler
   * periodically during execution). Default 10_000 — generous for reshaping,
   * lethal for runaway loops.
   */
  interruptBudget?: number;
  /** Wall-clock ceiling for a single eval. Default 1_000ms. */
  wallClockMs?: number;
  /**
   * Ceiling on the JSON size of the value a script may return. Default 1 MiB.
   *
   * The other three limits bound what a script may CONSUME; this bounds what it may
   * EMIT. A script's return value becomes the step's output and therefore a durable
   * `STEP_COMPLETED` payload in an append-only log — so an adversarial script could bloat
   * the immutable log with megabytes per call, which is exactly the concern that already
   * caps script-authored error text at 2 KB on the failure path. The success path was
   * unbounded (measured: a trivial script returning 5 MB), bounded in practice only by the
   * VM heap ceiling.
   */
  maxOutputBytes?: number;
  /**
   * Ceiling on the JSON size of the CALLER-supplied `input`. Default 32 MiB — matching
   * `memoryBytes`'s default, NOT `maxOutputBytes`'s: an input this large already succeeds
   * today under the default `memoryBytes` (real reshaping inputs measured 1.47–30.9 MB all
   * complete fine), so a tighter default would refuse calls that work now. There is no
   * general "headroom under the heap" rule to appeal to instead — how much a given JSON
   * text expands once `JSON.parse`d depends on its shape (e.g. a numeric array parses far
   * larger than an equally-long string), so the honest default is simply the existing
   * `memoryBytes` ceiling: nothing that fits in the heap today is newly refused, and
   * anything that would not have fit either way still fails, just earlier and typed (see
   * below) instead of via a VM allocation failure.
   *
   * `input` is unmarshaled `z.unknown()` — nothing here bounds it — and every other
   * limit is charged to the SCRIPT's execution, which does not start until the input has
   * already been JSON-stringified by the caller, posted (worker mode) or parsed into the
   * VM (either mode). None of that work runs inside the guarded window, so an oversized
   * input is bounded only by the worker pool's startup-liveness window (ADR 0089 D4) —
   * generous on purpose, since it also has to cover a slow cold host — and on a timeout
   * fails with the untyped `SandboxWorkerStartupError`, which default retry middleware
   * then retries: a 200 MB input can hold a worker for ~10 s per attempt, repeatedly.
   *
   * This is checked ONCE, on the caller's side, before either engine is touched: measured
   * in UTF-8 bytes of the same JSON the caller already produces to seed the VM or post to
   * a worker (never serialized twice), and refused with the typed, non-retryable
   * `inputTooLarge` channel (`SANDBOX_ERRORS.inputTooLarge`) — deterministic, so retrying
   * cannot help, and no worker is ever spawned or occupied for a rejected call. Deliberately
   * NOT `limitExceeded`: that channel is recorded as the SCRIPT's outcome and routes to
   * drift-repair, where a planner re-authors the script — which cannot shrink a caller's
   * input. `inputTooLarge` also covers a heap overflow while PARSING an input that passed
   * this check (an input under `maxInputBytes` can still expand past `memoryBytes` once
   * parsed) — the same class of caller problem, against the other ceiling.
   */
  maxInputBytes?: number;
}

/**
 * Where scripts evaluate (ADR 0089). Opt-in: omitted or `count: 0` keeps the
 * in-process engine, which is what every existing consumer gets.
 */
export interface SandboxWorkers {
  /**
   * Worker threads to run scripts on. QuickJS evaluation is synchronous and
   * cannot yield, so in-process it blocks the caller's event loop for up to
   * `wallClockMs` and a concurrency-limited fanout is fictitious — N evals
   * still run one after another. A pool fixes both, and adds the hard kill the
   * in-engine guards cannot do (see `hardKillGraceMs`).
   *
   * Requires the package to have been BUILT: the worker entry is compiled
   * output, resolved next to the pool module.
   */
  count?: number;
  /**
   * Grace past `wallClockMs` before a worker is terminated outright. Default
   * 2000 ms. The in-VM wall clock is a SOFT bound — it is only checked when
   * QuickJS invokes the interrupt handler, so a script allocating heavily
   * between callbacks runs past it. This is the backstop that ends that class.
   * It is measured from the same instant as the in-VM clock, and it stops when
   * the worker marks the run finished, so the grace need only cover the in-VM
   * `dump` of the result and disposing the runtime.
   *
   * Not charged to it: a cold worker's spawn and WASM compile (bounded by
   * `coldStartMs`), and input parse/seeding (bounded by `startupLivenessMs`).
   * Nor is encoding and posting the result once the run is marked finished;
   * that runs no script code and is bounded only by the worker replying.
   */
  hardKillGraceMs?: number;
  /**
   * How long past `wallClockMs + hardKillGraceMs` a run on a READY worker may
   * go without STARTING — input parse, runtime creation and seeding — before
   * its worker is terminated and the run fails with `SandboxWorkerStartupError`
   * (untyped, so retryable by default). Counted from when the eval is posted;
   * the cold compile has its own allowance, `coldStartMs`. Default 10 000 ms.
   * Must be a finite number >= 0.
   */
  startupLivenessMs?: number;
  /**
   * How long a cold worker may take to spawn and compile its WASM module,
   * measured from when it starts warming, before it is terminated and whatever
   * waits on it (a run, `warm()`) fails with `SandboxWorkerStartupError`
   * (`phase: "compile"`). Independent of any run's limits on purpose: a hard
   * kill leaves a cold worker behind, and a compile judged against a tight
   * `wallClockMs` would fail the next run, replace the worker cold, and loop.
   * Default 10 000 ms. Must be a finite number STRICTLY greater than 0 — unlike
   * `hardKillGraceMs`/`startupLivenessMs`, 0 is not "no allowance" here: it is
   * the only clock a cold compile is ever judged against, so 0 fails every cold
   * start, forever. Set it above this host's real cold spawn + WASM-compile time.
   */
  coldStartMs?: number;
}

/** Static description of a sandbox executor (P5 — wiring is static). */
export interface SandboxSpec {
  /** The effect id this executor registers under. Default `"sandbox.eval"`. */
  id?: string;
  limits?: SandboxLimits;
  workers?: SandboxWorkers;
}

// Moved to @loom/sandbox (ADR 0144); re-exported so existing imports keep working.
export {
  SANDBOX_ERRORS,
  SandboxEvalInput,
  type SandboxEvalInputValue,
  type ScriptReader,
} from "@loom/sandbox";
