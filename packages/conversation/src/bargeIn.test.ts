import type { LlmRequest, LlmStreamChunk } from "@loom/llm";
import { describe, expect, it } from "vitest";
import {
  Latch,
  boot,
  cloneStreams,
  lastUserText,
  messages,
  signRaw,
  until,
} from "./__fixtures__/harness";
import { type BargeInSource, inboxBargeIn } from "./index";

const never = (req: LlmRequest): Promise<never> =>
  new Promise((_, rej) => {
    if (req.signal?.aborted) rej(new Error("aborted"));
    req.signal?.addEventListener("abort", () => rej(new Error("aborted")));
  });

/** A provider whose FIRST call blocks until its request signal aborts (a long generation). */
function longFirst() {
  const started = new Latch();
  const seen = { aborted: false };
  return {
    started,
    seen,
    reply: async (req: LlmRequest, nth: number) => {
      if (nth === 1) {
        started.release();
        await never(req).catch((e) => {
          seen.aborted = true;
          throw e;
        });
      }
      return { content: `re: ${lastUserText(req)}`, stopReason: "end_turn" as const };
    },
  };
}

describe("barge-in", () => {
  it("a new turn interrupts the running turn; the execution is never cancelled", async () => {
    const p = longFirst();
    const b = boot({ reply: p.reply });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "tell me a long story");
    await p.started.promise;
    await b.conv.sendTurn(id, "actually, stop"); // lands on the running turn
    const all = await messages(b, id, 4);
    expect(all.map((m) => [m.turn, m.role, m.status, m.text])).toEqual([
      [1, "user", "complete", "tell me a long story"],
      [1, "assistant", "interrupted", ""],
      [2, "user", "complete", "actually, stop"],
      [2, "assistant", "complete", "re: actually, stop"],
    ]);
    expect(p.seen.aborted).toBe(true); // the generation itself was cut, not merely ignored
    const st = await b.runtime.loadState(id);
    expect(["running", "suspended"]).toContain(st?.status);
    expect(st?.status).not.toBe("cancelled");
    // and the dialogue goes on
    await b.conv.sendTurn(id, "thanks");
    expect((await messages(b, id, 6)).at(-1)?.text).toBe("re: thanks");
    // the interrupted partial is part of the context the next turns see
    const ctx = b.requests
      .at(-1)
      ?.messages.map((m) => JSON.stringify(m.content))
      .join("\n");
    expect(ctx).toContain("tell me a long story");
  });

  it("a RETRY of the running turn's message is not a barge-in (the conformance case for the idempotency key)", async () => {
    const gate = new Latch();
    const b = boot({
      reply: async (req) => {
        await Promise.race([gate.promise, never(req)]);
        return { content: `re: ${lastUserText(req)}`, stopReason: "end_turn" };
      },
    });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "slow question", { messageId: "q-1" });
    await until(() => b.calls.n === 1);
    await b.conv.sendTurn(id, "slow question", { messageId: "q-1" });
    gate.release();
    const all = await messages(b, id, 2);
    expect(all[1]).toMatchObject({
      role: "assistant",
      status: "complete",
      text: "re: slow question",
    });
    expect(b.calls.n).toBe(1);
  });

  it("keeps the streamed partial text of the interrupted reply", async () => {
    const started = new Latch();
    const b = boot({
      chunks: async function* (req, nth): AsyncGenerator<LlmStreamChunk> {
        if (nth === 1) {
          yield { delta: "Once upon ", done: false };
          yield { delta: "a time ", done: false };
          started.release();
          await never(req);
        }
        yield { delta: `re: ${lastUserText(req)}`, done: false };
        yield { delta: "", done: true, stopReason: "end_turn" };
      },
    });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "story");
    await started.promise;
    await b.conv.sendTurn(id, "enough");
    const all = await messages(b, id, 4);
    expect(all[1]).toMatchObject({
      role: "assistant",
      status: "interrupted",
      text: "Once upon a time ",
    });
    expect(all[3]).toMatchObject({ status: "complete", text: "re: enough" });
  });

  it("without a barge-in source the conversation QUEUES: the running turn finishes first", async () => {
    const gate = new Latch();
    const b = boot({
      config: { bargeIn: undefined as never },
      reply: async (req, nth) => {
        if (nth === 1) await gate.promise;
        return { content: `re: ${lastUserText(req)}`, stopReason: "end_turn" };
      },
    });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "first");
    await until(() => b.calls.n === 1);
    await b.conv.sendTurn(id, "second");
    gate.release();
    const all = await messages(b, id, 4);
    expect(all.map((m) => [m.role, m.status, m.text])).toEqual([
      ["user", "complete", "first"],
      ["assistant", "complete", "re: first"],
      ["user", "complete", "second"],
      ["assistant", "complete", "re: second"],
    ]);
  });

  it("a message already waiting when the turn starts interrupts it (nothing slips between consumption and subscription)", async () => {
    const turnStarted = new Latch();
    const go = new Latch();
    const delayed: BargeInSource = async (c, o, h) => {
      turnStarted.release();
      await go.promise; // the second message is appended before we subscribe
      return inboxBargeIn(b.eventStore)(c, o, h);
    };
    const b: ReturnType<typeof boot> = boot({ config: { bargeIn: delayed } });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "one");
    await turnStarted.promise;
    await b.conv.sendTurn(id, "two"); // appended while the turn has NOT subscribed yet
    go.release();
    const all = await messages(b, id, 4);
    expect(all.map((m) => [m.role, m.status, m.text])).toEqual([
      ["user", "complete", "one"],
      ["assistant", "interrupted", ""],
      ["user", "complete", "two"],
      ["assistant", "complete", "re: two"],
    ]);
    expect(b.calls.n).toBe(1); // turn 1 never reached the model
  });

  it("several quick messages: every one is recorded, the last is answered, nothing is lost", async () => {
    const p = longFirst();
    const b = boot({ reply: p.reply });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "a");
    await p.started.promise;
    await b.conv.sendTurn(id, "b");
    await b.conv.sendTurn(id, "c");
    await b.conv.sendTurn(id, "d");
    await until(
      async () => (await b.conv.status(id)).turns === 4 && !(await b.conv.status(id)).running
    );
    const all = await b.conv.history(id);
    const users = all.entries.filter((m) => m.role === "user").map((m) => m.text);
    expect(users).toEqual(["a", "b", "c", "d"]);
    expect(all.entries.at(-1)).toMatchObject({
      role: "assistant",
      status: "complete",
      text: "re: d",
    });
    // exactly one reply record per turn
    const replies = all.entries.filter((m) => m.role === "assistant").map((m) => m.turn);
    expect(replies).toEqual([1, 2, 3, 4]);
  });

  it("holds a store subscription only while a turn runs: none leak across turns, wakes or a close", async () => {
    let live = 0;
    let peak = 0;
    let b!: ReturnType<typeof boot>;
    const counting: BargeInSource = async (c, o, h) => {
      const off = await inboxBargeIn(b.eventStore)(c, o, h);
      peak = Math.max(peak, ++live);
      return () => {
        live--;
        off();
      };
    };
    b = boot({ config: { bargeIn: counting } });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 4; i++) {
      await b.conv.sendTurn(id, `q${i}`);
      await messages(b, id, i * 2);
    }
    await until(async () => (await b.runtime.loadState(id))?.status === "suspended");
    expect(live).toBe(0); // idle: nothing is listening
    expect(peak).toBe(1); // one turn at a time
    await b.conv.close(id);
    await until(async () => (await b.conv.status(id)).state === "closed");
    expect(live).toBe(0);
  });

  describe("replay and crash", () => {
    it("a restart replays an interrupted dialogue without a model call or a divergence", async () => {
      const p = longFirst();
      const watches = { n: 0 };
      const b: ReturnType<typeof boot> = boot({
        reply: p.reply,
        config: {
          bargeIn: (c, o, h) => {
            watches.n++;
            return inboxBargeIn(b.eventStore)(c, o, h);
          },
        },
      });
      const { conversationId: id } = await b.conv.start();
      await b.conv.sendTurn(id, "long one");
      await p.started.promise;
      await b.conv.sendTurn(id, "short one");
      await messages(b, id, 4);
      await until(async () => (await b.runtime.loadState(id))?.status === "suspended");
      const callsBefore = b.calls.n;
      expect(watches.n).toBe(2); // one per live turn

      // A new process: fresh runtime over the same stores, divergence "fail". The next turn re-runs
      // the whole body from the top; the recorded abort checkpoints must reproduce turn 1's interruption.
      const rt2 = b.mk();
      rt2.registerFlow(b.flow.definition, b.flow.runner);
      await rt2.send(id, {
        topic: "conversation:turn",
        payload: signRaw(id, { kind: "user", text: "third", id: "t3" }),
      });
      await until(async () => (await b.conv.history(id)).entries.length >= 6);
      const all = (await b.conv.history(id)).entries;
      expect(all.map((m) => [m.turn, m.role, m.status])).toEqual([
        [1, "user", "complete"],
        [1, "assistant", "interrupted"],
        [2, "user", "complete"],
        [2, "assistant", "complete"],
        [3, "user", "complete"],
        [3, "assistant", "complete"],
      ]);
      // only the NEW turn asked the model, and only the NEW turn subscribed to anything: the two
      // replayed turns (every wake re-runs the whole generation) listened to nothing
      expect(b.calls.n).toBe(callsBefore + 1);
      expect(watches.n).toBe(3);
    });

    it("a crash between the interrupting message's arrival and its consumption still interrupts, after recovery", async () => {
      const p = longFirst();
      const b = boot({ reply: p.reply });
      const { conversationId: id } = await b.conv.start();
      await b.conv.sendTurn(id, "a very long answer please");
      await p.started.promise; // turn 1's model call is in flight
      // The process dies with the interrupting message durable in the inbox and UNCONSUMED: the
      // owner's log is cut at the in-flight STEP_STARTED of turn 1, the inbox holds both messages.
      let ownerPrefix = -1;
      await until(async () => {
        const evs = await b.eventStore.read(id);
        const i = evs.findIndex((e) => e.eventType === "STEP_STARTED");
        ownerPrefix = i;
        return i >= 0;
      }, "turn 1's STEP_STARTED");
      const inbox = `__loom_inbox__:${id}`;
      await b.conv.sendTurn(id, "never mind");
      const crashed = await cloneStreams(b.eventStore, [id, inbox], { [id]: ownerPrefix });
      const events = await crashed.read(id);
      expect(events.at(-1)?.eventType).toBe("STEP_STARTED");

      const calls2 = { n: 0 };
      const survivor = boot({
        store: crashed,
        reply: async (req) => {
          calls2.n++;
          if (calls2.n === 1) await never(req); // the re-run of the long generation
          return { content: `re: ${lastUserText(req)}`, stopReason: "end_turn" };
        },
      });
      const folded = await survivor.runtime.loadState(id);
      expect(folded?.status).toBe("running"); // a crash, not a failure
      const handle = await survivor.runtime.restoreFromState(folded as never);
      void handle;
      await until(async () => (await survivor.conv.history(id)).entries.length >= 4);
      const all = (await survivor.conv.history(id)).entries;
      expect(all.map((m) => [m.role, m.status, m.text])).toEqual([
        ["user", "complete", "a very long answer please"],
        ["assistant", "interrupted", ""],
        ["user", "complete", "never mind"],
        ["assistant", "complete", "re: never mind"],
      ]);
    });
  });
});
