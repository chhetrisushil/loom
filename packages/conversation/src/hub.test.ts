import type { LlmStreamChunk } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { Latch, boot, lastUserText, messages } from "./__fixtures__/harness";
import { ConversationHub, type LiveEvent, SubscriberLimitError, withTurnScope } from "./index";

const live = (hub: ConversationHub, id: string) => {
  const got: LiveEvent[] = [];
  const stop = hub.subscribe(id, (e) => got.push(e));
  return { got, stop };
};
const sig = () => new AbortController().signal;

describe("ConversationHub", () => {
  it("attributes model deltas to the conversation turn that is running the call, and to no other", async () => {
    const hub = new ConversationHub();
    const gateA = new Latch();
    const b = boot({
      hub,
      chunks: async function* (req): AsyncGenerator<LlmStreamChunk> {
        const text = lastUserText(req);
        yield { delta: `${text}-1 `, done: false };
        if (text.startsWith("A")) await gateA.promise; // A is mid-stream while B runs to completion
        yield { delta: `${text}-2`, done: false };
        yield { delta: "", done: true, stopReason: "end_turn" };
      },
    });
    const a = (await b.conv.start({ conversationId: "conv-a" })).conversationId;
    const c = (await b.conv.start({ conversationId: "conv-b" })).conversationId;
    const onlyA = live(hub, a);
    const onlyB = live(hub, c);
    await b.conv.sendTurn(a, "Aquestion");
    await b.conv.sendTurn(c, "Bquestion");
    await messages(b, c, 2); // B finished while A is still streaming
    gateA.release();
    await messages(b, a, 2);
    const text = (xs: LiveEvent[]) =>
      xs.map((e) => (e.type === "delta" ? e.text : "[reset]")).join("");
    expect(text(onlyA.got)).toBe("Aquestion-1 Aquestion-2");
    expect(text(onlyB.got)).toBe("Bquestion-1 Bquestion-2");
    expect(onlyA.got.every((e) => e.conversationId === a && e.turn === 1)).toBe(true);
    expect(onlyB.got.every((e) => e.conversationId === c)).toBe(true);
  });

  it("a delta outside any turn scope is dropped, never broadcast", () => {
    const hub = new ConversationHub();
    const x = live(hub, "c1");
    hub.deltaSink()("stray");
    expect(x.got).toEqual([]);
  });

  it("a re-run of a turn (a crash-recovered process asked the model again) is announced with a reset", () => {
    const hub = new ConversationHub();
    const x = live(hub, "c1");
    const sink = hub.deltaSink();
    withTurnScope("c1", 4, sig(), () => sink("hel"));
    withTurnScope("c1", 4, sig(), () => sink("hello again"));
    expect(x.got.map((e) => e.type)).toEqual(["delta", "reset", "delta"]);
    // NEGATIVE: the same run streaming on does not reset
    const y = live(hub, "c2");
    withTurnScope("c2", 1, sig(), () => {
      sink("a");
      sink("b");
    });
    expect(y.got.map((e) => e.type)).toEqual(["delta", "delta"]);
  });

  it("unsubscribe stops delivery, and the subscriber count per conversation is bounded", () => {
    const hub = new ConversationHub({ maxSubscribersPerConversation: 2 });
    const one = live(hub, "c");
    live(hub, "c");
    expect(() => hub.subscribe("c", () => {})).toThrow(SubscriberLimitError);
    expect(() => hub.subscribe("other", () => {})).not.toThrow(); // the limit is per conversation
    one.stop();
    expect(hub.subscriberCount("c")).toBe(1);
    hub.subscribe("c", () => {}); // room again
    hub.publish("c", { type: "delta", conversationId: "c", turn: 1, text: "x" });
    expect(one.got).toEqual([]);
  });

  it("a throwing subscriber cannot hurt the turn or the other subscribers", () => {
    const hub = new ConversationHub();
    hub.subscribe("c", () => {
      throw new Error("boom");
    });
    const ok = live(hub, "c");
    hub.publish("c", { type: "delta", conversationId: "c", turn: 1, text: "x" });
    expect(ok.got).toHaveLength(1);
  });
});
