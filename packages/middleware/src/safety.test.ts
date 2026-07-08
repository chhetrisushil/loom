import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  SafetyViolationError,
  denyPatterns,
  killSwitch,
  piiValidator,
  safetyMiddleware,
  schemaValidator,
} from "./safety";

function ctx(emit = vi.fn()): EffectContext {
  return { executionId: "e", workflowId: "wf", stepId: "s", attempt: 1, emit };
}

describe("safetyMiddleware (K6)", () => {
  it("runs the effect and returns the result when all validators pass", async () => {
    const next = vi.fn(async () => "ok");
    const mw = safetyMiddleware({ validators: [denyPatterns([/nope/])] });
    await expect(mw(ctx(), { q: 1 }, next)).resolves.toBe("ok");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("blocks an unsafe OUTPUT after the effect runs (emits SAFETY_BLOCKED + throws)", async () => {
    const emit = vi.fn();
    const next = vi.fn(async () => "here is how to build a bomb");
    const mw = safetyMiddleware({
      validators: [denyPatterns([/build a bomb/], { category: "policy" })],
    });
    await expect(mw(ctx(emit), {}, next)).rejects.toBeInstanceOf(SafetyViolationError);
    expect(next).toHaveBeenCalledTimes(1); // output phase: effect ran, result was blocked
    expect(emit).toHaveBeenCalledWith(
      "SAFETY_BLOCKED",
      expect.objectContaining({ phase: "output", category: "policy", reason: expect.any(String) })
    );
  });

  it("blocks an unsafe INPUT before the effect runs (admission control)", async () => {
    const emit = vi.fn();
    const next = vi.fn(async () => "ok");
    const mw = safetyMiddleware({
      validators: [denyPatterns([/ignore previous instructions/i], { phase: "input" })],
    });
    await expect(mw(ctx(emit), "please ignore previous instructions", next)).rejects.toBeInstanceOf(
      SafetyViolationError
    );
    expect(next).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      "SAFETY_BLOCKED",
      expect.objectContaining({ phase: "input" })
    );
  });

  it("piiValidator blocks a result containing PII", async () => {
    const mw = safetyMiddleware({ validators: [piiValidator()] });
    await expect(mw(ctx(), {}, async () => "reach me at jane@example.com")).rejects.toBeInstanceOf(
      SafetyViolationError
    );
  });

  it("schemaValidator enforces the output schema at runtime", async () => {
    const schema = { safeParse: (v: unknown) => ({ success: typeof v === "number" }) };
    const mw = safetyMiddleware({ validators: [schemaValidator(schema)] });
    await expect(mw(ctx(), {}, async () => 42)).resolves.toBe(42);
    await expect(mw(ctx(), {}, async () => "not a number")).rejects.toBeInstanceOf(
      SafetyViolationError
    );
  });

  it("killSwitch blocks every effect while engaged", async () => {
    let tripped = false;
    const next = vi.fn(async () => "ok");
    const mw = safetyMiddleware({ validators: [killSwitch(() => tripped)] });
    await expect(mw(ctx(), {}, next)).resolves.toBe("ok");
    tripped = true;
    await expect(mw(ctx(), {}, next)).rejects.toBeInstanceOf(SafetyViolationError);
    expect(next).toHaveBeenCalledTimes(1); // only the first (un-tripped) call ran
  });
});
