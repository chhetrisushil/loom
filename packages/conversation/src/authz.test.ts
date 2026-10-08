import { ExecutionDeniedError, executionAccessPolicy } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { alice, bob, boot, mallory, messages } from "./__fixtures__/harness";
import { ConversationNotFoundError } from "./index";

describe("conversation authorization", () => {
  async function owned(policy = executionAccessPolicy()) {
    const b = boot({ secure: true, policy });
    const { conversationId: id } = await b.conv.start({ principal: alice });
    await b.conv.sendTurn(id, "hello", { principal: alice });
    await messages(b, id, 2, alice);
    return { b, id };
  }
  const logSize = async (b: Awaited<ReturnType<typeof owned>>["b"], id: string) =>
    (await b.eventStore.read(id)).length + (await b.eventStore.read(`__loom_inbox__:${id}`)).length;

  it("the owner converses; the turn runs under the owner's authority (the model effect is granted to the flow)", async () => {
    const { b, id } = await owned();
    expect((await b.conv.history(id, { principal: alice })).entries.map((m) => m.text)).toEqual([
      "hello",
      "re: hello",
    ]);
    expect(await b.conv.status(id, { principal: alice })).toMatchObject({ state: "open" });
  });

  it("a stranger (other tenant) cannot send, read, close or even see the conversation; nothing is written", async () => {
    const { b, id } = await owned();
    const before = await logSize(b, id);
    await expect(b.conv.sendTurn(id, "pwned", { principal: mallory })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    await expect(b.conv.close(id, { principal: mallory })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    await expect(b.conv.history(id, { principal: mallory })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    await expect(b.conv.status(id, { principal: mallory })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    await expect(b.conv.authorizeRead(id, { principal: mallory })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    expect(await logSize(b, id)).toBe(before);
    expect(b.calls.n).toBe(1);
  });

  it("a conversation that does not exist is NotFound, distinct from a refusal (the transport maps both to one answer)", async () => {
    const { b, id } = await owned();
    await expect(b.conv.history(id, { principal: mallory })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    await expect(
      b.conv.history("no-such-conversation", { principal: alice })
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(b.conv.sendTurn("no~such", "x", { principal: alice })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
  });

  it("an unauthenticated caller is refused when the runtime fails closed", async () => {
    const { b, id } = await owned();
    await expect(b.conv.sendTurn(id, "anon")).rejects.toBeInstanceOf(ExecutionDeniedError);
    await expect(b.conv.history(id)).rejects.toBeInstanceOf(ExecutionDeniedError);
    await expect(b.conv.start({})).rejects.toBeInstanceOf(ExecutionDeniedError);
  });

  it("the default policy lets a same-tenant colleague in; an owner-only policy does not", async () => {
    const open = await owned();
    await open.b.conv.sendTurn(open.id, "from bob", { principal: bob });
    expect((await messages(open.b, open.id, 4, alice)).at(-1)?.text).toBe("re: from bob");

    const strict = await owned(executionAccessPolicy({ rules: { send: "owner", query: "owner" } }));
    await expect(
      strict.b.conv.sendTurn(strict.id, "from bob", { principal: bob })
    ).rejects.toBeInstanceOf(ExecutionDeniedError);
    await expect(strict.b.conv.history(strict.id, { principal: bob })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    await strict.b.conv.sendTurn(strict.id, "from alice", { principal: alice });
    expect((await messages(strict.b, strict.id, 4, alice)).at(-1)?.text).toBe("re: from alice");
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
      ExecutionDeniedError
    );
    await expect(b.conv.history(id, { principal: mallory })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    await b.conv.sendTurn(id, "q4", { principal: alice });
    expect((await messages(b, id, 8, alice)).at(-1)?.text).toBe("re: q4");
  });
});
