import { isTainted } from "@loom/classify";
import { flow$ } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Latch, boot, lastUserText, messages, until } from "./__fixtures__/harness";
import { isNew } from "./bargeIn";
import { carryOf } from "./conversation";
import { inboxBargeIn, pendingInbox, senderKey } from "./index";

const perChar = { perMessage: 0, count: (t: string) => t.length };

// Fix round 1 (review of PR #518): the owner-mode hardening items, each with the case that failed.

describe("P2-3 the summarizer is handed the user's words TAINTED", () => {
  it("every user message and the previous summary reach the summarizer as tainted content", async () => {
    const seen: { role: string; content: unknown }[][] = [];
    const b = boot({
      config: {
        budget: {
          contextWindow: 300,
          reserveOutputTokens: 0,
          counter: perChar,
          summarizerToolId: "audit-summarize",
        },
      },
      reply: () => ({ content: "r".repeat(60), stopReason: "end_turn" }),
      extraEffects: (e) =>
        e.register(
          "audit-summarize",
          new ToolEffect(async (input: unknown) => {
            seen.push((input as { messages: { role: string; content: unknown }[] }).messages);
            return { summary: "a short summary" };
          })
        ),
    });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 7; i++) {
      await b.conv.sendTurn(id, `question-${i}-${"q".repeat(40)}`);
      await messages(b, id, i * 2);
    }
    expect(seen.length).toBeGreaterThan(1);
    for (const call of seen) {
      for (const m of call) {
        if (m.role === "user") expect(isTainted(m.content)).toBe(true);
        else expect(typeof m.content).toBe("string"); // the model's own words stay plain
      }
    }
    // the SECOND call carries the first summary, as tainted model-over-untrusted content
    expect(seen[1]?.[0]).toMatchObject({ role: "user" });
    expect(isTainted(seen[1]?.[0]?.content)).toBe(true);
  });
});

describe("P3-1 a summary can never wedge the conversation", () => {
  it("an oversize summary injected through the carry is dropped by the fit instead of making every turn too large", async () => {
    const b = boot({ config: { budget: { contextWindow: 300, reserveOutputTokens: 0 } } });
    await b.runtime.start(
      b.flow as never,
      { v: 1, seq: 0, ord: 0, turns: [], summary: "enormous ".repeat(1500) } as never,
      { executionId: "wedge" }
    );
    await b.conv.sendTurn("wedge", "still alive?");
    const all = await messages(b, "wedge", 2);
    expect(all[0]).toMatchObject({ role: "user", status: "complete" });
    expect(all[1]).toMatchObject({ role: "assistant", status: "complete" });
    expect(JSON.stringify(b.requests[0])).not.toContain("enormous");
  });

  it("a summarizer that returns far too much is cut to maxSummaryTokens by a recorded decision", async () => {
    const b = boot({
      config: {
        budget: {
          contextWindow: 400,
          reserveOutputTokens: 0,
          counter: perChar,
          summarizerToolId: "huge",
          maxSummaryTokens: 40,
        },
      },
      reply: () => ({ content: "r".repeat(60), stopReason: "end_turn" }),
      extraEffects: (e) =>
        e.register("huge", new ToolEffect(async () => ({ summary: "verbose ".repeat(500) }))),
    });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 8; i++) {
      await b.conv.sendTurn(id, `question ${i} ${"q".repeat(60)}`);
      await messages(b, id, i * 2);
    }
    const entries = (await b.conv.history(id, { limit: 100 })).entries;
    expect(entries.filter((e) => e.status === "rejected")).toEqual([]); // never wedged
    const last = JSON.stringify(b.requests.at(-1)?.messages);
    const summaryChars = (last.match(/verbose /g) ?? []).length * 8;
    expect(summaryChars).toBeGreaterThan(0);
    expect(summaryChars).toBeLessThan(40 * 2); // 40 tokens (1 per char here), not 500 words
  });
});

