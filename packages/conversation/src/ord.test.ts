import { describe, expect, it } from "vitest";
import {
  alice,
  boot,
  carol,
  cloneStreams,
  dave,
  messages,
  signRaw,
  until,
} from "./__fixtures__/harness";
import { CONVERSATION_TOPIC, RECORD_SOURCE } from "./index";

// R17 follow-up (ADR 0122 amendment): a unique per-record `ord`, rejected records that are no turn, and a
// signed `editOf`.

const asId = (p: { actor: string; tenant?: string }) => ({
  actor: p.actor,
  ...(p.tenant !== undefined && { tenant: p.tenant }),
});

async function sharedConv() {
  const b = boot({ shared: true });
  const { conversationId: id } = await b.conv.start({ principal: alice });
  await b.conv.addParticipant(id, asId(carol), { principal: alice });
  await b.conv.addParticipant(id, asId(dave), { principal: alice });
  return { b, id };
}

describe("rejected records are no turn, and every record has a unique ord", () => {
  it("4 rejected + 1 accepted no longer share a turn number; ords are unique and increasing", async () => {
    const b = boot({ config: { maxTurnChars: 20 } });
    const { conversationId: id } = await b.conv.start();
    await b.runtime.send(id, { topic: CONVERSATION_TOPIC, payload: { kind: "user" } });
    await b.runtime.send(id, { topic: CONVERSATION_TOPIC, payload: "just a string" });
    await b.runtime.send(id, {
      topic: CONVERSATION_TOPIC,
      payload: signRaw(id, { kind: "user", text: "x".repeat(21) }),
    });
    await b.runtime.send(id, {
      topic: CONVERSATION_TOPIC,
      payload: signRaw(id, { kind: "user", text: "   " }),
    });
    await b.conv.sendTurn(id, "fine");
    const all = await messages(b, id, 6);
    expect(all.map((m) => [m.status, m.turn])).toEqual([
      ["rejected", 0],
      ["rejected", 0],
      ["rejected", 0],
      ["rejected", 0],
      ["complete", 1],
      ["complete", 1],
    ]);
    expect(all.map((m) => m.ord)).toEqual([1, 2, 3, 4, 5, 6]);
    // status counts ACCEPTED turns, whatever rejected records trail them
    await b.runtime.send(id, { topic: CONVERSATION_TOPIC, payload: { kind: "user" } });
    await messages(b, id, 7);
    expect((await b.conv.status(id)).turns).toBe(1);
  });

  it("ord is unique and monotonic across continue-as-new rotations", async () => {
    const b = boot({ config: { rotateEveryTurns: 2 } });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 5; i++) {
      await b.conv.sendTurn(id, `q${i}`);
      await messages(b, id, i * 2);
    }
    const all = (await b.conv.history(id, { limit: 100 })).entries;
    expect(new Set(all.map((m) => m.executionId)).size).toBeGreaterThan(1); // it did rotate
    expect(all.map((m) => m.ord)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const back = (await b.conv.history(id, { limit: 100, direction: "backward" })).entries;
    expect(back.map((m) => m.ord)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("a log written before R17b (no ord, rejected on the next turn's number) is still read, and resumes without divergence", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    await b.runtime.send(id, { topic: CONVERSATION_TOPIC, payload: { kind: "user" } });
    await b.conv.sendTurn(id, "one");
    await messages(b, id, 3);
    // Rewrite the durable transcript the way the old body wrote it: no `ord`, rejected on turn seq + 1.
    const inbox = `__loom_inbox__:${id}`;
    const crashed = await cloneStreams(b.eventStore, [id, inbox]);
    const evs = await crashed.read(id);
    const old = new (crashed.constructor as new () => typeof crashed)();
    for (const e of evs) {
      const p = e.payload as { source?: string; choice?: Record<string, unknown> };
      if (e.eventType === "DECISION_RECORDED" && p.source === RECORD_SOURCE) {
        const { ord: _o, ...rest } = p.choice as Record<string, unknown>;
        await old.append({
          ...e,
          payload: { ...p, choice: { ...rest, ...(rest.status === "rejected" && { turn: 1 }) } },
        });
      } else await old.append(e);
    }
    for (const e of await crashed.read(inbox)) await old.append(e);
    const survivor = boot({ store: old });
    const entries = (await survivor.conv.history(id)).entries;
    expect(entries.map((m) => [m.status, m.turn, m.ord])).toEqual([
      ["rejected", 1, undefined],
      ["complete", 1, undefined],
      ["complete", 1, undefined],
    ]);
    const folded = await survivor.runtime.loadState(id);
    await survivor.runtime.restoreFromState(folded as never);
    await survivor.conv.sendTurn(id, "two");
    await until(async () => (await survivor.conv.history(id)).entries.length >= 5);
    const after = (await survivor.conv.history(id)).entries;
    expect(after.slice(0, 3)).toEqual(entries); // byte-identical: nothing recorded earlier changed
    expect(after.slice(3).map((m) => [m.text, m.turn, typeof m.ord])).toEqual([
      ["two", 2, "number"],
      ["re: two", 2, "number"],
    ]);
    expect(survivor.calls.n).toBe(1); // only the new turn reached the model
    expect((await survivor.runtime.loadState(id))?.status).not.toBe("failed"); // no divergence failure
  });
});

describe("editOf: a signed, validated edit of an earlier turn", () => {
  it("owner: an edit is a NEW turn that records editOf and tells the model what it replaces", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "what is 2+2");
    const first = await messages(b, id, 2);
    await b.conv.sendTurn(id, "what is 3+3", { editOf: first[0]?.ord as number });
    const all = await messages(b, id, 4);
    expect(all[2]).toMatchObject({
      role: "user",
      status: "complete",
      turn: 2,
      text: "what is 3+3", // the transcript shows what the user typed
      editOf: first[0]?.ord,
    });
    expect(all[0]?.editOf).toBeUndefined();
    const prompt = JSON.stringify(b.requests.at(-1)?.messages);
    expect(prompt).toContain("what is 2+2"); // the earlier text is in the context anyway, as data
    expect(prompt).toContain("edits the user's earlier message");
    expect(prompt).toContain("<untrusted-input"); // fenced like any user text
  });

  it("invalid references are rejected with a fixed reason and NOT obeyed: assistant turn, rejected record, unknown ord", async () => {
    const b = boot({ config: { maxTurnChars: 20 } });
    const { conversationId: id } = await b.conv.start();
    await b.runtime.send(id, { topic: CONVERSATION_TOPIC, payload: { kind: "user" } }); // rejected, ord 1
    await b.conv.sendTurn(id, "real"); // user ord 2, assistant ord 3
    await messages(b, id, 3);
    const calls = b.calls.n;
    let n = 3;
    for (const bad of [1, 3, 999, 4]) {
      // 4 = the id of the record the rejection itself is about to take: not a user turn yet
      await b.conv.sendTurn(id, "edited", { editOf: bad });
      n++;
      const all = await messages(b, id, n);
      expect(all.at(-1)).toMatchObject({ status: "rejected", reason: "edit-invalid", turn: 0 });
      expect(all.at(-1)?.editOf).toBeUndefined();
    }
    expect(b.calls.n).toBe(calls); // nothing was sent to the model
    expect((await b.conv.status(id)).turns).toBe(1);
  });

  it("an edit of a turn that fell out of the prompt window is refused (fail closed)", async () => {
    const b = boot({ config: { maxWindowTurns: 1 } });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "a");
    const first = await messages(b, id, 2);
    await b.conv.sendTurn(id, "b");
    await messages(b, id, 4);
    await b.conv.sendTurn(id, "c");
    await messages(b, id, 6);
    await b.conv.sendTurn(id, "d", { editOf: first[0]?.ord as number });
    const all = await messages(b, id, 7);
    expect(all.at(-1)).toMatchObject({ status: "rejected", reason: "edit-invalid" });
  });

  it("the client refuses a malformed editOf before anything is sent", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(b.conv.sendTurn(id, "x", { editOf: bad })).rejects.toThrow(/editOf/);
    }
  });

  it("forging editOf outside the signature is refused as unauthenticated; a signed non-integer is malformed", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "hello");
    const first = await messages(b, id, 2);
    const calls = b.calls.n;
    const signed = signRaw(id, { kind: "user", text: "sneaky" });
    await b.runtime.send(id, {
      topic: CONVERSATION_TOPIC,
      payload: { ...signed, editOf: first[0]?.ord }, // added after signing
    });
    await b.runtime.send(id, {
      topic: CONVERSATION_TOPIC,
      payload: signRaw(id, { kind: "user", text: "odd", editOf: "1" } as never),
    });
    const all = await messages(b, id, 4);
    expect(all.slice(2).map((m) => [m.status, m.reason])).toEqual([
      ["rejected", "unauthenticated"],
      ["rejected", "malformed"],
    ]);
    expect(b.calls.n).toBe(calls);
  });

  it("shared: you may edit your own turn, never another asker's (rejected, nothing leaked or obeyed)", async () => {
    const { b, id } = await sharedConv();
    await b.conv.sendTurn(id, "carol asks", { principal: carol });
    const first = await messages(b, id, 2, carol);
    const calls = b.calls.n;
    await b.conv.sendTurn(id, "dave edits carol", {
      principal: dave,
      editOf: first[0]?.ord as number,
    });
    const afterDave = await messages(b, id, 3, dave);
    expect(afterDave.at(-1)).toMatchObject({
      status: "rejected",
      reason: "edit-invalid",
      asker: asId(dave),
    });
    expect(b.calls.n).toBe(calls);
    await b.conv.sendTurn(id, "carol edits carol", {
      principal: carol,
      editOf: first[0]?.ord as number,
    });
    const all = await messages(b, id, 5, carol);
    expect(all.at(-2)).toMatchObject({
      role: "user",
      status: "complete",
      editOf: first[0]?.ord,
      asker: asId(carol),
    });
  });

  it("shared: a restricted placeholder keeps ord but carries no text and no editOf", async () => {
    const { b, id } = await sharedConv();
    await b.conv.sendTurn(id, "use the secret db", { principal: alice });
    const asAlice = await messages(b, id, 2, alice);
    await b.conv.sendTurn(id, "use the secret db again", {
      principal: alice,
      editOf: asAlice[0]?.ord as number,
    });
    await messages(b, id, 4, alice);
    const asCarol = (await b.conv.history(id, { principal: carol })).entries;
    const hidden = asCarol.filter((e) => e.status === "restricted");
    expect(hidden.length).toBeGreaterThan(0);
    for (const h of hidden) {
      expect(typeof h.ord).toBe("number");
      expect(h.text).toBe("");
      expect(h.editOf).toBeUndefined();
    }
    expect(JSON.stringify(hidden)).not.toContain("TOP-SECRET");
  });
});

