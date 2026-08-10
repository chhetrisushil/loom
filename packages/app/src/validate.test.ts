import { handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";
import { validateFlowGraph } from "./validate";

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const noopRunner = (async () => ({})) as FlowRunner<unknown, unknown>;

describe("validateFlowGraph", () => {
  const flows = [{ id: "f", steps: [{ id: "a", toolId: "a-tool" }, { id: "b" }] }];

  it("flags a step whose toolId has no registered effect", () => {
    const issues = validateFlowGraph({ flows, hasEffect: (t) => t === "a-tool" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "missing-effect", flowId: "f" });
    expect(issues[0]?.detail).toContain('"b"');
  });

  it("passes when every step has an effect", () => {
    expect(validateFlowGraph({ flows, hasEffect: () => true })).toEqual([]);
  });

  it("flags a dangling capability→agent mapping", () => {
    const issues = validateFlowGraph({
      flows: [],
      hasEffect: () => true,
      capabilityAgents: { "known-cap": "a1", "ghost-cap": "a2" },
      hasCapability: (id) => id === "known-cap",
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "dangling-capability-agent" });
    expect(issues[0]?.detail).toContain("ghost-cap");
  });
});

describe("defineConfig({ validate })", () => {
  // A step with a toolId but no handler ⇒ needs an effect nobody registered.
  const badFlow = {
    definition: {
      _tag: "FlowDefinition",
      id: "bad",
      name: "Bad",
      version: "1.0.0",
      ...io,
      steps: [step$({ id: "s", name: "S", toolId: "unregistered-tool", ...io })],
    },
    runner: noopRunner,
  } as RegisteredFlow;

  // A step with an inline handler$ ⇒ registerFlow auto-registers its effect.
  const goodFlow = {
    definition: {
      _tag: "FlowDefinition",
      id: "good",
      name: "Good",
      version: "1.0.0",
      ...io,
      steps: [step$({ id: "s", name: "S", ...io, handler: handler$(async () => ({})) })],
    },
    runner: noopRunner,
  } as RegisteredFlow;

  it("warns about a missing effect at boot", async () => {
    const warnings: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [badFlow],
      observability: { onWarn: (m) => warnings.push(m) },
      checks: { validate: true },
    });
    expect(warnings.some((w) => w.includes("unregistered-tool"))).toBe(true);
    await app.close();
  });

  it('validate: "error" throws on a missing effect', () => {
    expect(() =>
      defineConfig({ storage: { kind: "memory" }, flows: [badFlow], checks: { validate: "error" } })
    ).toThrow(/validation failed/);
  });

  it("is silent when the graph is sound (handler steps auto-register effects)", async () => {
    const warnings: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [goodFlow],
      observability: { onWarn: (m) => warnings.push(m) },
      checks: { validate: true },
    });
    expect(warnings).toEqual([]);
    await app.close();
  });
});
