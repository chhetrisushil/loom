import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";

// ADR 0112 (R6 review, Q3) — `kernel.features.scopes` and `execution.errorClasses` reach the runtime.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const A = step$({ id: "a", name: "a", toolId: "tool-a", ...io });
const B = step$({ id: "b", name: "b", toolId: "tool-b", ...io });
const definition: FlowDefinition<unknown, unknown> = {
  _tag: "FlowDefinition",
  id: "scoped",
  name: "scoped",
  version: "1.0.0",
  ...io,
  steps: [A, B],
};
class Outage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Outage";
  }
}

async function run(features: { scopes?: boolean }, errorClasses?: Record<string, typeof Outage>) {
  const app = defineConfig({
    storage: { kind: "memory" },
    autostart: false,
    kernel: { features },
    ...(errorClasses !== undefined && { execution: { errorClasses } }),
  });
  app.effectRuntime.register(
    "tool-a",
    new ToolEffect(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Outage("down");
    })
  );
  app.effectRuntime.register("tool-b", new ToolEffect(async () => ({ ok: true })));
  let caught: unknown;
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    try {
      await ctx.parallel([
        [A, {}],
        [B, {}],
      ]);
    } catch (e) {
      caught = e;
    }
    return {};
  };
  app.runtime.registerFlow(definition, runner);
  const h = await app.runtime.start({ definition, runner }, {}, { executionId: "x" });
  await h.waitForCompletion();
  const log = await app.runtime.events.read("x");
  await app.close();
  return { caught, types: log.map((e) => e.eventType) };
}

describe("kernel.features.scopes", () => {
  it("is OFF by default: no scope record is written and the original error is thrown", async () => {
    const r = await run({});
    expect(r.types).not.toContain("PARALLEL_COMPLETED");
    expect(r.caught).toBeInstanceOf(Outage);
  });

  it("on: the scope is journaled, and execution.errorClasses rehydrates the thrown class", async () => {
    const r = await run({ scopes: true }, { Outage });
    expect(r.types).toContain("PARALLEL_COMPLETED");
    expect(r.caught).toBeInstanceOf(Outage);
    expect((r.caught as Error).message).toBe("down");
  });
});
