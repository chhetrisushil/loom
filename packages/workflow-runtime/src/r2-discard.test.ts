import { unwrapTainted } from "@loom/classify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inboxBackends } from "./__tests__/r2Backends";
import { Latch, build, eventsOf, flow, kinds, slow, until } from "./__tests__/r2Harness";
import { executionAccessPolicy } from "./executionAccessPolicy";
import { cursorsOf, inboxStreamId } from "./inbox";
import {
  ExecutionDeniedError,
  InboxClosedError,
  InboxDiscardRefusedError,
  InboxFullError,
} from "./types";

// ADR 0110 amendment (D8) — a journaled, authorized operator discard.

const owner = { actor: "alice", tenant: "t1" };
const ops = { actor: "ops", tenant: "t1" };
const mallory = { actor: "mallory", tenant: "t2" };

for (const backend of inboxBackends("discard")) {
  describe.skipIf(backend.skip === true)(`operator discard on ${backend.name}`, () => {
    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());
    let seq = 0;
    const id = () => `${backend.name}-e${++seq}-${Math.random().toString(36).slice(2, 6)}`;
    const mk = (deps = {}, opts: Parameters<typeof build>[1] = {}) =>
      build(deps, { ...backend.make(), ...opts });
    const consumedCount = async (h: ReturnType<typeof build>, e: string) =>
      (await eventsOf(h.eventStore, e, "MESSAGE_CONSUMED")).length;
    /** A hot-topic consumer loop with a cold topic read only at the very end. */
    const hotLoop = (n: number) =>
      flow("w", async (ctx) => {
        for (let i = 0; i < n; i++) unwrapTainted(await ctx.receive("hot"));
        return unwrapTainted(await ctx.receive("cold"));
      });

    it("releases a stream one unconsumed cold message pins; the skip is a log fact that replays", async () => {
      const h = mk({ inboxMaxBacklog: 10, inboxMaxRetained: 20 });
      const f = hotLoop(1000);
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      const cold = await h.rt.send(e, {
        topic: "cold",
        payload: { secret: "SECRET-PAYLOAD" },
        messageId: "c0",
      });
      expect(cold.inboxSeq).toBe(0);
      // Hot traffic is consumed live, yet the cold message at sequence 0 pins every entry above it.
      let refused: unknown;
      let sent = 0;
      for (; sent < 60 && refused === undefined; sent++) {
        try {
          await h.rt.send(e, { topic: "hot", payload: sent, messageId: `h${sent}` });
        } catch (err) {
          refused = err;
          break;
        }
        await until(async () => (await consumedCount(h, e)) === sent + 1);
      }
      expect(refused).toBeInstanceOf(InboxFullError);
      expect((refused as Error).message).toMatch(/inbox sequence 0/);

      const res = await h.rt.discardInbox(e, { topic: "cold", throughSeq: 0, reason: "stale" });
      expect(res).toMatchObject({ executionId: e, topic: "cold", skipped: 1, cursor: 0 });

      // The pin is gone: the stream accepts hot traffic again and its consumed prefix was trimmed.
      await h.rt.send(e, { topic: "hot", payload: "after", messageId: "after" });
      await until(async () => (await consumedCount(h, e)) === sent + 2);
      const retained = await h.eventStore.read(inboxStreamId(e));
      // (the store always keeps sequence 0; everything consumed above it is gone)
      expect(retained.length).toBeLessThan(6);

      // It is a fact in the OWNER's log: ignorable, no payload copied, the operator recorded.
      const fact = (await eventsOf(h.eventStore, e, "MESSAGE_CONSUMED")).find(
        (c) => (c.payload as { discarded?: boolean }).discarded === true
      );
      expect(fact?.metadata?.kernel).toBe(true);
      expect(fact?.payload).toMatchObject({
        topic: "cold",
        inboxSeq: 0,
        payload: null,
        skipped: 1,
        reason: "stale",
        sender: {},
      });
      expect(JSON.stringify(await h.eventStore.read(e)).includes("SECRET-PAYLOAD")).toBe(false);
      const state = await h.rt.loadState(e, h.rt.systemOptions());
      expect(cursorsOf(state?.variables ?? {}).cold).toBe(0);

      // Replay: a fresh runtime over the same log folds the same cursor, and the NEXT cold message
      // is the one delivered (the discarded one never is).
      const again = await h.sibling().loadState(e, h.rt.systemOptions());
      expect(cursorsOf(again?.variables ?? {})).toEqual(cursorsOf(state?.variables ?? {}));
      expect(JSON.stringify(again?.variables._waitAnswers).includes("SECRET-PAYLOAD")).toBe(false);
    });

    it("the discarded message is never delivered; the next one is", async () => {
      const h = mk();
      const f = flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        return unwrapTainted(await ctx.receive<string>("t"));
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await h.rt.send(e, { topic: "t", payload: "old1", messageId: "1" });
      const second = await h.rt.send(e, { topic: "t", payload: "old2", messageId: "2" });
      const res = await h.rt.discardInbox(e, { topic: "t", throughSeq: second.inboxSeq });
      expect(res.skipped).toBe(2);
      await h.rt.send(e, { topic: "t", payload: "fresh", messageId: "3" });
      await h.rt.resume(e, { eventType: "Go", payload: null });
      await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
      expect((await h.rt.loadState(e))?.variables._output).toBe("fresh");
    });

    it("leaves other topics' messages alone, does not resume the park, and is idempotent", async () => {
      const h = mk();
      const f = flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        const other = unwrapTainted(await ctx.receive<string>("other"));
        const t = unwrapTainted(await ctx.receive<string>("t"));
        return [other, t];
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      await h.rt.send(e, { topic: "other", payload: "keep", messageId: "o" });
      const t = await h.rt.send(e, { topic: "t", payload: "drop", messageId: "t1" });
      const before = await kinds(h.eventStore, e);
      await h.rt.discardInbox(e, { topic: "t", throughSeq: t.inboxSeq });
      const after = await kinds(h.eventStore, e);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toEqual(["MESSAGE_CONSUMED"]);
      expect((await h.rt.loadState(e))?.status).toBe("suspended"); // the park is still unanswered
      // Idempotent: the cursor is already there, nothing more is appended.
      const again = await h.rt.discardInbox(e, { topic: "t", throughSeq: t.inboxSeq });
      expect(again).toMatchObject({ skipped: 0, cursor: t.inboxSeq });
      expect(await kinds(h.eventStore, e)).toEqual(after);
      await h.rt.send(e, { topic: "t", payload: "next", messageId: "t2" });
      await h.rt.resume(e, { eventType: "Go", payload: null });
      await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
      expect((await h.rt.loadState(e))?.variables._output).toEqual(["keep", "next"]);
    });

    it("racing a delivery that wakes the owner: the hot message is delivered once and the discard lands (retried while the owner runs)", async () => {
      const h = mk();
      const f = flow("w", async (ctx) => {
        for (let i = 0; i < 13; i++) unwrapTainted(await ctx.receive("hot"));
        return "done";
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      const hotConsumed = async (): Promise<number[]> =>
        (await eventsOf(h.eventStore, e, "MESSAGE_CONSUMED"))
          .map((c) => c.payload as { topic: string; payload: number })
          .filter((p) => p.topic === "hot")
          .map((p) => p.payload);
      for (let i = 0; i < 12; i++) {
        const cold = await h.rt.send(e, { topic: "cold", payload: i, messageId: `c${i}` });
        const delivery = h.rt.send(e, { topic: "hot", payload: i, messageId: `h${i}` });
        // The discard races the delivery that wakes (and briefly runs) the owner: a refusal says
        // "retry", and the retry lands once it parks again.
        const discard = (async () => {
          for (;;) {
            try {
              const r = await h.rt.discardInbox(e, { topic: "cold", throughSeq: cold.inboxSeq });
              return r;
            } catch (err) {
              if (!(err instanceof InboxDiscardRefusedError && err.retryable)) throw err;
              await new Promise((r) => setTimeout(r, 2));
            }
          }
        })();
        await delivery;
        const landed = await discard;
        expect(landed.cursor).toBe(cold.inboxSeq);
        await until(async () => (await hotConsumed()).length === i + 1);
      }
      expect(await hotConsumed()).toEqual(Array.from({ length: 12 }, (_, i) => i));
      // none of the cold messages was ever delivered (the flow never reads that topic)
      expect(cursorsOf((await h.rt.loadState(e))?.variables ?? {}).cold).toBeGreaterThan(0);
    });

    it("many discards add one answer entry, not one per discard", async () => {
      const h = mk();
      const f = flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        return "done";
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      for (let i = 0; i < 5; i++) {
        const m = await h.rt.send(e, { topic: `t${i}`, payload: i, messageId: `m${i}` });
        await h.rt.discardInbox(e, { topic: `t${i}`, throughSeq: m.inboxSeq });
      }
      const answers = (await h.rt.loadState(e))?.variables._waitAnswers as Record<string, unknown>;
      expect(Object.keys(answers)).toEqual(["__loom_discard__"]);
    });

    it("a running owner is refused (not-parked, retryable) and nothing is appended", async () => {
      const latch = new Latch();
      const h = mk({}, { latch });
      const f = flow("w", async (ctx) => {
        await ctx.run(slow, {});
        return unwrapTainted(await ctx.receive<string>("t"));
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await h.rt.start(f, {}, { executionId: e });
      const m = await h.rt.send(e, { topic: "t", payload: "x", messageId: "1" });
      const before = await kinds(h.eventStore, e);
      const err = await h.rt
        .discardInbox(e, { topic: "t", throughSeq: m.inboxSeq })
        .catch((x) => x);
      expect(err).toBeInstanceOf(InboxDiscardRefusedError);
      expect(err.reason).toBe("not-parked");
      expect(err.retryable).toBe(true);
      expect(await kinds(h.eventStore, e)).toEqual(before);
      latch.release();
      await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
      expect((await h.rt.loadState(e))?.variables._output).toBe("x"); // the message was NOT discarded
    });

    it("refuses what cannot be a discard: a future sequence, a bad topic, a bad bound", async () => {
      const h = mk();
      const f = flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        return "done";
      });
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
      const m = await h.rt.send(e, { topic: "t", payload: 1, messageId: "1" });
      const before = await kinds(h.eventStore, e);
      for (const bad of [
        { topic: "t", throughSeq: m.inboxSeq + 1 }, // would swallow the NEXT message
        { topic: "t", throughSeq: -1 },
        { topic: "t", throughSeq: 1.5 },
        { topic: "__loom_x", throughSeq: 0 },
        { topic: "", throughSeq: 0 },
        { topic: "t", throughSeq: 0, reason: "x".repeat(257) },
      ]) {
        const err = await h.rt.discardInbox(e, bad).catch((x) => x);
        expect(err, JSON.stringify(bad)).toBeInstanceOf(InboxDiscardRefusedError);
        expect(err.reason).toBe("invalid");
      }
      expect(await kinds(h.eventStore, e)).toEqual(before);
      // ...and the NEXT message was therefore not swallowed.
      const next = await h.rt.send(e, { topic: "t", payload: 2, messageId: "2" });
      expect(next.inboxSeq).toBe(m.inboxSeq + 1);
    });

    it("a finished owner is InboxClosedError (its stream is gone)", async () => {
      const h = mk();
      const f = flow("w", async () => "done");
      h.rt.registerFlow(f.definition, f.runner);
      const e = id();
      await (await h.rt.start(f, {}, { executionId: e })).waitForCompletion();
      await expect(h.rt.discardInbox(e, { topic: "t", throughSeq: 0 })).rejects.toBeInstanceOf(
        InboxClosedError
      );
    });

    describe("authorization", () => {
      const strict = async (rules?: Parameters<typeof executionAccessPolicy>[0]) => {
        const h = mk({
          executionAuthorizer: executionAccessPolicy(rules),
          executionAuthz: { requirePrincipal: true },
        });
        const f = flow("w", async (ctx) => {
          await ctx.suspend({ on: "Go" });
          return "done";
        });
        h.rt.registerFlow(f.definition, f.runner);
        const e = id();
        await (await h.rt.start(f, {}, { executionId: e, principal: owner })).waitForSuspend();
        const m = await h.rt.send(
          e,
          { topic: "t", payload: "x", messageId: "1" },
          { principal: owner }
        );
        return { h, e, m };
      };

      it("is closed by default: even the owner is refused, and nothing is appended", async () => {
        const { h, e, m } = await strict();
        const before = await kinds(h.eventStore, e);
        for (const principal of [undefined, owner, ops, mallory]) {
          await expect(
            h.rt.discardInbox(e, { topic: "t", throughSeq: m.inboxSeq }, principal && { principal })
          ).rejects.toBeInstanceOf(ExecutionDeniedError);
        }
        expect(await kinds(h.eventStore, e)).toEqual(before); // not even an EXECUTION_DENIED
        expect(await h.eventStore.read(inboxStreamId(e))).toHaveLength(1);
      });

      it("opened for a tenant's operators: the operator is recorded, another tenant is refused", async () => {
        const { h, e, m } = await strict({ rules: { discard: "tenant" } });
        await expect(
          h.rt.discardInbox(e, { topic: "t", throughSeq: m.inboxSeq }, { principal: mallory })
        ).rejects.toBeInstanceOf(ExecutionDeniedError);
        expect(await consumedCount(h, e)).toBe(0);
        await h.rt.discardInbox(e, { topic: "t", throughSeq: m.inboxSeq }, { principal: ops });
        const [fact] = await eventsOf(h.eventStore, e, "MESSAGE_CONSUMED");
        expect((fact?.payload as { sender: unknown }).sender).toEqual(ops);
      });

      it("existence is not an oracle for an anonymous operator", async () => {
        const { h } = await strict({ rules: { discard: "any" } });
        await expect(
          h.rt.discardInbox("ghost", { topic: "t", throughSeq: 0 })
        ).rejects.toBeInstanceOf(ExecutionDeniedError);
      });

      it("the authorizer is told the op: discard", async () => {
        const seen: string[] = [];
        const h = mk({
          executionAuthorizer: {
            authorize: (r: { op: string }) => {
              seen.push(r.op);
              return { allowed: true } as const;
            },
          },
        });
        const f = flow("w", async (ctx) => {
          await ctx.suspend({ on: "Go" });
          return "done";
        });
        h.rt.registerFlow(f.definition, f.runner);
        const e = id();
        await (await h.rt.start(f, {}, { executionId: e, principal: owner })).waitForSuspend();
        const m = await h.rt.send(e, { topic: "t", payload: 1 }, { principal: owner });
        await h.rt.discardInbox(e, { topic: "t", throughSeq: m.inboxSeq }, { principal: ops });
        expect(seen).toContain("discard");
      });
    });
  });
}
