import { afterEach, describe, expect, it } from "vitest";
import {
  type Booted,
  Latch,
  type SseConn,
  boot,
  get,
  lastUserText,
  openSse,
  post,
  until,
} from "./__fixtures__/harness";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function up(opts: Parameters<typeof boot>[0] = {}): Promise<Booted> {
  const b = await boot(opts);
  cleanup.push(() => b.server.stop());
  return b;
}
const track = (c: SseConn): SseConn => {
  cleanup.push(() => c.close());
  return c;
};
async function startConv(b: Booted, token = "tok-alice"): Promise<string> {
  const r = await post(`${b.url}/conversations`, token, {});
  expect(r.status).toBe(201);
  return r.body.conversationId as string;
}
const texts = (c: SseConn) =>
  c.events.filter((e) => e.event === "message").map((e) => (e.data as { text: string }).text);

describe("gateway: the happy path", () => {
  it("start, send a turn, stream the user message and the reply with resumable ids", async () => {
    const b = await up();
    const id = await startConv(b);
    const sse = track(
      await openSse(`${b.url}/conversations/${id}/events`, { authorization: "Bearer tok-alice" })
    );
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    expect(sse.headers.get("cache-control")).toContain("no-cache");
    const sent = await post(`${b.url}/conversations/${id}/turns`, "tok-alice", {
      text: "hello",
      messageId: "m-1",
    });
    expect(sent.status).toBe(202);
    await sse.waitFor(
      (e) => e.event === "message" && (e.data as { role: string }).role === "assistant"
    );
    expect(sse.events[0]).toMatchObject({ event: "status", data: { state: "open", turns: 0 } });
    expect(texts(sse)).toEqual(["hello", "re: hello"]);
    // every durable message carries a cursor as its SSE id; deltas and status have none
    for (const e of sse.events) {
      if (e.event === "message") expect(e.id).toMatch(/^\d+\.\d+$/);
      else expect(e.id).toBeUndefined();
    }
    const hist = await get(`${b.url}/conversations/${id}/history`, "tok-alice");
    expect(hist.body.entries.map((m: { text: string }) => m.text)).toEqual(["hello", "re: hello"]);
    const st = await get(`${b.url}/conversations/${id}`, "tok-alice");
    expect(st.body).toMatchObject({ state: "open", turns: 1 });
    // a retry with the same messageId is accepted and delivered once
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", {
      text: "hello",
      messageId: "m-1",
    });
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", {
      text: "again",
      messageId: "m-2",
    });
    await sse.waitFor((e) => (e.data as { text?: string }).text === "re: again");
    expect(texts(sse)).toEqual(["hello", "re: hello", "again", "re: again"]);
    // close ends the stream with a `closed` event
    expect((await post(`${b.url}/conversations/${id}/close`, "tok-alice", {})).status).toBe(202);
    await sse.waitFor((e) => e.event === "closed");
    await sse.ended;
  });

  it("streams the live reply deltas, then the durable reply supersedes them", async () => {
    const gate = new Latch();
    const b = await up({
      chunks: async function* (req) {
        yield { delta: "Hel", done: false };
        yield { delta: "lo ", done: false };
        await gate.promise;
        yield { delta: lastUserText(req), done: false };
        yield { delta: "", done: true, stopReason: "end_turn" };
      },
    });
    const id = await startConv(b);
    const sse = track(
      await openSse(`${b.url}/conversations/${id}/events`, { authorization: "Bearer tok-alice" })
    );
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "world" });
    await sse.waitFor((e) => e.event === "delta" && (e.data as { text: string }).text === "lo ");
    gate.release();
    await sse.waitFor(
      (e) => e.event === "message" && (e.data as { role: string }).role === "assistant"
    );
    const deltas = sse.events
      .filter((e) => e.event === "delta")
      .map((e) => (e.data as { text: string }).text);
    expect(deltas.join("")).toBe("Hello world");
    expect(texts(sse).at(-1)).toBe("Hello world");
  });

  it("a client that attaches mid-reply is caught up with the partial text so far", async () => {
    const gate = new Latch();
    const b = await up({
      chunks: async function* () {
        yield { delta: "so far ", done: false };
        await gate.promise;
        yield { delta: "and the rest", done: false };
        yield { delta: "", done: true, stopReason: "end_turn" };
      },
    });
    const id = await startConv(b);
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "go" });
    await until(() => b.hub.partialOf(id)?.text === "so far ", "the partial");
    const late = track(
      await openSse(`${b.url}/conversations/${id}/events`, { authorization: "Bearer tok-alice" })
    );
    const partial = await late.waitFor((e) => e.event === "partial");
    expect(partial.data).toEqual({ turn: 1, text: "so far " });
    gate.release();
    await late.waitFor(
      (e) => e.event === "message" && (e.data as { role: string }).role === "assistant"
    );
    expect(texts(late).at(-1)).toBe("so far and the rest");
  });

  it("barge-in over HTTP: the second POST interrupts the running turn and the stream shows it", async () => {
    const started = new Latch();
    const b = await up({
      chunks: async function* (req, nth) {
        yield { delta: "thinking ", done: false };
        if (nth === 1) {
          started.release();
          await new Promise((_, rej) =>
            req.signal?.addEventListener("abort", () => rej(new Error("aborted")))
          );
        }
        yield { delta: `re: ${lastUserText(req)}`, done: false };
        yield { delta: "", done: true, stopReason: "end_turn" };
      },
    });
    const id = await startConv(b);
    const sse = track(
      await openSse(`${b.url}/conversations/${id}/events`, { authorization: "Bearer tok-alice" })
    );
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "long story" });
    await started.promise;
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "stop" });
    await sse.waitFor((e) => (e.data as { text?: string }).text === "thinking re: stop");
    const msgs = sse.events
      .filter((e) => e.event === "message")
      .map((e) => e.data as { role: string; status: string; text: string });
    expect(msgs.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "interrupted"],
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(msgs[1]?.text).toBe("thinking "); // the partial survived
  });
});

