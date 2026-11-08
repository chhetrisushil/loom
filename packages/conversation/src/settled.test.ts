import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmRequest } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { Latch, boot, lastUserText, messages, signRaw, until } from "./__fixtures__/harness";
import { type TurnSettledEvent, turnSettledObserver } from "./index";

/** A boot whose runtime reports settled turns into `seen`, via `onDurableEvent`. */
function observed(opts: Parameters<typeof boot>[0] = {}) {
  const seen: TurnSettledEvent[] = [];
  const flowRef: { definition: { id: string } } = { definition: { id: "conversation" } };
  const b = boot({
    ...opts,
    runtime: {
      ...opts.runtime,
      onDurableEvent: turnSettledObserver(flowRef, (e) => {
        seen.push(e);
      }),
    },
  });
  expect(b.flow.definition.id).toBe(flowRef.definition.id);
  return { b, seen };
}

/** An event store whose writes of assistant records wait until `release()`. */
class HeldReplies extends InMemoryAsyncEventStore {
  held = new Latch();
  heldCount = 0;
  override async append(event: EventEnvelope): Promise<void> {
    const p = event.payload as { source?: string; choice?: { role?: string } } | null;
    if (p?.source === "conversation-record" && p.choice?.role === "assistant") {
      this.heldCount++;
      await this.held.promise;
    }
    return super.append(event);
  }
}

