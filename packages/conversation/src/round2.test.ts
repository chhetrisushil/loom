import { memoryWriteBackEffect } from "@loom/agent";
import { agent$ } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import { InMemoryMemoryStore, TieredMemory } from "@loom/memory";
import { ExecutionDeniedError, executionAccessPolicy } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import {
  Latch,
  SECRET,
  SERVICE,
  TEST_KEY,
  alice,
  boot,
  carol,
  dave,
  kb,
  lastUserText,
  messages,
  ownerScoped,
  secretDb,
  sharedScript,
  signRaw,
  until,
} from "./__fixtures__/harness";
import { sign } from "./access";
import {
  ConversationNotFoundError,
  InvalidTurnError,
  QueueFullError,
  logParticipants,
  parseIdentity,
} from "./index";
import { turnExecutionId } from "./turn";

// Fix round 2 (review of shared mode): every repro was run against the reference runtime first.

const id0 = (p: { actor?: string; tenant?: string }) => ({
  actor: p.actor as string,
  ...(p.tenant !== undefined && { tenant: p.tenant }),
});
const bob = { actor: "bob", tenant: "t2" };

async function room(extra: Parameters<typeof boot>[0] = {}) {
  const b = boot({ shared: true, ...extra });
  const { conversationId: id } = await b.conv.start({ principal: alice });
  for (const p of [bob, carol, dave]) await b.conv.addParticipant(id, id0(p), { principal: alice });
  return { b, id };
}
const inboxOf = async (b: ReturnType<typeof boot>, id: string) =>
  (await b.eventStore.read(`__loom_inbox__:${id}`)).map(
    (e) => e.payload as { payload: Record<string, unknown>; messageId: string }
  );
const rejections = async (b: ReturnType<typeof boot>, id: string) =>
  (await b.conv.reader.read(id, { limit: 500, maxScan: 20_000 })).entries
    .filter((e) => e.status === "rejected")
    .map((e) => e.reason);
/** A peer who SHARES the coordinator's tenant: the strongest raw attacker the reference policy ever admitted. */
const peer = { actor: "peer", tenant: SERVICE.tenant };

describe("P1-1 a signed envelope cannot be replayed", () => {
  it("copied with a fresh messageId (the review's repro): rejected 'replayed', the model is not asked again", async () => {
    // the runtime policy is LOOSE here (tenant-scoped, acknowledged): the body must hold on its own
    const { b, id } = await room({ policy: executionAccessPolicy(), ackPolicy: true });
    await b.conv.sendTurn(id, "use the secret db", { principal: dave });
    await messages(b, id, 2, dave);
    const stolen = (await inboxOf(b, id))[0]?.payload as Record<string, unknown>;
    const callsBefore = b.calls.n;
    await b.runtime.send(
      id,
      { topic: "conversation:turn", payload: stolen, messageId: "fresh-1" },
      { principal: peer }
    );
    await b.runtime.send(
      id,
      { topic: "conversation:turn", payload: stolen, messageId: "fresh-2" },
      { principal: peer }
    );
    await b.conv.sendTurn(id, "legit after", { principal: carol });
    await messages(b, id, 5, carol);
    expect(await rejections(b, id)).toEqual(["replayed", "replayed"]);
    expect(b.calls.n).toBe(callsBefore + 1); // only carol's own message reached the model
    const users = (await b.conv.reader.read(id, { limit: 100 })).entries.filter(
      (e) => e.role === "user"
    );
    expect(users.filter((u) => u.status === "complete").map((u) => u.asker?.actor)).toEqual([
      "dave",
      "carol",
    ]);
  });

  it("an envelope for ANOTHER conversation, a tampered text and a stale one are refused", async () => {
    const { b, id } = await room({ policy: executionAccessPolicy(), ackPolicy: true });
    const other = await b.conv.start({ principal: alice });
    await b.conv.addParticipant(other.conversationId, id0(dave), { principal: alice });
    await b.conv.sendTurn(other.conversationId, "hello there", { principal: dave });
    await messages(b, other.conversationId, 2, dave);
    const envelopeForOther = (await inboxOf(b, other.conversationId))[0]?.payload as Record<
      string,
      unknown
    >;
    // lifted into THIS conversation
    await b.runtime.send(
      id,
      { topic: "conversation:turn", payload: envelopeForOther, messageId: "m-a" },
      { principal: peer }
    );
    // the text changed after signing
    const mine = signRaw(id, { kind: "user", text: "original", asker: id0(dave) });
    await b.runtime.send(
      id,
      { topic: "conversation:turn", payload: { ...mine, text: "tampered" }, messageId: "m-b" },
      { principal: peer }
    );
    // validly signed, but issued two hours ago
    const old = signRaw(id, {
      kind: "user",
      text: "old news",
      asker: id0(dave),
      iat: Date.now() - 2 * 3600_000,
    });
    await b.runtime.send(
      id,
      { topic: "conversation:turn", payload: old, messageId: "m-c" },
      { principal: peer }
    );
    await b.conv.sendTurn(id, "fine", { principal: carol });
    await messages(b, id, 3, carol);
    expect(await rejections(b, id)).toEqual(["unauthenticated", "unauthenticated", "stale"]);
    expect(b.calls.n).toBe(2); // dave's message in the OTHER conversation, and carol's here
  });

  it("on the reference (owner-scoped) policy the raw send is refused outright", async () => {
    const { b, id } = await room();
    await b.conv.sendTurn(id, "use the secret db", { principal: dave });
    await messages(b, id, 2, dave);
    const stolen = (await inboxOf(b, id))[0]?.payload as Record<string, unknown>;
    await expect(
      b.runtime.send(
        id,
        { topic: "conversation:turn", payload: stolen, messageId: "x" },
        { principal: peer }
      )
    ).rejects.toBeInstanceOf(ExecutionDeniedError);
  });
});

