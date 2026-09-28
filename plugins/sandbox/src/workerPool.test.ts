import { TypedFailure } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { InMemoryContentStore } from "@loom/plugin-content";
import { getQuickJS } from "quickjs-emscripten";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxWorkerPool, SandboxWorkerStartupError } from "./SandboxWorkerPool";
import { type EvalLimits, evalInFreshRuntime } from "./evalCore";
import { SANDBOX_TOOL_ID, registerSandboxEval } from "./sandboxEval$";
import type { SandboxSpec } from "./types";

// ── ADR 0089 — what the worker pool adds beyond running the same list ────────
//
// The shared security list (sandbox.test.ts) proves worker mode does not WEAKEN
// anything. This file is the other half: the three things it exists to add —
// evaluation off the caller's event loop, real concurrency, and a hard kill for
// the class the in-engine guards cannot reach — plus the one place the two modes
// observably differ.

const encoder = new TextEncoder();
const opened: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((e) => e.close()));
});

const baseCtx: EffectContext = {
  executionId: "x-1",
  stepId: "reshape#0",
  workflowId: "w-1",
  attempt: 1,
  emit: () => {},
};

async function boot(spec: SandboxSpec) {
  const scripts = new InMemoryContentStore();
  const effects = new EffectRuntime();
  const effect = registerSandboxEval(effects, scripts, spec);
  opened.push(effect);
  await effect.warm();
  const put = (code: string) => scripts.put(encoder.encode(code));
  const run = (ref: { __loomContent: string }, ctx: EffectContext = baseCtx) =>
    effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, ctx);
  return { effects, put, run };
}

/**
 * A script the interrupt handler NEVER sees: one primitive op, no backward jump.
 * Measured in QuickJS at 120e6 — ~245 ms and exactly ONE interrupt callback, so
 * a 50 ms in-VM wall clock cannot fire. The margin only widens on slower
 * hardware, where the allocation takes longer and the kill deadline does not.
 */
const NON_YIELDING = '"x".repeat(120000000).length';
/**
 * The same property — ONE interrupt callback, measured — for SECONDS rather than ~245 ms:
 * catastrophic backtracking, which runs inside the regex engine and never reaches the
 * interrupt handler. Measured 3–4.5 s unloaded on an M2 at 25 characters (it doubles per
 * character), slower under load, in a few KB of memory.
 *
 * ENGINE ASSUMPTION: this holds for the QuickJS that quickjs-emscripten 0.31 ships. Upstream
 * QuickJS 2025-04+ and quickjs-ng check interrupts during regex backtracking, so after a
 * quickjs-emscripten bump the in-VM clock ends this script at ~50 ms instead — and every
 * test that asserts `POOL_KILL` fails LOUDLY, naming `interrupted`. That is the signal to
 * swap in another non-yielding op (the measured shape: one interrupt callback, seconds long),
 * not to relax the assertion.
 *
 * The kill tests use this, not `NON_YIELDING`: against a 50 + 50 ms deadline a 245 ms script
 * leaves a starved parent ~150 ms to notice, after which the script simply FINISHES and the
 * test fails for a kill that was merely late (L13). Here the pool's kill is the only way the
 * run can end inside the test window. Tests that must tell a pool kill from the in-VM clock
 * (which can still fire on that one callback, at the very end) check the kill's own message.
 */
const RUNS_FOR_SECONDS = `/(a+)+$/.test("${"a".repeat(25)}b")`;
/** The pool's hard kill — not the in-VM clock's `InternalError: interrupted`. */
const POOL_KILL = /without yielding to the interrupt handler/;
/**
 * Long enough to observe, short enough for a shared runner. CI measured ~10x
 * slower than a dev machine on this suite, so this is deliberately modest —
 * these tests assert WHICH THREAD is blocked, never how fast the script is.
 */
const BUSY = "(() => { let n = 0; for (let i = 0; i < 1500000; i++) n += i; return n; })()";
/** CI runs this suite roughly 10x slower than a dev machine; vitest's default 5 s is too tight. */
const SLOW = 30_000;

