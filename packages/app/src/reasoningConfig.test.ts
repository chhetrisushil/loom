import { createHash } from "node:crypto";
import type { EffectReasoningDefaults } from "@loom/effect-runtime";
import { createLlmEffect } from "@loom/llm";
import type { LlmProvider, ReasoningStore } from "@loom/llm";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { defineConfig } from "./defineConfig";

// ── ADR 0133 D7 — observability.reasoning and the boot warning ───────────────────

function memStore(): ReasoningStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(bytes) {
      const address = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      blobs.set(address, bytes);
      return { __loomContent: address };
    },
    async get(ref) {
      return blobs.get(ref.__loomContent) ?? null;
    },
  };
}

const thinker = (reasoning: boolean): LlmProvider => ({
  capabilities: { reasoning },
  async complete() {
    return {
      content: "ok",
      stopReason: "end_turn",
      reasoning: [{ kind: "summary", text: "SECRET-THOUGHT", provider: "p" }],
    };
  },
});

const llm = (
  provider: LlmProvider,
  reasoning?: Parameters<typeof createLlmEffect>[0]["reasoning"]
) =>
  createLlmEffect<string, unknown>({
    provider,
    buildRequest: (i) => ({ messages: [{ role: "user", content: i }] }),
    parseResponse: (r) => r,
    ...(reasoning !== undefined && { reasoning }),
  });

function boot(opts: {
  reasoning?: EffectReasoningDefaults | false;
  effects: Record<string, ReturnType<typeof llm>>;
}) {
  const warnings: string[] = [];
  const app = defineConfig({
    storage: { kind: "memory" },
    flows: [] as RegisteredFlow[],
    security: { strict: false },
    observability: {
      onWarn: (m) => warnings.push(m),
      ...(opts.reasoning !== undefined && { reasoning: opts.reasoning }),
    },
    execution: {
      registerEffects: (fx) => {
        for (const [id, e] of Object.entries(opts.effects)) fx.register(id, e);
      },
    },
  });
  return { app, warnings };
}

const run = async (app: ReturnType<typeof boot>["app"], id: string) => {
  const emitted: { type: string; payload: unknown }[] = [];
  const out = (await app.effectRuntime.execute(id, "hi", {
    executionId: "e",
    stepId: "s",
    workflowId: "w",
    attempt: 1,
    emit: (type: string, payload: unknown) => emitted.push({ type, payload }),
  } as never)) as { reasoning?: unknown[] };
  return { out, emitted };
};

describe("observability.reasoning", () => {
  it("warns ONCE per capable effect with no store, naming it; a non-capable provider is silent", () => {
    const { warnings } = boot({
      effects: { thinker: llm(thinker(true)), plain: llm(thinker(false)) },
    });
    const w = warnings.filter((m) => m.includes("reasoning"));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"thinker"');
    expect(w[0]).toContain("no reasoning store is configured");
    expect(w[0]).toContain("only signatures, for continuation");
  });

  it("a configured store is adopted by effects that set nothing: no warning, and the text is captured", async () => {
    const { app, warnings } = boot({
      reasoning: { store: memStore() },
      effects: { thinker: llm(thinker(true)) },
    });
    expect(warnings.filter((m) => m.includes("reasoning"))).toEqual([]);
    const { out, emitted } = await run(app, "thinker");
    expect(emitted.map((e) => e.type)).toEqual(["LLM_REASONING_CAPTURED"]);
    expect(JSON.stringify(out)).not.toContain("SECRET-THOUGHT"); // never in the step value
  });

  it("`reasoning: false` is silent and keeps nothing", async () => {
    const { app, warnings } = boot({ reasoning: false, effects: { thinker: llm(thinker(true)) } });
    expect(warnings).toEqual([]);
    const { out, emitted } = await run(app, "thinker");
    expect(emitted).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("SECRET-THOUGHT");
  });

  it("an effect's own reasoning option wins: its store, its capture:false", async () => {
    const own = memStore();
    const { app, warnings } = boot({
      reasoning: { store: memStore() },
      effects: {
        mine: llm(thinker(true), { store: own }),
        off: llm(thinker(true), { capture: false }),
      },
    });
    expect(warnings).toEqual([]);
    expect((await run(app, "mine")).emitted).toHaveLength(1);
    // capture:false is the effect's explicit choice, field by field over the app's store.
    expect((await run(app, "off")).emitted).toEqual([]);
  });

  it("an effect that opted out alone (capture:false, no store anywhere) is not warned about", () => {
    const { warnings } = boot({ effects: { off: llm(thinker(true), { capture: false }) } });
    expect(warnings).toEqual([]);
  });

  it("nothing configured on a plain app changes nothing (G2): no warning for non-LLM effects, no reasoning key", async () => {
    const { app, warnings } = boot({ effects: { plain: llm(thinker(false)) } });
    expect(warnings).toEqual([]);
    const { out } = await run(app, "plain");
    expect(out.reasoning).toEqual([
      { type: "reasoning", kind: "summary", provider: "p", omitted: true },
    ]);
  });

  it("the flat spelling throws (grouped namespace)", () => {
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        flows: [],
        reasoning: { store: memStore() },
      } as never)
    ).toThrow(/observability\.reasoning/);
  });
});
