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
// refused typed and non-retryable, before either engine is touched.

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
  it("refuses an option that would silently disable the bound", () => {
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
        expect((err as TypedFailure).channel).toBe("limitExceeded");
        expect((err as TypedFailure).payload).toEqual({ kind: "input" });
        // retryMiddleware's default retries anything that is NOT a TypedFailure; exactly one
        // call proves this one was not retried.
        expect(executeSpy).toHaveBeenCalledTimes(1);

        // No worker was ever spawned: the pool only creates a slot from `run()`/`warm()`,
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
  });
});
