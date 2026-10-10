import { describe, expect, it } from "vitest";
import { TEST_KEY, alice, boot, messages } from "./__fixtures__/harness";
import { CONVERSATION_TOPIC, InvalidEnvelopeError, signInboxEnvelope } from "./index";

// F4: a host (or test) can build a validly signed inbox envelope. Signing is not authority: the key, the
// replay set and the voice checks all still apply.
describe("signInboxEnvelope", () => {
  const env = (id: string, over: Record<string, unknown> = {}) => ({
    conversationId: id,
    kind: "user" as const,
    id: `m-${Math.random().toString(36).slice(2)}`,
    iat: Date.now(),
    text: "hello from a bridge",
    ...over,
  });

  it("a host-signed envelope is accepted and answered", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    await b.runtime.send(id, {
      topic: CONVERSATION_TOPIC,
      payload: signInboxEnvelope(TEST_KEY, env(id)),
    });
    const all = await messages(b, id, 2);
    expect(all.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(all[0]?.text).toBe("hello from a bridge");
  });

  it("a wrong key is refused as unauthenticated and the model is never asked", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    await b.runtime.send(id, {
      topic: CONVERSATION_TOPIC,
      payload: signInboxEnvelope("not-the-key", env(id)),
    });
    const all = await messages(b, id, 1);
    expect(all.map((m) => [m.status, m.reason])).toEqual([["rejected", "unauthenticated"]]);
    expect(b.calls.n).toBe(0);
  });

  it("a replay of the same signed envelope is refused", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    const payload = signInboxEnvelope(TEST_KEY, env(id));
    await b.runtime.send(id, { topic: CONVERSATION_TOPIC, payload });
    await messages(b, id, 2); // the whole first exchange, so the copy is not a barge-in
    await b.runtime.send(id, { topic: CONVERSATION_TOPIC, payload });
    const all = await messages(b, id, 3);
    expect(all.map((m) => [m.role, m.status, m.reason ?? ""])).toEqual([
      ["user", "complete", ""],
      ["assistant", "complete", ""],
      ["user", "rejected", "replayed"],
    ]);
    expect(b.calls.n).toBe(1);
  });

  it("owner mode: the owner's own voice is accepted, another owner's voice is refused (positive control)", async () => {
    const b = boot({ secure: true });
    const { conversationId: id } = await b.conv.start({ principal: alice });
    const send = (asker: { actor: string; tenant: string }) =>
      b.runtime.send(
        id,
        {
          topic: CONVERSATION_TOPIC,
          payload: signInboxEnvelope(TEST_KEY, env(id, { asker })),
        },
        { principal: alice }
      );
    await send({ actor: "alice", tenant: "t1" });
    await messages(b, id, 2, alice); // alice's turn and its answer: the signer and the voice check work
    await send({ actor: "bob", tenant: "t1" });
    const all = await messages(b, id, 3, alice);
    expect(all.map((m) => [m.role, m.status, m.reason ?? ""])).toEqual([
      ["user", "complete", ""],
      ["assistant", "complete", ""],
      ["user", "rejected", "unauthenticated"],
    ]);
    expect(b.calls.n).toBe(1);
  });

  it("validates the body up front: a body the conversation would refuse as malformed is not signed", () => {
    const bad: Record<string, unknown>[] = [
      { id: "" },
      { id: "x".repeat(257) },
      { iat: Number.NaN },
      { iat: "now" },
      { text: undefined },
      { text: "" },
      { text: "  \n\t " },
      { kind: "other" },
      { asker: { actor: 7 } },
      { editOf: 0 },
      { editOf: 1.5 },
    ];
    for (const over of bad) {
      expect(() => signInboxEnvelope(TEST_KEY, env("c", over))).toThrow(InvalidEnvelopeError);
    }
    expect(() =>
      signInboxEnvelope(TEST_KEY, env("c", { kind: "close", text: undefined }))
    ).not.toThrow();
  });

  it("refuses an empty key up front", () => {
    expect(() => signInboxEnvelope("", env("c"))).toThrow(/non-empty/);
  });
});
