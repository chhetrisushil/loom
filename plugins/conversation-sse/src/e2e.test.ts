import { afterEach, describe, expect, it } from "vitest";
import { Latch, boot, get, lastUserText, openSse, post, until } from "./__fixtures__/harness";

// The whole feature at once, over real HTTP on loopback: a multi-turn conversation with a barge-in,
// rotation (continue-as-new), token budgeting and an SSE client that drops and resumes.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

describe("end to end: chat over SSE", () => {
  it("multi-turn + barge-in + rotation + budgeting + resume", async () => {
    const started = new Latch();
    const b = await boot({
      config: {
        rotateEveryTurns: 3,
        budget: { contextWindow: 400, reserveOutputTokens: 0, summarizerToolId: "summarize" },
      },
      chunks: async function* (req, nth) {
        const text = lastUserText(req);
        yield { delta: "thinking… ", done: false };
        if (text === "write me an epic") {
          started.release();
          await new Promise((_, rej) =>
            req.signal?.addEventListener("abort", () => rej(new Error("aborted")))
          );
        }
        yield { delta: `re ${nth}: ${text}`, done: false };
        yield { delta: "", done: true, stopReason: "end_turn" };
      },
    });
    cleanup.push(() => b.server.stop());
    const auth = { authorization: "Bearer tok-alice" };
    const id = (await post(`${b.url}/conversations`, "tok-alice", {})).body
      .conversationId as string;
    const send = (text: string, messageId?: string) =>
      post(`${b.url}/conversations/${id}/turns`, "tok-alice", {
        text,
        ...(messageId && { messageId }),
      });
    const done = (turns: number) =>
      until(async () => {
        const st = (await get(`${b.url}/conversations/${id}`, "tok-alice")).body;
        return st.turns === turns && st.running === false;
      }, `turn ${turns} to finish`);

    // A client follows the stream, drops mid-conversation, and resumes from the last id it saw.
    const c1 = await openSse(`${b.url}/conversations/${id}/events`, auth);
    cleanup.push(() => c1.close());
    await send("hello");
    await done(1);
    await send("write me an epic"); // turn 2: a long generation...
    await started.promise;
    await send("never mind, what is 2+2?"); // ...barged in on: turn 3
    await done(3);
    const lastSeen = c1.events.filter((e) => e.event === "message").at(-1)?.id as string;
    c1.close();

    // While it is away: more turns, a retry, enough to rotate and to overflow the token window.
    for (let i = 4; i <= 9; i++) {
      await send(`filler ${i} ${"padding ".repeat(25)}`, `m-${i}`);
      await send(`filler ${i} ${"padding ".repeat(25)}`, `m-${i}`); // a client retry: must not be a turn
      await done(i);
    }
    const st = (await get(`${b.url}/conversations/${id}`, "tok-alice")).body;
    expect(st.generation).toBeGreaterThanOrEqual(2); // rotated at least twice (3 turns per generation)

    const c2 = await openSse(`${b.url}/conversations/${id}/events`, {
      ...auth,
      "last-event-id": lastSeen,
    });
    cleanup.push(() => c2.close());
    await c2.waitFor(
      (e) =>
        e.event === "message" &&
        (e.data as { turn: number; role: string }).turn === 9 &&
        (e.data as { role: string }).role === "assistant"
    );
    const resumed = c2.events
      .filter((e) => e.event === "message")
      .map((e) => e.data as { turn: number; role: string; status: string });
    // exactly turns 4..9, each a user message then a reply: nothing repeated, nothing skipped
    expect(resumed.map((m) => `${m.turn}${m.role[0]}`)).toEqual(
      [4, 5, 6, 7, 8, 9].flatMap((t) => [`${t}u`, `${t}a`])
    );

    // The whole transcript, from the history API, across generations.
    const hist = (await get(`${b.url}/conversations/${id}/history?limit=100`, "tok-alice")).body
      .entries as {
      turn: number;
      role: string;
      status: string;
      text: string;
    }[];
    expect(hist.filter((m) => m.role === "user").map((m) => m.turn)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    const turn2 = hist.filter((m) => m.turn === 2);
    expect(turn2.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "interrupted"],
    ]);
    expect(turn2[1]?.text).toBe("thinking… "); // the partial of the interrupted epic was kept
    expect(hist.filter((m) => m.turn === 3).at(-1)).toMatchObject({
      role: "assistant",
      status: "complete",
    });

    // Budgeting held: no request ever exceeded the window, and the oldest turns were summarized away.
    for (const r of b.requests) expect(JSON.stringify(r).length).toBeLessThan(2_400);
    const last = JSON.stringify(b.requests.at(-1)?.messages);
    expect(last).toContain("Summary of the earlier conversation");
    expect(last).not.toContain("hello");
    // The retries were absorbed: 9 turns, 9 model calls (the interrupted epic included).
    expect(b.calls.n).toBe(9);

    // The stream the live client saw before it dropped is a prefix of the transcript.
    const before = c1.events
      .filter((e) => e.event === "message")
      .map((e) => (e.data as { text: string }).text);
    expect(before.slice(0, 2)).toEqual(["hello", "thinking… re 1: hello"]);
  });
});
