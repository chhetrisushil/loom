import { describe, expect, it } from "vitest";
import { SECRET, alice, boot, carol, dave, mallory, messages, until } from "./__fixtures__/harness";
import { ConversationNotFoundError } from "./index";

const asIdentity = (p: { actor?: string; tenant?: string }) => ({
  actor: p.actor as string,
  ...(p.tenant !== undefined && { tenant: p.tenant }),
});

async function sharedConv(extra: Parameters<typeof boot>[0] = {}) {
  const b = boot({ shared: true, ...extra });
  const { conversationId: id } = await b.conv.start({ principal: alice });
  await b.conv.addParticipant(id, asIdentity(carol), { principal: alice });
  await b.conv.addParticipant(id, asIdentity(dave), { principal: alice });
  return { b, id };
}

describe("shared mode: the basics", () => {
  it("a participant asks; the turn runs as THEM; the answer is attributed", async () => {
    const { b, id } = await sharedConv();
    await b.conv.sendTurn(id, "look in the kb", { principal: carol });
    const all = await messages(b, id, 2, carol);
    expect(all[0]).toMatchObject({
      role: "user",
      asker: asIdentity(carol),
      text: "look in the kb",
    });
    expect(all[1]).toMatchObject({
      role: "assistant",
      status: "complete",
      asker: asIdentity(carol),
    });
    expect(all[1]?.text).toContain("public-fact");
    expect(all[1]?.turnExecutionId).toMatch(/^turn:/);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────
import type { LlmRequest } from "@loom/llm";
import { Latch, lastUserText, sharedScript } from "./__fixtures__/harness";
import { sign } from "./access";

const never = (req: LlmRequest): Promise<never> =>
  new Promise((_, rej) => {
    if (req.signal?.aborted) rej(new Error("aborted"));
    req.signal?.addEventListener("abort", () => rej(new Error("aborted")));
  });
const texts = (xs: { text: string }[]) => xs.map((x) => x.text);

describe("shared mode: participants, not tenants", () => {
  it("a non-participant is refused everywhere as 'not found', and nothing is written", async () => {
    const { b, id } = await sharedConv();
    await b.conv.sendTurn(id, "hello", { principal: alice });
    await messages(b, id, 2, alice);
    const before =
      (await b.eventStore.read(id)).length +
      (await b.eventStore.read(`__loom_inbox__:${id}`)).length;
    const ops = (who: typeof mallory) => [
      b.conv.sendTurn(id, "x", { principal: who }),
      b.conv.close(id, { principal: who }),
      b.conv.history(id, { principal: who }),
      b.conv.status(id, { principal: who }),
      b.conv.authorizeRead(id, { principal: who }),
      b.conv.participants(id, { principal: who }),
      b.conv.addParticipant(id, asIdentity(mallory), { principal: who }),
    ];
    for (const r of await Promise.allSettled(ops(mallory))) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConversationNotFoundError);
    }
    // a participant who is not a manager cannot manage or close either
    for (const r of await Promise.allSettled([
      b.conv.close(id, { principal: carol }),
      b.conv.participants(id, { principal: carol }),
      b.conv.addParticipant(id, asIdentity(mallory), { principal: carol }),
      b.conv.removeParticipant(id, asIdentity(dave), { principal: carol }),
    ])) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConversationNotFoundError);
    }
    expect(
      (await b.eventStore.read(id)).length +
        (await b.eventStore.read(`__loom_inbox__:${id}`)).length
    ).toBe(before);
    expect(b.calls.n).toBe(1);
  });

  it("the owner is always a participant and cannot be removed; the set is bounded and a host manager may manage", async () => {
    const { b, id } = await sharedConv({
      shared: { manageParticipants: (m) => m.actor === "dave" },
    });
    await expect(
      b.conv.removeParticipant(id, asIdentity(alice), { principal: alice })
    ).rejects.toThrow(/owner cannot be removed/);
    // dave is a manager by the host hook, though not the owner
    await b.conv.addParticipant(id, { actor: "erin", tenant: "t4" }, { principal: dave });
    expect(
      (await b.conv.participants(id, { principal: alice })).map((i) => i.actor).sort()
    ).toEqual(["carol", "dave", "erin"]);
    await b.conv.close(id, { principal: dave });
    await until(async () => (await b.conv.status(id, { principal: alice })).state === "closed");
  });

  it("an unsigned or wrongly signed envelope cannot speak as anyone: it is rejected, never answered", async () => {
    const { b, id } = await sharedConv();
    const sys = b.runtime.systemOptions();
    const body = { kind: "user", text: "i am alice", asker: asIdentity(alice), id: "forged-1" };
    await b.runtime.send(id, { topic: "conversation:turn", payload: body }, sys);
    await b.runtime.send(
      id,
      {
        topic: "conversation:turn",
        payload: { ...body, id: "forged-2", sig: sign("wrong-key", { ...body, id: "forged-2" }) },
      },
      sys
    );
    await b.conv.sendTurn(id, "legit", { principal: carol });
    const all = await messages(b, id, 4, carol);
    expect(all.slice(0, 2).map((m) => [m.status, m.reason])).toEqual([
      ["rejected", "unauthenticated"],
      ["rejected", "unauthenticated"],
    ]);
    expect(JSON.stringify(all)).not.toContain("i am alice");
    expect(b.calls.n).toBe(1);
  });
});

