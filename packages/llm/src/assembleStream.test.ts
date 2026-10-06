import { describe, expect, it } from "vitest";
import { MalformedStreamError, assembleStream, collectStream } from "./assembleStream";
import type { LlmProvider, LlmStreamChunk } from "./types";

// ── R8 — the streamed-≡-completed contract ────────────────────────────────────
//
// `LlmStreamChunk` used to be `{ delta, done }`, so the streaming path dropped
// tool calls, stop reason and usage — everything a ReAct loop branches on and
// everything K3 meters. Widening the type is half the fix; the half that keeps it
// honest is a rule saying the two paths agree, which is what these pin.

const text = (s: string): LlmStreamChunk => ({ delta: s, done: false });

describe("assembleStream", () => {
  it("concatenates deltas into the completed content", () => {
    expect(assembleStream([text("he"), text("llo"), { delta: "", done: true }]).content).toBe(
      "hello"
    );
  });

  it("takes the outcome from the terminal chunk", () => {
    const res = assembleStream([
      text("ok"),
      {
        delta: "",
        done: true,
        toolCalls: [{ id: "c1", name: "lookup", input: { q: 1 } }],
        stopReason: "tool_use",
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    ]);
    expect(res).toEqual({
      content: "ok",
      toolCalls: [{ id: "c1", name: "lookup", input: { q: 1 } }],
      stopReason: "tool_use",
      usage: { inputTokens: 4, outputTokens: 2 },
    });
  });

  it("defaults an unreported stopReason to end_turn, like complete does", () => {
    expect(assembleStream([text("hi"), { delta: "", done: true }])).toEqual({
      content: "hi",
      stopReason: "end_turn",
    });
  });

  it("leaves unreported toolCalls and usage ABSENT, not empty", () => {
    // `undefined` means "not reported"; `[]` would mean "reported none", and
    // metering must be able to tell a provider that omits usage from one that
    // charged nothing.
    const res = assembleStream([text("hi"), { delta: "", done: true }]);
    expect("toolCalls" in res).toBe(false);
    expect("usage" in res).toBe(false);
  });

  // ── shape refusals: a malformed stream fails HERE, not at the point of use ──

  it("refuses a stream with no terminal chunk", () => {
    expect(() => assembleStream([text("a")])).toThrow(MalformedStreamError);
  });

  it("refuses a stream that terminates twice", () => {
    expect(() =>
      assembleStream([{ delta: "", done: true }, text("a"), { delta: "", done: true }])
    ).toThrow(/2 terminal chunks/);
  });

  it("refuses a terminal chunk that is not last", () => {
    expect(() => assembleStream([{ delta: "a", done: true }, text("b")])).toThrow(
      MalformedStreamError
    );
  });

  it("collectStream drains an async iterable and folds it", async () => {
    async function* gen(): AsyncIterable<LlmStreamChunk> {
      yield text("a");
      yield { delta: "", done: true, stopReason: "max_tokens" };
    }
    expect(await collectStream(gen())).toEqual({ content: "a", stopReason: "max_tokens" });
  });
});

describe("parity is a real check, not a shape", () => {
  // The conformance suite compares `assembleStream(stream)` against `complete()`.
  // If that comparison could not fail, the contract would be decoration — so this
  // asserts a DIVERGENT provider is caught, which is the property the suite relies
  // on and cannot demonstrate about itself from the inside.
  const divergent: LlmProvider = {
    async complete() {
      return {
        content: "hello",
        toolCalls: [{ id: "c1", name: "lookup", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 1 },
      };
    },
    // Reports NOTHING on the terminal chunk — the pre-R8 shape, and the exact
    // failure mode: a tool-using turn arrives at the agent as a text answer.
    async *stream() {
      yield { delta: "hello", done: false };
      yield { delta: "", done: true };
    },
  };

  it("catches a stream that drops the tool calls its completion reports", async () => {
    const completed = await divergent.complete({ messages: [] });
    const streamed = await collectStream(
      divergent.stream?.({ messages: [] }) as AsyncIterable<LlmStreamChunk>
    );

    expect(streamed.content).toBe(completed.content); // text agrees…
    expect(streamed.toolCalls).toBeUndefined(); // …and the outcome does not
    expect(streamed.stopReason).not.toBe(completed.stopReason);
    expect(streamed.usage).toBeUndefined();
  });
});

describe("collectStream's mid-flight guard (K8.4's seam)", () => {
  async function* endless(): AsyncIterable<LlmStreamChunk> {
    for (let i = 0; i < 1000; i++) yield { delta: "tok", done: false };
    yield { delta: "", done: true };
  }

  it("calls the guard after every delta, with the text so far", async () => {
    const seen: { text: string; deltas: number }[] = [];
    await collectStream(
      (async function* () {
        yield text("a");
        yield text("b");
        yield { delta: "", done: true } as LlmStreamChunk;
      })(),
      { guard: (p) => seen.push({ text: p.text, deltas: p.deltas }) }
    );
    expect(seen.map((s) => s.text)).toEqual(["a", "ab", "ab"]);
  });

  it("a throwing guard SEVERS the stream — the whole point of K8.4", async () => {
    // Without this the generation runs to completion and the budget is enforced
    // after the money is spent, which is admission control, not severance.
    let delivered = 0;
    const err = await collectStream(endless(), {
      onDelta: () => {
        delivered++;
      },
      guard: (p) => {
        if (p.deltas >= 5) throw new Error("budget");
      },
    }).catch((e) => e);

    expect((err as Error).message).toBe("budget");
    expect(delivered).toBe(4); // not 1000; the breaching 5th is withheld (ADR 0119 P3)
  });

  it("a guard throw is NOT an interruption, even under an abort signal", async () => {
    // The distinction matters: an interruption keeps the partial as a value on a
    // typed channel; a budget breach must surface as the budget error so the
    // caller can tell "a human stopped this" from "this cost too much".
    const controller = new AbortController();
    controller.abort();
    const err = await collectStream(endless(), {
      signal: controller.signal,
      guard: () => {
        throw new Error("budget");
      },
    }).catch((e) => e);

    expect((err as Error).message).toBe("budget");
    expect((err as { channel?: string }).channel).toBeUndefined();
  });

  it("the guard runs BEFORE delivery: the breaching delta is never handed to a sink (ADR 0119)", async () => {
    const delivered: string[] = [];
    await collectStream(endless(), {
      onDelta: (d) => {
        delivered.push(d);
      },
      guard: (p) => {
        if (p.deltas >= 3) throw new Error("budget");
      },
    }).catch(() => {});
    expect(delivered).toHaveLength(2); // deltas 1 and 2; the 3rd breached and was withheld
  });

  it("an abort severs a signal-IGNORING stream at the next chunk instead of delivering it", async () => {
    const controller = new AbortController();
    const delivered: string[] = [];
    const err = await collectStream(endless(), {
      signal: controller.signal,
      onDelta: (d) => {
        delivered.push(d);
        if (delivered.length === 2) controller.abort(new Error("stop"));
      },
    }).catch((e) => e);
    expect(delivered).toHaveLength(2); // not 1000
    expect((err as { channel?: string }).channel).toBe("llmInterrupted");
  });
});
