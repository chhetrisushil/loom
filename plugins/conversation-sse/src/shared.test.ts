import type { LlmStreamChunk } from "@loom/llm";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Booted,
  Latch,
  SECRET,
  type SseConn,
  boot,
  get,
  lastUserText,
  openSse,
  post,
  sharedScript,
} from "./__fixtures__/harness";

// SHARED MODE over HTTP (ADR 0122 D10): participants, per-asker turns, per-viewer filtering of history,
// the stream and the live deltas.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function up(opts: Parameters<typeof boot>[0] = {}): Promise<Booted> {
  const b = await boot({ shared: true, ...opts });
  cleanup.push(() => b.server.stop());
  return b;
}
const track = (c: SseConn): SseConn => {
  cleanup.push(() => c.close());
  return c;
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** alice (t1) owns it; bob (t2) and dave (t3) are participants; carol (t1, alice's tenant) is NOT. */
async function room(b: Booted): Promise<string> {
  const id = (await post(`${b.url}/conversations`, "tok-alice", {})).body.conversationId as string;
  expect(
    (
      await post(`${b.url}/conversations/${id}/participants`, "tok-alice", {
        actor: "bob",
        tenant: "t2",
      })
    ).status
  ).toBe(202);
  expect(
    (
      await post(`${b.url}/conversations/${id}/participants`, "tok-alice", {
        actor: "dave",
        tenant: "t3",
      })
    ).status
  ).toBe(202);
  return id;
}
const say = (b: Booted, id: string, token: string, text: string) =>
  post(`${b.url}/conversations/${id}/turns`, token, { text });
const answered = (turn: number) => (e: { event: string; data: unknown }) =>
  e.event === "message" &&
  (e.data as { turn: number; role: string }).turn === turn &&
  (e.data as { role: string }).role === "assistant";

describe("participants over HTTP", () => {
  it("a non-participant is the same 404 on every route and the stream, even in the owner's own tenant", async () => {
    const b = await up();
    const id = await room(b);
    const unknown = await get(`${b.url}/conversations/conv-nope`, "tok-carol");
    for (const r of [
      await get(`${b.url}/conversations/${id}`, "tok-carol"),
      await get(`${b.url}/conversations/${id}/history`, "tok-carol"),
      await get(`${b.url}/conversations/${id}/participants`, "tok-carol"),
      await say(b, id, "tok-carol", "let me in"),
      await post(`${b.url}/conversations/${id}/close`, "tok-carol", {}),
      await post(`${b.url}/conversations/${id}/participants`, "tok-carol", {
        actor: "carol",
        tenant: "t1",
      }),
    ]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(unknown.body);
    }
    expect((await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-carol"))).status).toBe(
      404
    );
    expect(b.calls.n).toBe(0);
  });

  it("only the owner (or a host-named manager) manages; a participant may converse but not manage or close", async () => {
    const b = await up();
    const id = await room(b);
    expect(
      (
        await post(`${b.url}/conversations/${id}/participants`, "tok-bob", {
          actor: "carol",
          tenant: "t1",
        })
      ).status
    ).toBe(404);
    expect(
      (
        await post(`${b.url}/conversations/${id}/participants/remove`, "tok-bob", {
          actor: "dave",
          tenant: "t3",
        })
      ).status
    ).toBe(404);
    expect((await post(`${b.url}/conversations/${id}/close`, "tok-bob", {})).status).toBe(404);
    expect(
      (await get(`${b.url}/conversations/${id}/participants`, "tok-alice")).body.participants
    ).toHaveLength(2);
    expect((await say(b, id, "tok-bob", "hello")).status).toBe(202);
  });

  it("removing a participant ends their open stream at the next re-authorization, and locks them out at once", async () => {
    const b = await up({ server: { reauthMs: 20 } });
    const id = await room(b);
    const s = await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-bob"));
    expect(s.status).toBe(200);
    expect(
      (
        await post(`${b.url}/conversations/${id}/participants/remove`, "tok-alice", {
          actor: "bob",
          tenant: "t2",
        })
      ).status
    ).toBe(202);
    expect((await get(`${b.url}/conversations/${id}/history`, "tok-bob")).status).toBe(404); // next request
    await s.waitFor((e) => e.event === "error");
    await s.ended;
  });
});

describe("per-viewer filtering of history and the stream", () => {
  it("a restricted answer reaches the cleared viewers and reaches the others as a bare placeholder, in history AND on the wire", async () => {
    const b = await up();
    const id = await room(b);
    const bobStream = track(
      await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-bob"))
    );
    const daveStream = track(
      await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-dave"))
    );
    await say(b, id, "tok-alice", "use the secret db");
    await bobStream.waitFor(answered(1));
    await daveStream.waitFor(answered(1));
    const wire = (c: SseConn) => JSON.stringify(c.events);
    expect(wire(bobStream)).not.toContain(SECRET);
    expect(wire(bobStream)).not.toMatch(/secret-db|classes|turn:/);
    const bobReply = bobStream.events.find(answered(1))?.data as {
      status: string;
      text: string;
      asker: { actor: string };
    };
    expect(bobReply).toMatchObject({ status: "restricted", text: "", asker: { actor: "alice" } });
    expect(wire(daveStream)).toContain(SECRET);
    const hist = (u: string) => get(`${b.url}/conversations/${id}/history`, u);
    expect(JSON.stringify((await hist("tok-bob")).body)).not.toContain(SECRET);
    expect(JSON.stringify((await hist("tok-dave")).body)).toContain(SECRET);
    expect(JSON.stringify((await hist("tok-alice")).body)).toContain(SECRET);
    // resuming bob's stream from the log is filtered the same way
    const resumed = track(
      await openSse(`${b.url}/conversations/${id}/events`, {
        ...bearer("tok-bob"),
        "last-event-id": "0.0",
      })
    );
    await resumed.waitFor(answered(1));
    expect(JSON.stringify(resumed.events)).not.toContain(SECRET);
  });

  it("a participant who lacks the grant sees the denial as THEIR failed turn, and the others see only that it failed", async () => {
    const b = await up();
    const id = await room(b);
    const dave = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-dave")));
    await say(b, id, "tok-bob", "use the secret db"); // bob has no secret-db grant
    const reply = await dave.waitFor(answered(1));
    expect(reply.data).toMatchObject({
      status: "failed",
      reason: "denied",
      asker: { actor: "bob" },
    });
    expect(JSON.stringify(dave.events)).not.toContain(SECRET);
    expect((reply.data as { errorId?: string }).errorId).toBeDefined();
  });
});

describe("live deltas are the ASKER's until the turn is classified", () => {
  it("only the asker receives tokens (and the catch-up partial); everyone else gets the entry on completion", async () => {
    const gate = new Latch();
    const midway = new Latch();
    const b = await up({
      chunks: async function* (req): AsyncGenerator<LlmStreamChunk> {
        const r = sharedScript(req);
        if (r.toolCalls !== undefined) {
          yield { delta: "", done: true, toolCalls: r.toolCalls, stopReason: "tool_use" };
          return;
        }
        yield { delta: "live-token-one ", done: false };
        midway.release();
        await gate.promise;
        yield { delta: lastUserText(req), done: false };
        yield { delta: "", done: true, stopReason: "end_turn" };
      },
    });
    const id = await room(b);
    const aliceS = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice")));
    const bobS = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-bob")));
    await say(b, id, "tok-alice", "tell me a story");
    await midway.promise;
    await aliceS.waitFor((e) => e.event === "delta");
    // a viewer who joins MID-reply is caught up only if it is their own turn
    const lateBob = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-bob")));
    const lateAlice = track(
      await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice"))
    );
    await lateAlice.waitFor((e) => e.event === "partial");
    gate.release();
    await aliceS.waitFor(answered(1));
    await bobS.waitFor(answered(1));
    await lateBob.waitFor(answered(1));
    for (const c of [bobS, lateBob]) {
      expect(
        c.events.filter((e) => e.event === "delta" || e.event === "partial" || e.event === "reset")
      ).toEqual([]);
    }
    // ...but the completed (unrestricted) answer is shown to bob in full
    expect(bobS.events.find(answered(1))?.data).toMatchObject({ status: "complete" });
    expect((bobS.events.find(answered(1))?.data as { text: string }).text).toContain(
      "tell me a story"
    );
    expect(aliceS.events.some((e) => e.event === "delta")).toBe(true);
  });
});

describe("round 2: the gateway", () => {
  it("refuses a runtime whose policy lets a tenant peer query or send (the transcript would be readable around the filter)", async () => {
    const { executionAccessPolicy } = await import("@loom/workflow-runtime");
    await expect(
      boot({
        shared: true,
        policy: executionAccessPolicy(),
        conversations: { policy: executionAccessPolicy() },
      })
    ).rejects.toThrow(/"query" as "tenant"/);
    await expect(
      boot({
        shared: true,
        policy: executionAccessPolicy({
          rules: { query: "owner", send: "owner", cancel: "owner", resume: "owner" },
        }),
        ackPolicy: false,
      })
    ).rejects.toThrow(/owner-scoped/);
  });

  it("membership is judged for EVERY delivered message: a participant removed a moment ago is not handed the next entry", async () => {
    const b = await up({ server: { reauthMs: 3_600_000 } }); // the periodic re-authorization will not rescue this
    const id = await room(b);
    const bobS = await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-bob"));
    expect(bobS.status).toBe(200);
    expect(
      (
        await post(`${b.url}/conversations/${id}/participants/remove`, "tok-alice", {
          actor: "bob",
          tenant: "t2",
        })
      ).status
    ).toBe(202);
    await say(b, id, "tok-alice", "something bob must not see");
    await bobS.waitFor((e) => e.event === "error");
    await bobS.ended;
    expect(JSON.stringify(bobS.events)).not.toContain("something bob must not see");
  });

  it("a participant who floods the queue is refused with 429; the others are not", async () => {
    const gate = new Latch();
    const started = new Latch();
    const b = await up({
      conversations: { maxQueuedPerAsker: 1 },
      reply: async (req) => {
        if (lastUserText(req) === "hold") {
          started.release();
          await gate.promise;
        }
        return sharedScript(req);
      },
    });
    const id = await room(b);
    await say(b, id, "tok-alice", "hold");
    await started.promise;
    expect((await say(b, id, "tok-bob", "one")).status).toBe(202);
    expect((await say(b, id, "tok-bob", "two")).status).toBe(429);
    expect((await say(b, id, "tok-dave", "mine")).status).toBe(202);
    gate.release();
  });
});
