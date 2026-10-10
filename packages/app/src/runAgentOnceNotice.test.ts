import { agent$ } from "@loom/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const agent = agent$({ id: "scripted", name: "Scripted", tools: [] });
const provider = {
  async complete() {
    return { content: "ok", stopReason: "end_turn" as const };
  },
};

async function fresh() {
  vi.resetModules();
  return (await import("./runAgentOnce")).runAgentOnce;
}
const notices = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter((c) => String(c[0]).includes("permissive defaults")).length;

describe("runAgentOnce permissive notice", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints at most once per process", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = await fresh();
    for (let i = 0; i < 3; i++) await run({ agent, provider: provider as never, input: "hi" });
    expect(notices(warn)).toBe(1);
  });

  it("prints nothing for a strict profile, and does not burn the once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = await fresh();
    await run({ agent, provider: provider as never, input: "hi", config: { security: { strict: false } } });
    expect(notices(warn)).toBe(0);
    await run({ agent, provider: provider as never, input: "hi" });
    expect(notices(warn)).toBe(1);
  });

  it("a caller's own onWarn still receives it every call", async () => {
    const got: string[] = [];
    const run = await fresh();
    for (let i = 0; i < 2; i++)
      await run({
        agent,
        provider: provider as never,
        input: "hi",
        config: { observability: { onWarn: (m) => got.push(m) } },
      });
    expect(got.length).toBe(2);
  });
});