describe("shared mode: every turn runs as its ASKER", () => {
  it("a participant with fewer grants cannot reach the owner's tool; the denial surfaces to them", async () => {
    const { b, id } = await sharedConv();
    let secretRuns = 0;
    b.effects.register("spy", {
      kind: "tool",
      execute: async () => {
        secretRuns++;
        return {};
      },
    } as never);
    // alice (the owner) CAN reach it...
    await b.conv.sendTurn(id, "use the secret db", { principal: alice });
    const mine = await messages(b, id, 2, alice);
    expect(mine[1]?.text).toContain(SECRET);
    // ...carol cannot, though the CONVERSATION (owner's authority) can
    await b.conv.sendTurn(id, "use the secret db too", { principal: carol });
    const all = await messages(b, id, 4, carol);
    expect(all[3]).toMatchObject({
      role: "assistant",
      status: "failed",
      reason: "denied",
      asker: asIdentity(carol),
    });
    expect(all[3]?.errorId).toBeDefined();
    expect(all[3]?.text).toBe("");
    expect(JSON.stringify(b.requests.slice(-1))).not.toContain(SECRET);
    void secretRuns;
  });

  it("the turn is its OWN execution under the asker's principal, not the owner's", async () => {
    const { b, id } = await sharedConv();
    await b.conv.sendTurn(id, "look in the kb", { principal: carol });
    const all = await messages(b, id, 2, carol);
    const turnId = all[1]?.turnExecutionId as string;
    expect(turnId).toBeDefined();
    const first = (await b.eventStore.read(turnId))[0];
    expect(JSON.stringify(first?.payload)).toContain("carol");
    expect(JSON.stringify(first?.payload)).not.toContain("alice");
    const coord = (await b.eventStore.read(id))[0];
    expect(JSON.stringify(coord?.payload)).toContain("alice");
  });

  it("memory write-back must be an effect (a direct write would not be the asker's)", () => {
    expect(() =>
      boot({
        shared: true,
        config: {
          agent: {
            definition: undefined as never,
            modelToolId: "m",
            writeBack: { allowDirect: true },
          },
        },
      })
    ).toThrow();
  });
});

