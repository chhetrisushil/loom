import type { LlmProvider, LlmRequest } from "@loom/llm";
import { describe, expect, it, vi } from "vitest";
import { TASKS } from "./agentLoop/tasks";
import { MODEL_ENV, type RecordDeps, judgeRecording, runRecord } from "./record";

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
    for (const ci of ["true", "1", "TRUE", "yes", "True", "on"]) {
      const { d, lines } = deps();
      const env = { ...KEY, CI: ci, [MODEL_ENV]: "gemini:some-model" };
      expect(await runRecord(["--live"], env, d)).toBe(1);
      expect(lines.join("\n")).toMatch(/refusing to record under CI/);
      expect(d.makeProvider).not.toHaveBeenCalled();
    }
    const { d } = deps();
    expect(await runRecord([], { CI: "true" }, d)).toBe(1); // a dry run refuses too
    for (const ci of ["false", "0", "FALSE", ""]) {
      expect(await runRecord([], { CI: ci }, d), `CI=${ci}`).toBe(0); // only an explicit "off" proceeds
    }
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

// ── a failed live run never clobbers a reviewed cassette ─────────────────────────────────────────────────────
// A FAKE provider only: nothing here can reach Gemini.

const sayOk = { content: "ok", stopReason: "end_turn" as const };
const promptOf = (id: string) => (TASKS.find((t) => t.id === id) as { prompt: string }).prompt;
const mentions = (req: LlmRequest, id: string) => JSON.stringify(req).includes(promptOf(id));
const env = { GEMINI_API_KEY: "sekrit-key-123", [MODEL_ENV]: "gemini:fake" };

function harness(provider: LlmProvider) {
  const written: Record<string, Record<string, unknown>> = {};
  const lines: string[] = [];
  const d: RecordDeps = {
    makeProvider: async () => provider,
    write: (id, data) => {
      written[id] = data;
    },
    log: (l) => lines.push(l),
  };
  return { d, written, lines, text: () => lines.join("\n") };
}

describe("eval:record never replaces a cassette with a failed or empty recording", () => {
  it("success: a clean task is written, exit 0", async () => {
    const h = harness({ complete: async () => sayOk });
    expect(await runRecord(["--live", "--task", "no-tool-answer"], env, h.d)).toBe(0);
    expect(Object.keys(h.written)).toEqual(["no-tool-answer"]);
    expect(Object.keys(h.written["no-tool-answer"] as object).length).toBe(1);
  });

  it("the provider throws on the FIRST call (401): nothing written, non-zero, key not printed", async () => {
    const h = harness({
      complete: async () => {
        throw new Error("401 Unauthorized for key sekrit-key-123");
      },
    });
    expect(await runRecord(["--live", "--task", "single-lookup"], env, h.d)).toBe(1);
    expect(h.written).toEqual({});
    expect(h.text()).toMatch(/single-lookup: NOT WRITTEN.*provider error: 401/);
    expect(h.text()).not.toContain("sekrit-key-123");
  });

  it("the provider throws MID-RUN (429 on the second call): nothing written, non-zero", async () => {
    let n = 0;
    const h = harness({
      complete: async () => {
        if (++n === 1) {
          return {
            content: "looking",
            toolCalls: [{ id: "c0", name: "lookup_order", input: { order: 1042 } }],
            stopReason: "tool_use" as const,
          };
        }
        throw new Error("429 Too Many Requests");
      },
    });
    expect(await runRecord(["--live", "--task", "single-lookup"], env, h.d)).toBe(1);
    expect(h.written).toEqual({});
    expect(h.text()).toMatch(/provider error: 429/);
  });

  it("an empty or short recording is refused (judgeRecording), whatever the status", () => {
    const t = { expected: { status: "completed" } } as never;
    const out = { status: "completed", steps: 2 } as const;
    expect(judgeRecording(t, { ...out, steps: 0 }, 0, [])).toMatch(/empty recording/);
    expect(judgeRecording(t, out, 1, [])).toMatch(/incomplete recording \(1 exchange\(s\) for 2/);
    expect(judgeRecording(t, out, 2, [])).toBeUndefined();
    expect(judgeRecording(t, out, 2, ["boom"])).toMatch(/provider error: boom/);
    expect(judgeRecording(t, { ...out, status: "failed" }, 2, [])).toMatch(
      /ended failed, expected completed/
    );
  });

  it("tasks that legitimately end failed (quota-stop, denied-tool) ARE recorded when a clean run fails as expected", async () => {
    const h = harness({
      complete: async (req) =>
        mentions(req, "denied-tool")
          ? {
              content: "deleting",
              toolCalls: [{ id: "c0", name: "delete_account", input: { id: "cus_ada" } }],
              stopReason: "tool_use" as const,
            }
          : sayOk,
    });
    expect(await runRecord(["--live", "--task", "denied-tool"], env, h.d)).toBe(0);
    expect(Object.keys(h.written)).toEqual(["denied-tool"]);
  });

  it("a task that ends differently than expected is skipped; the run goes on and exits non-zero", async () => {
    // single-lookup is expected `completed` and does; denied-tool is expected `failed` but the fake just answers.
    const h = harness({ complete: async () => sayOk });
    expect(
      await runRecord(["--live", "--task", "denied-tool", "--task", "no-tool-answer"], env, h.d)
    ).toBe(1);
    expect(Object.keys(h.written)).toEqual(["no-tool-answer"]);
    expect(h.text()).toMatch(/denied-tool: NOT WRITTEN.*ended completed, expected failed/);
    expect(h.text()).toMatch(/FAILED for denied-tool/);
  });

  it("a PROVIDER error aborts the remaining tasks; earlier clean ones stay written, later ones untouched", async () => {
    const h = harness({
      complete: async (req) => {
        if (mentions(req, "single-lookup")) throw new Error("model not found");
        return sayOk;
      },
    });
    const argv = [
      "--live",
      "--task",
      "no-tool-answer",
      "--task",
      "single-lookup",
      "--task",
      "two-parallel",
    ];
    expect(await runRecord(argv, env, h.d)).toBe(1);
    // TASKS order decides the sequence: whichever ran before single-lookup was written, none after it.
    const order = TASKS.map((t) => t.id).filter((id) => argv.includes(id));
    const upto = order.slice(0, order.indexOf("single-lookup"));
    expect(Object.keys(h.written)).toEqual(upto);
    expect(h.text()).toMatch(/aborting the remaining tasks/);
  });
});