describe("gateway: resume from Last-Event-ID", () => {
  it("reconnecting with the last id delivers exactly the messages after it", async () => {
    const b = await up({ config: { rotateEveryTurns: 2 } });
    const id = await startConv(b);
    const first = track(
      await openSse(`${b.url}/conversations/${id}/events`, { authorization: "Bearer tok-alice" })
    );
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "one" });
    await first.waitFor((e) => (e.data as { text?: string }).text === "re: one");
    const lastId = first.events.filter((e) => e.event === "message").at(-1)?.id as string;
    first.close(); // the connection drops
    // the conversation moves on (and rotates) while the client is away
    for (const t of ["two", "three", "four"]) {
      await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: t });
      await until(
        async () => (await get(`${b.url}/conversations/${id}`, "tok-alice")).body.running === false
      );
    }
    expect(
      (await get(`${b.url}/conversations/${id}`, "tok-alice")).body.generation
    ).toBeGreaterThan(0);
    const again = track(
      await openSse(`${b.url}/conversations/${id}/events`, {
        authorization: "Bearer tok-alice",
        "last-event-id": lastId,
      })
    );
    await again.waitFor((e) => (e.data as { text?: string }).text === "re: four");
    expect(texts(again)).toEqual(["two", "re: two", "three", "re: three", "four", "re: four"]);
    // the query-string form is equivalent (EventSource cannot set headers on a manual reconnect)
    const viaQuery = track(
      await openSse(`${b.url}/conversations/${id}/events?cursor=${lastId}`, {
        authorization: "Bearer tok-alice",
      })
    );
    await viaQuery.waitFor((e) => (e.data as { text?: string }).text === "re: four");
    expect(texts(viaQuery)).toEqual(texts(again));
    // NEGATIVE: with no cursor the whole transcript replays
    const full = track(
      await openSse(`${b.url}/conversations/${id}/events`, { authorization: "Bearer tok-alice" })
    );
    await full.waitFor((e) => (e.data as { text?: string }).text === "re: four");
    expect(texts(full)).toHaveLength(8);
  });

  it("a malformed Last-Event-ID is a 400, never a silent restart", async () => {
    const b = await up();
    const id = await startConv(b);
    for (const bad of ["abc", "1.x", "../etc", "-1.0"]) {
      const c = await openSse(`${b.url}/conversations/${id}/events`, {
        authorization: "Bearer tok-alice",
        "last-event-id": bad,
      });
      expect(c.status).toBe(400);
    }
  });
});

describe("gateway: record ord and editOf (R17 follow-up)", () => {
  it("frames and history carry a unique ord; a signed editOf round-trips; a bad editOf is a 400", async () => {
    const b = await up();
    const id = await startConv(b);
    const sse = track(
      await openSse(`${b.url}/conversations/${id}/events`, { authorization: "Bearer tok-alice" })
    );
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "first" });
    await sse.waitFor((e) => (e.data as { text?: string }).text === "re: first");
    const hist = await get(`${b.url}/conversations/${id}/history`, "tok-alice");
    const firstOrd = hist.body.entries[0].ord as number;
    expect(hist.body.entries.map((m: { ord: number }) => m.ord)).toEqual([1, 2]);
    for (const bad of [0, -1, 1.5, "1", null]) {
      const r = await post(`${b.url}/conversations/${id}/turns`, "tok-alice", {
        text: "x",
        editOf: bad,
      });
      expect(r.status).toBe(400);
    }
    expect(
      (
        await post(`${b.url}/conversations/${id}/turns`, "tok-alice", {
          text: "second",
          editOf: firstOrd,
        })
      ).status
    ).toBe(202);
    await sse.waitFor(
      (e) =>
        e.event === "message" &&
        (e.data as { role: string; turn: number }).role === "assistant" &&
        (e.data as { turn: number }).turn === 2
    );
    const msgs = sse.events
      .filter((e) => e.event === "message")
      .map((e) => e.data as Record<string, unknown>);
    expect(msgs.map((m) => m.ord)).toEqual([1, 2, 3, 4]);
    expect(msgs[2]).toMatchObject({ text: "second", editOf: firstOrd, turn: 2 });
    expect(msgs[0]?.editOf).toBeUndefined();
  });
});