describe("P3-9 roles alternate, whatever a turn left behind", () => {
  it("an interrupted turn with no partial does not leave two user messages in a row", async () => {
    const started = new Latch();
    const roles: string[][] = [];
    const b = boot({
      reply: async (req, nth) => {
        roles.push(req.messages.map((m) => m.role));
        // a provider that REJECTS consecutive same-role messages
        for (let i = 1; i < req.messages.length; i++) {
          if (req.messages[i]?.role === req.messages[i - 1]?.role)
            throw new Error("roles must alternate");
        }
        if (nth === 1) {
          started.release();
          await new Promise<never>((_, rej) =>
            req.signal?.addEventListener("abort", () => rej(new Error("aborted")))
          );
        }
        return { content: `re: ${lastUserText(req)}`, stopReason: "end_turn" };
      },
    });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "long");
    await started.promise;
    await b.conv.sendTurn(id, "short");
    const all = await messages(b, id, 4);
    expect(all[1]).toMatchObject({ status: "interrupted", text: "" });
    expect(all[3]).toMatchObject({ status: "complete", text: "re: short" });
    expect(roles.at(-1)).toEqual(["user", "assistant", "user"]);
  });

  it("a failed turn, and a summary, also keep roles alternating", async () => {
    const b = boot({
      config: {
        budget: {
          contextWindow: 300,
          reserveOutputTokens: 0,
          counter: perChar,
          summarizerToolId: "summarize",
        },
      },
      reply: (req, nth) => {
        for (let i = 1; i < req.messages.length; i++) {
          if (req.messages[i]?.role === req.messages[i - 1]?.role)
            throw new Error("roles must alternate");
        }
        if (nth === 1) throw new Error("boom");
        return { content: "r".repeat(60), stopReason: "end_turn" };
      },
    });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 7; i++) {
      await b.conv.sendTurn(id, `question ${i} ${"q".repeat(40)}`);
      await messages(b, id, i * 2);
    }
    const all = (await b.conv.history(id, { limit: 100 })).entries;
    expect(all[1]).toMatchObject({ status: "failed" });
    expect(
      all
        .filter((e) => e.role === "assistant")
        .slice(1)
        .every((e) => e.status === "complete")
    ).toBe(true);
    expect(JSON.stringify(b.requests.at(-1)?.messages)).toContain(
      "Summary of the earlier conversation"
    );
  });
});

