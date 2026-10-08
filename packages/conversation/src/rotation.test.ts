import { describe, expect, it } from "vitest";
import { Latch, boot, lastUserText, messages, until } from "./__fixtures__/harness";
import { findHeadGeneration } from "./index";

async function say(
  b: ReturnType<typeof boot>,
  id: string,
  text: string,
  n: number,
  opts?: { messageId?: string }
) {
  await b.conv.sendTurn(id, text, opts);
  await messages(b, id, n);
}

describe("rotation (continue-as-new)", () => {
  it("a long conversation rotates; history, status and the window survive the rotation", async () => {
    const b = boot({ config: { rotateEveryTurns: 2 } });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 7; i++) await say(b, id, `q${i}`, i * 2);

    const head = await findHeadGeneration(b.eventStore, id);
    expect(head).toBeGreaterThanOrEqual(2); // 7 turns at 2 per generation
    const st = await b.conv.status(id);
    expect(st).toMatchObject({ state: "open", turns: 7, generation: head });
    expect(st.executionId).toBe(`${id}~${head}`);

    // the whole transcript reads across generations, in order, with no gaps or repeats
    const page = await b.conv.history(id, { limit: 100 });
    expect(page.entries.map((m) => m.text)).toEqual(
      Array.from({ length: 7 }, (_, i) => [`q${i + 1}`, `re: q${i + 1}`]).flat()
    );
    expect(new Set(page.entries.map((m) => m.cursor)).size).toBe(14);
    expect(new Set(page.entries.map((m) => m.executionId)).size).toBe((head ?? 0) + 1);

    // the carried window: turn 7 (in a later generation) still sees turn 6
    const ctx = JSON.stringify(b.requests.at(-1)?.messages);
    expect(ctx).toContain("q6");
    expect(ctx).toContain("re: q6");
    // each generation's own log stays small (this is the point of rotating)
    const sizes = await Promise.all(
      Array.from(
        { length: (head ?? 0) + 1 },
        async (_, g) => (await b.eventStore.read(g === 0 ? id : `${id}~${g}`)).length
      )
    );
    expect(Math.max(...sizes)).toBeLessThan(40);
  });

  it("the dedupe window crosses the rotation: a retry after it is still delivered once", async () => {
    const b = boot({ config: { rotateEveryTurns: 1 } });
    const { conversationId: id } = await b.conv.start();
    await say(b, id, "one", 2, { messageId: "k-1" });
    await say(b, id, "two", 4, { messageId: "k-2" });
    await say(b, id, "three", 6, { messageId: "k-3" });
    expect(await findHeadGeneration(b.eventStore, id)).toBeGreaterThanOrEqual(2);
    const callsBefore = b.calls.n;
    await b.conv.sendTurn(id, "one", { messageId: "k-1" }); // a retry of a turn from generation 0
    await b.conv.sendTurn(id, "four", { messageId: "k-4" });
    await messages(b, id, 8);
    const users = (await b.conv.history(id, { limit: 100 })).entries.filter(
      (m) => m.role === "user"
    );
    expect(users.map((m) => m.text)).toEqual(["one", "two", "three", "four"]);
    expect(b.calls.n).toBe(callsBefore + 1);
  });

  it("an interrupting message is handled across a rotation boundary", async () => {
    const started = new Latch();
    const b = boot({
      config: { rotateEveryTurns: 1 },
      reply: async (req, nth) => {
        if (nth === 2) {
          started.release();
          await new Promise<never>((_, rej) =>
            req.signal?.addEventListener("abort", () => rej(new Error("aborted")))
          );
        }
        return { content: `re: ${lastUserText(req)}`, stopReason: "end_turn" };
      },
    });
    const { conversationId: id } = await b.conv.start();
    await say(b, id, "a", 2);
    await b.conv.sendTurn(id, "b-long");
    await started.promise;
    await b.conv.sendTurn(id, "c");
    const all = await messages(b, id, 6);
    expect(all.map((m) => [m.role, m.status, m.text])).toEqual([
      ["user", "complete", "a"],
      ["assistant", "complete", "re: a"],
      ["user", "complete", "b-long"],
      ["assistant", "interrupted", ""],
      ["user", "complete", "c"],
      ["assistant", "complete", "re: c"],
    ]);
    expect((await findHeadGeneration(b.eventStore, id)) ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("the carry is bounded: an oversized window is trimmed oldest-first at the rotation", async () => {
    const b = boot({
      config: { rotateEveryTurns: 3, maxCarryBytes: 2_000 },
      reply: (req) => ({ content: "x".repeat(900), stopReason: "end_turn" }),
    });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 4; i++) await say(b, id, `question ${i}`, i * 2);
    // generation 1 starts from a carry capped at 2 000 bytes: it cannot hold all of turns 1-3
    const first = (await b.eventStore.read(`${id}~1`))[0];
    const carry = (first?.payload as { input: { turns: unknown[] } }).input;
    expect(JSON.stringify(carry).length).toBeLessThanOrEqual(2_300);
    expect(carry.turns.length).toBeLessThan(3);
  });

  it("history pages walk generations in both directions with a stable cursor", async () => {
    const b = boot({ config: { rotateEveryTurns: 2 } });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 5; i++) await say(b, id, `q${i}`, i * 2);
    const fwd: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const p = await b.conv.history(id, { limit: 3, ...(cursor && { cursor }) });
      fwd.push(...p.entries.map((m) => m.text));
      if (p.done && p.entries.length === 0) break;
      cursor = p.nextCursor;
    }
    expect(fwd).toEqual(Array.from({ length: 5 }, (_, i) => [`q${i + 1}`, `re: q${i + 1}`]).flat());
    const back: string[] = [];
    cursor = undefined;
    for (let guard = 0; guard < 20; guard++) {
      const p = await b.conv.history(id, {
        limit: 4,
        direction: "backward",
        ...(cursor && { cursor }),
      });
      back.push(...p.entries.map((m) => m.text));
      if (p.done) break;
      cursor = p.nextCursor;
    }
    expect(back).toEqual([...fwd].reverse());
    await until(async () => (await b.conv.status(id)).running === false);
  });
});
