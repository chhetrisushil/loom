import { createHash } from "node:crypto";
import type { LlmStreamChunk, ReasoningStore } from "@loom/llm";
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
} from "./__fixtures__/harness";

// ── ADR 0133 D6 — live and durable reasoning over SSE ───────────────────────────────────────────
//
// OFF by default; when on, the turn's ASKER only (shared mode), over its own event types and endpoint.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
const track = (c: SseConn): SseConn => {
  cleanup.push(() => c.close());
  return c;
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

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

const T1 = "THOUGHT-ONE ";
const T2 = "THOUGHT-TWO";

/** A streaming model that thinks, (optionally) waits on `gate` mid-thought, then answers. */
function thinking(gate?: Latch, reached?: Latch) {
  return async function* (
    req: Parameters<NonNullable<Parameters<typeof boot>[0]>["chunks"] & {}>[0]
  ) {
    yield { delta: "", done: false, reasoningDelta: T1 } satisfies LlmStreamChunk;
    reached?.release();
    if (gate !== undefined) await gate.promise;
    yield { delta: "", done: false, reasoningDelta: T2 } satisfies LlmStreamChunk;
    yield { delta: `re: ${lastUserText(req)}`, done: false } satisfies LlmStreamChunk;
    yield {
      delta: "",
      done: true,
      stopReason: "end_turn",
      reasoning: [{ kind: "summary", text: T1 + T2, provider: "anthropic" }],
    } satisfies LlmStreamChunk;
  };
}

async function up(opts: Parameters<typeof boot>[0] = {}): Promise<Booted> {
  const b = await boot(opts);
  cleanup.push(() => b.server.stop());
  return b;
}

const reasoningText = (c: SseConn): string =>
  c.events
    .filter((e) => e.event === "reasoning-partial" || e.event === "reasoning")
    .map((e) => (e.data as { text: string }).text)
    .join("");

async function room(b: Booted): Promise<string> {
  const id = (await post(`${b.url}/conversations`, "tok-alice", {})).body.conversationId as string;
  for (const [actor, tenant] of [
    ["bob", "t2"],
    ["dave", "t3"],
  ] as const) {
    expect(
      (await post(`${b.url}/conversations/${id}/participants`, "tok-alice", { actor, tenant }))
        .status
    ).toBe(202);
  }
  return id;
}

describe("owner conversation", () => {
  it("is OFF by default: a thinking model streams no reasoning event and exposes no endpoint", async () => {
    const store = memStore();
    const b = await up({ reasoning: { store, live: true }, chunks: thinking() });
    const id = (await post(`${b.url}/conversations`, "tok-alice", {})).body
      .conversationId as string;
    const s = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice")));
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "hi" });
    await s.waitFor(
      (e) => e.event === "message" && (e.data as { role: string }).role === "assistant"
    );
    expect(s.events.some((e) => e.event === "reasoning" || e.event === "reasoning-partial")).toBe(
      false
    );
    // Text deltas are text only.
    expect(
      s.events
        .filter((e) => e.event === "delta")
        .map((e) => (e.data as { text: string }).text)
        .join("")
    ).toBe("re: hi");
    expect(JSON.stringify(s.events)).not.toContain("THOUGHT");
    expect(
      (await get(`${b.url}/conversations/${id}/reasoning?cursor=0.1`, "tok-alice")).status
    ).toBe(404);
  });

  it("opted in: reasoning streams on its own event type; the owner can read it durably; another tenant gets nothing", async () => {
    const store = memStore();
    const b = await up({
      reasoning: { store, live: true },
      chunks: thinking(),
      server: { reasoning: { live: true, store } },
    });
    const id = (await post(`${b.url}/conversations`, "tok-alice", {})).body
      .conversationId as string;
    const s = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice")));
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "hi" });
    const reply = await s.waitFor(
      (e) => e.event === "message" && (e.data as { role: string }).role === "assistant"
    );
    expect(reasoningText(s)).toBe(T1 + T2);
    expect(
      s.events
        .filter((e) => e.event === "delta")
        .map((e) => (e.data as { text: string }).text)
        .join("")
    ).toBe("re: hi"); // NEGATIVE: not in the text channel

    const durable = await get(
      `${b.url}/conversations/${id}/reasoning?cursor=${reply.id}`,
      "tok-alice"
    );
    expect(durable.status).toBe(200);
    const parts = durable.body.steps.flatMap(
      (st: { attempts: { parts: { text?: string; status: string }[] }[] }) =>
        st.attempts.flatMap((a) => a.parts)
    );
    expect(parts).toEqual([{ kind: "summary", status: "ok", text: T1 + T2 }]);

    // Tenant isolation: another tenant's reader sees the same 404 as a missing conversation.
    const missing = await get(
      `${b.url}/conversations/conv-nope/reasoning?cursor=${reply.id}`,
      "tok-bob"
    );
    const other = await get(`${b.url}/conversations/${id}/reasoning?cursor=${reply.id}`, "tok-bob");
    expect(other.status).toBe(404);
    expect(other.body).toEqual(missing.body);
    expect(JSON.stringify(other.body)).not.toContain("THOUGHT");
    // A cursor that is not an assistant reply is the same 404, not a hint.
    const user = (await get(`${b.url}/conversations/${id}/history`, "tok-alice")).body.entries.find(
      (e: { role: string }) => e.role === "user"
    );
    expect(
      (await get(`${b.url}/conversations/${id}/reasoning?cursor=${user.cursor}`, "tok-alice"))
        .status
    ).toBe(404);
    expect((await get(`${b.url}/conversations/${id}/reasoning`, "tok-alice")).status).toBe(400);
  });

  it("a reconnect mid-call is caught up with reasoning-partial, then live deltas, with no duplicate", async () => {
    const store = memStore();
    const gate = new Latch();
    const reached = new Latch();
    const b = await up({
      reasoning: { store, live: true },
      chunks: thinking(gate, reached),
      server: { reasoning: true },
    });
    const id = (await post(`${b.url}/conversations`, "tok-alice", {})).body
      .conversationId as string;
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "hi" });
    await reached.promise; // the model has streamed T1 and is parked
    const late = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice")));
    await late.waitFor((e) => e.event === "reasoning-partial");
    gate.release();
    await late.waitFor(
      (e) => e.event === "message" && (e.data as { role: string }).role === "assistant"
    );
    expect(late.events.filter((e) => e.event === "reasoning-partial")).toHaveLength(1);
    expect(reasoningText(late)).toBe(T1 + T2); // partial + live deltas, no gap and no duplicate
    // The partial is cleared with the durable reply: a later attach gets none.
    const after = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice")));
    await after.waitFor((e) => e.event === "status");
    expect(after.events.some((e) => e.event === "reasoning-partial")).toBe(false);
  });
});

