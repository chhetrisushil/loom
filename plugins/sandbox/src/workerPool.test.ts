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
/** Enough arithmetic to be worth parallelising; no allocation, so it is pure CPU. */
const BUSY = "(() => { let n = 0; for (let i = 0; i < 4000000; i++) n += i; return n; })()";

describe("SandboxWorkerPool (ADR 0089)", () => {
  it("hard-kills a script that outruns the wall clock without yielding", async () => {
    // The reason the pool exists at all. `wallClockMs` is enforced from the
    // interrupt handler, so a script that never reaches one is bounded by
    // nothing in-engine. `terminate()` does not need the script's cooperation.
    const { put, run } = await boot({
      limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 50 },
      workers: { count: 1, hardKillGraceMs: 50 },
    });
    const ref = await put(NON_YIELDING);

    const started = Date.now();
    await expect(run(ref)).rejects.toMatchObject({ channel: "limitExceeded" });
    // Killed on the pool's deadline (50 + 50), not on the script finishing.
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("reports the hard kill as the ceiling it blew through", async () => {
    const { put, run } = await boot({
      limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 50 },
      workers: { count: 1, hardKillGraceMs: 50 },
    });
    const ref = await put(NON_YIELDING);
    const err = await run(ref).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypedFailure);
    expect((err as TypedFailure).payload).toEqual({ kind: "wallClock" });
  });

  it("in-process, that same script runs to completion past its wall clock", async () => {
    // Not an aspiration — the documented soft-bound. Asserted so the gap the
    // pool closes is a fact in the suite rather than a claim in a comment.
    const { put, run } = await boot({
      limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 50 },
    });
    const ref = await put(NON_YIELDING);
    await expect(run(ref)).resolves.toBe(120000000);
  });

  it("survives a hard kill: the pool replaces the worker and keeps serving", async () => {
    const { put, run } = await boot({
      limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 50 },
      workers: { count: 1, hardKillGraceMs: 50 },
    });
    await expect(run(await put(NON_YIELDING))).rejects.toBeInstanceOf(TypedFailure);
    // The only worker was terminated; the next run must get a fresh one.
    await expect(run(await put("(() => 1 + 1)()"))).resolves.toBe(2);
  });

  it("aborts a run on ctx.signal and stays usable afterwards", async () => {
    const { put, run } = await boot({
      limits: { memoryBytes: 512 * 1024 * 1024, wallClockMs: 60_000 },
      workers: { count: 1 },
    });
    const controller = new AbortController();
    const pending = run(await put(NON_YIELDING), { ...baseCtx, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("caller went away")), 20);

    await expect(pending).rejects.toThrow(/caller went away/);
    await expect(run(await put("(() => 7)()"))).resolves.toBe(7);
  });

  it("queues past the pool size and answers every run", async () => {
    const { put, run } = await boot({ workers: { count: 2 } });
    const refs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => put(`(() => ({ i: ${i} }))()`))
    );
    const results = await Promise.all(refs.map((r) => run(r)));
    expect(results).toEqual(Array.from({ length: 6 }, (_, i) => ({ i })));
  });

  it("leaves the event loop free while a script evaluates", async () => {
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
  });

  it("refuses runs after close", async () => {
    const { put, run, effects: _effects } = await boot({ workers: { count: 1 } });
    const ref = await put("(() => 1)()");
    await Promise.all(opened.splice(0).map((e) => e.close()));
    await expect(run(ref)).rejects.toThrow(/worker pool closed/);
  });

  it("returns byte-identical results to in-process, including values JSON cannot carry", async () => {
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
  });
});
