import { executionAccessPolicy } from "@loom/workflow-runtime";
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
import { createConversationSseServer } from "./index";

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
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function startConv(b: Booted, token = "tok-alice"): Promise<string> {
  return (await post(`${b.url}/conversations`, token, {})).body.conversationId as string;
}
const logSize = async (b: Booted, id: string) =>
  (await b.eventStore.read(id)).length + (await b.eventStore.read(`__loom_inbox__:${id}`)).length;

describe("authentication: fail closed", () => {
  it("every route refuses an unauthenticated or unrecognised caller with 401", async () => {
    const b = await up();
    const id = await startConv(b);
    const before = await logSize(b, id);
    for (const token of [undefined, "nope", ""]) {
      expect((await post(`${b.url}/conversations`, token, {})).status).toBe(401);
      expect((await get(`${b.url}/conversations/${id}`, token)).status).toBe(401);
      expect((await get(`${b.url}/conversations/${id}/history`, token)).status).toBe(401);
      expect((await post(`${b.url}/conversations/${id}/turns`, token, { text: "x" })).status).toBe(
        401
      );
      expect((await post(`${b.url}/conversations/${id}/close`, token, {})).status).toBe(401);
      expect(
        (await openSse(`${b.url}/conversations/${id}/events`, token ? bearer(token) : {})).status
      ).toBe(401);
    }
    expect(await logSize(b, id)).toBe(before);
    expect(b.calls.n).toBe(0);
  });

  it("a principal with no actor is refused (a per-caller identity is the minimum)", async () => {
    const b = await up({ tokens: { anon: { tenant: "t1" } as never } });
    expect((await post(`${b.url}/conversations`, "anon", {})).status).toBe(401);
  });

  it("the server refuses to be created without authenticate, unless insecure is explicit (and then warns; never on a strict runtime)", async () => {
    const open = await up({ openRuntime: true, server: { allowNoRuntimeAuthz: true } });
    const base = { conversations: open.conversations, hub: open.hub, eventStore: open.eventStore };
    expect(() => createConversationSseServer({ ...base, allowNoRuntimeAuthz: true })).toThrow(
      /unauthenticated/
    );
    const warnings: string[] = [];
    expect(() =>
      createConversationSseServer({ ...base, insecure: true, warn: (m) => warnings.push(m) })
    ).not.toThrow();
    expect(warnings.join()).toMatch(/NO authentication/);
    expect(() => createConversationSseServer({ ...base, insecure: true, strict: true })).toThrow(
      /strict/
    );
    // P3-2: `strict` defaults from the runtime, as the A2A server does: insecure on a strict runtime is refused
    const strictRt = await up();
    expect(() =>
      createConversationSseServer({
        conversations: strictRt.conversations,
        hub: strictRt.hub,
        eventStore: strictRt.eventStore,
        insecure: true,
      })
    ).toThrow(/strict/);
  });

  it("P3-3: refuses to front a runtime with no fail-closed execution authorizer, unless that is explicit", async () => {
    const open = await up({ openRuntime: true, server: { allowNoRuntimeAuthz: true } });
    const base = {
      conversations: open.conversations,
      hub: open.hub,
      eventStore: open.eventStore,
      authenticate: () => ({ actor: "x" }),
    };
    expect(() => createConversationSseServer(base)).toThrow(/no fail-closed execution authorizer/);
    expect(() => createConversationSseServer({ ...base, allowNoRuntimeAuthz: true })).not.toThrow();
  });

  it("binds loopback by default", async () => {
    const b = await up();
    expect(b.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("authorization and isolation", () => {
  it("another tenant can neither read, send, close nor stream; every refusal is the same 404; nothing is written", async () => {
    const b = await up();
    const id = await startConv(b); // alice (t1)
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "private" });
    await until(
      async () => (await get(`${b.url}/conversations/${id}`, "tok-alice")).body.running === false
    );
    const before = await logSize(b, id);
    const calls = b.calls.n;

    const attempts = [
      get(`${b.url}/conversations/${id}`, "tok-bob"),
      get(`${b.url}/conversations/${id}/history`, "tok-bob"),
      post(`${b.url}/conversations/${id}/turns`, "tok-bob", { text: "pwned" }),
      post(`${b.url}/conversations/${id}/close`, "tok-bob", {}),
    ];
    const unknown = await get(`${b.url}/conversations/conv-does-not-exist`, "tok-bob");
    for (const r of await Promise.all(attempts)) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(unknown.body); // indistinguishable from "no such conversation"
    }
    const stream = await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-bob"));
    expect(stream.status).toBe(404);
    expect(await logSize(b, id)).toBe(before);
    expect(b.calls.n).toBe(calls);
    // and the owner is unaffected
    expect(
      (await get(`${b.url}/conversations/${id}/history`, "tok-alice")).body.entries
    ).toHaveLength(2);
  });

  it("two tenants stream concurrently and each sees only its own conversation (messages AND deltas)", async () => {
    const gate = new Latch();
    const b = await up({
      chunks: async function* (req) {
        const t = lastUserText(req);
        yield { delta: `${t}:a `, done: false };
        await gate.promise;
        yield { delta: `${t}:b`, done: false };
        yield { delta: "", done: true, stopReason: "end_turn" };
      },
    });
    const a = await startConv(b, "tok-alice");
    const c = await startConv(b, "tok-bob");
    const sa = track(await openSse(`${b.url}/conversations/${a}/events`, bearer("tok-alice")));
    const sb = track(await openSse(`${b.url}/conversations/${c}/events`, bearer("tok-bob")));
    await post(`${b.url}/conversations/${a}/turns`, "tok-alice", { text: "ALPHA" });
    await post(`${b.url}/conversations/${c}/turns`, "tok-bob", { text: "BRAVO" });
    await until(
      () => sa.events.some((e) => e.event === "delta") && sb.events.some((e) => e.event === "delta")
    );
    gate.release();
    await sa.waitFor(
      (e) => e.event === "message" && (e.data as { role: string }).role === "assistant"
    );
    await sb.waitFor(
      (e) => e.event === "message" && (e.data as { role: string }).role === "assistant"
    );
    const all = (s: SseConn) => JSON.stringify(s.events);
    expect(all(sa)).toContain("ALPHA");
    expect(all(sa)).not.toContain("BRAVO");
    expect(all(sb)).toContain("BRAVO");
    expect(all(sb)).not.toContain("ALPHA");
  });

  it("a cursor taken from another conversation cannot be used to read it", async () => {
    const b = await up();
    const a = await startConv(b, "tok-alice");
    const c = await startConv(b, "tok-bob");
    await post(`${b.url}/conversations/${a}/turns`, "tok-alice", { text: "alice secret" });
    await until(
      async () => (await get(`${b.url}/conversations/${a}`, "tok-alice")).body.turns === 1
    );
    const aliceCursor = (await get(`${b.url}/conversations/${a}/history`, "tok-alice")).body
      .entries[0].cursor as string;
    // bob presents alice's cursor on HIS conversation: it is a position in HIS chain
    const h = await get(`${b.url}/conversations/${c}/history?cursor=${aliceCursor}`, "tok-bob");
    expect(h.status).toBe(200);
    expect(JSON.stringify(h.body)).not.toContain("alice secret");
    // and on alice's conversation it still hits the authorization wall
    expect(
      (await get(`${b.url}/conversations/${a}/history?cursor=${aliceCursor}`, "tok-bob")).status
    ).toBe(404);
  });

  it("sending to or closing an unknown conversation is the same 404 a stranger gets, never a 500", async () => {
    const b = await up();
    const id = await startConv(b);
    const strangerOnReal = await post(`${b.url}/conversations/${id}/turns`, "tok-bob", {
      text: "x",
    });
    const unknown = await post(`${b.url}/conversations/conv-nope/turns`, "tok-alice", {
      text: "x",
    });
    const unknownClose = await post(`${b.url}/conversations/conv-nope/close`, "tok-alice", {});
    expect(unknown.status).toBe(404);
    expect(unknownClose.status).toBe(404);
    expect(strangerOnReal.status).toBe(404);
    expect(unknown.body).toEqual(strangerOnReal.body);
  });

  it("OWNER-ONLY by default: a same-tenant colleague is refused like any stranger (the 404), on every route and the stream", async () => {
    const b = await up();
    const id = await startConv(b, "tok-alice");
    const before = await logSize(b, id);
    const unknown = await get(`${b.url}/conversations/conv-nope`, "tok-carol");
    for (const r of [
      await post(`${b.url}/conversations/${id}/turns`, "tok-carol", { text: "hi from carol" }),
      await post(`${b.url}/conversations/${id}/close`, "tok-carol", {}),
      await get(`${b.url}/conversations/${id}`, "tok-carol"),
      await get(`${b.url}/conversations/${id}/history`, "tok-carol"),
    ]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(unknown.body);
    }
    expect((await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-carol"))).status).toBe(
      404
    );
    expect(await logSize(b, id)).toBe(before);
    expect(b.calls.n).toBe(0);
  });

  it("conversation ids are minted by the server: a client cannot choose, collide with or squat one", async () => {
    const b = await up();
    const r = await post(`${b.url}/conversations`, "tok-alice", { conversationId: "mine" });
    expect(r.status).toBe(201);
    expect(r.body.conversationId).not.toBe("mine");
    expect((await get(`${b.url}/conversations/mine`, "tok-alice")).status).toBe(404);
  });

  it("path ids that are not valid conversation ids never reach the runtime", async () => {
    const b = await up();
    for (const bad of ["a~1", "a::b", "__loom_inbox__:x", "%2e%2e", "a%20b", "%E0%A4%A"]) {
      expect((await get(`${b.url}/conversations/${bad}`, "tok-alice")).status).toBe(404);
    }
  });
});

describe("limits", () => {
  it("caps concurrent streams per principal and in total, and frees the slot on disconnect", async () => {
    const b = await up({ server: { maxConnectionsPerPrincipal: 1, maxConnections: 2 } });
    const a1 = await startConv(b, "tok-alice");
    const a2 = await startConv(b, "tok-alice");
    const first = await openSse(`${b.url}/conversations/${a1}/events`, bearer("tok-alice"));
    expect(first.status).toBe(200);
    const second = await openSse(`${b.url}/conversations/${a2}/events`, bearer("tok-alice"));
    expect(second.status).toBe(429);
    // another principal still gets in (the cap is per principal) until the total is reached
    const c = await startConv(b, "tok-bob");
    const other = track(await openSse(`${b.url}/conversations/${c}/events`, bearer("tok-bob")));
    expect(other.status).toBe(200);
    const c2 = await startConv(b, "tok-carol");
    expect((await openSse(`${b.url}/conversations/${c2}/events`, bearer("tok-carol"))).status).toBe(
      429
    ); // total
    first.close();
    await until(() => b.server.connections === 1, "the slot to be freed");
    expect(
      track(await openSse(`${b.url}/conversations/${a2}/events`, bearer("tok-alice"))).status
    ).toBe(200);
  });

  it("caps live subscribers per conversation without leaking that it exists", async () => {
    const { ConversationHub } = await import("@loom/conversation");
    const b = await up({ hub: new ConversationHub({ maxSubscribersPerConversation: 1 }) });
    const id = await startConv(b, "tok-alice");
    const one = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice")));
    expect(one.status).toBe(200);
    expect((await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice"))).status).toBe(
      429
    );
    // a stranger probing a busy conversation learns nothing from the limit: authorization came first
    expect((await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-bob"))).status).toBe(
      404
    );
  });

  it("bounds request bodies and demands JSON", async () => {
    const b = await up({ server: { maxBodyBytes: 256 } });
    const id = await startConv(b);
    expect(
      (await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "x".repeat(1000) }))
        .status
    ).toBe(413);
    const wrongType = await fetch(`${b.url}/conversations/${id}/turns`, {
      method: "POST",
      headers: { ...bearer("tok-alice"), "content-type": "text/plain" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(wrongType.status).toBe(415);
    const garbage = await fetch(`${b.url}/conversations/${id}/turns`, {
      method: "POST",
      headers: { ...bearer("tok-alice"), "content-type": "application/json" },
      body: "{not json",
    });
    expect(garbage.status).toBe(400);
    expect(
      (await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: 42 })).status
    ).toBe(400);
    expect(
      (await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "ok", messageId: "" }))
        .status
    ).toBe(400);
    expect(b.calls.n).toBe(0);
  });

  it("a request error never leaks internals: a 500 is a fixed body plus an errorId", async () => {
    const errors: string[] = [];
    const b = await up({ server: { onError: (id) => errors.push(id) } });
    const id = await startConv(b);
    // sabotage the runtime so the next call fails inside
    (b.conversations as unknown as { status: () => never }).status = () => {
      throw new Error('pg: relation "events" does not exist at /var/lib/secret');
    };
    const r = await get(`${b.url}/conversations/${id}`, "tok-alice");
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/relation|secret|events/);
    expect(r.body.errorId).toBe(errors[0]);
  });
});

describe("browser safety", () => {
  it("refuses a cross-site Origin, answers preflight only for allowed origins, and echoes CORS only to them", async () => {
    const b = await up({ server: { allowedOrigins: ["https://app.example"] } });
    const id = await startConv(b);
    const evil = await fetch(`${b.url}/conversations/${id}`, {
      headers: { ...bearer("tok-alice"), origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    const good = await fetch(`${b.url}/conversations/${id}`, {
      headers: { ...bearer("tok-alice"), origin: "https://app.example" },
    });
    expect(good.status).toBe(200);
    expect(good.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const pre = await fetch(`${b.url}/conversations/${id}/turns`, {
      method: "OPTIONS",
      headers: { origin: "https://app.example" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    const badPre = await fetch(`${b.url}/conversations/${id}/turns`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(badPre.status).toBe(403);
    // P3-5: Host is attacker-influenced and never proves same-origin: the server's OWN origin is not listed, so refused
    const own = await fetch(`${b.url}/conversations/${id}`, {
      headers: { ...bearer("tok-alice"), origin: b.url },
    });
    expect(own.status).toBe(403);
    // no Origin (a non-browser client) is unaffected, and carries no CORS headers
    const plain = await fetch(`${b.url}/conversations/${id}`, { headers: bearer("tok-alice") });
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();
    // a streamed response to an allowed origin is CORS-enabled too
    const s = track(
      await openSse(`${b.url}/conversations/${id}/events`, {
        ...bearer("tok-alice"),
        origin: "https://app.example",
      })
    );
    expect(s.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  it("sends nosniff, and the user's own words travel as JSON data", async () => {
    const b = await up();
    const id = await startConv(b);
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", {
      text: "<script>alert(1)</script>\nevent: error\ndata: forged",
    });
    const s = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice")));
    await s.waitFor(
      (e) => e.event === "message" && (e.data as { role: string }).role === "assistant"
    );
    expect(s.headers.get("x-content-type-options")).toBe("nosniff");
    // the embedded newline did not forge an SSE field: exactly one user message, no `error` event
    expect(s.events.filter((e) => e.event === "error")).toEqual([]);
    expect((s.events.find((e) => e.event === "message")?.data as { text: string }).text).toContain(
      "event: error"
    );
  });
});

describe("stream lifetime", () => {
  it("re-authenticates open streams: a revoked token ends the stream", async () => {
    const tokens: Record<string, { actor: string; tenant: string }> = {
      t: { actor: "alice", tenant: "t1" },
    };
    const b = await up({ tokens: tokens as never, server: { reauthMs: 20 } });
    const id = (await post(`${b.url}/conversations`, "t", {})).body.conversationId as string;
    const s = await openSse(`${b.url}/conversations/${id}/events`, bearer("t"));
    expect(s.status).toBe(200);
    Reflect.deleteProperty(tokens, "t"); // revoked
    await s.waitFor((e) => e.event === "error");
    await s.ended;
    expect(b.server.connections).toBe(0);
  });

  it("re-authorizes open streams: when the runtime's policy stops allowing the caller, the stream ends", async () => {
    const base = executionAccessPolicy();
    const revoked = { on: false };
    const b = await up({
      ackPolicy: true,
      policy: {
        authorize: (r) =>
          revoked.on && r.op === "query"
            ? { allowed: false, reason: "revoked" }
            : base.authorize(r),
      },
      server: { reauthMs: 20 },
    });
    const id = await startConv(b);
    const s = await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice"));
    expect(s.status).toBe(200);
    revoked.on = true; // the token is still good; the policy no longer admits this caller
    await s.waitFor((e) => e.event === "error");
    await s.ended;
  });

  it("ends a stream after its maximum lifetime with a reconnect hint", async () => {
    const b = await up({ server: { maxStreamMs: 30 } });
    const id = await startConv(b);
    const s = await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice"));
    await s.waitFor((e) => e.event === "reconnect");
    await s.ended;
  });

  it("stopping the server closes every open stream and leaves no subscription behind", async () => {
    const b = await up();
    const id = await startConv(b);
    const s = await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice"));
    expect(b.hub.subscriberCount(id)).toBe(1);
    await b.server.stop();
    await s.ended;
    expect(b.hub.subscriberCount(id)).toBe(0);
  });
});