describe("SandboxWorkerPool (ADR 0089)", () => {
  it(
    "hard-kills a script that outruns the wall clock without yielding",
    async () => {
      // The reason the pool exists at all. `wallClockMs` is enforced from the
      // interrupt handler, so a script that never reaches one is bounded by
      // nothing in-engine. `terminate()` does not need the script's cooperation.
      //
      // This used to be asserted as timing — first a fixed 200 ms bound (#383), then a
      // ratio against the same script run to completion in-process. Both compared a
      // ~100 ms deadline with a ~245 ms script, so a parent starved for ~150 ms saw the
      // script finish instead (L13). Now the script runs for seconds and the assertion is
      // WHO ended it: completion is `ok: true`, the in-VM clock says `interrupted`, and only
      // the pool's kill carries this message. No clock is compared, so load cannot move it.
      const pool = new SandboxWorkerPool({ size: 1, hardKillGraceMs: 50 });
      opened.push(pool);
      await pool.warm();

      const killed = await pool.runJson(
        RUNS_FOR_SECONDS,
        "null",
        {
          memoryBytes: 512 * 1024 * 1024,
          interruptBudget: Number.MAX_SAFE_INTEGER,
          wallClockMs: 50,
        },
        undefined
      );
      expect(killed).toMatchObject({ ok: false, tripped: "wallClock" });
      expect(killed.ok === false && killed.message).toMatch(POOL_KILL);
    },
    SLOW
  );

  it(
    "reports the hard kill as the ceiling it blew through",
    async () => {
      const { put, run } = await boot({
        limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 50 },
        workers: { count: 1, hardKillGraceMs: 50 },
      });
      const ref = await put(RUNS_FOR_SECONDS);
      const err = await run(ref).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypedFailure);
      expect((err as TypedFailure).payload).toEqual({ kind: "wallClock" });
    },
    SLOW
  );

  it(
    "in-process, a non-yielding script runs to completion past its wall clock",
    async () => {
      // Not an aspiration — the documented soft-bound. Asserted so the gap the
      // pool closes is a fact in the suite rather than a claim in a comment.
      const { put, run } = await boot({
        limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 50 },
      });
      const ref = await put(NON_YIELDING);
      await expect(run(ref)).resolves.toBe(120000000);
    },
    SLOW
  );

  it(
    "survives a hard kill: the pool replaces the worker and keeps serving",
    async () => {
      // Driven through the pool directly, because the pool takes limits PER RUN and the two
      // runs here want different ones. Through the effect both runs shared one 50 + 50 ms
      // budget, so the follow-up asserted "a trivial script finishes within 100 ms of wall
      // time" — which a host running ~129 vitest processes does not promise: the worker
      // thread is simply not scheduled, and a wall clock correctly counts that (L13). What is
      // under test is the REPLACEMENT, so the kill keeps its tight deadline and the follow-up
      // gets a budget that only a broken pool could miss.
      const pool = new SandboxWorkerPool({ size: 1, hardKillGraceMs: 50 });
      opened.push(pool);
      await pool.warm();
      const memoryBytes = 512 * 1024 * 1024;
      const interruptBudget = Number.MAX_SAFE_INTEGER;

      const killed = await pool.runJson(
        RUNS_FOR_SECONDS,
        "null",
        { memoryBytes, interruptBudget, wallClockMs: 50 },
        undefined
      );
      expect(killed).toMatchObject({ ok: false, tripped: "wallClock" });
      // The pool's own kill, not the in-VM clock — or this proves nothing about replacement.
      expect(killed.ok === false && killed.message).toMatch(POOL_KILL);

      // The only worker was terminated; the next run must get a fresh one.
      //
      // Asserted directly again. This briefly tolerated a retry, because under a full-repo
      // run the trivial script came back `limitExceeded` with the worker long since done
      // (#383) — the parent's kill timer charging its own latency to the script. That is
      // fixed at the source (#399), so tolerating it here would now hide a regression
      // rather than absorb a known artifact.
      await expect(
        pool.runJson(
          "(() => 1 + 1)()",
          "null",
          { memoryBytes, interruptBudget, wallClockMs: 60_000 },
          undefined
        )
      ).resolves.toEqual({ ok: true, value: 2 });
    },
    SLOW
  );

  it(
    "does not charge the parent's own latency to the script (#399)",
    async () => {
      // `wallClockMs` bounds the SCRIPT. The kill timer lives on THIS thread, so before
      // #399 it also measured however long this thread took to hear back — and libuv runs
      // timers before polling, so a due deadline fires ahead of a reply that already
      // arrived. A trivial script then came back `limitExceeded { wallClock }`: a resource
      // kill routed to drift-repair, for a script that was never the problem.
      //
      // Starvation, made deterministic. The worker answers in microseconds on its own
      // thread; this thread refuses to listen for four times the deadline.
      const { put, run } = await boot({
        limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 50 },
        workers: { count: 1, hardKillGraceMs: 50 },
      });
      const ref = await put("(() => 1 + 1)()");

      const pending = run(ref);
      await new Promise((r) => setTimeout(r, 5)); // let the eval actually be posted
      const until = Date.now() + 400; // 4x the 50 + 50 deadline
      while (Date.now() < until) {
        // Deliberate: the parent is unresponsive, which is the whole scenario.
      }

      await expect(pending).resolves.toBe(2);
    },
    SLOW
  );

  it(
    "does not charge a cold worker's startup to the script's wall clock",
    async () => {
      // Regression guard for what CI caught and a dev machine did not. The pool
      // used to arm the deadline before the worker had compiled its WASM
      // module, so on a slow runner the spawn + compile ate the budget and a
      // trivial script came back as `limitExceeded { wallClock }` — a resource
      // kill, routed to drift-repair, for a script that was never the problem.
      // Startup is the engine booting; the wall clock bounds the SCRIPT.
      //
      // Self-calibrating rather than a fixed number: measure THIS machine's
      // cold start, then give the real run a budget smaller than it. A hardcoded
      // deadline passes on a fast machine whether or not the bug is present,
      // which is precisely how it reached CI.
      const probe = registerSandboxEval(new EffectRuntime(), new InMemoryContentStore(), {
        workers: { count: 1 },
      });
      opened.push(probe);
      const probeStart = Date.now();
      await probe.warm();
      const coldStartMs = Date.now() - probeStart;

      const scripts = new InMemoryContentStore();
      const effects = new EffectRuntime();
      const effect = registerSandboxEval(effects, scripts, {
        // Under the cold start, so a pool that armed too early must kill this.
        limits: { wallClockMs: Math.max(10, Math.floor(coldStartMs * 0.6)) },
        workers: { count: 1, hardKillGraceMs: 0 },
      });
      opened.push(effect);
      const ref = await scripts.put(encoder.encode("(() => 1 + 1)()"));
      // Deliberately NOT warmed: this run pays the spawn and the WASM compile.
      await expect(effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx)).resolves.toBe(2);
    },
    SLOW
  );

  it(
    "does not charge runtime creation or input seeding to the script's wall clock (L13)",
    async () => {
      // The in-VM wall clock is armed AFTER the runtime exists and the input is seeded. The
      // pool's hard kill used to stamp its own start BEFORE both, so a large input spent the
      // budget before the script ran: in-process completed what worker mode killed as
      // `limitExceeded { wallClock }` — a resource kill, routed to drift-repair, for a script
      // that never ran long. It also showed up as a full-suite flake, where a loaded host
      // makes even an empty runtime slow to create.
      const input = "x".repeat(32 * 1024 * 1024);
      const memoryBytes = 512 * 1024 * 1024;

      // Calibrate on EXACTLY the phase in question — call to `onScriptStart` — rather than
      // on a whole run. The MINIMUM of two, because load can only lengthen this work: a
      // spike during calibration would otherwise inflate the budget past what the worker
      // needs and pass vacuously, while the minimum is a floor the worker's identical work
      // cannot come in under.
      const quickjs = await getQuickJS();
      const probeLimits: EvalLimits = {
        memoryBytes,
        interruptBudget: Number.MAX_SAFE_INTEGER,
        wallClockMs: 60_000,
      };
      const inputJson = JSON.stringify(input);
      let preScriptMs = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 2; i++) {
        const calledAt = Date.now();
        let startedAt = Number.NaN;
        const probe = evalInFreshRuntime(
          quickjs,
          "input.length",
          inputJson,
          probeLimits,
          undefined,
          (at) => {
            startedAt = at;
          }
        );
        expect(probe).toEqual({ ok: true, value: input.length });
        preScriptMs = Math.min(preScriptMs, startedAt - calledAt);
      }

      // The whole hard-kill budget (grace 0) is HALF the pre-script phase. Under the old
      // stamp the run is EVALUATING for that whole phase, so a check lands inside it with
      // the budget already spent — a certain kill, not a probable one.
      const wallClockMs = Math.floor(preScriptMs / 2);
      // …and positively non-vacuous: the premise is asserted, not assumed. Too fast a host
      // fails HERE, naming why, rather than passing a test that could not have failed. The
      // floor also keeps the trivial script's own in-VM clock clear of scheduling jitter.
      expect(
        wallClockMs,
        `pre-script phase ${preScriptMs} ms is too short to test`
      ).toBeGreaterThanOrEqual(50);

      const pool = new SandboxWorkerPool({ size: 1, hardKillGraceMs: 0 });
      opened.push(pool);
      await pool.warm();
      await expect(
        pool.runJson(
          "input.length",
          inputJson,
          { memoryBytes, interruptBudget: Number.MAX_SAFE_INTEGER, wallClockMs },
          undefined
        )
      ).resolves.toEqual({ ok: true, value: input.length });
    },
    // Three 32 MiB seedings (two calibrations + the run): ~35 s on a saturated full-suite host.
    SLOW * 3
  );

  it(
    "bounds the uncharged startup phases, and names that failure (SandboxWorkerStartupError)",
    async () => {
      // What L13 excluded from the script's budget still needs a bound, or a wedged worker
      // holds its slot forever. Made deterministic with a zero window: a 32 MiB input takes
      // far longer to parse and seed than the first 20 ms re-check, so the run has not
      // STARTED when the window closes — and load only makes that more certain.
      const input = "x".repeat(32 * 1024 * 1024);
      const pool = new SandboxWorkerPool({ size: 1, hardKillGraceMs: 0, startupLivenessMs: 0 });
      opened.push(pool);
      await pool.warm();

      const limits: EvalLimits = {
        memoryBytes: 512 * 1024 * 1024,
        interruptBudget: Number.MAX_SAFE_INTEGER,
        wallClockMs: 1,
      };
      const err = await pool
        .runJson("input.length", JSON.stringify(input), limits, undefined)
        .catch((e: unknown) => e);
      // A named class, NOT a TypedFailure: the environment failed, not the script, so it
      // must not land on `limitExceeded` (drift-repair) — and retry middleware's default,
      // which retries anything that is not a TypedFailure, retries it.
      expect(err).toBeInstanceOf(SandboxWorkerStartupError);
      expect(err).not.toBeInstanceOf(TypedFailure);
      expect(err).toMatchObject({ name: "SandboxWorkerStartupError", limitMs: 1 });

      // The wedged worker was replaced, not reused.
      await expect(
        pool.runJson("(() => 3)()", "null", { ...limits, wallClockMs: 60_000 }, undefined)
      ).resolves.toEqual({ ok: true, value: 3 });
    },
    SLOW
  );

  it(
    "aborts a run on ctx.signal and stays usable afterwards",
    async () => {
      const { put, run } = await boot({
        limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 60_000 },
        workers: { count: 1 },
      });
      const controller = new AbortController();
      // Seconds long, so the abort is the only thing that can end it inside the window.
      const pending = run(await put(RUNS_FOR_SECONDS), { ...baseCtx, signal: controller.signal });
      setTimeout(() => controller.abort(new Error("caller went away")), 20);

      await expect(pending).rejects.toThrow(/caller went away/);
      await expect(run(await put("(() => 7)()"))).resolves.toBe(7);
    },
    SLOW
  );

  it("queues past the pool size and answers every run", async () => {
    const { put, run } = await boot({ workers: { count: 2 } });
    const refs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => put(`(() => ({ i: ${i} }))()`))
    );
    const results = await Promise.all(refs.map((r) => run(r)));
    expect(results).toEqual(Array.from({ length: 6 }, (_, i) => ({ i })));
  });

  it(
    "leaves the event loop free while a script evaluates",
    async () => {
      // The headline property, asserted structurally rather than as a speedup
      // ratio. A ratio test needs idle cores to prove anything, and under `turbo
      // test` — 125 packages at once — there are none; it flaked on the first full
      // run. This does not care how loaded the machine is:
      //
      //   in-process, the main thread IS the VM. Timers cannot run until evalCode
      //   returns, so the count is zero by construction, not by scheduling luck.
      //
      //   on a worker, the main thread is merely idle, and an idle loop services
      //   its timers.
      //
      // (The concurrency that follows from this is measured in ADR 0089 rather
      // than asserted here, for the same load-sensitivity reason.)
      // A generous wall clock on purpose: this measures who gets the main thread,
      // not how fast the script is, and under a saturated `turbo test` the default
      // 1 s ceiling kills BUSY before it can measure anything.
      const measure = async (spec: SandboxSpec): Promise<number> => {
        const { put, run } = await boot({ ...spec, limits: { wallClockMs: 60_000 } });
        const ref = await put(BUSY);
        let ticks = 0;
        const ticker = setInterval(() => {
          ticks += 1;
        }, 10);
        await run(ref);
        clearInterval(ticker);
        return ticks;
      };

      expect(await measure({})).toBeLessThanOrEqual(1);
      expect(await measure({ workers: { count: 1 } })).toBeGreaterThan(3);
    },
    SLOW
  );

  it(
    "reclaims a hung cold compile under its own allowance, whatever the run's limits",
    async () => {
      // `ensureReady` runs before any eval is posted, so before `begin` arms a timer. A
      // compile that never acknowledged used to strand its run forever. Simulated
      // deterministically: detach the pool's listener for the worker's `ready`, which is
      // exactly what a compile that never finishes looks like from the parent. The run's own
      // window would be 0 ms; the compile is judged against `coldStartMs` alone.
      const pool = new SandboxWorkerPool({
        size: 1,
        hardKillGraceMs: 0,
        startupLivenessMs: 0,
        coldStartMs: 200,
      });
      opened.push(pool);
      const limits: EvalLimits = {
        memoryBytes: 32 * 1024 * 1024,
        interruptBudget: Number.MAX_SAFE_INTEGER,
        wallClockMs: 0,
      };
      const pending = pool.runJson("(() => 1)()", "null", limits, undefined);
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private slot to wedge it
      const [slot] = (pool as any).slots as { worker: import("node:worker_threads").Worker }[];
      slot!.worker.removeAllListeners("message");

      const err = await pending.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SandboxWorkerStartupError);
      expect(err).toMatchObject({ limitMs: 200, phase: "compile" });
      // The wedged worker is gone. (That a replacement then serves is "survives a hard kill";
      // not re-asserted here, where the 200 ms allowance would also judge the replacement's
      // REAL cold start — which a loaded host can exceed.)
      await vi.waitFor(() => {
        // biome-ignore lint/suspicious/noExplicitAny: asserting the slot was replaced
        expect((pool as any).slots).not.toContain(slot);
      });
    },
    SLOW
  );

  it(
    "a warm()-only waiter killed by the cold-start allowance frees its slot for the next run",
    async () => {
      // R3: the case the test above does NOT cover. There, a `run()` is also waiting on
      // `ensureReady`, and `dispatch`'s own rejection handler calls `replace` regardless of
      // what the worker's `exit` does. With nothing but `warm()` waiting, the ONLY thing that
      // used to reclaim the slot was `exit` reaching `ensureSlot`'s death handler — and that
      // handler ignored a `code !== 0` exit, which a worker `terminate()`d this soon after
      // spawn can be (Node 24). So the dead slot sat in `this.slots`, not busy and not ready,
      // and the next `run()` picked it, posted `warm` to a corpse, and waited the full
      // allowance again before anything served it.
      const pool = new SandboxWorkerPool({ size: 1, coldStartMs: 200 });
      opened.push(pool);
      const warming = pool.warm().catch((e: unknown) => e);
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private slot to wedge it
      const [dead] = (pool as any).slots as { worker: import("node:worker_threads").Worker }[];
      dead!.worker.removeAllListeners("message");

      const err = await warming;
      expect(err).toBeInstanceOf(SandboxWorkerStartupError);
      expect(err).toMatchObject({ limitMs: 200, phase: "compile" });
      // The dead slot is gone the instant the allowance fires — not merely destined to be
      // removed once its `exit` event happens to reach the death handler.
      // biome-ignore lint/suspicious/noExplicitAny: asserting the slot was replaced synchronously
      expect((pool as any).slots).not.toContain(dead);

      // A run posted now must be served by a FRESH worker, not hang on the corpse.
      const result = await pool.runJson(
        "(() => 1)()",
        "null",
        { memoryBytes: 32 * 1024 * 1024, interruptBudget: 1_000, wallClockMs: 1_000 },
        undefined
      );
      expect(result).toEqual({ ok: true, value: 1 });
    },
    SLOW
  );

  it(
    "after a hard kill, the next run succeeds on the fresh cold worker however tight its limits",
    async () => {
      // ADR 0089 D4's failure loop. A hard kill leaves a COLD worker; if its spawn + compile
      // were judged against the next run's `wallClockMs + grace + liveness`, a window shorter
      // than this host's cold start would fail that run, replace the worker cold, and repeat
      // (retry middleware multiplies it). The compile has its own allowance instead.
      //
      // Made deterministic rather than calibrated (an idle host cold-starts in ~25 ms, too
      // close to any window a trivial script can be trusted to start inside): the fresh
      // worker's `ready` is held back 3 s, a slow cold start on demand, against a follow-up
      // whose whole window is 1 s. A pool that folds the compile into that window fails. The
      // 1 s is also what a loaded host needs to START a trivial script (measured >50 ms).
      const pool = new SandboxWorkerPool({ size: 1, hardKillGraceMs: 0, startupLivenessMs: 0 });
      opened.push(pool);
      await pool.warm();
      const memoryBytes = 512 * 1024 * 1024;
      const interruptBudget = Number.MAX_SAFE_INTEGER;
      const killed = await pool.runJson(
        RUNS_FOR_SECONDS,
        "null",
        { memoryBytes, interruptBudget, wallClockMs: 1_000 },
        undefined
      );
      expect(killed.ok === false && killed.message).toMatch(POOL_KILL);

      // The only worker was terminated: this run pays a cold spawn + compile.
      const next = pool.runJson(
        "(() => 1 + 1)()",
        "null",
        { memoryBytes, interruptBudget, wallClockMs: 1_000 },
        undefined
      );
      // biome-ignore lint/suspicious/noExplicitAny: slowing the fresh worker's compile
      const [fresh] = (pool as any).slots as { worker: import("node:worker_threads").Worker }[];
      const emit = fresh!.worker.emit.bind(fresh!.worker);
      fresh!.worker.emit = ((event: string, ...args: unknown[]) => {
        if (event === "message" && (args[0] as { type?: string })?.type === "ready") {
          setTimeout(() => emit(event, ...args), 3_000);
          return true;
        }
        return emit(event, ...args);
      }) as typeof fresh.worker.emit;

      await expect(next).resolves.toEqual({ ok: true, value: 2 });
    },
    SLOW
  );

  it(
    "warm() settles when its worker is reclaimed or the pool closes",
    async () => {
      // `ensureReady` listened for `ready` and `error` only. A worker terminated while warming
      // — by the compile allowance, or by `close()` — emits neither, so `warm()` hung.
      //
      // `coldStartMs` must be a positive number now (R4 — 0 would be refused at construction,
      // since it is the only clock a cold compile is judged against), so the wedge is
      // deterministic — detach the worker's `message` listener before `ready` can arrive —
      // rather than relying on a real compile losing a race against a near-zero window.
      const reclaimed = new SandboxWorkerPool({ size: 1, coldStartMs: 200 });
      opened.push(reclaimed);
      const limits: EvalLimits = {
        memoryBytes: 32 * 1024 * 1024,
        interruptBudget: 1_000,
        wallClockMs: 1_000,
      };
      const warmPromise = reclaimed.warm().catch((e: unknown) => e);
      const runPromise = reclaimed
        .runJson("(() => 1)()", "null", limits, undefined)
        .catch((e: unknown) => e);
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private slot to wedge it
      const [slot] = (reclaimed as any).slots as { worker: import("node:worker_threads").Worker }[];
      slot!.worker.removeAllListeners("message");
      const [warmErr, runErr] = await Promise.all([warmPromise, runPromise]);
      // ONE warm-up, shared: both waiters get the same verdict.
      expect(warmErr).toBeInstanceOf(SandboxWorkerStartupError);
      expect(warmErr).toMatchObject({ phase: "compile", limitMs: 200 });
      expect(runErr).toBe(warmErr);

      const closing = new SandboxWorkerPool({ size: 1 });
      const warming = closing.warm().catch((e: unknown) => e);
      await closing.close();
      expect(await warming).toMatchObject({ message: "sandbox: worker pool closed" });
    },
    SLOW
  );

  it(
    "an unexpected exit while warming fails typed, not with a plain Error (R5)",
    async () => {
      // The cold-start allowance and `close()` both already reject typed/plainly BEFORE they
      // terminate the worker, so `onExit` firing after either of them is a no-op (the promise
      // already settled). This test's exit is neither: the worker is killed directly, as a
      // crash mid-compile would, so `onExit` itself is what settles the promise — and it used
      // to do that with a plain `Error`, indistinguishable from any other failure, instead of
      // the same `SandboxWorkerStartupError` a wedged compile produces.
      const pool = new SandboxWorkerPool({ size: 1, coldStartMs: 5_000 });
      opened.push(pool);
      const warming = pool.warm().catch((e: unknown) => e);
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private slot to kill it mid-compile
      const [slot] = (pool as any).slots as { worker: import("node:worker_threads").Worker }[];
      void slot!.worker.terminate();

      const err = await warming;
      expect(err).toBeInstanceOf(SandboxWorkerStartupError);
      expect(err).toMatchObject({ phase: "compile", limitMs: 5_000 });
    },
    SLOW
  );

  it(
    "an abort during warm-up rejects the run and frees the slot",
    async () => {
      // The abort listener used to be attached only in `begin`, after the compile, so a run
      // aborted while its worker warmed sat out the whole compile first.
      const pool = new SandboxWorkerPool({ size: 1 });
      opened.push(pool);
      const limits: EvalLimits = {
        memoryBytes: 32 * 1024 * 1024,
        interruptBudget: 1_000,
        wallClockMs: 1_000,
      };
      const controller = new AbortController();
      const pending = pool.runJson("(() => 1)()", "null", limits, controller.signal);
      // biome-ignore lint/suspicious/noExplicitAny: observing the private slot
      const [slot] = (pool as any).slots as { busy: boolean; ready: boolean }[];
      expect(slot!.ready).toBe(false); // still warming: this is the window under test
      controller.abort(new Error("caller went away"));

      await expect(pending).rejects.toThrow(/caller went away/);
      // Rejected DURING the warm-up, not after it: the worker has still not reported ready.
      expect(slot!.ready).toBe(false);
      expect(slot!.busy).toBe(false);
      // The warm-up ran on; the same worker serves the next run.
      await expect(pool.runJson("(() => 2)()", "null", limits, undefined)).resolves.toEqual({
        ok: true,
        value: 2,
      });
      // biome-ignore lint/suspicious/noExplicitAny: same worker, not a replacement
      expect((pool as any).slots[0]).toBe(slot);
    },
    SLOW
  );

  it("close() settles a run still waiting on a cold worker's compile", async () => {
    // During the compile no eval is in flight, so `close()` had nothing to settle and the
    // run hung until (at best) the compile allowance. It is the slot's to settle now.
    const pool = new SandboxWorkerPool({ size: 1 });
    const pending = pool.runJson(
      "(() => 1)()",
      "null",
      { memoryBytes: 32 * 1024 * 1024, interruptBudget: 1_000, wallClockMs: 1_000 },
      undefined
    );
    const settled = expect(pending).rejects.toThrow(/worker pool closed/);
    await pool.close();
    await settled;
  });

  it(
    "the timing options reach the pool through the effect",
    async () => {
      // `coldStartMs: 200` reaching the pool the effect builds — 0 is refused at construction
      // now (R4), so the compile is wedged deterministically instead of raced against a
      // near-zero window: detach the worker's `message` listener before `ready` can arrive.
      const coldScripts = new InMemoryContentStore();
      const coldEffects = new EffectRuntime();
      const coldEffect = registerSandboxEval(coldEffects, coldScripts, {
        workers: { count: 1, coldStartMs: 200 },
      });
      opened.push(coldEffect);
      const warming = coldEffect.warm();
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private pool to wedge its worker
      const [coldSlot] = (coldEffect as any).pool.slots as {
        worker: import("node:worker_threads").Worker;
      }[];
      coldSlot!.worker.removeAllListeners("message");
      await expect(warming).rejects.toMatchObject({
        name: "SandboxWorkerStartupError",
        phase: "compile",
      });

      // `startupLivenessMs: 0` on a WARM worker with a 32 MiB input: seeding cannot finish
      // inside a 1 ms window; the default would let this succeed. `maxInputBytes` raised
      // past the input's size on purpose — this test targets the POOL's startup-liveness
      // bound (backlog L13), which sits downstream of `maxInputBytes` (backlog L19); a
      // 32 MiB input would otherwise be refused by the default 1 MiB ceiling before ever
      // reaching a worker, which is a different (and now also-tested) failure mode.
      const scripts = new InMemoryContentStore();
      const effects = new EffectRuntime();
      const effect = registerSandboxEval(effects, scripts, {
        limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 1, maxInputBytes: 64 * 1024 * 1024 },
        workers: { count: 1, hardKillGraceMs: 0, startupLivenessMs: 0 },
      });
      opened.push(effect);
      await effect.warm();
      const ref = await scripts.put(encoder.encode("input.length"));
      await expect(
        effects.execute(
          SANDBOX_TOOL_ID,
          { scriptRef: ref, input: "x".repeat(32 * 1024 * 1024) },
          baseCtx
        )
      ).rejects.toMatchObject({ name: "SandboxWorkerStartupError", phase: "start" });
    },
    SLOW
  );

  it("refuses a duration option that would silently disable its bound", () => {
    // `NaN` makes every deadline comparison false and `Infinity` never comes due: both turn
    // a bound off without saying so. Refused at construction, as a bad `size` is.
    const nonNegative = ["hardKillGraceMs", "startupLivenessMs"] as const;
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, "5" as unknown as number]) {
      for (const name of nonNegative) {
        expect(
          () => new SandboxWorkerPool({ size: 1, [name]: bad }),
          `${name}=${String(bad)}`
        ).toThrow(new RegExp(`${name} must be a finite number >= 0`));
      }
    }
    // `coldStartMs` additionally refuses 0 (R4): it is the only clock a cold compile is ever
    // judged against, so 0 does not mean "no allowance, caller's choice" the way it does for
    // the other two — it means every cold worker fails forever, chained through a hard kill
    // into the very loop ADR 0089 D4 exists to prevent.
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, "5" as unknown as number]) {
      expect(
        () => new SandboxWorkerPool({ size: 1, coldStartMs: bad }),
        `coldStartMs=${String(bad)}`
      ).toThrow(/coldStartMs must be a finite number > 0/);
    }
    // …through the effect too, which builds its pool from `SandboxSpec.workers`.
    expect(() =>
      registerSandboxEval(new EffectRuntime(), new InMemoryContentStore(), {
        workers: { count: 1, startupLivenessMs: Number.NaN },
      })
    ).toThrow(/startupLivenessMs must be a finite number >= 0/);
    expect(() =>
      registerSandboxEval(new EffectRuntime(), new InMemoryContentStore(), {
        workers: { count: 1, coldStartMs: 0 },
      })
    ).toThrow(/coldStartMs must be a finite number > 0/);
    // Zero IS accepted for the other two: it means "no allowance at all", which a caller may
    // choose on purpose — e.g. a pool that is always warmed before use, so `startupLivenessMs`
    // never has anything to judge. `coldStartMs` cannot share that reading (above), so a valid
    // pool needs a positive one even when the other two are zero.
    expect(
      () =>
        new SandboxWorkerPool({ size: 1, hardKillGraceMs: 0, startupLivenessMs: 0, coldStartMs: 1 })
    ).not.toThrow();
  });

  it("refuses runs after close", async () => {
    const { put, run, effects: _effects } = await boot({ workers: { count: 1 } });
    const ref = await put("(() => 1)()");
    await Promise.all(opened.splice(0).map((e) => e.close()));
    await expect(run(ref)).rejects.toThrow(/worker pool closed/);
  });

  it(
    "returns byte-identical results to in-process, including values JSON cannot carry",
    async () => {
      // Worker mode carries the completion value as JSON bytes, so the obvious
      // worry is that `Infinity`/`NaN`/`undefined` mean something different across
      // the boundary. They do not — `vm.dump` already normalizes through JSON on
      // the way out of the VM, so in-process has always produced `null` for a
      // non-finite number and dropped an undefined-valued key. The transport adds
      // no normalization the engine was not doing anyway.
      //
      // Asserted by COMPARING the two engines rather than by pinning literals, so
      // this keeps holding if quickjs-emscripten changes what `dump` produces.
      const scripts = [
        "(() => ({ n: Infinity, d: NaN, u: undefined, ok: 1 }))()",
        '(() => [1, -0, 1e308 * 10, "\\u0000"])()',
        "(() => ({ nested: { deep: [{ a: null }] } }))()",
        "(() => 9007199254740993)()",
        "(() => undefined)()",
        "(() => null)()",
      ];
      const inProcess = await boot({});
      const pooled = await boot({ workers: { count: 1 } });
      for (const script of scripts) {
        const direct = await inProcess.run(await inProcess.put(script));
        const viaWorker = await pooled.run(await pooled.put(script));
        expect(viaWorker, script).toEqual(direct);
      }
    },
    SLOW
  );
});