describe("shared conversation: the turn's asker ONLY", () => {
  it("bob and dave see the answer but never alice's reasoning, live, partial or durable", async () => {
    const store = memStore();
    const gate = new Latch();
    const reached = new Latch();
    const b = await up({
      shared: true,
      reasoning: { store, live: true },
      chunks: thinking(gate, reached),
      server: { reasoning: { live: true, store } },
    });
    const id = await room(b);
    const aliceS = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice")));
    const bobS = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-bob")));
    await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "hi" });
    await reached.promise;
    // Everyone attached mid-call, asker included: only the asker is caught up.
    const aliceLate = track(
      await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice"))
    );
    const daveLate = track(
      await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-dave"))
    );
    await aliceLate.waitFor((e) => e.event === "reasoning-partial");
    gate.release();
    const isReply = (e: { event: string; data: unknown }) =>
      e.event === "message" && (e.data as { role: string }).role === "assistant";
    const reply = await aliceS.waitFor(isReply);
    await bobS.waitFor(isReply);
    await daveLate.waitFor(isReply);

    expect(reasoningText(aliceS)).toBe(T1 + T2);
    expect(reasoningText(aliceLate)).toBe(T1 + T2);
    for (const other of [bobS, daveLate]) {
      expect(other.events.some((e) => e.event.startsWith("reasoning"))).toBe(false);
      expect(JSON.stringify(other.events)).not.toContain("THOUGHT");
    }
    // Durable: the asker reads it; no other participant does, the owner-of-record included.
    const entry = reply.id as string;
    expect(
      (await get(`${b.url}/conversations/${id}/reasoning?cursor=${entry}`, "tok-alice")).status
    ).toBe(200);
    const unknown = await get(
      `${b.url}/conversations/conv-nope/reasoning?cursor=${entry}`,
      "tok-bob"
    );
    for (const t of ["tok-bob", "tok-dave", "tok-carol"]) {
      const r = await get(`${b.url}/conversations/${id}/reasoning?cursor=${entry}`, t);
      expect(r.status).toBe(404);
      expect(r.body).toEqual(unknown.body);
    }
  });

  it("when bob asks, alice (the owner) is NOT served his reasoning", async () => {
    const store = memStore();
    const b = await up({
      shared: true,
      reasoning: { store, live: true },
      chunks: thinking(),
      server: { reasoning: { live: true, store } },
    });
    const id = await room(b);
    const aliceS = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice")));
    const bobS = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-bob")));
    await post(`${b.url}/conversations/${id}/turns`, "tok-bob", { text: "bob asks" });
    const isReply = (e: { event: string; data: unknown }) =>
      e.event === "message" && (e.data as { role: string }).role === "assistant";
    const reply = await bobS.waitFor(isReply);
    await aliceS.waitFor(isReply);
    expect(reasoningText(bobS)).toBe(T1 + T2);
    expect(aliceS.events.some((e) => e.event.startsWith("reasoning"))).toBe(false);
    expect(
      (await get(`${b.url}/conversations/${id}/reasoning?cursor=${reply.id}`, "tok-alice")).status
    ).toBe(404);
    expect(
      (await get(`${b.url}/conversations/${id}/reasoning?cursor=${reply.id}`, "tok-bob")).status
    ).toBe(200);
  });
});
