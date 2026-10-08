import { flow$ } from "@loom/core";
import { executionAccessPolicy } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Latch,
  SERVICE,
  TEST_KEY,
  alice,
  boot,
  carol,
  dave,
  lastUserText,
  messages,
  sharedScript,
  signRaw,
  until,
} from "./__fixtures__/harness";
import { sign } from "./access";
import { signedEnvelope } from "./conversation";
import { QueueFullError, senderKey } from "./index";
import { turnExecutionId } from "./turn";

// Fix round 3 (re-review P3s), each with the case that fails without the fix.

const id0 = (p: { actor?: string; tenant?: string }) => ({
  actor: p.actor as string,
  ...(p.tenant !== undefined && { tenant: p.tenant }),
});
const peer = { actor: "peer", tenant: SERVICE.tenant };

async function room(extra: Parameters<typeof boot>[0] = {}) {
  const b = boot({ shared: true, ...extra });
  const { conversationId: id } = await b.conv.start({ principal: alice });
  for (const p of [carol, dave]) await b.conv.addParticipant(id, id0(p), { principal: alice });
  return { b, id };
}
const lastEntries = async (b: ReturnType<typeof boot>, id: string, n: number) =>
  (await b.conv.reader.read(id, { direction: "backward", limit: n })).entries.reverse();

describe("P3-1 the replay set's eviction cannot reopen an old envelope", () => {
  it("flood 1 025+ envelopes, then replay a captured one: refused (the floor, not the set, is the guarantee)", async () => {
    const { b, id } = await room({ policy: executionAccessPolicy(), ackPolicy: true });
    await b.conv.sendTurn(id, "use the secret db", { principal: dave });
    await messages(b, id, 2, dave);
    const stolen = (
      (await b.eventStore.read(`__loom_inbox__:${id}`))[0]?.payload as {
        payload: Record<string, unknown>;
      }
    ).payload;
    const callsBefore = b.calls.n;
    // non-participant voices: validly signed, so they enter the replay set before the membership check rejects them
    for (let i = 0; i < 1030; i++) {
      await b.runtime.send(
        id,
        {
          topic: "conversation:turn",
          payload: signRaw(id, {
            kind: "user",
            text: `flood ${i}`,
            asker: { actor: "stranger", tenant: "t9" },
            id: `flood-${i}`,
            iat: Date.now() + 1 + i,
          }),
          messageId: `f${i}`,
        },
        { principal: peer }
      );
    }
    await b.runtime.send(
      id,
      { topic: "conversation:turn", payload: stolen, messageId: "replay-after-flood" },
      { principal: peer }
    );
    await b.conv.sendTurn(id, "legit", { principal: carol });
    await until(
      async () =>
        (await lastEntries(b, id, 1))[0]?.role === "assistant" &&
        (await lastEntries(b, id, 1))[0]?.asker?.actor === "carol",
      "carol's answer, after the flood"
    );
    const tail = await lastEntries(b, id, 6);
    expect(tail.at(-1)).toMatchObject({ role: "assistant", asker: id0(carol) });
    const replayEntry = tail.find((e) => e.status === "rejected" && e.reason === "stale");
    expect(replayEntry).toBeDefined();
    expect(b.calls.n).toBe(callsBefore + 1); // only carol's own message was answered; the replay was not
  }, 60_000);
});

describe("P3-2 the queue count only counts envelopes the host signed", () => {
  it("garbage-signature messages naming carol cannot fill carol's quota", async () => {
    const started = new Latch();
    const gate = new Latch();
    const { b, id } = await room({
      policy: executionAccessPolicy(),
      ackPolicy: true,
      conversations: { maxQueuedPerAsker: 2 },
      reply: async (req) => {
        if (lastUserText(req) === "hold") {
          started.release();
          await gate.promise;
        }
        return sharedScript(req);
      },
    });
    await b.conv.sendTurn(id, "hold", { principal: alice });
    await started.promise;
    for (let i = 0; i < 10; i++) {
      await b.runtime.send(
        id,
        {
          topic: "conversation:turn",
          payload: {
            ...signRaw(id, { kind: "user", text: "x", asker: id0(carol), id: `g${i}` }),
            sig: "0".repeat(64),
          },
          messageId: `g${i}`,
        },
        { principal: peer }
      );
    }
    // properly signed, but for ANOTHER conversation: lifted into this inbox, it must not count either
    for (let i = 0; i < 5; i++) {
      await b.runtime.send(
        id,
        {
          topic: "conversation:turn",
          payload: signRaw("some-other-conversation", {
            kind: "user",
            text: "x",
            asker: id0(carol),
            id: `o${i}`,
          }),
          messageId: `o${i}`,
        },
        { principal: peer }
      );
    }
    await b.conv.sendTurn(id, "mine one", { principal: carol }); // not blocked by the forgeries
    await b.conv.sendTurn(id, "mine two", { principal: carol });
    await expect(b.conv.sendTurn(id, "mine three", { principal: carol })).rejects.toBeInstanceOf(
      QueueFullError
    );
    gate.release();
  });
});

describe("P3-3 annotate is policed too", () => {
  it("a policy that opens annotate to the tenant is refused at construction", () => {
    const loose = executionAccessPolicy({
      rules: {
        query: "owner",
        send: "owner",
        cancel: "owner",
        resume: "owner",
        annotate: "tenant",
      },
    });
    expect(() =>
      boot({ secure: true, policy: loose, ackPolicy: false, conversations: { policy: loose } })
    ).toThrow(/"annotate" as "tenant"/);
  });
});