describe("shared mode: classification and per-viewer filtering", () => {
  async function withSecret() {
    const { b, id } = await sharedConv();
    await b.conv.sendTurn(id, "use the secret db", { principal: alice }); // alice: cleared, asker
    await messages(b, id, 2, alice);
    return { b, id };
  }

  it("the answer is classified by the tools it touched; a viewer who is not cleared sees a bare placeholder", async () => {
    const { b, id } = await withSecret();
    const asAlice = (await b.conv.history(id, { principal: alice })).entries;
    expect(asAlice[1]).toMatchObject({ status: "complete" });
    expect(asAlice[1]?.text).toContain(SECRET);
    // dave is cleared for "restricted"
    const asDave = (await b.conv.history(id, { principal: dave })).entries;
    expect(asDave[1]?.text).toContain(SECRET);
    // carol is not
    const asCarol = (await b.conv.history(id, { principal: carol })).entries;
    expect(asCarol[0]).toMatchObject({ role: "user", text: "use the secret db" }); // the question is not restricted
    expect(asCarol[1]).toEqual({
      turn: 1,
      ord: 2, // an ordinal is not content: the placeholder keeps it
      role: "assistant",
      text: "",
      status: "restricted",
      cursor: asAlice[1]?.cursor,
      executionId: asAlice[1]?.executionId,
      at: asAlice[1]?.at,
      asker: asIdentity(alice),
    });
    // nothing of the answer: no text, no tool name, no class label, no turn execution
    expect(JSON.stringify(asCarol)).not.toMatch(/TOP-SECRET|secret-db|classes|turn:/);
    expect(JSON.stringify(asCarol)).not.toContain(SECRET);
  });

  it("fail closed: a tool the policy does not know makes the answer 'unclassified', hidden from everyone but its asker", async () => {
    const { b, id } = await sharedConv({ shared: { classOf: () => undefined } });
    await b.conv.sendTurn(id, "look in the kb", { principal: carol });
    await messages(b, id, 2, carol);
    const asDave = (await b.conv.history(id, { principal: dave })).entries;
    expect(asDave[1]).toMatchObject({ status: "restricted", text: "" });
    const asCarol = (await b.conv.history(id, { principal: carol })).entries;
    expect(asCarol[1]?.text).toContain("public-fact"); // your own answer is yours
  });

  it("a turn that fed on a restricted entry inherits its class: dave's follow-up is hidden from carol too", async () => {
    const { b, id } = await withSecret();
    await b.conv.sendTurn(id, "summarize what we know", { principal: dave });
    const all = await messages(b, id, 4, dave);
    expect(all[3]?.text).toBeDefined();
    const asCarol = (await b.conv.history(id, { principal: carol })).entries;
    expect(asCarol[3]).toMatchObject({ status: "restricted", text: "" });
    // the record carries the inherited class
    const raw = (await b.conv.reader.read(id)).entries;
    expect(raw[3]?.classes).toEqual(["restricted"]);
  });

  it("paging and status never leak: a backward page is filtered the same way", async () => {
    const { b, id } = await withSecret();
    const back = (await b.conv.history(id, { principal: carol, direction: "backward", limit: 2 }))
      .entries;
    expect(back[0]).toMatchObject({ status: "restricted", text: "" });
    expect(JSON.stringify(await b.conv.status(id, { principal: carol }))).not.toContain(SECRET);
  });
});

describe("shared mode: the model context is per ASKER", () => {
  it("a restricted answer never enters an uncleared asker's prompt, nor does anything it was summarized into", async () => {
    const { b, id } = await sharedConv();
    await b.conv.sendTurn(id, "use the secret db", { principal: alice });
    await messages(b, id, 2, alice);
    await b.conv.sendTurn(id, "what have we found so far?", { principal: carol });
    await messages(b, id, 4, carol);
    const carolReq = b.requests.at(-1) as LlmRequest;
    const ctx = JSON.stringify(carolReq);
    expect(ctx).not.toContain(SECRET);
    expect(ctx).not.toContain("answer: ["); // alice's restricted reply
    expect(ctx).not.toContain("use the secret db");
    // the turn it belongs to is dropped WHOLE from her context (question included): fail closed
    // and the uncleared asker's own answer is therefore not restricted by what she could not see
    const raw = (await b.conv.reader.read(id)).entries;
    expect(raw[3]?.classes).toBeUndefined();
    // NEGATIVE: a cleared asker's prompt does carry it
    await b.conv.sendTurn(id, "and now for dave", { principal: dave });
    await messages(b, id, 6, dave);
    expect(JSON.stringify(b.requests.at(-1))).toContain(SECRET);
  });

  it("the rolling summary is built only from unrestricted turns: restricted ones are dropped, not summarized", async () => {
    const summarized: string[] = [];
    const { b, id } = await sharedConv({
      config: { maxWindowTurns: 2, budget: { contextWindow: 100_000, summarizerToolId: "audit" } },
      extraEffects: (e) =>
        e.register("audit", {
          kind: "tool",
          execute: async (input: unknown) => {
            summarized.push(JSON.stringify(input));
            return { summary: "neutral summary" };
          },
        } as never),
    });
    await b.conv.sendTurn(id, "use the secret db", { principal: alice });
    await messages(b, id, 2, alice);
    await b.conv.sendTurn(id, "plain question one", { principal: carol });
    await messages(b, id, 4, carol);
    await b.conv.sendTurn(id, "plain question two", { principal: carol });
    await messages(b, id, 6, carol);
    await b.conv.sendTurn(id, "plain question three", { principal: carol });
    await messages(b, id, 8, carol);
    await b.conv.sendTurn(id, "plain question four", { principal: carol });
    await messages(b, id, 10, carol);
    expect(summarized.length).toBeGreaterThan(0);
    for (const s of summarized) {
      expect(s).not.toContain(SECRET);
      expect(s).not.toContain("use the secret db"); // the restricted TURN is dropped whole
    }
    expect(JSON.stringify(b.requests.at(-1))).toContain("neutral summary");
    expect(JSON.stringify(b.requests.at(-1))).not.toContain(SECRET);
  });
});

