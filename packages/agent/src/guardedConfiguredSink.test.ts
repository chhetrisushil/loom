import { agent$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { LlmProvider } from "@loom/llm";
import { piiValidator, safetyMiddleware } from "@loom/middleware";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "./AgentRunner";
import { createAgentModelEffect } from "./createAgentModelEffect";

// ADR 0119 (review 2) — the CONFIGURED sink of an agent turn is reached only through
// the runtime's guarded delta channel, on the durable (`execute`) seam.

const ctx = (): EffectContext => ({
  executionId: "e",
  stepId: "agent",
  workflowId: "w",
  attempt: 1,
  emit: vi.fn(),
});

const leaky: LlmProvider = {
  async complete() {
    return { content: "mail bob@corp.io", stopReason: "end_turn" };
  },
  async *stream() {
    yield { delta: "mail ", done: false };
    yield { delta: "bob@", done: false };
    yield { delta: "corp.io", done: false };
    yield { delta: "", done: true, stopReason: "end_turn" as const };
  },
};

const noDeltaForm = safetyMiddleware({
  validators: [{ id: "any", phase: "output", check: () => ({ ok: true }) }],
});
const def = agent$({ id: "a", name: "A", tools: [] });

describe("AgentRunner configured onDelta on a durable call", () => {
  it("is severed by a delta-form PII validator before the leak", async () => {
    const seen: string[] = [];
    const rt = new EffectRuntime([safetyMiddleware({ validators: [piiValidator()] })]);
    rt.register(
      "agent",
      new AgentRunner({
        definition: def,
        provider: leaky,
        effectRuntime: new EffectRuntime(),
        stream: true,
        onDelta: (d) => seen.push(d),
      }).asEffect()
    );
    await rt.execute("agent", { prompt: "go" }, ctx()).catch(() => {});
    expect(seen.join("")).not.toContain("corp.io");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("receives NOTHING under an output validator without a delta form; the call completes", async () => {
    const seen: string[] = [];
    const warns: string[] = [];
    const rt = new EffectRuntime([noDeltaForm], { onWarn: (m) => warns.push(m) });
    rt.register(
      "agent",
      new AgentRunner({
        definition: def,
        provider: leaky,
        effectRuntime: new EffectRuntime(),
        stream: true,
        onDelta: (d) => seen.push(d),
      }).asEffect()
    );
    const out = (await rt.execute("agent", { prompt: "go" }, ctx())) as { content: string };
    expect(out.content).toBe("mail bob@corp.io");
    expect(seen).toEqual([]);
    expect(warns.join("")).toMatch(/streaming disabled/);
  });

  it("streams normally with no middleware, and bare (no runtime) calls the sink directly", async () => {
    const seen: string[] = [];
    const rt = new EffectRuntime();
    const runner = new AgentRunner({
      definition: def,
      provider: leaky,
      effectRuntime: new EffectRuntime(),
      stream: true,
      onDelta: (d) => seen.push(d),
    });
    rt.register("agent", runner.asEffect());
    await rt.execute("agent", { prompt: "go" }, ctx());
    expect(seen.join("")).toBe("mail bob@corp.io");
    seen.length = 0;
    await runner.run({ prompt: "go" }, ctx());
    expect(seen.join("")).toBe("mail bob@corp.io");
  });
});

describe("createAgentModelEffect configured onDelta on a durable call", () => {
  it("is severed by a PII delta guard; silent under an uncovered validator", async () => {
    const seen: string[] = [];
    const a = new EffectRuntime([safetyMiddleware({ validators: [piiValidator()] })]);
    a.register(
      "model",
      createAgentModelEffect(leaky, { stream: true, onDelta: (d) => seen.push(d) })
    );
    await a.execute("model", { messages: [{ role: "user", content: "x" }] }, ctx()).catch(() => {});
    expect(seen.join("")).not.toContain("corp.io");

    const seen2: string[] = [];
    const b = new EffectRuntime([noDeltaForm], { onWarn: () => {} });
    b.register(
      "model",
      createAgentModelEffect(leaky, { stream: true, onDelta: (d) => seen2.push(d) })
    );
    await b.execute("model", { messages: [{ role: "user", content: "x" }] }, ctx());
    expect(seen2).toEqual([]);
  });
});
