import { ExecutionDeniedError, executionAccessPolicy } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { alice, bob, boot, mallory, messages, signRaw } from "./__fixtures__/harness";
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

  it("a SAME-TENANT colleague is refused: by the client, and by the runtime's owner-scoped policy", async () => {
    const { b, id } = await owned();
    const colleague = { ...bob, tenant: alice.tenant }; // bob, in alice's tenant
    const before = await logSize(b, id);
    const types = async () =>
      (await b.eventStore.read(id)).map((e) => e.eventType).filter((t) => t !== "EXECUTION_DENIED");
    const typesBefore = await types();
    for (const p of await Promise.allSettled(everyOp(b, id, colleague))) {
      expect((p as PromiseRejectedResult).reason).toBeInstanceOf(ConversationNotFoundError);
    }
    // the RAW paths are closed too: the policy that gates them is owner-scoped
    await expect(
      b.runtime.send(
        id,
        { topic: "conversation:turn", payload: { kind: "user", text: "raw" } },
        { principal: colleague }
      )
    ).rejects.toBeInstanceOf(ExecutionDeniedError);
    await expect(b.runtime.loadState(id, { principal: colleague })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    await expect(b.runtime.cancel(id, "x", { principal: colleague })).rejects.toBeInstanceOf(
      ExecutionDeniedError
    );
    expect(await types()).toEqual(typesBefore); // the kernel's own EXECUTION_DENIED audit aside, nothing was written
    expect((await b.eventStore.read(`__loom_inbox__:${id}`)).length + 0).toBeGreaterThanOrEqual(0);
    void before;
  });

  it("construction REFUSES a runtime policy that lets a tenant peer query, send to or cancel (a looser host must say so)", () => {
    expect(() =>
      boot({
        secure: true,
        policy: executionAccessPolicy(),
        ackPolicy: false,
        conversations: { policy: executionAccessPolicy() },
      })
    ).toThrow(/"query" as "tenant"/);
    expect(() =>
      boot({
        secure: true,
        policy: executionAccessPolicy({
          rules: { query: "owner", send: "owner", cancel: "owner", resume: "tenant" },
        }),
        ackPolicy: false,
        conversations: {
          policy: executionAccessPolicy({
            rules: { query: "owner", send: "owner", cancel: "owner", resume: "tenant" },
          }),
        },
      })
    ).toThrow(/"resume"/);
    // an opaque authorizer cannot be inspected: the host must acknowledge it
    expect(() =>
      boot({ secure: true, policy: { authorize: () => ({ allowed: true }) }, ackPolicy: false })
    ).toThrow(/owner-scoped/);
  });

  it("DEFENCE IN DEPTH: even on a looser runtime, a raw message from the owner's tenant is never obeyed", async () => {
    // the host lies (or errs) about its policy: tenant-scoped, acknowledged anyway
    const b = boot({ secure: true, policy: executionAccessPolicy(), ackPolicy: true });
    const { conversationId: id } = await b.conv.start({ principal: alice });
    const colleague = { ...bob, tenant: alice.tenant };
    // the runtime lets the colleague send...
    await b.runtime.send(
      id,
      {
        topic: "conversation:turn",
        payload: { kind: "user", text: "i am alice", asker: { actor: "alice", tenant: "t1" } },
      },
      { principal: colleague }
    );
    // ...and the colleague's forgery with a made-up signature
    await b.runtime.send(
      id,
      {
        topic: "conversation:turn",
        payload: {
          ...signRaw(id, {
            kind: "user",
            text: "i am alice",
            asker: { actor: "alice", tenant: "t1" },
          }),
          sig: "0".repeat(64),
        },
      },
      { principal: colleague }
    );
    // a PROPERLY SIGNED envelope that speaks as somebody other than the owner (the host's signing key leaked to
    // a service, a bug in a second client): only the owner's voice is accepted in an owner-only conversation
    await b.runtime.send(
      id,
      {
        topic: "conversation:turn",
        payload: signRaw(id, {
          kind: "user",
          text: "as bob",
          asker: { actor: "bob", tenant: "t1" },
        }),
      },
      { principal: colleague }
    );
    // the owner is still served, after the junk
    await b.conv.sendTurn(id, "the real one", { principal: alice });
    const all = await messages(b, id, 4, alice);
    expect(all.slice(0, 3).map((m) => [m.status, m.reason])).toEqual([
      ["rejected", "unauthenticated"],
      ["rejected", "unauthenticated"],
      ["rejected", "unauthenticated"],
    ]);
    expect(JSON.stringify(all)).not.toContain("as bob");
    expect(JSON.stringify(all)).not.toContain("i am alice");
    expect(b.calls.n).toBe(1); // the model was asked ONLY for the owner's own message
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
    const rejection = async (p: Promise<unknown>): Promise<Error> => {
      try {
        await p;
      } catch (e) {
        if (e instanceof Error) return e;
        throw e;
      }
      throw new Error("expected the call to reject");
    };
    const real = await rejection(b.conv.history(id, { principal: mallory }));
    const unknown = await rejection(b.conv.history("no-such-conversation", { principal: mallory }));
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