describe("shared mode: a queue, and no cross-user barge-in", () => {
  it("turns run FIFO and attributed; B cannot interrupt A's running turn; A can", async () => {
    const started = new Latch();
    const gate = new Latch();
    const order: string[] = [];
    const { b, id } = await sharedConv({
      reply: async (req, nth) => {
        const text = lastUserText(req);
        order.push(text);
        if (text === "alice long") {
          started.release();
          await Promise.race([gate.promise, never(req)]);
          return { content: "alice finished", stopReason: "end_turn" };
        }
        return sharedScript(req);
      },
    });
    await b.conv.sendTurn(id, "alice long", { principal: alice });
    await started.promise;
    await b.conv.sendTurn(id, "carol next", { principal: carol });
    await b.conv.sendTurn(id, "dave after", { principal: dave });
    // give an interrupt every chance to land: it must not
    await until(
      async () => (await b.eventStore.read(`__loom_inbox__:${id}`)).length === 3,
      "all three messages stored"
    );
    expect((await b.conv.status(id, { principal: alice })).running).toBe(true);
    expect(order).toEqual(["alice long"]);
    gate.release();
    const all = await messages(b, id, 6, alice);
    expect(order).toEqual(["alice long", "carol next", "dave after"]);
    expect(all.map((m) => [m.turn, m.role, m.status, m.asker?.actor])).toEqual([
      [1, "user", "complete", "alice"],
      [1, "assistant", "complete", "alice"],
      [2, "user", "complete", "carol"],
      [2, "assistant", "complete", "carol"],
      [3, "user", "complete", "dave"],
      [3, "assistant", "complete", "dave"],
    ]);
    expect(all[1]?.text).toBe("alice finished");
  });

  it("a participant's OWN follow-up interrupts their running turn (and only theirs)", async () => {
    const started = new Latch();
    const { b, id } = await sharedConv({
      reply: async (req) => {
        const text = lastUserText(req);
        if (text === "carol long") {
          started.release();
          await never(req);
        }
        return sharedScript(req);
      },
    });
    await b.conv.sendTurn(id, "carol long", { principal: carol });
    await started.promise;
    await b.conv.sendTurn(id, "carol again", { principal: carol });
    const all = await messages(b, id, 4, carol);
    expect(all.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "interrupted"],
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
  });

  it("a participant removed while their message was queued is not served", async () => {
    const started = new Latch();
    const gate = new Latch();
    const { b, id } = await sharedConv({
      reply: async (req) => {
        if (lastUserText(req) === "alice long") {
          started.release();
          await gate.promise;
        }
        return sharedScript(req);
      },
    });
    await b.conv.sendTurn(id, "alice long", { principal: alice });
    await started.promise;
    await b.conv.sendTurn(id, "carol queued", { principal: carol });
    await b.conv.removeParticipant(id, asIdentity(carol), { principal: alice });
    // takes effect on the VERY NEXT request...
    await expect(b.conv.history(id, { principal: carol })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
    await expect(b.conv.sendTurn(id, "again", { principal: carol })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
    gate.release();
    // ...and a message already queued is rejected when dequeued
    const all = await messages(b, id, 3, alice);
    expect(all[2]).toMatchObject({
      role: "user",
      status: "rejected",
      reason: "not-a-participant",
      text: "",
    });
    expect(JSON.stringify(all)).not.toContain("carol queued");
    expect(b.calls.n).toBe(1);
  });
});

describe("shared mode: replay", () => {
  it("a restart replays a mixed-asker conversation under divergence 'fail': no model call for old turns, no divergence, no leak", async () => {
    const { b, id } = await sharedConv();
    await b.conv.sendTurn(id, "use the secret db", { principal: alice });
    await messages(b, id, 2, alice);
    await b.conv.sendTurn(id, "use the secret db too", { principal: carol }); // denied for carol
    await messages(b, id, 4, carol);
    await b.conv.sendTurn(id, "look in the kb", { principal: dave });
    await messages(b, id, 6, dave);
    await until(
      async () => (await b.runtime.loadState(id, b.runtime.systemOptions()))?.status === "suspended"
    );
    const callsBefore = b.calls.n;

    // a NEW process over the same stores
    const b2 = boot({ shared: true, store: b.eventStore });
    await b2.conv.sendTurn(id, "after the restart", { principal: carol });
    const all = await messages(b2, id, 8, carol);
    expect(all.slice(0, 6).map((m) => [m.turn, m.role, m.status])).toEqual([
      [1, "user", "complete"],
      [1, "assistant", "restricted"],
      [2, "user", "complete"],
      [2, "assistant", "failed"],
      [3, "user", "restricted"], // dave's question was built on alice's restricted answer
      [3, "assistant", "restricted"],
    ]);
    expect(all[7]).toMatchObject({ status: "complete", asker: asIdentity(carol) });
    expect(b2.calls.n).toBe(1); // only the new turn asked the model
    expect(b.calls.n).toBe(callsBefore);
    expect(JSON.stringify(all)).not.toContain(SECRET);
  });
});

describe("shared mode: rotation and approvals", () => {
  it("rotation carries the owner, the attribution and the classes: a restricted entry stays restricted in the next generation", async () => {
    const { b, id } = await sharedConv({ config: { rotateEveryTurns: 1 } });
    await b.conv.sendTurn(id, "use the secret db", { principal: alice });
    await messages(b, id, 2, alice);
    await b.conv.sendTurn(id, "look in the kb", { principal: carol });
    await messages(b, id, 4, carol);
    await b.conv.sendTurn(id, "what is known?", { principal: dave });
    await messages(b, id, 6, dave);
    expect((await b.conv.status(id, { principal: alice })).generation).toBeGreaterThanOrEqual(2);
    // dave's context (cleared) carries alice's restricted answer; carol's does not, in a LATER generation
    expect(JSON.stringify(b.requests.at(-1))).toContain(SECRET);
    await b.conv.sendTurn(id, "and from me?", { principal: carol });
    await messages(b, id, 8, carol);
    expect(JSON.stringify(b.requests.at(-1))).not.toContain(SECRET);
    // the owner is still the owner at the head; a stranger is still a stranger
    await expect(b.conv.history(id, { principal: mallory })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
    const asCarol = (await b.conv.history(id, { principal: carol, limit: 100 })).entries;
    expect(asCarol.filter((e) => e.status === "restricted").map((e) => e.turn)).toEqual([1, 3, 3]);
  });

  it("approvals stay refused: a parked approval gate cannot coexist with a conversation", () => {
    expect(() =>
      boot({
        shared: true,
        config: {
          agent: { definition: undefined as never, modelToolId: "m", requireApproval: () => false },
        },
      })
    ).toThrow(/requireApproval/);
    expect(() =>
      boot({
        shared: true,
        config: {
          agent: { definition: undefined as never, modelToolId: "m", needsApproval: () => true },
        },
      })
    ).toThrow(/needsApproval/);
  });
});
