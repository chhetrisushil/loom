import { createHash } from "node:crypto";
import { tainted } from "@loom/classify";
import type { LlmStreamChunk, ReasoningStore } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { boot, lastUserText, messages } from "./__fixtures__/harness";
import { ConversationHub, type LiveEvent, withTurnScope } from "./index";

// ── ADR 0133 D6 — live reasoning through the hub ────────────────────────────────

const sig = () => new AbortController().signal;
const live = (hub: ConversationHub, id: string) => {
  const got: LiveEvent[] = [];
  hub.subscribe(id, (e) => got.push(e));
  return got;
};
const wrap = (s: string) => tainted(s, "llm-reasoning:test");

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

describe("ConversationHub reasoning", () => {
  it("publishes reasoning on its own event type, never as a text delta, and keeps a bounded partial", () => {
    const hub = new ConversationHub({ maxPartialChars: 8 });
    const got = live(hub, "c1");
    const r = hub.reasoningSink();
    withTurnScope("c1", 2, sig(), () => {
      r(wrap("abcdef"));
      r(wrap("ghijkl"));
    });
    expect(got.map((e) => e.type)).toEqual(["reasoning", "reasoning"]);
    expect(hub.partialOf("c1")).toBeUndefined(); // the REPLY partial is untouched
    // Same bound as the reply: the head is dropped.
    expect(hub.reasoningPartialOf("c1")).toEqual({ turn: 2, text: "efghijkl" });
  });

  it("is cleared when the turn's durable message lands, and a re-run clears it with ONE reset", () => {
    const hub = new ConversationHub();
    const got = live(hub, "c1");
    const r = hub.reasoningSink();
    const d = hub.deltaSink();
    withTurnScope("c1", 1, sig(), () => r(wrap("first")));
    withTurnScope("c1", 1, sig(), () => {
      r(wrap("again")); // a different run of the same turn: reset
      d("text"); // same (new) run: no second reset
      r(wrap(" more"));
    });
    expect(got.map((e) => e.type)).toEqual([
      "reasoning",
      "reset",
      "reasoning",
      "delta",
      "reasoning",
    ]);
    expect(hub.reasoningPartialOf("c1")?.text).toBe("again more");
    hub.endTurn("c1", 1);
    expect(hub.reasoningPartialOf("c1")).toBeUndefined();
    expect(hub.partialOf("c1")).toBeUndefined();
  });

  it("outside any turn scope a reasoning increment is dropped, never broadcast", () => {
    const hub = new ConversationHub();
    const got = live(hub, "c1");
    hub.reasoningSink()(wrap("stray"));
    expect(got).toEqual([]);
  });

  it("the reasoning partial of one conversation is not visible through another", () => {
    const hub = new ConversationHub();
    withTurnScope("a", 1, sig(), () => hub.reasoningSink()(wrap("secret thought")));
    expect(hub.reasoningPartialOf("b")).toBeUndefined();
  });

  it("end to end: a streaming model's reasoning reaches the hub, text deltas stay text, and the log holds no readable reasoning", async () => {
    const hub = new ConversationHub();
    const store = memStore();
    const b = boot({
      hub,
      reasoning: { store, live: true },
      chunks: async function* (req): AsyncGenerator<LlmStreamChunk> {
        yield { delta: "", done: false, reasoningDelta: "THOUGHT-A " };
        yield { delta: `re: ${lastUserText(req)}`, done: false };
        yield { delta: "", done: false, reasoningDelta: "THOUGHT-B" };
        yield {
          delta: "",
          done: true,
          stopReason: "end_turn",
          reasoning: [{ kind: "summary", text: "THOUGHT-A THOUGHT-B", provider: "anthropic" }],
        };
      },
    });
    const { conversationId: id } = await b.conv.start();
    const got = live(hub, id);
    await b.conv.sendTurn(id, "hello");
    await messages(b, id, 2);
    expect(
      got.filter((e) => e.type === "reasoning").map((e) => (e as { text: string }).text)
    ).toEqual(["THOUGHT-A ", "THOUGHT-B"]);
    // NEGATIVE: the text channel carries no reasoning.
    const text = got.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text);
    expect(text.join("")).toBe("re: hello");
    // NEGATIVE: no journaled value holds readable reasoning (only the sidecar does).
    const log = JSON.stringify(await b.eventStore.read(id));
    expect(log).not.toContain("THOUGHT-");
    expect(log).toContain("LLM_REASONING_CAPTURED");
    // The durable reply landed: the live buffers are gone.
    expect(hub.reasoningPartialOf(id)).toBeUndefined();
  });

  it("without `live` configured nothing is streamed (G2), but capture still happens", async () => {
    const hub = new ConversationHub();
    const b = boot({
      hub,
      reasoning: { store: memStore() },
      chunks: async function* (): AsyncGenerator<LlmStreamChunk> {
        yield { delta: "", done: false, reasoningDelta: "T" };
        yield { delta: "x", done: false };
        yield {
          delta: "",
          done: true,
          stopReason: "end_turn",
          reasoning: [{ kind: "summary", text: "T", provider: "anthropic" }],
        };
      },
    });
    const { conversationId: id } = await b.conv.start();
    const got = live(hub, id);
    await b.conv.sendTurn(id, "hi");
    await messages(b, id, 2);
    expect(got.some((e) => e.type === "reasoning")).toBe(false);
    expect(JSON.stringify(await b.eventStore.read(id))).toContain("LLM_REASONING_CAPTURED");
  });
});
