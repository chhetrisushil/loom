import { describe, expect, it, vi } from "vitest";
import { MODEL_ENV, type RecordDeps, runRecord } from "./record";

// `pnpm eval:record` is the only live path in evals/. It must be impossible to trigger by accident: every
// refusal and the dry run are proven to NEVER build a provider or write a file.

const KEY = { GEMINI_API_KEY: "test-key-not-real" };

function deps() {
  const lines: string[] = [];
  const d: RecordDeps = {
    makeProvider: vi.fn(async () => {
      throw new Error("a live provider was constructed");
    }),
    write: vi.fn(),
    log: (l) => lines.push(l),
  };
  return { d, lines };
}

describe("eval:record refuses unless explicitly and fully asked", () => {
  it("without --live it is a DRY RUN: lists the cassettes, builds no provider, writes nothing", async () => {
    const { d, lines } = deps();
    expect(await runRecord([], KEY, d)).toBe(0);
    expect(lines.join("\n")).toMatch(/DRY RUN/);
    expect(lines.join("\n")).toMatch(/single-lookup/);
    expect(d.makeProvider).not.toHaveBeenCalled();
    expect(d.write).not.toHaveBeenCalled();
  });

  it("refuses under CI=true, even with --live, a model and a key", async () => {
    for (const ci of ["true", "1"]) {
      const { d, lines } = deps();
      const env = { ...KEY, CI: ci, [MODEL_ENV]: "gemini:some-model" };
      expect(await runRecord(["--live"], env, d)).toBe(1);
      expect(lines.join("\n")).toMatch(/CI=true/);
      expect(d.makeProvider).not.toHaveBeenCalled();
    }
    const { d } = deps();
    expect(await runRecord([], { CI: "true" }, d)).toBe(1); // a dry run refuses too
  });

  it("refuses --live without a model, naming both ways to pass one (no default is guessed)", async () => {
    const { d, lines } = deps();
    expect(await runRecord(["--live"], KEY, d)).toBe(1);
    expect(lines.join("\n")).toMatch(/--model gemini:/);
    expect(lines.join("\n")).toContain(MODEL_ENV);
    expect(d.makeProvider).not.toHaveBeenCalled();
  });

  it("refuses --live with a non-Gemini model or without a key, never printing the key", async () => {
    const a = deps();
    expect(await runRecord(["--live", "--model", "openai:x"], KEY, a.d)).toBe(1);
    const b = deps();
    expect(await runRecord(["--live", "--model", "gemini:m"], {}, b.d)).toBe(1);
    expect(b.lines.join("\n")).toMatch(/GEMINI_API_KEY/);
    const c = deps();
    await runRecord(["--live", "--model", "gemini:m", "--task", "nope"], KEY, c.d);
    expect(`${a.lines}${b.lines}${c.lines}`).not.toContain("test-key-not-real");
    for (const x of [a, b, c]) expect(x.d.makeProvider).not.toHaveBeenCalled();
  });

  it("with --live, a model and a key it records ONLY the selected tasks, one cassette each, nothing else", async () => {
    const written: string[] = [];
    const lines: string[] = [];
    const d: RecordDeps = {
      makeProvider: vi.fn(async (id: string) => {
        expect(id).toBe("some-model");
        return { complete: async () => ({ content: "hi", stopReason: "end_turn" as const }) };
      }),
      write: (id) => void written.push(id),
      log: (l) => lines.push(l),
    };
    const env = { ...KEY, [MODEL_ENV]: "gemini:some-model" };
    expect(await runRecord(["--live", "--task", "no-tool-answer"], env, d)).toBe(0);
    expect(written).toEqual(["no-tool-answer"]);
    expect(lines.join("\n")).toMatch(/eval:update-baseline/);
  });
});
