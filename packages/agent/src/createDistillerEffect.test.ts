import { tainted } from "@loomwork/classify";
import type { EffectContext } from "@loomwork/effect-runtime";
import type { LlmProvider, LlmRequest } from "@loomwork/llm";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DISTILLER_INSTRUCTION,
  DEFAULT_DISTILLER_MAX_TOKENS,
  DistillerOutputError,
  createDistillerEffect,
} from "./createDistillerEffect";

const ctx = (): EffectContext => ({
  executionId: "e",
  stepId: "s",
  workflowId: "w",
  attempt: 1,
  emit: vi.fn(),
});

function fake(reply: string) {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    async complete(r) {
      requests.push(r);
      return { content: reply, stopReason: "end_turn" };
    },
  };
  return { provider, requests };
}

const input = {
  prompt: tainted("I moved to the Pro plan", "user"),
  answer: "Noted.",
  existing: [{ id: "fact:1", content: "Tenant is on the Free plan" }],
};

describe("createDistillerEffect", () => {
  it("sends the instruction as system and one user message holding the ids, prompt and answer", async () => {
    const { provider, requests } = fake('{"add":[],"supersede":[]}');
    await createDistillerEffect(provider).execute(input, ctx());
    const req = requests[0] as LlmRequest;
    expect(req.system).toBe(DEFAULT_DISTILLER_INSTRUCTION);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]?.role).toBe("user");
    const body = JSON.stringify(req.messages[0]);
    expect(body).toContain("[fact:1] Tenant is on the Free plan");
    expect(body).toContain("I moved to the Pro plan");
    expect(body).toContain("Noted.");
    // the tainted input is fenced under the distiller origin, not unwrapped into the system prompt
    expect(body).toContain("agent:distiller-input");
    expect(req.system).not.toContain("Pro plan");
  });

  it("honours a custom instruction and maxTokens; defaults otherwise", async () => {
    const a = fake('{"add":[]}');
    await createDistillerEffect(a.provider).execute(input, ctx());
    expect(a.requests[0]?.maxTokens).toBe(DEFAULT_DISTILLER_MAX_TOKENS);
    const b = fake('{"add":[]}');
    await createDistillerEffect(b.provider, { instruction: "X", maxTokens: 64 }).execute(
      input,
      ctx()
    );
    expect(b.requests[0]?.system).toBe("X");
    expect(b.requests[0]?.maxTokens).toBe(64);
  });

  it("marks an empty existing set", async () => {
    const { provider, requests } = fake('{"add":[]}');
    await createDistillerEffect(provider).execute({ ...input, existing: [] }, ctx());
    expect(JSON.stringify(requests[0]?.messages)).toContain("(none)");
  });

  it("parses plain and fenced JSON", async () => {
    const reply = '{"add":["Tenant is on Pro"],"supersede":["fact:1"]}';
    const want = { add: ["Tenant is on Pro"], supersede: ["fact:1"] };
    expect(await createDistillerEffect(fake(reply).provider).execute(input, ctx())).toEqual(want);
    expect(
      await createDistillerEffect(fake(`\`\`\`json\n${reply}\n\`\`\``).provider).execute(
        input,
        ctx()
      )
    ).toEqual(want);
    expect(
      await createDistillerEffect(fake(`\`\`\`\n${reply}\n\`\`\``).provider).execute(input, ctx())
    ).toEqual(want);
  });

  it("reads a missing supersede as []", async () => {
    const out = await createDistillerEffect(fake('{"add":["a"]}').provider).execute(input, ctx());
    expect(out).toEqual({ add: ["a"], supersede: [] });
  });

  it.each([
    ["not json", "sure, here are the facts"],
    ["array root", '["a"]'],
    ["null", "null"],
    ["missing add", '{"supersede":[]}'],
    ["add not array", '{"add":"a","supersede":[]}'],
    ["supersede not array", '{"add":[],"supersede":"fact:1"}'],
    ["empty", ""],
  ])("throws DistillerOutputError on %s", async (_n, reply) => {
    await expect(
      createDistillerEffect(fake(reply).provider).execute(input, ctx())
    ).rejects.toBeInstanceOf(DistillerOutputError);
  });
});
