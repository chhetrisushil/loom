import { TypedFailure } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { InMemoryContentStore } from "@loom/plugin-content";
import { afterEach, describe, expect, it } from "vitest";
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
      // "Killed on the deadline, not on the script finishing" used to be a fixed 200 ms
      // bound against a 50 + 50 ms deadline — 100 ms of slack for spawning a worker,
      // reaching the interrupt and terminating it. That travels badly: this suite passed
      // alone and failed under a full-repo run with 128 vitest processes sharing every
      // core (#383). So measure what it is actually being compared against, here, under
      // whatever load this run happens to have.
      const inProcess = await boot({
        limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 50 },
      });
      const baselineRef = await inProcess.put(NON_YIELDING);
      const baselineStart = Date.now();
      await expect(inProcess.run(baselineRef)).resolves.toBe(120000000);
      const unkilledMs = Math.max(Date.now() - baselineStart, 1);

      const { put, run } = await boot({
        limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 50 },
        workers: { count: 1, hardKillGraceMs: 50 },
      });
      const ref = await put(NON_YIELDING);

      const started = Date.now();
      await expect(run(ref)).rejects.toMatchObject({ channel: "limitExceeded" });
      const killedMs = Date.now() - started;

      // Killed on the pool's deadline (50 + 50), not on the script finishing — asserted
      // as a RATIO, because both measurements absorb the same load. The gap is ~100 ms
      // against ~245 ms unloaded, and it only WIDENS under contention: the baseline is
      // CPU-bound and inflates, while the deadline is wall-clock and fires on time. Half
      // is therefore a conservative line, and one a script merely running fast cannot reach.
      expect(killedMs).toBeLessThan(unkilledMs / 2);
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
      const ref = await put(NON_YIELDING);
      const err = await run(ref).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypedFailure);
      expect((err as TypedFailure).payload).toEqual({ kind: "wallClock" });
    },
    SLOW
  );

  it(
    "in-process, that same script runs to completion past its wall clock",
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
      const { put, run } = await boot({
        limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 50 },
        workers: { count: 1, hardKillGraceMs: 50 },
      });
      await expect(run(await put(NON_YIELDING))).rejects.toBeInstanceOf(TypedFailure);

      // The only worker was terminated; the next run must get a fresh one.
      //
      // Retried once, deliberately. `wallClockMs` is enforced by a `setTimeout` on THIS
      // thread, so it measures the script PLUS however long the main thread took to drain
      // the worker's reply — and libuv runs the timers phase before the poll phase, so a
      // due deadline can fire ahead of a reply that already arrived. Under a full-repo run
      // this trivial script came back as `limitExceeded` with the worker long since done
      // (#383). That misattribution is real and is tracked in #399; the subject HERE is
      // worker replacement, so this asserts the pool serves again rather than asserting a
      // clock the test does not own.
      const serveAgain = async (): Promise<unknown> => run(await put("(() => 1 + 1)()"));
      const first = await serveAgain().catch((e: unknown) => e);
      expect(first instanceof Error ? await serveAgain() : first).toBe(2);
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
    "aborts a run on ctx.signal and stays usable afterwards",
    async () => {
      const { put, run } = await boot({
        limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 60_000 },
        workers: { count: 1 },
      });
      const controller = new AbortController();
      const pending = run(await put(NON_YIELDING), { ...baseCtx, signal: controller.signal });
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
