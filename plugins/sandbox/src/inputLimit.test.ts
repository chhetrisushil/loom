import { TypedFailure } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { retryMiddleware } from "@loom/middleware";
import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it, vi } from "vitest";
import { SandboxEvalEffect } from "./SandboxEvalEffect";
import { SANDBOX_TOOL_ID, registerSandboxEval } from "./sandboxEval$";
import type { SandboxSpec } from "./types";

// ── backlog L19 — bounding the sandbox's INPUT, not just its output ─────────
//
// `maxOutputBytes` (outputLimit.test.ts) bounds what a script EMITS. `input` was the
// unbounded half: `z.unknown()`, JSON-stringified by the caller, parsed in the worker
// (or seeded straight into the VM in-process) — none of that charged to the script's
// wall clock, so it was bounded only by the worker pool's startup-liveness window
// (ADR 0089 D4), which fails with the untyped `SandboxWorkerStartupError` that default
// retry middleware then retries. This file proves `maxInputBytes` closes that gap:
// refused typed and non-retryable (`inputTooLarge`, NOT `limitExceeded` — that channel
// is the SCRIPT's outcome and routes to drift-repair, which cannot shrink a caller's
// input), before either engine is touched — plus the round-1 review findings: the
// default must not break inputs that work today, an unserializable `input` must fail
// typed rather than crash into an untyped retry loop, and a seed that OOMs under the
// VM heap ceiling (rather than the pre-flight byte check) must ALSO be typed.

const ctx: EffectContext = {
  executionId: "e",
  stepId: "s",
  workflowId: "w",
  attempt: 1,
  emit: () => {},
};

const encoder = new TextEncoder();
const scripts = new InMemoryContentStore();
const put = (script: string) => scripts.put(encoder.encode(script));