describe("turnSettledObserver", () => {
  it("fires once per settled turn, with ids and status only, and a read from the callback sees the reply", async () => {
    const reads: number[] = [];
    const seen: TurnSettledEvent[] = [];
    const b = boot({
      runtime: {
        onDurableEvent: turnSettledObserver({ definition: { id: "conversation" } }, async (e) => {
          seen.push(e);
          // what a consumer does: re-read through the store, find the closing record
          const h = await b.conv.history(e.conversationId, { limit: 100 });
          reads.push(h.entries.filter((m) => m.ord === e.ord && m.role === "assistant").length);
        }),
      },
    });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "hello");
    await messages(b, id, 2);
    await b.conv.sendTurn(id, "again");
    const all = await messages(b, id, 4);
    await until(() => reads.length === 2, "two settled reads");

    expect(seen).toEqual([
      { conversationId: id, executionId: id, turn: 1, ord: all[1]?.ord, status: "complete" },
      { conversationId: id, executionId: id, turn: 2, ord: all[3]?.ord, status: "complete" },
    ]);
    expect(reads).toEqual([1, 1]);
    expect(JSON.stringify(seen)).not.toContain("re: hello"); // no reply text
  });

  it("is not called before the reply's write has landed", async () => {
    const store = new HeldReplies();
    const { b, seen } = observed({ store });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "hello");
    await until(() => store.heldCount === 1, "the reply's write in flight");
    expect(seen).toEqual([]);
    store.held.release();
    await until(() => seen.length === 1, "settled after the write");
    expect(seen[0]).toMatchObject({ conversationId: id, turn: 1, status: "complete" });
  });

  it("reports interrupted, failed and rejected turns", async () => {
    const started = new Latch();
    const { b, seen } = observed({
      config: { maxTurnChars: 40 },
      reply: async (req: LlmRequest, nth: number) => {
        if (nth === 1) {
          started.release();
          await new Promise<never>((_, rej) =>
            req.signal?.addEventListener("abort", () => rej(new Error("aborted")))
          );
        }
        if (lastUserText(req) === "break") throw new Error("upstream failure");
        return { content: `re: ${lastUserText(req)}`, stopReason: "end_turn" };
      },
    });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "a long story");
    await started.promise;
    await b.conv.sendTurn(id, "stop"); // barges in: turn 1 interrupted, turn 2 complete
    await messages(b, id, 4);
    await b.conv.sendTurn(id, "break");
    await messages(b, id, 6);
    // a message the body refuses (over maxTurnChars), written to the inbox raw past the client's check
    await b.runtime.send(id, {
      topic: "conversation:turn",
      payload: signRaw(id, { kind: "user", text: "x".repeat(41), id: "long" }),
    });
    await until(() => seen.length === 4, "four settled");
    expect(seen.map((e) => [e.turn, e.status])).toEqual([
      [1, "interrupted"],
      [2, "complete"],
      [3, "failed"],
      [0, "rejected"],
    ]);
    const ords = seen.map((e) => e.ord);
    expect(new Set(ords).size).toBe(4);
  });

  it("a replay or a restart does not call it again for a turn already settled", async () => {
    const { b, seen } = observed();
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "one");
    await messages(b, id, 2);
    await b.conv.sendTurn(id, "two");
    await messages(b, id, 4);
    await until(() => seen.length === 2, "two settled");
    await until(async () => (await b.runtime.loadState(id))?.status === "suspended", "parked");

    // A new process over the same store. The next turn re-runs the whole body from the top, serving
    // turns 1 and 2 from the log: only turn 3 is a new write.
    const seen2: TurnSettledEvent[] = [];
    const rt2 = b.mk({ onDurableEvent: turnSettledObserver(b.flow, (e) => void seen2.push(e)) });
    rt2.registerFlow(b.flow.definition, b.flow.runner);
    await rt2.send(id, {
      topic: "conversation:turn",
      payload: signRaw(id, { kind: "user", text: "three", id: "t3" }),
    });
    await until(() => seen2.length === 1, "turn 3 settled");
    await until(async () => (await rt2.loadState(id))?.status === "suspended", "parked again");
    expect(seen2.map((e) => e.turn)).toEqual([3]);
    expect(seen.map((e) => e.turn)).toEqual([1, 2]);
  });

  it("keeps the conversation id across a rotation", async () => {
    const { b, seen } = observed({ config: { rotateEveryTurns: 1 } });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "one");
    await messages(b, id, 2);
    await b.conv.sendTurn(id, "two");
    await messages(b, id, 4);
    await until(() => seen.length === 2, "two settled");
    expect(seen.map((e) => [e.conversationId, e.turn])).toEqual([
      [id, 1],
      [id, 2],
    ]);
    expect(seen[1]?.executionId).toBe(`${id}~1`);
  });

  it("a throwing or rejecting listener never fails the turn", async () => {
    const warnings: string[] = [];
    let n = 0;
    const b = boot({
      runtime: {
        onWarn: (m: string) => warnings.push(m),
        onDurableEvent: turnSettledObserver({ definition: { id: "conversation" } }, (_e) => {
          n++;
          if (n === 1) throw new Error("listener boom");
          return Promise.reject(new Error("listener async boom"));
        }),
      },
    });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "one");
    await messages(b, id, 2);
    await b.conv.sendTurn(id, "two");
    const all = await messages(b, id, 4);
    expect(all.map((m) => m.status)).toEqual(["complete", "complete", "complete", "complete"]);
    await until(() => n === 2, "both calls made");
    await until(() => warnings.some((w) => w.includes("listener boom")), "reported via onWarn");
    expect((await b.runtime.loadState(id))?.status).not.toBe("failed");
  });

  it("ignores another flow's events and non-closing records", () => {
    const calls: TurnSettledEvent[] = [];
    const observe = turnSettledObserver({ definition: { id: "conversation" } }, (e) => {
      calls.push(e);
    });
    const ev = (workflowId: string, choice: unknown): EventEnvelope => ({
      id: "x-1",
      workflowId,
      executionId: "c1",
      eventType: "DECISION_RECORDED",
      sequence: 1,
      timestamp: 0,
      payload: { decisionId: "d", source: "conversation-record", choice },
    });
    const reply = { turn: 1, ord: 2, role: "assistant", text: "t", status: "complete" };
    observe(ev("other-flow", reply));
    observe(ev("conversation", { turn: 1, ord: 1, role: "user", text: "q", status: "complete" }));
    observe(ev("conversation", { kind: "closed", turns: 1 }));
    observe(ev("conversation", { ...reply, ord: undefined })); // a pre-ord record
    expect(calls).toEqual([]);
    observe(ev("conversation", reply));
    expect(calls).toEqual([
      { conversationId: "c1", executionId: "c1", turn: 1, ord: 2, status: "complete" },
    ]);
  });
});