describe("R17b fix round 1", () => {
  it("P1: an edit of a turn the budget dropped from the prompt still inherits its classes (no restricted quote in an unrestricted reply)", async () => {
    const perChar = { perMessage: 0, count: (t: string) => t.length };
    const { conversationId: id, b } = await (async () => {
      const b = boot({
        shared: true,
        config: { budget: { contextWindow: 400, reserveOutputTokens: 0, counter: perChar } },
      });
      const { conversationId } = await b.conv.start({ principal: alice });
      await b.conv.addParticipant(conversationId, asId(carol), { principal: alice });
      return { conversationId, b };
    })();
    await b.conv.sendTurn(id, "use the secret db", { principal: alice });
    await messages(b, id, 2, alice);
    await b.conv.sendTurn(id, "repeat TOP-SECRET-PAYLOAD", { principal: alice });
    const xs = await messages(b, id, 4, alice);
    const x = xs[2]?.ord as number;
    await b.conv.sendTurn(id, `fix ${"z".repeat(240)}`, { principal: alice, editOf: x });
    const all = await messages(b, id, 6, alice);
    expect(all[4]).toMatchObject({ editOf: x, editOfTurn: 2 });
    const asCarol = (await b.conv.history(id, { principal: carol })).entries;
    expect(JSON.stringify(asCarol)).not.toContain("TOP-SECRET");
    expect(asCarol.slice(2).every((e) => e.status === "restricted" || e.role === "user")).toBe(
      true
    );
    expect(asCarol[5]?.status).toBe("restricted");
    expect(asCarol[4]?.editOfTurn).toBeUndefined(); // hidden or not, a placeholder never carries it
  });

  it("P2: an edit records editOfTurn (the edited turn's number) beside editOf (its ord)", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "one");
    await messages(b, id, 2);
    await b.conv.sendTurn(id, "two");
    const xs = await messages(b, id, 4);
    await b.conv.sendTurn(id, "two, better", { editOf: xs[2]?.ord as number });
    const all = await messages(b, id, 6);
    expect(all[4]).toMatchObject({ editOf: xs[2]?.ord, editOfTurn: 2, turn: 3 });
    expect(all[0]?.editOfTurn).toBeUndefined();
  });

  it("P3-1: status().turns survives more than 100 trailing rejections", async () => {
    const b = boot({ config: { maxTurnChars: 20 } });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "ok");
    await messages(b, id, 2);
    for (let i = 0; i < 101; i++) {
      await b.runtime.send(id, {
        topic: CONVERSATION_TOPIC,
        payload: signRaw(id, { kind: "user", text: "x".repeat(21) }),
      });
    }
    await until(
      async () =>
        (await b.conv.history(id, { direction: "backward", limit: 1 })).entries[0]?.ord === 103,
      "103 records"
    );
    expect((await b.conv.status(id)).turns).toBe(1);
  });

  it("P3-2: an edit of a turn carried across continue-as-new works", async () => {
    const b = boot({ config: { rotateEveryTurns: 1 } });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "first");
    const first = await messages(b, id, 2);
    await b.conv.sendTurn(id, "second");
    await messages(b, id, 4);
    await b.conv.sendTurn(id, "first, again", { editOf: first[0]?.ord as number });
    const all = await messages(b, id, 6);
    expect(new Set(all.map((m) => m.executionId)).size).toBeGreaterThan(2);
    expect(all[4]).toMatchObject({ status: "complete", editOf: first[0]?.ord, editOfTurn: 1 });
  });
});
