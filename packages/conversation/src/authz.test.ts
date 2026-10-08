import { ExecutionDeniedError } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { alice, bob, boot, mallory, messages } from "./__fixtures__/harness";
import { ConversationNotFoundError } from "./index";

// OWNER-ONLY is the default (ADR 0122 D8): the identity that started a conversation is the only one that
// may send to it, close it, read it or stream it; every other caller gets the SAME not-found as for a
// conversation that does not exist.

describe("conversation authorization: owner-only by default", () => {
  async function owned(extra: Parameters<typeof boot>[0] = {}) {
    const b = boot({ secure: true, ...extra });
    const { conversationId: id } = await b.conv.start({ principal: alice });
    await b.conv.sendTurn(id, "hello", { principal: alice });
    await messages(b, id, 2, alice);
    return { b, id };
  }
  const logSize = async (b: Awaited<ReturnType<typeof owned>>["b"], id: string) =>
    (await b.eventStore.read(id)).length + (await b.eventStore.read(`__loom_inbox__:${id}`)).length;
  const everyOp = (
    b: Awaited<ReturnType<typeof owned>>["b"],
    id: string,
    who: typeof alice | undefined
  ) => [
    b.conv.sendTurn(id, "pwned", who && { principal: who }),
    b.conv.close(id, who && { principal: who }),
    b.conv.history(id, who && { principal: who }),
    b.conv.status(id, who && { principal: who }),
    b.conv.authorizeRead(id, who && { principal: who }),
  ];

  it("the owner converses; the turn runs under the owner's authority", async () => {
    const { b, id } = await owned();
    expect((await b.conv.history(id, { principal: alice })).entries.map((m) => m.text)).toEqual([
      "hello",
      "re: hello",
    ]);
    expect(await b.conv.status(id, { principal: alice })).toMatchObject({ state: "open" });
  });

  it("a stranger in another tenant is refused everywhere, as 'not found', and nothing is written", async () => {
    const { b, id } = await owned();
    const before = await logSize(b, id);
    for (const p of await Promise.allSettled(everyOp(b, id, mallory))) {
      expect(p.status).toBe("rejected");
      expect((p as PromiseRejectedResult).reason).toBeInstanceOf(ConversationNotFoundError);
    }
    expect(await logSize(b, id)).toBe(before);
    expect(b.calls.n).toBe(1);
  });

  it("a SAME-TENANT colleague is refused too, although the runtime's own default policy would admit the tenant", async () => {
    const { b, id } = await owned();
    const colleague = { ...bob, tenant: alice.tenant }; // bob, in alice's tenant
    const before = await logSize(b, id);
    for (const p of await Promise.allSettled(everyOp(b, id, colleague))) {
      expect((p as PromiseRejectedResult).reason).toBeInstanceOf(ConversationNotFoundError);
    }
    expect(await logSize(b, id)).toBe(before);
    // ...and it really is the client's check: the runtime alone lets that colleague send
    await expect(
      b.runtime.send(
        id,
        { topic: "conversation:turn", payload: { kind: "user", text: "raw" } },
        { principal: colleague }
      )
    ).resolves.toBeDefined();
  });

  it("a delegate acting on behalf of the owner is a DIFFERENT identity and does not become the owner", async () => {
    const { b, id } = await owned();
    const delegate = { ...alice, onBehalfOf: "someone-else" };
    for (const p of await Promise.allSettled(everyOp(b, id, delegate))) {
      expect((p as PromiseRejectedResult).reason).toBeInstanceOf(ConversationNotFoundError);
    }
  });

  it("identity is tenant AND actor: the same actor name in another tenant is not the owner", async () => {
    const { b, id } = await owned();
    const namesake = { actor: alice.actor, tenant: "t-other" };
    await expect(b.conv.history(id, { principal: namesake })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
  });

  it("a real conversation and an unknown one give the caller the SAME answer", async () => {
    const { b, id } = await owned();
    const real = await b.conv.history(id, { principal: mallory }).catch((e: Error) => e);
    const unknown = await b.conv
      .history("no-such-conversation", { principal: mallory })
      .catch((e: Error) => e);
    expect(real).toBeInstanceOf(ConversationNotFoundError);
    expect(unknown).toBeInstanceOf(ConversationNotFoundError);
    expect(real.message.replace(id, "X")).toBe(
      unknown.message.replace("no-such-conversation", "X")
    );
    await expect(b.conv.sendTurn("no~such", "x", { principal: alice })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
  });

  it("an unauthenticated caller is refused (starting needs a principal under a fail-closed runtime)", async () => {
    const { b, id } = await owned();
    for (const p of await Promise.allSettled(everyOp(b, id, undefined))) {
      expect((p as PromiseRejectedResult).reason).toBeInstanceOf(ConversationNotFoundError);
    }
    await expect(b.conv.start({})).rejects.toBeInstanceOf(ExecutionDeniedError);
  });

  it("a conversation keeps its owner across rotations: a stranger is refused at the head too", async () => {
    const b = boot({ secure: true, config: { rotateEveryTurns: 1 } });
    const { conversationId: id } = await b.conv.start({ principal: alice });
    for (let i = 1; i <= 3; i++) {
      await b.conv.sendTurn(id, `q${i}`, { principal: alice });
      await messages(b, id, i * 2, alice);
    }
    expect((await b.conv.status(id, { principal: alice })).generation).toBeGreaterThan(0);
    await expect(b.conv.sendTurn(id, "x", { principal: mallory })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
    await b.conv.sendTurn(id, "q4", { principal: alice });
    expect((await messages(b, id, 8, alice)).at(-1)?.text).toBe("re: q4");
  });

  it("a forged owner stamp cannot widen access: when the kernel's recorded identity disagrees, nobody matches", async () => {
    const b = boot({ secure: true });
    // started through the runtime directly by alice, stamping MALLORY as the owner
    const h = await b.runtime.start(
      b.flow as never,
      { v: 1, seq: 0, ord: 0, turns: [], owner: { actor: "mallory", tenant: "t2" } } as never,
      { executionId: "forged", principal: alice }
    );
    void h;
    await expect(b.conv.history("forged", { principal: mallory })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
    await expect(b.conv.history("forged", { principal: alice })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
  });
});