describe("P3-10 the start input is read as untrusted JSON", () => {
  it("garbage, wrong shapes and oversized windows are bounded, not trusted", async () => {
    const b = boot({ config: { maxWindowTurns: 3, maxTurnChars: 50, maxReplyChars: 50 } });
    const turn = (n: number) => ({
      n,
      user: "u".repeat(5000),
      assistant: "a".repeat(5000),
      status: "complete",
    });
    await b.runtime.start(
      b.flow as never,
      {
        v: 1,
        seq: -4,
        ord: "nope",
        summary: 42,
        ids: [1, "ok", { x: 1 }],
        turns: [
          turn(1),
          turn(2),
          turn(3),
          turn(4),
          turn(5),
          null,
          "str",
          { user: 1 },
          { user: "x", status: "weird" },
        ],
      } as never,
      { executionId: "junk" }
    );
    await b.conv.sendTurn("junk", "hello");
    const all = await messages(b, "junk", 2);
    expect(all[0]).toMatchObject({ turn: 1 }); // seq -4 became 0
    // only the last 3 valid turns were kept, each clipped
    const ctx = JSON.stringify(b.requests[0]?.messages);
    expect((ctx.match(/u{10,}/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(Math.max(...(ctx.match(/u+/g) ?? [""]).map((m) => m.length))).toBeLessThanOrEqual(60);
  });
});

describe("P3-8 a retry is the SAME sender's same id, not anyone's", () => {
  const known = (id: string) => id === senderKey({ tenant: "t1", actor: "alice" }, "m-1");
  const stored = (sender: { tenant?: string; actor?: string }, payloadId: string) => ({
    topic: "conversation:turn",
    messageId: "m-1",
    sender,
    payload: { kind: "user", text: "x", id: payloadId },
  });
  it("the sender's own retry is known; another sender replaying the id (or forging the payload id) is NEW", () => {
    const aliceId = senderKey({ tenant: "t1", actor: "alice" }, "m-1");
    expect(isNew(stored({ tenant: "t1", actor: "alice" }, aliceId), { isKnown: known })).toBe(
      false
    );
    // eve sends the same messageId and copies alice's payload id: the id does not match HER dedupe identity
    expect(isNew(stored({ tenant: "t1", actor: "eve" }, aliceId), { isKnown: known })).toBe(true);
    // a payload id that was never the kernel's identity for this message is ignored
    expect(
      isNew(stored({ tenant: "t1", actor: "alice" }, "made-up"), { isKnown: () => true })
    ).toBe(true);
    // a different topic never interrupts
    expect(isNew({ ...stored({}, aliceId), topic: "other" }, { isKnown: () => false })).toBe(false);
  });
});

describe("P3-7 the barge-in peek finds the consumed cursor however long the turn's log is", () => {
  it("a message waiting behind 300 events of the owner's tail is still seen", async () => {
    const b = boot();
    const hold = new Latch();
    b.effects.register(
      "hold",
      new ToolEffect(async () => {
        await hold.promise;
        return { ok: true };
      })
    );
    const def = flow$({
      id: "noisy",
      name: "noisy",
      version: "1.0.0",
      inputSchema: z.any(),
      outputSchema: z.any(),
      steps: [],
    });
    b.runtime.registerFlow(def, async (ctx) => {
      await ctx.receive("conversation:turn");
      for (let i = 0; i < 300; i++) ctx.emit("noise", { i });
      await ctx.execute({ _tag: "TaskDefinition", kind: "tool", id: "hold", toolId: "hold" }, {});
      return "done";
    });
    const run = await b.runtime.start(def, {}, { executionId: "noisy-1" });
    await run.waitForSuspend();
    await b.runtime.send("noisy-1", {
      topic: "conversation:turn",
      payload: { kind: "user", text: "first" },
    });
    await until(
      async () =>
        (await b.eventStore.read("noisy-1")).filter((e) => e.eventType === "noise").length === 300
    );
    await b.runtime.send("noisy-1", {
      topic: "conversation:turn",
      payload: { kind: "user", text: "second" },
    });
    // the old fixed 64-event lookback would not reach the MESSAGE_CONSUMED behind 300 emits
    expect(await pendingInbox(b.eventStore, "noisy-1", "noisy-1", { isKnown: () => false })).toBe(
      true
    );
    // NEGATIVE: with nothing waiting it says no
    const quiet = boot();
    const { conversationId: q } = await quiet.conv.start();
    await quiet.conv.sendTurn(q, "x");
    await messages(quiet, q, 2);
    expect(await pendingInbox(quiet.eventStore, q, q, { isKnown: () => false })).toBe(false);
    hold.release();
    void inboxBargeIn;
  });
});

describe("P3-10 carryOf", () => {
  const lim = { turns: 3, turnChars: 50, replyChars: 50, summaryChars: 100, bytes: 100_000 };
  it("validates shape, clips text, bounds counts and ids", () => {
    const turn = (n: number) => ({
      n,
      user: "u".repeat(500),
      assistant: "a".repeat(500),
      status: "complete",
    });
    const c = carryOf(
      {
        v: 1,
        seq: -1,
        ord: 1.5,
        summary: "s".repeat(500),
        ids: ["ok", 7, "x".repeat(300)],
        owner: { actor: "alice" },
        turns: [
          turn(1),
          turn(2),
          turn(3),
          turn(4),
          turn(5),
          null,
          { user: 1 },
          { user: "x", status: "weird" },
          { ...turn(6), classes: ["a", 3, "b"] },
        ],
      },
      lim
    );
    expect(c.seq).toBe(0);
    expect(c.ord).toBe(0);
    expect(c.summary).toHaveLength(101);
    expect(c.ids).toEqual(["ok"]);
    expect(c.turns.map((t) => t.n)).toEqual([4, 5, 6]);
    expect(c.turns.every((t) => t.user.length <= 51 && (t.assistant?.length ?? 0) <= 51)).toBe(
      true
    );
    expect(c.turns.at(-1)?.classes).toEqual(["a", "b"]);
  });
  it("trims to the byte cap, oldest first, and survives non-objects", () => {
    const big = Array.from({ length: 3 }, (_, n) => ({
      n,
      user: "u".repeat(50),
      assistant: "a".repeat(50),
      status: "complete",
    }));
    const c = carryOf({ v: 1, turns: big }, { ...lim, bytes: 200 });
    expect(c.turns.length).toBeLessThan(3);
    expect(carryOf("junk", lim)).toEqual({ v: 1, seq: 0, ord: 0, turns: [] });
    expect(carryOf({ v: 2 }, lim).turns).toEqual([]);
  });
});
