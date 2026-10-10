import { tainted } from "@loom/classify";
import { agent$ } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import { TEST_KEY, boot, messages, signRaw, until } from "./__fixtures__/harness";
import {
  type TokenCounter,
  conversation$,
  fitToWindow,
  heuristicTokenCounter,
  summarizerText,
} from "./index";

/** 1 token per character: exact arithmetic for the tests. */
const perChar = (calls?: { n: number }): TokenCounter => ({
  perMessage: 0,
  count: (t) => {
    if (calls) calls.n++;
    return t.length;
  },
});

describe("fitToWindow", () => {
  const turns = [
    { user: "aaaa", assistant: "bbbb" }, // 8
    { user: "cccc", assistant: "dddd" }, // 8
    { user: "eeee", assistant: "ffff" }, // 8
  ];

  it("keeps the longest NEWEST suffix of whole turns that fits beside system, summary and prompt", async () => {
    const v = await fitToWindow({
      contextWindow: 40,
      reserveOutputTokens: 10,
      system: "sss", // 3
      summary: "yy", // 2
      prompt: "pppp", // 4  -> fixed 9, room 21 -> two turns (16), a third would be 24
      turns,
      counter: perChar(),
    });
    expect(v).toMatchObject({ ok: true, keep: 2, tokens: 25 });
  });

  it("never drops the prompt: a prompt that cannot fit is refused", async () => {
    const v = await fitToWindow({
      contextWindow: 10,
      reserveOutputTokens: 2,
      prompt: "p".repeat(9),
      turns,
      counter: perChar(),
    });
    expect(v).toMatchObject({ ok: false, reason: "prompt-too-large" });
  });

  it("counts a turn once (cached tokens are trusted) and stops at the first turn that does not fit", async () => {
    const calls = { n: 0 };
    const v = await fitToWindow({
      contextWindow: 30,
      reserveOutputTokens: 0,
      prompt: "pp",
      turns: [
        { user: "x".repeat(50), assistant: "y" }, // too old to matter: never counted
        { user: "cccc", assistant: "dddd", tokens: 8 },
        { user: "eeee", assistant: "ffff" },
      ],
      counter: perChar(calls),
    });
    expect(v).toMatchObject({ ok: true, keep: 2 });
    // prompt + the newest (uncounted) turn's two texts + the first turn that did not fit
    expect(calls.n).toBe(1 + 2 + 2);
    if (v.ok) expect(v.counted.map(([i]) => i)).toEqual([2, 0]);
  });

  it("is deterministic: the same counts give the same verdict", async () => {
    const req = { contextWindow: 64, prompt: "hello", turns, counter: heuristicTokenCounter() };
    expect(await fitToWindow(req)).toEqual(await fitToWindow(req));
  });

  it("the default counter is conservative for non-ASCII (never under-counts a CJK/emoji prompt 4x)", async () => {
    const c = heuristicTokenCounter();
    expect(c.count("abcd")).toBe(1);
    expect(c.count("你好世界")).toBe(4);
    expect(c.count("😀")).toBe(1);
    expect(() => heuristicTokenCounter({ asciiCharsPerToken: 0 })).toThrow(RangeError);
  });

  it("an async (provider) counter is awaited", async () => {
    const v = await fitToWindow({
      contextWindow: 100,
      reserveOutputTokens: 0,
      prompt: "p",
      turns,
      counter: { perMessage: 0, count: async (t) => t.length },
    });
    expect(v).toMatchObject({ ok: true, keep: 3 });
  });
});