describe("SandboxEvalEffect — input size limit", () => {
  it("refuses a maxInputBytes option that would silently disable the bound", () => {
    // Mirrors `SandboxWorkerPoolOptions`' own refusal of a bad duration: `NaN` makes every
    // comparison false (a bound that never fires) and a negative number is not a size.
    for (const bad of [Number.NaN, -1, "5" as unknown as number]) {
      expect(
        () => new SandboxEvalEffect(scripts, { maxInputBytes: bad }),
        `maxInputBytes=${String(bad)}`
      ).toThrow(/maxInputBytes must be a finite number >= 0/);
    }
    // 0 IS accepted — "refuse every input", a caller's deliberate choice (a call with no
    // `input` at all still costs 0 bytes, so it is not "refuse every call").
    expect(() => new SandboxEvalEffect(scripts, { maxInputBytes: 0 })).not.toThrow();
  });

  it("the default refuses nothing that succeeds today (P1): a 20 MB input under default memoryBytes", async () => {
    // Round-1 finding: a 1 MiB default would have refused real reshaping inputs measured
    // 1.47-30.9 MB, all of which succeed under the default 32 MiB `memoryBytes` today.
    // `maxInputBytes` now DEFAULTS to `memoryBytes`'s default, so this must still succeed
    // with BOTH limits left at their defaults.
    const big = "x".repeat(20 * 1024 * 1024);
    const ref = await put("(() => input.length)()");
    const effects = new EffectRuntime();
    const effect = registerSandboxEval(effects, scripts, {});
    try {
      await expect(
        effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref, input: big }, ctx)
      ).resolves.toBe(big.length);
    } finally {
      await effect.close();
    }
  }, 30_000);

  const ENGINES: { name: string; workers: SandboxSpec["workers"] }[] = [
    { name: "in-process", workers: {} },
    { name: "worker pool", workers: { count: 1 } },
  ];

  describe.each(ENGINES)("$name", ({ workers }) => {
    it("refuses an oversized input typed and non-retryable, touching neither engine", async () => {
      // 1022 'x' characters JSON-stringifies to exactly 1024 bytes (the two quote chars).
      // One byte over the ceiling.
      const oversized = "x".repeat(1023);
      const ref = await put("(() => input.length)()");

      const effects = new EffectRuntime([retryMiddleware({ maxRetries: 3 })]);
      const effect = registerSandboxEval(effects, scripts, {
        limits: { maxInputBytes: 1024 },
        workers,
      });
      // Directly count invocations under the SAME retry middleware a real caller wires up —
      // the concrete proof that it is non-retryable, not just an inference from `err`'s type.
      const executeSpy = vi.spyOn(effect, "execute");
      try {
        // Deliberately NOT warmed: a rejected call must never touch a worker, so nothing
        // here may depend on one having been spawned.
        const err = await effects
          .execute(SANDBOX_TOOL_ID, { scriptRef: ref, input: oversized }, ctx)
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(TypedFailure);
        expect((err as TypedFailure).channel).toBe("inputTooLarge");
        expect((err as TypedFailure).payload).toEqual({ bytes: 1025, limit: 1024 });
        // retryMiddleware's default retries anything that is NOT a TypedFailure; exactly one
        // call proves this one was not retried.
        expect(executeSpy).toHaveBeenCalledTimes(1);

        // No worker was ever spawned: the pool only creates a slot from `runJson()`/`warm()`,
        // neither of which this call reaches.
        // biome-ignore lint/suspicious/noExplicitAny: reaching the private pool/module fields
        const anyEffect = effect as any;
        if (workers.count !== undefined && workers.count > 0) {
          expect(anyEffect.pool.slots).toHaveLength(0);
        } else {
          // In-process: a VM is only ever created once `this.module` is populated, which
          // happens lazily inside `evaluate()` — never reached for a refused input.
          expect(anyEffect.module).toBeUndefined();
        }
      } finally {
        await effect.close();
      }
    });

    it("accepts an input exactly at the limit", async () => {
      const exact = "x".repeat(1022); // JSON: 1022 + 2 quote chars = 1024 bytes, == the limit
      const ref = await put("(() => input.length)()");

      const effects = new EffectRuntime();
      const effect = registerSandboxEval(effects, scripts, {
        limits: { maxInputBytes: 1024 },
        workers,
      });
      try {
        await expect(
          effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref, input: exact }, ctx)
        ).resolves.toBe(1022);
      } finally {
        await effect.close();
      }
    });

    it("a call with no input at all costs nothing against the limit", async () => {
      const ref = await put("(() => input)()");
      const effects = new EffectRuntime();
      // A limit too small even for the `"null"` seeded when `input` is omitted — proves
      // omission is 0 bytes, not the 4 bytes of the JSON it seeds either way (`input` is
      // still seeded as `null`, same as before this limit existed — only the byte count
      // charged against `maxInputBytes` changes).
      const effect = registerSandboxEval(effects, scripts, {
        limits: { maxInputBytes: 0 },
        workers,
      });
      try {
        await expect(effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, ctx)).resolves.toBe(null);
      } finally {
        await effect.close();
      }
    });

    it("measures UTF-8 bytes, not .length (P3 minor): a multi-byte string at and over the limit", async () => {
      // "é" (U+00E9) is ONE UTF-16 code unit (`.length` counts it as 1) but TWO UTF-8 bytes.
      // A implementation that measured `.length` instead of `Buffer.byteLength` would accept
      // an input this test refuses, and refuse one it should accept.
      const ref = await put("(() => input.length)()");
      const n = 500;
      const exact = "é".repeat(n); // JSON bytes: 2*n (the é's) + 2 (quotes) = 1002
      const oversized = "é".repeat(n + 1); // one é more: 1004 bytes — over a 1002 limit

      const effects = new EffectRuntime();
      const effect = registerSandboxEval(effects, scripts, {
        limits: { maxInputBytes: 2 * n + 2 },
        workers,
      });
      try {
        await expect(
          effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref, input: exact }, ctx)
        ).resolves.toBe(n); // .length (UTF-16 code units) == n, even though the JSON is 2*n+2 BYTES

        const err = await effects
          .execute(SANDBOX_TOOL_ID, { scriptRef: ref, input: oversized }, ctx)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TypedFailure);
        expect((err as TypedFailure).channel).toBe("inputTooLarge");
        expect((err as TypedFailure).payload).toEqual({ bytes: 2 * (n + 1) + 2, limit: 2 * n + 2 });
      } finally {
        await effect.close();
      }
    });

    it("an out-of-memory while SEEDING (input under maxInputBytes, over memoryBytes) is typed inputTooLarge, not an untyped throw (P3-5b)", async () => {
      // An input can pass the caller-side `maxInputBytes` check and still overflow the VM
      // heap once `JSON.parse`d inside it (parsing can expand a JSON text well past its own
      // byte length) — measured: a 64 KiB heap cannot even hold a 500 KB string once parsed.
      // Before this fix that surfaced as an UNTYPED "sandbox: input marshalling failed: out
      // of memory" (in-process) or the same message via a worker's `fatal` (worker mode),
      // retried by default middleware for nothing — deterministic given the same input and
      // limits, so retrying can never succeed.
      const bigButUnderMaxInput = "x".repeat(500_000); // ~500 KB JSON, well under maxInputBytes
      const ref = await put("(() => input.length)()");
      const effects = new EffectRuntime([retryMiddleware({ maxRetries: 3 })]);
      const effect = registerSandboxEval(effects, scripts, {
        limits: { memoryBytes: 64 * 1024, maxInputBytes: 10 * 1024 * 1024 },
        workers,
      });
      const executeSpy = vi.spyOn(effect, "execute");
      try {
        const err = await effects
          .execute(SANDBOX_TOOL_ID, { scriptRef: ref, input: bigButUnderMaxInput }, ctx)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TypedFailure);
        expect((err as TypedFailure).channel).toBe("inputTooLarge");
        // `limit` here is `memoryBytes` (the ceiling that actually overflowed), not
        // `maxInputBytes` (which this input passed) — `bytes` is still the JSON length.
        expect((err as TypedFailure).payload).toEqual({
          bytes: Buffer.byteLength(JSON.stringify(bigButUnderMaxInput), "utf8"),
          limit: 64 * 1024,
        });
        expect(executeSpy).toHaveBeenCalledTimes(1); // non-retryable
      } finally {
        await effect.close();
      }
    }, 30_000);
  });

  describe("input that cannot become JSON at all (P3-4)", () => {
    // Engine-independent: this fails inside `execute()`, before `evaluate()` is ever called,
    // so which engine is configured cannot change the outcome — tested once, in-process.
    async function expectUnserializable(input: unknown) {
      const ref = await put("(() => input)()");
      const effects = new EffectRuntime([retryMiddleware({ maxRetries: 3 })]);
      const effect = registerSandboxEval(effects, scripts, {});
      const executeSpy = vi.spyOn(effect, "execute");
      try {
        const err = await effects
          .execute(SANDBOX_TOOL_ID, { scriptRef: ref, input }, ctx)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TypedFailure);
        expect((err as TypedFailure).channel).toBe("inputNotSerializable");
        const payload = (err as TypedFailure).payload as { reason: unknown };
        expect(payload).not.toBeNull();
        expect(typeof payload.reason).toBe("string");
        expect(executeSpy).toHaveBeenCalledTimes(1); // non-retryable
      } finally {
        await effect.close();
      }
    }

    it("a bare function (JSON.stringify returns undefined)", async () => {
      await expectUnserializable(() => 1);
    });

    it("a bare Symbol (JSON.stringify returns undefined)", async () => {
      await expectUnserializable(Symbol("x"));
    });

    it("a toJSON returning undefined (JSON.stringify returns undefined)", async () => {
      await expectUnserializable({ toJSON: () => undefined });
    });

    it("a BigInt (JSON.stringify throws TypeError)", async () => {
      await expectUnserializable({ n: 1n });
    });

    it("a circular reference (JSON.stringify throws TypeError)", async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expectUnserializable(circular);
    });
  });
});
