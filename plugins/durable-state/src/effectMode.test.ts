import { EffectModeViolationError, EffectRuntime } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryDurableStateStore } from "./InMemoryDurableStateStore";
import { durableState } from "./durableState";

// ── ADR 0073 seam declarations ───────────────────────────────────────────────
//
// The interesting assertions here are the NEGATIVE ones: `load` stays undeclared
// on purpose. A sweep that filled in every blank would forbid a legitimate
// caller, which is the failure mode the opt-in marker exists to avoid.

function build() {
  return durableState({
    id: "carry",
    version: 1,
    schema: z.object({ n: z.number() }),
    store: new InMemoryDurableStateStore(),
  });
}

describe("durable-state effect modes", () => {
  it("declares save and clear journaled — an unrecorded write is a split brain", () => {
    const handle = build();
    expect(handle.effects.save.mode).toBe("journaled");
    expect(handle.effects.clear.mode).toBe("journaled");
  });

  it("refuses a transient save, so the store can never move without the log", async () => {
    const handle = build();
    const rt = new EffectRuntime();
    handle.register(rt);

    await expect(
      rt.invokeTransient(handle.toolIds.save, { key: "k", value: { n: 1 } })
    ).rejects.toThrow(EffectModeViolationError);
    await expect(rt.invokeTransient(handle.toolIds.clear, { key: "k" })).rejects.toThrow(
      EffectModeViolationError
    );
  });

  // The deliberate omission. Reading carry state outside an execution — an
  // operator dashboard peeking at a sentinel — changes nothing, and should not
  // require starting a run.
  it("leaves load undeclared so it works on BOTH seams", async () => {
    const handle = build();
    const rt = new EffectRuntime();
    handle.register(rt);

    expect(handle.effects.load.mode).toBeUndefined();

    const transient = await rt.invokeTransient<{ key: string }, { found: boolean }>(
      handle.toolIds.load,
      { key: "absent" }
    );
    expect(transient.found).toBe(false);

    const journaled = await rt.execute<{ key: string }, { found: boolean }>(
      handle.toolIds.load,
      { key: "absent" },
      {
        executionId: "e1",
        stepId: "s1",
        workflowId: "w1",
        attempt: 1,
        emit: () => {},
      }
    );
    expect(journaled.found).toBe(false);
  });
});