describe("conversation budgeting", () => {
  const cfg = (extra = {}) => ({
    budget: { contextWindow: 300, reserveOutputTokens: 0, counter: perChar(), ...extra },
  });

  it("drops the OLDEST turns from the prompt once the window is full; they stay in history", async () => {
    const b = boot({
      config: cfg(),
      reply: () => ({ content: "r".repeat(60), stopReason: "end_turn" }),
    });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 6; i++) {
      await b.conv.sendTurn(id, `question-${i}-${"q".repeat(40)}`);
      await messages(b, id, i * 2);
    }
    const last = JSON.stringify(b.requests.at(-1)?.messages);
    expect(last).toContain("question-6"); // the new prompt
    expect(last).toContain("question-5"); // recent turns kept
    expect(last).not.toContain("question-1"); // the oldest is out of the prompt...
    expect(b.requests.every((r) => JSON.stringify(r).length < 1_500)).toBe(true);
    // ...but not out of the record
    const hist = (await b.conv.history(id, { limit: 100 })).entries.filter(
      (m) => m.role === "user"
    );
    expect(hist.map((m) => m.text.slice(0, 10))).toContain("question-1");
  });

  it("folds evicted turns into a rolling summary through the configured effect", async () => {
    const b = boot({
      config: cfg({ summarizerToolId: "summarize" }),
      reply: () => ({ content: "r".repeat(60), stopReason: "end_turn" }),
    });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 6; i++) {
      await b.conv.sendTurn(id, `question-${i}-${"q".repeat(40)}`);
      await messages(b, id, i * 2);
    }
    const last = JSON.stringify(b.requests.at(-1)?.messages);
    expect(last).toContain("Summary of the earlier conversation");
    expect(last).toContain("summary of"); // the effect's output
    // the summary is model output over untrusted text: it rides FENCED in a user message
    expect(last).toContain("conversation:summary");
    expect(last).not.toContain("question-1");
  });

  it("a summarizer reading its input through summarizerText survives rotation; the summary is fenced", async () => {
    const seen: string[] = [];
    const b = boot({
      config: { ...cfg({ summarizerToolId: "real-summarize" }), rotateEveryTurns: 2 },
      reply: () => ({ content: "r".repeat(60), stopReason: "end_turn" }),
      extraEffects: (e) =>
        e.register(
          "real-summarize",
          new ToolEffect(async (input: unknown) => {
            const text = (input as { messages: { content: unknown }[] }).messages
              .map((m) => summarizerText(m.content))
              .join("|");
            seen.push(text);
            return { summary: `digest(${text.length})` };
          })
        ),
    });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 6; i++) {
      await b.conv.sendTurn(id, `question-${i}-${"q".repeat(40)}`);
      await messages(b, id, i * 2);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join("")).toContain("question-1"); // the text was readable, not [object Object]
    const last = JSON.stringify(b.requests.at(-1)?.messages);
    expect(last).toContain("digest(");
    expect(last).toContain("conversation:summary"); // re-injected fenced, origin-labelled
  });

  it("a prompt that cannot fit even alone is refused: no model call, the dialogue continues", async () => {
    const b = boot({ config: cfg() });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "z".repeat(400)); // 400 > the 300-token window
    await b.conv.sendTurn(id, "ok");
    const all = await messages(b, id, 3);
    expect(all[0]).toMatchObject({ role: "user", status: "rejected", reason: "prompt-too-large" });
    expect(all[1]).toMatchObject({ role: "user", text: "ok" });
    expect(b.calls.n).toBe(1);
  });

  it("is recorded: a restart replays the verdicts and never re-counts an old turn", async () => {
    const seen: string[] = [];
    const recording: TokenCounter = {
      perMessage: 0,
      count: (t) => {
        seen.push(t);
        return t.length;
      },
    };
    const b = boot({ config: cfg({ counter: recording }) });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 3; i++) {
      await b.conv.sendTurn(id, `message ${i}`);
      await messages(b, id, i * 2);
    }
    await until(async () => (await b.runtime.loadState(id))?.status === "suspended");
    seen.length = 0;

    // A new process (divergence "fail") whose counter has CHANGED its mind about every old text: the
    // recorded verdicts win, and the cached per-turn counts mean old turns are not counted again at all.
    const rt2 = b.mk();
    const flow2 = conversation$({
      key: TEST_KEY,
      agent: { definition: agent$({ id: "chat", name: "Chat", tools: [] }), modelToolId: "model" },
      budget: {
        contextWindow: 300,
        reserveOutputTokens: 0,
        counter: {
          perMessage: 0,
          count: (t) => {
            seen.push(t);
            return /message|re:/.test(t) ? t.length * 1000 : t.length;
          },
        },
      },
    });
    rt2.registerFlow(flow2.definition, flow2.runner);
    await rt2.send(id, {
      topic: "conversation:turn",
      payload: signRaw(id, { kind: "user", text: "m4", id: "x4" }),
    });
    await until(async () => (await b.conv.history(id, { limit: 100 })).entries.length >= 8);
    const all = (await b.conv.history(id, { limit: 100 })).entries;
    expect(all.map((m) => [m.turn, m.role, m.status])).toEqual(
      [1, 2, 3, 4].flatMap((t) => [
        [t, "user", "complete"],
        [t, "assistant", "complete"],
      ])
    );
    // turns 1-2 were counted by recorded verdicts and cached: never re-counted. Turn 3 had not been
    // weighed yet (a turn is counted by the NEXT fit), so it is counted now, once.
    expect(seen.filter((t) => /message|re:/.test(t))).toEqual(["message 3", "re: message 3"]);
    expect(seen).toContain("m4");
    // the verdicts are decisions in the log, one per consumed message
    const fits = (await b.eventStore.read(id)).filter(
      (e) => (e.payload as { source?: string } | null)?.source === "conversation-budget"
    );
    expect(fits).toHaveLength(4);
  });
});

describe("summarizerText", () => {
  it("passes a plain string and a parts array through textOf, and unwraps a tainted one", () => {
    expect(summarizerText("hi")).toBe("hi");
    expect(
      summarizerText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ])
    ).toBe("ab");
    expect(summarizerText(tainted("data", "x"))).toBe("data");
    expect(summarizerText(tainted([{ type: "text", text: "p" }], "x"))).toBe("p");
  });
});