describe("P3-4 a turn execution id is its asker's", () => {
  it("another viewer's history and the asker's own differ in exactly that field", async () => {
    const { b, id } = await room();
    await b.conv.sendTurn(id, "look in the kb", { principal: dave });
    await messages(b, id, 2, dave);
    const own = (await b.conv.history(id, { principal: dave })).entries[1];
    const other = (await b.conv.history(id, { principal: carol })).entries[1];
    expect(own?.turnExecutionId).toMatch(/^turn:/);
    expect(other).toMatchObject({ role: "assistant", status: "complete", text: own?.text });
    expect(other).not.toHaveProperty("turnExecutionId");
    expect(JSON.stringify(other)).not.toContain("turn:");
  });
});

describe("P3-6 adoption checks each stand alone", () => {
  const text = "look in the kb";
  const known = () => senderKey(id0(carol), "m-1");
  async function plant(
    b: ReturnType<typeof boot>,
    id: string,
    opts: { flow: "ours" | "forged"; principal: { actor: string; tenant?: string } }
  ) {
    const input = {
      conversationId: id,
      turn: 1,
      ord: 1,
      asker: id0(carol),
      text,
      id: known(),
      history: [],
      known: [],
    };
    const turnId = turnExecutionId(id, 1, TEST_KEY);
    if (opts.flow === "ours") {
      await b.runtime.start(b.flow.sharedTurn!.flow, input as never, {
        executionId: turnId,
        principal: opts.principal,
      });
    } else {
      const def = flow$({
        id: "forged-turn",
        name: "forged",
        version: "1.0.0",
        inputSchema: z.any(),
        outputSchema: z.any(),
        steps: [],
      });
      b.runtime.registerFlow(def, async () => ({
        status: "complete",
        content: "FORGED ANSWER",
        tools: [],
      }));
      await b.runtime.start(def, input as never, {
        executionId: turnId,
        principal: opts.principal,
      });
    }
  }

  it("ONLY the workflow differs (same principal, same input): refused", async () => {
    const { b, id } = await room();
    await plant(b, id, { flow: "forged", principal: id0(carol) });
    await b.conv.sendTurn(id, text, { principal: carol, messageId: "m-1" });
    const all = await messages(b, id, 2, carol);
    expect(all[1]).toMatchObject({ status: "failed", reason: "turn-failed" });
    expect(all[1]?.text).not.toContain("FORGED");
  });

  it("ONLY the recorded principal differs (our flow, same input): refused", async () => {
    const { b, id } = await room();
    await plant(b, id, { flow: "ours", principal: id0(dave) });
    await b.conv.sendTurn(id, text, { principal: carol, messageId: "m-1" });
    const all = await messages(b, id, 2, carol);
    expect(all[1]).toMatchObject({ status: "failed", reason: "turn-failed" });
  });

  it("NEGATIVE: the same planted execution by the RIGHT principal on OUR flow with the exact input is the one adopted", async () => {
    const { b, id } = await room();
    await plant(b, id, { flow: "ours", principal: id0(carol) });
    await b.conv.sendTurn(id, text, { principal: carol, messageId: "m-1" });
    const all = await messages(b, id, 2, carol);
    expect(all[1]).toMatchObject({ status: "complete", asker: id0(carol) });
  });
});

describe("P3-7 key rotation and domain separation", () => {
  it("an envelope signed under a PREVIOUS key is accepted only while that key is listed", async () => {
    const OLD = "the-previous-key-1";
    const b = boot({ config: { key: TEST_KEY, previousKeys: [OLD] } });
    const { conversationId: id } = await b.conv.start();
    const body = {
      kind: "user" as const,
      text: "from the old key",
      id: "old-1",
      iat: Date.now(),
      conversationId: id,
    };
    await b.runtime.send(id, { topic: "conversation:turn", payload: signedEnvelope(OLD, body) });
    const all = await messages(b, id, 2);
    expect(all[1]).toMatchObject({ status: "complete", text: "re: from the old key" });
    const strict = boot();
    const { conversationId: id2 } = await strict.conv.start();
    await strict.runtime.send(id2, {
      topic: "conversation:turn",
      payload: signedEnvelope(OLD, { ...body, conversationId: id2 }),
    });
    await strict.conv.sendTurn(id2, "after", { principal: undefined });
    const rest = await messages(strict, id2, 3);
    expect(rest[0]).toMatchObject({ status: "rejected", reason: "unauthenticated" });
  });

  it("a MAC made without the envelope domain (the same key, another purpose) is not an envelope", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    const body = {
      kind: "user" as const,
      text: "undomained",
      id: "u-1",
      iat: Date.now(),
      conversationId: id,
    };
    await b.runtime.send(id, {
      topic: "conversation:turn",
      payload: { ...body, sig: sign(TEST_KEY, body) },
    });
    await b.conv.sendTurn(id, "after");
    const all = await messages(b, id, 3);
    expect(all[0]).toMatchObject({ status: "rejected", reason: "unauthenticated" });
    expect(JSON.stringify(all)).not.toContain("undomained");
  });
});