describe("P1-3 the raw runtime does not expose the unfiltered transcript", () => {
  it("a peer cannot load, cancel or fork the coordinator or a turn execution; the coordinator is the SERVICE's", async () => {
    const { b, id } = await room();
    await b.conv.sendTurn(id, "use the secret db", { principal: dave });
    const all = await messages(b, id, 2, dave);
    const turnId = all[1]?.turnExecutionId as string;
    const nosy = { actor: "nosy", tenant: "t3" }; // dave's tenant: a "tenant peer" of the asker
    for (const target of [id, turnId]) {
      await expect(b.runtime.loadState(target, { principal: nosy })).rejects.toBeInstanceOf(
        ExecutionDeniedError
      );
      await expect(b.runtime.loadState(target, { principal: alice })).rejects.toBeInstanceOf(
        ExecutionDeniedError
      );
      await expect(b.runtime.cancel(target, "x", { principal: nosy })).rejects.toBeInstanceOf(
        ExecutionDeniedError
      );
      await expect(b.runtime.fork(target, 1, { principal: nosy })).rejects.toBeInstanceOf(
        ExecutionDeniedError
      );
    }
    // the asker themself owns their turn execution; nobody owns the coordinator but the service
    await expect(b.runtime.loadState(turnId, { principal: dave })).resolves.toBeDefined();
    await expect(b.runtime.loadState(id, { principal: SERVICE })).resolves.toBeDefined();
    const coord = (await b.eventStore.read(id))[0];
    expect(JSON.stringify(coord?.payload)).toContain(SERVICE.actor);
  });

  it("the service identity can be nobody's: not an owner, not a participant, not a viewer", async () => {
    const { b, id } = await room();
    await expect(b.conv.start({ principal: SERVICE })).rejects.toBeInstanceOf(InvalidTurnError);
    await expect(
      b.conv.addParticipant(id, id0(SERVICE), { principal: alice })
    ).rejects.toBeInstanceOf(InvalidTurnError);
    await expect(b.conv.history(id, { principal: SERVICE })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
  });

  it("a coordinator someone started as THEMSELVES, claiming another owner, matches nobody", async () => {
    const { b } = await room();
    await b.runtime.start(
      b.flow as never,
      { v: 1, seq: 0, ord: 0, turns: [], owner: id0(alice) } as never,
      {
        executionId: "usurped",
        principal: { actor: "eve", tenant: "t9" },
      }
    );
    await expect(b.conv.history("usurped", { principal: alice })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
    await expect(
      b.conv.history("usurped", { principal: { actor: "eve", tenant: "t9" } })
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("construction: a shared conversation needs a service principal, and refuses a looser runtime policy", () => {
    expect(() => boot({ shared: { servicePrincipal: undefined as never } })).toThrow(
      /servicePrincipal/
    );
    expect(() =>
      boot({
        shared: true,
        policy: executionAccessPolicy(),
        ackPolicy: false,
        conversations: { policy: executionAccessPolicy() },
      })
    ).toThrow(/owner-scoped|"query"/);
  });
});

describe("P2-b a conflicting owner record is its own state", () => {
  it("it refuses everyone, the anonymous caller included", async () => {
    const b = boot({ secure: true });
    await b.runtime.start(
      b.flow as never,
      { v: 1, seq: 0, ord: 0, turns: [], owner: { actor: "mallory", tenant: "t2" } } as never,
      { executionId: "forged", principal: alice }
    );
    for (const who of [undefined, alice, { actor: "mallory", tenant: "t2" }]) {
      await expect(b.conv.history("forged", who && { principal: who })).rejects.toBeInstanceOf(
        ConversationNotFoundError
      );
    }
  });
});

describe("P1-4 the turn execution's id cannot be guessed, and a planted one is never adopted", () => {
  it("the id carries an HMAC of (conversation, ordinal) under the host's key", () => {
    const a = turnExecutionId("c1", 1, "key-one-key-one");
    expect(a).toMatch(/^turn:c1:o1:[0-9a-f]{24}$/);
    expect(turnExecutionId("c1", 1, "key-one-key-one")).toBe(a);
    expect(turnExecutionId("c1", 1, "key-two-key-two")).not.toBe(a);
    expect(turnExecutionId("c1", 2, "key-one-key-one")).not.toBe(a);
  });

  it("an execution planted at the OLD predictable id changes nothing", async () => {
    const { b, id } = await room();
    await b.runtime.start(b.flow.sharedTurn!.flow, { text: "forged" } as never, {
      executionId: `turn:${id}:o1`,
      principal: id0(bob),
    });
    await b.conv.sendTurn(id, "look in the kb", { principal: carol });
    const all = await messages(b, id, 2, carol);
    expect(all[1]).toMatchObject({ status: "complete", asker: id0(carol) });
    expect(all[1]?.text).toContain("public-fact");
  });

  it("an execution planted at the REAL id by someone else is refused, not adopted (fail closed, host told why)", async () => {
    const errors: unknown[] = [];
    const { b, id } = await room({ config: { onError: (_i, e) => errors.push(e) } });
    // the attacker somehow learned the id (a leaked log, a future bug): plant a "finished" turn as THEMSELVES
    const turnId = turnExecutionId(id, 1, TEST_KEY);
    await b.runtime.start(
      b.flow.sharedTurn!.flow,
      {
        conversationId: id,
        turn: 1,
        ord: 1,
        asker: id0(carol),
        text: "FORGED QUESTION",
        history: [],
        known: [],
      } as never,
      { executionId: turnId, principal: id0(bob) }
    );
    await b.conv.sendTurn(id, "look in the kb", { principal: carol });
    const all = await messages(b, id, 2, carol);
    expect(all[1]).toMatchObject({ status: "failed", reason: "turn-failed", asker: id0(carol) });
    expect(all[1]?.text).not.toContain("FORGED");
    expect(String((errors[0] as Error).message)).toMatch(/refused to adopt/);
  });

  it("right principal, wrong content (a different text under the same id) is refused too", async () => {
    const { b, id } = await room();
    const turnId = turnExecutionId(id, 1, TEST_KEY);
    await b.runtime.start(
      b.flow.sharedTurn!.flow,
      {
        conversationId: id,
        turn: 1,
        ord: 1,
        asker: id0(carol),
        text: "something else",
        history: [],
        known: [],
      } as never,
      { executionId: turnId, principal: id0(carol) }
    );
    await b.conv.sendTurn(id, "look in the kb", { principal: carol });
    const all = await messages(b, id, 2, carol);
    expect(all[1]).toMatchObject({ status: "failed", reason: "turn-failed" });
  });
});

describe("P1-5 a delegated sender is not run as their full self", () => {
  const delegated = {
    actor: "bot",
    tenant: "t4",
    delegation: { id: "d1", scope: [], sig: "x" },
  } as never;
  it("is refused in a shared conversation unless the host maps identity to a principal", async () => {
    const { b, id } = await room();
    await b.conv.addParticipant(id, { actor: "bot", tenant: "t4" }, { principal: alice });
    await expect(
      b.conv.sendTurn(id, "look in the kb", { principal: delegated })
    ).rejects.toBeInstanceOf(InvalidTurnError);
    expect(b.calls.n).toBe(0);
  });

  it("with principalFor the turn runs as the PRINCIPAL THE HOST MAPS (here: narrower than the actor's own grants)", async () => {
    const mapped: string[] = [];
    const { b, id } = await room({
      conversations: {
        principalFor: (a: { actor: string; tenant?: string }) => {
          mapped.push(a.actor);
          return { actor: "limited-bot", tenant: "t4" };
        },
      },
    });
    await b.conv.addParticipant(id, { actor: "bot", tenant: "t4" }, { principal: alice });
    await b.conv.sendTurn(id, "use the secret db", { principal: delegated });
    const all = await messages(b, id, 2, { actor: "bot", tenant: "t4" });
    expect(all[1]).toMatchObject({ status: "failed", reason: "denied" });
    expect(JSON.stringify(all)).not.toContain(SECRET);
    expect(mapped).toContain("bot");
  });
});

describe("P1-6 memory in a shared conversation is per asker", () => {
  const memory = () =>
    new TieredMemory({ store: new InMemoryMemoryStore(), tiers: { working: { maxEntries: 100 } } });
  const withMemory = (mem: TieredMemory) => ({
    config: {
      agent: {
        definition: agent$({ id: "chat", name: "Chat", tools: [kb, secretDb] }),
        modelToolId: "model",
        memory: mem,
        writeBack: { toolId: "memwrite" },
      },
      shared: undefined as never,
    },
    extraEffects: (e: { register(id: string, fx: never): void }) =>
      e.register("memwrite", memoryWriteBackEffect(mem) as never),
  });

  it("construction refuses a constant scope, a missing scope function and a direct write-back", () => {
    const mem = memory();
    const base = (agent: Record<string, unknown>) => () =>
      boot({
        shared: true,
        config: {
          agent: {
            definition: agent$({ id: "c", name: "c", tools: [] }),
            modelToolId: "m",
            ...agent,
          } as never,
        },
      });
    expect(base({ memory: mem, memoryScope: "everyone" })).toThrow(/constant/);
    expect(base({ memory: mem })).toThrow(/memoryScope/);
    expect(base({ memory: mem, writeBack: { allowDirect: true } })).toThrow(/toolId/);
    expect(base({ memory: mem, writeBack: { toolId: "w", scope: "x" } })).toThrow(/scope/);
  });

  it("one participant's remembered answer never reaches another's prompt; the answer is classified by the scope it drew on", async () => {
    const mem = memory();
    const w = withMemory(mem);
    const b = boot({
      shared: { memoryScope: (a) => `scope:${a.actor}` },
      config: { agent: w.config.agent as never },
      extraEffects: w.extraEffects as never,
    });
    const { conversationId: id } = await b.conv.start({ principal: alice });
    for (const p of [carol]) await b.conv.addParticipant(id, id0(p), { principal: alice });
    await b.conv.sendTurn(id, "use the secret db", { principal: alice });
    const mine = await messages(b, id, 2, alice);
    expect(mine[1]?.text).toContain(SECRET);
    await until(
      async () => (await mem.recall("working", "scope:alice")).length > 0,
      "alice's write-back"
    );
    await b.conv.sendTurn(id, "what do you remember?", { principal: carol });
    const all = await messages(b, id, 4, carol);
    expect(JSON.stringify(b.requests.at(-1))).not.toContain(SECRET); // carol's prompt: none of alice's memory
    expect(
      (await mem.recall("working", "scope:carol")).map((e) => String(e.content)).join()
    ).not.toContain(SECRET);
    const raw = (await b.conv.reader.read(id)).entries;
    expect(raw[1]?.classes).toEqual(["memory:scope:alice", "restricted"]);
    expect(raw[3]?.classes).toEqual(["memory:scope:carol"]);
    // alice's memory-derived answer is hidden from carol, who is not cleared for her scope
    expect(all[1]).toMatchObject({ status: "restricted", text: "" });
  });
});

describe("P2-a a question is classified like its answer", () => {
  it("a question asked against restricted context is restricted for the uncleared", async () => {
    const { b, id } = await room();
    await b.conv.sendTurn(id, "use the secret db", { principal: alice });
    await messages(b, id, 2, alice);
    await b.conv.sendTurn(id, "summarize the secret finding in your own words", {
      principal: dave,
    });
    await messages(b, id, 4, dave);
    const raw = (await b.conv.reader.read(id)).entries;
    expect(raw[0]?.classes).toBeUndefined(); // alice's first question had no context
    expect(raw[2]?.classes).toEqual(["restricted"]); // dave's question was built on alice's restricted answer
    const asCarol = (await b.conv.history(id, { principal: carol })).entries;
    expect(asCarol[0]).toMatchObject({ text: "use the secret db" });
    expect(asCarol[2]).toMatchObject({ role: "user", status: "restricted", text: "" });
    expect(JSON.stringify(asCarol)).not.toContain("summarize the secret finding");
    // the asker and a cleared viewer read it
    expect((await b.conv.history(id, { principal: dave })).entries[2]?.text).toContain("summarize");
    expect((await b.conv.history(id, { principal: alice })).entries[2]?.text).toContain(
      "summarize"
    );
  });
});

describe("clearance is a strict boolean, and required", () => {
  it("a truthy non-true verdict from `cleared` is NOT clearance: history and context both refuse", async () => {
    const { b, id } = await room({ shared: { cleared: (() => "yes") as never } });
    await b.conv.sendTurn(id, "use the secret db", { principal: alice });
    await messages(b, id, 2, alice);
    const asDave = (await b.conv.history(id, { principal: dave })).entries;
    expect(asDave[1]).toMatchObject({ status: "restricted", text: "" });
    await b.conv.sendTurn(id, "anything new?", { principal: dave });
    await messages(b, id, 4, dave);
    expect(JSON.stringify(b.requests.at(-1))).not.toContain(SECRET); // and not in dave's context either
    // the asker keeps their own answer regardless
    expect((await b.conv.history(id, { principal: alice })).entries[1]?.text).toContain(SECRET);
  });

  it("construction refuses a shared conversation with no `cleared`", () => {
    expect(() => boot({ shared: { cleared: undefined as never } })).toThrow(/cleared/);
  });
});

describe("P3 fairness and floods", () => {
  it("one asker cannot fill the queue: past maxQueuedPerAsker their send is refused, others are not", async () => {
    const started = new Latch();
    const gate = new Latch();
    const { b, id } = await room({
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
    await b.conv.sendTurn(id, "c1", { principal: carol });
    await b.conv.sendTurn(id, "c2", { principal: carol });
    await expect(b.conv.sendTurn(id, "c3", { principal: carol })).rejects.toBeInstanceOf(
      QueueFullError
    );
    await b.conv.sendTurn(id, "d1", { principal: dave }); // another asker is unaffected
    gate.release();
    await messages(b, id, 8, alice);
    expect(
      (await b.conv.reader.read(id, { limit: 100 })).entries
        .filter((e) => e.role === "user")
        .map((e) => e.text)
    ).toEqual(["hold", "c1", "c2", "d1"]);
  });

  it("a flood of forged envelopes is recorded up to a cap and then only COUNTED", async () => {
    const { b, id } = await room({
      policy: executionAccessPolicy(),
      ackPolicy: true,
      config: { maxInvalidRecords: 3 },
    });
    for (let i = 0; i < 105; i++) {
      await b.runtime.send(
        id,
        {
          topic: "conversation:turn",
          payload: { kind: "user", text: `junk ${i}`, sig: "0".repeat(64) },
          messageId: `j${i}`,
        },
        { principal: peer }
      );
    }
    await b.conv.sendTurn(id, "look in the kb", { principal: carol });
    await until(
      async () =>
        (await b.conv.reader.read(id, { limit: 500, maxScan: 20_000 })).entries.some(
          (e) => e.role === "assistant"
        ),
      "the legitimate turn, after the flood"
    );
    expect((await rejections(b, id)).length).toBe(3);
    const counters = (await b.eventStore.read(id)).filter(
      (e) => (e.payload as { choice?: { kind?: string } } | null)?.choice?.kind === "dropped"
    );
    expect(counters.map((e) => (e.payload as { choice: { count: number } }).choice.count)).toEqual([
      100,
    ]);
  });
});

describe("P3 smaller findings", () => {
  it("a forged participant event on the side stream (wrong workflow) is ignored, whoever wrote it", async () => {
    const { b, id } = await room();
    const stream = `conversation-participants:${id}`;
    const tip = (await b.eventStore.read(stream)).length;
    await b.eventStore.append({
      id: `${stream}#forged`,
      workflowId: "not-ours",
      executionId: stream,
      eventType: "PARTICIPANT_CHANGED",
      sequence: tip,
      timestamp: Date.now(),
      payload: { op: "add", identity: { actor: "mallory", tenant: "t2" }, by: id0(alice) },
    });
    await b.eventStore.append({
      id: `${stream}#forged2`,
      workflowId: "conversation-participants",
      executionId: stream,
      eventType: "SOMETHING_ELSE",
      sequence: tip + 1,
      timestamp: Date.now(),
      payload: { op: "add", identity: { actor: "mallory", tenant: "t2" }, by: id0(alice) },
    });
    expect((await logParticipants(b.eventStore).list(id)).map((i) => i.actor).sort()).toEqual([
      "bob",
      "carol",
      "dave",
    ]);
    await expect(
      b.conv.history(id, { principal: { actor: "mallory", tenant: "t2" } })
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("the shared summary is not dropped for everyone because it crowded ONE asker's turn out", async () => {
    const { b } = await room({
      config: {
        rotateEveryTurns: 1,
        budget: {
          contextWindow: 300,
          reserveOutputTokens: 0,
          counter: { perMessage: 0, count: (t: string) => t.length },
        },
      },
    });
    const huge = "enormous ".repeat(1500);
    await b.runtime.start(
      b.flow as never,
      { v: 1, seq: 0, ord: 0, turns: [], owner: id0(alice), summary: huge } as never,
      { executionId: "sum-1", principal: SERVICE }
    );
    await b.conv.addParticipant("sum-1", id0(carol), { principal: alice });
    await b.conv.sendTurn("sum-1", "hi", { principal: carol });
    const all = await messages(b, "sum-1", 2, carol);
    expect(all[1]).toMatchObject({ status: "complete" }); // not wedged, not rejected
    expect(JSON.stringify(b.requests[0])).not.toContain("enormous"); // this turn went without it
    await b.conv.sendTurn("sum-1", "and again", { principal: carol }); // rotation happens when the NEXT message is consumed
    await until(async () => (await b.eventStore.read("sum-1~1")).length > 0, "the rotation");
    const carried = (
      (await b.eventStore.read("sum-1~1"))[0]?.payload as { input: { summary?: string } }
    ).input.summary;
    expect(carried?.startsWith("enormous")).toBe(true); // the shared summary survived for the others
    void parseIdentity;
    void sign;
    void ownerScoped;
    void TEST_KEY;
    void ToolEffect;
  });
});
