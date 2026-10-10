import { unwrapTainted } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import {
  INBOX_LAYOUT_STREAM,
  INBOX_TOPIC_SEQ_BASE,
  inboxRegistryStreamId,
  inboxTopicStreamId,
} from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import { inboxBackends } from "./__tests__/r2Backends";
import { build, eventsOf, flow, kinds, settle, until } from "./__tests__/r2Harness";
import type { Harness } from "./__tests__/r2Harness";
import {
  appendInboxMessage,
  cursorsOf,
  inboxStreamId,
  readRegisteredTopics,
  registerInboxTopic,
} from "./inbox";
import { recoverAbandoned } from "./recoverAbandoned";
import { InboxFullError, InboxMessageRefusedError } from "./types";

// ADR 0110 amendment, D10b — per-topic inbox streams behind `inboxTopicStreams`, switched fleet-wide by
// `enableInboxTopicStreams`. One cursor space, the fold untouched: these tests read the raw streams.

const BASE = INBOX_TOPIC_SEQ_BASE;
const OPS = { actor: "ops", tenant: "t1" };

for (const backend of inboxBackends("topics")) {
  describe.skipIf(backend.skip === true)(`per-topic inbox streams on ${backend.name}`, () => {
    beforeAll(() => backend.setup());
    afterAll(() => backend.teardown());
    // The fleet switch is ONE stream per store: a store shared across tests (Postgres) must not carry
    // one test's switch into the next.
    beforeEach(async () => {
      await backend.make().eventStore.deleteExecution?.(INBOX_LAYOUT_STREAM);
    });
    let seq = 0;
    const id = () => `${backend.name}-e${++seq}-${Math.random().toString(36).slice(2, 6)}`;
    const mk = (deps: Record<string, unknown> = {}, opts: Parameters<typeof build>[1] = {}) =>
      build({ inboxTopicStreams: true, ...deps }, { ...backend.make(), ...opts });
    const enable = (h: Harness) => h.rt.enableInboxTopicStreams({ principal: OPS });
    const raw = (store: EventStore, stream: string): Promise<EventEnvelope[]> => store.read(stream);
    const done = (h: Harness, e: string) =>
      until(
        async () => (await h.rt.loadState(e, h.rt.systemOptions()))?.status === "completed",
        15000
      );
    const answers = async (h: Harness, e: string) =>
      Object.keys(
        ((await h.rt.loadState(e, h.rt.systemOptions()))?.variables._waitAnswers as object) ?? {}
      ).length;
    /** A flow that waits for `Go`, then receives `n` messages of `topic`. */
    const gated = (topic: string, n: number) =>
      flow("w", async (ctx) => {
        await ctx.suspend({ on: "Go" });
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) out.push(unwrapTainted(await ctx.receive(topic)));
        return out;
      });
    const hotLoop = () =>
      flow("w", async (ctx) => {
        for (let i = 0; i < 1000; i++) unwrapTainted(await ctx.receive("hot"));
        return unwrapTainted(await ctx.receive("cold"));
      });
    const parkOn = async (h: Harness, f: ReturnType<typeof flow>, e: string) => {
      h.rt.registerFlow(f.definition, f.runner);
      await settle(await h.rt.start(f, {}, { executionId: e }));
    };

    for (const perTopic of [false, true]) {
      it(`a cold topic beside a hot one: ${perTopic ? "per-topic streams do not pin each other" : "the single stream pins (control)"}`, async () => {
        const h = mk({ inboxMaxBacklog: 6, inboxMaxRetained: 12, inboxTopicStreams: perTopic });
        if (perTopic) await enable(h);
        const e = id();
        await parkOn(h, hotLoop(), e);
        await h.rt.send(e, { topic: "cold", payload: "pin", messageId: "cold" });
        let refused: unknown;
        for (let i = 0; i < 40 && refused === undefined; i++) {
          await h.rt
            .send(e, { topic: "hot", payload: i, messageId: `h${i}` })
            .catch((err: unknown) => {
              refused = err;
            });
          if (refused === undefined) await until(async () => (await answers(h, e)) === i + 1);
        }
        if (!perTopic) {
          expect(refused).toBeInstanceOf(InboxFullError);
          return;
        }
        expect(refused).toBeUndefined();
        // The hot stream was trimmed as it was consumed; the cold message sits alone in its own.
        const hotStream = await raw(h.eventStore, inboxTopicStreamId(e, "hot"));
        expect(hotStream.length).toBeLessThan(5);
        expect(hotStream[0]?.sequence).toBeGreaterThanOrEqual(BASE);
        expect(await raw(h.eventStore, inboxTopicStreamId(e, "cold"))).toHaveLength(1);
        expect(await readRegisteredTopics(h.eventStore, e)).toEqual(["cold", "hot"]);
        const cursors = cursorsOf((await h.rt.loadState(e))?.variables ?? {});
        expect(cursors.hot).toBe(BASE + 39);
        expect(cursors.cold).toBeUndefined();
      }, 60_000);
    }

    it("the backlog bound is per topic: one full topic does not refuse another", async () => {
      const h = mk({ inboxMaxBacklog: 3 });
      await enable(h);
      const e = id();
      await parkOn(h, gated("a", 1), e);
      for (let i = 0; i < 3; i++)
        await h.rt.send(e, { topic: "a", payload: i, messageId: `a${i}` });
      const err = await h.rt.send(e, { topic: "a", payload: 9, messageId: "a9" }).catch((x) => x);
      expect(err).toBeInstanceOf(InboxFullError);
      await h.rt.send(e, { topic: "b", payload: "ok", messageId: "b0" }); // its own stream, not full
      expect(await raw(h.eventStore, inboxTopicStreamId(e, "b"))).toHaveLength(1);
    });

    it("legacy single-stream data is read first and in order after the switch", async () => {
      const h = mk();
      const e = id();
      await parkOn(h, gated("t", 5), e);
      // Before the fleet switch the node writes the legacy stream, flag on or not.
      const first = [];
      for (const p of ["a", "b", "c"]) {
        first.push(await h.rt.send(e, { topic: "t", payload: p, messageId: p }));
      }
      expect(first.map((r) => r.inboxSeq)).toEqual([0, 1, 2]);
      expect(await raw(h.eventStore, inboxTopicStreamId(e, "t"))).toEqual([]);
      expect(await raw(h.eventStore, INBOX_LAYOUT_STREAM)).toEqual([]);
      expect(await enable(h)).toEqual({ enabled: true, newlyEnabled: true });
      expect(await enable(h)).toEqual({ enabled: true, newlyEnabled: false }); // idempotent
      const second = [];
      for (const p of ["d", "e"]) {
        second.push(await h.rt.send(e, { topic: "t", payload: p, messageId: p }));
      }
      expect(second.map((r) => r.inboxSeq)).toEqual([BASE, BASE + 1]);
      expect(await raw(h.eventStore, inboxStreamId(e))).toHaveLength(3); // nothing copied or rewritten
      await h.rt.resume(e, { eventType: "Go", payload: null });
      await done(h, e);
      expect((await h.rt.loadState(e))?.variables._output).toEqual(["a", "b", "c", "d", "e"]);
      // The chain finished: every stream of it is gone (topic stream, legacy stream, registry).
      for (const stream of [
        inboxStreamId(e),
        inboxTopicStreamId(e, "t"),
        inboxRegistryStreamId(e),
      ]) {
        expect(await raw(h.eventStore, stream)).toEqual([]);
      }
    });

    it("rolling upgrade: a node with the flag off keeps writing the legacy stream; nothing is lost or doubled", async () => {
      const be = backend.make();
      const on = build({ inboxTopicStreams: true }, be);
      const off = on.sibling({ inboxTopicStreams: false });
      const e = id();
      const f = gated("t", 4);
      on.rt.registerFlow(f.definition, f.runner);
      off.registerFlow(f.definition, f.runner);
      await settle(await on.rt.start(f, {}, { executionId: e }));
      await on.rt.send(e, { topic: "t", payload: 1, messageId: "m1" });
      await off.send(e, { topic: "t", payload: 2, messageId: "m2" });
      // The operator procedure: every node has the flag, then the switch. (The flag-off node here is
      // the pre-switch writer; after the switch it must not write.)
      await enable(on);
      await on.rt.send(e, { topic: "t", payload: 3, messageId: "m3" });
      await on.rt.send(e, { topic: "t", payload: 4, messageId: "m4" });
      await on.rt.resume(e, { eventType: "Go", payload: null });
      await done(on, e);
      expect((await on.rt.loadState(e))?.variables._output).toEqual([1, 2, 3, 4]);
    });

    it("a send racing the switch is neither lost nor doubled (its topic-stream copy is deduped)", async () => {
      const be = backend.make();
      const inner = be.eventStore;
      const view = Object.create(inner) as EventStore;
      let armed = false;
      let atAppend!: () => void;
      const reached = new Promise<void>((r) => {
        atAppend = r;
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      view.append = async (env) => {
        if (
          armed &&
          env.executionId.startsWith("__loom_inbox__:") &&
          !env.executionId.includes("#")
        ) {
          armed = false;
          atAppend(); // the straggler has read "no switch" and is about to write the legacy stream
          await gate;
        }
        return inner.append(env);
      };
      const straggler = build({ inboxTopicStreams: true }, { ...be, eventStore: view });
      const other = straggler.sibling({ eventStore: inner });
      const e = id();
      const f = flow("w", async (ctx) => {
        const a = unwrapTainted(await ctx.receive<string>("t"));
        const b = unwrapTainted(await ctx.receive<string>("t"));
        return [a, b];
      });
      straggler.rt.registerFlow(f.definition, f.runner);
      other.registerFlow(f.definition, f.runner);
      await settle(await straggler.rt.start(f, {}, { executionId: e }));
      armed = true;
      const sending = straggler.rt.send(e, { topic: "t", payload: "STRAGGLER", messageId: "s" });
      await reached;
      // The switch lands while that send is in flight; another node then writes and the owner consumes
      // from the topic's own stream, moving its cursor above every legacy sequence.
      await other.enableInboxTopicStreams({ principal: OPS });
      await other.send(e, { topic: "t", payload: "FIRST", messageId: "f" });
      await until(async () => (await answers(straggler, e)) === 1);
      release();
      await sending;
      await done(straggler, e);
      const out = (await straggler.rt.loadState(e))?.variables._output as string[];
      expect(out).toHaveLength(2);
      expect([...out].sort()).toEqual(["FIRST", "STRAGGLER"]);
    });

    it("flag off (and flag on before the switch) is byte-identical: only the legacy stream, from sequence 0", async () => {
      const run = async (deps: Record<string, unknown>) => {
        const h = build(deps, backend.make());
        const e = id();
        await parkOn(h, gated("t", 3), e);
        for (const p of ["a", "b", "c"])
          await h.rt.send(e, { topic: "t", payload: p, messageId: p });
        const stream = (await raw(h.eventStore, inboxStreamId(e))).map((x) => [
          x.sequence,
          x.eventType,
          x.payload,
        ]);
        expect(await raw(h.eventStore, inboxRegistryStreamId(e))).toEqual([]);
        expect(await raw(h.eventStore, inboxTopicStreamId(e, "t"))).toEqual([]);
        expect(await raw(h.eventStore, INBOX_LAYOUT_STREAM)).toEqual([]);
        await h.rt.resume(e, { eventType: "Go", payload: null });
        await done(h, e);
        const log = (await h.eventStore.read(e)).map((x) => [x.eventType, x.payload]);
        const consumed = (await eventsOf(h.eventStore, e, "MESSAGE_CONSUMED")).map(
          (x) => (x.payload as { inboxSeq: number }).inboxSeq
        );
        return { stream, kinds: log.map((l) => l[0]), consumed };
      };
      const off = await run({});
      const onUnswitched = await run({ inboxTopicStreams: true });
      expect(onUnswitched.stream).toEqual(off.stream);
      expect(onUnswitched.kinds).toEqual(off.kinds);
      expect(onUnswitched.consumed).toEqual([0, 1, 2]);
      expect(off.consumed).toEqual([0, 1, 2]);
      // And the switch needs the flag.
      const h = build({}, backend.make());
      await expect(h.rt.enableInboxTopicStreams({ principal: OPS })).rejects.toThrow(
        /inboxTopicStreams/
      );
    });

    it("the reserved id rule: an id that would alias a topic or registry stream is refused at start", async () => {
      const h = mk();
      const f = flow("w", async () => "x");
      h.rt.registerFlow(f.definition, f.runner);
      for (const bad of ["chain#0123456789abcdef", "chain#reg"]) {
        await expect(h.rt.start(f, {}, { executionId: bad })).rejects.toThrow(/aliases?|alias/);
      }
      // Near misses are ordinary ids.
      for (const ok of ["chain#012345", "chain#0123456789abcdeg", "chain#register"]) {
        await settle(await h.rt.start(f, {}, { executionId: `${id()}${ok}` }));
      }
    });

    it("a chain's topic count is capped (counted from its registry); a known topic is never refused", async () => {
      const h = mk({ inboxMaxTopics: 2 });
      await enable(h);
      const e = id();
      await parkOn(h, gated("a", 1), e);
      await h.rt.send(e, { topic: "a", payload: 1, messageId: "1" });
      await h.rt.send(e, { topic: "b", payload: 1, messageId: "2" });
      const err = await h.rt.send(e, { topic: "c", payload: 1, messageId: "3" }).catch((x) => x);
      expect(err).toBeInstanceOf(InboxMessageRefusedError);
      expect(err.message).toMatch(/inbox\.maxTopics/);
      await h.rt.send(e, { topic: "a", payload: 2, messageId: "4" });
      expect(await readRegisteredTopics(h.eventStore, e)).toEqual(["a", "b"]);
      expect(await raw(h.eventStore, inboxTopicStreamId(e, "c"))).toEqual([]);
    });

    it("continue-as-new carries the per-topic cursors: each generation reads the next message of the topic's stream", async () => {
      const h = mk({ continueAsNewEnabled: true });
      await enable(h);
      const hop = flow<{ n?: number }, unknown>("hop", async (ctx, input) => {
        const n = input?.n ?? 0;
        const got = unwrapTainted(await ctx.receive("go"));
        if (n >= 3) return got;
        return ctx.continueAsNew({ n: n + 1 });
      });
      h.rt.registerFlow(hop.definition, hop.runner);
      const chain = id();
      await settle(await h.rt.start(hop, {}, { executionId: chain }));
      let head = chain;
      for (let i = 0; i < 3; i++) {
        await until(
          async () => (await h.rt.loadState(head, h.rt.systemOptions()))?.status === "suspended"
        );
        await h.rt.send(head, { topic: "go", payload: i, messageId: `go${i}` });
        const next = `${chain}~${i + 1}`;
        await until(async () => (await h.rt.loadState(next, h.rt.systemOptions())) !== null);
        head = next;
      }
      await until(
        async () => (await h.rt.loadState(head, h.rt.systemOptions()))?.status === "suspended"
      );
      // One chain, one stream per topic: the successors read on from the carried cursor.
      await h.rt.send(chain, { topic: "go", payload: "last", messageId: "last" });
      await done(h, head);
      expect((await h.rt.loadState(head))?.variables._output).toBe("last");
      expect(cursorsOf((await h.rt.loadState(head))?.variables ?? {}).go).toBe(BASE + 3);
    }, 60_000);

    it("a fork inherits per-topic cursors: a send to it lands above them and is delivered", async () => {
      const h = mk();
      await enable(h);
      const e = id();
      const f = flow("w", async (ctx) => {
        const out: string[] = [];
        for (let i = 0; i < 4; i++) out.push(unwrapTainted(await ctx.receive<string>("x")));
        return out;
      });
      await parkOn(h, f, e);
      for (const p of ["a", "b", "c"]) await h.rt.send(e, { topic: "x", payload: p, messageId: p });
      await until(async () => (await answers(h, e)) === 3);
      await until(
        async () => (await h.rt.loadState(e, h.rt.systemOptions()))?.status === "suspended"
      );
      const tip = (await h.rt.loadState(e, h.rt.systemOptions()))?.sequence as number;
      const fk = await h.rt.fork(e, tip, { executionId: `${e}-fork` });
      const sent = await h.rt.send(`${e}-fork`, { topic: "x", payload: "to-fork", messageId: "f" });
      expect(sent.inboxSeq).toBeGreaterThan(BASE + 2); // above the inherited cursor, in the topic range
      await done(h, fk.executionId);
      expect((await h.rt.loadState(fk.executionId))?.variables._output).toEqual([
        "a",
        "b",
        "c",
        "to-fork",
      ]);
    });

    it("a re-opened terminal owner keeps receiving per-topic messages above its cursors", async () => {
      const h = mk();
      await enable(h);
      const e = id();
      let fixed = false;
      const f = flow("w", async (ctx) => {
        const a = unwrapTainted(await ctx.receive<string>("x"));
        if (!fixed) throw new Error("boom");
        const b = unwrapTainted(await ctx.receive<string>("x"));
        return [a, b];
      });
      await parkOn(h, f, e);
      await h.rt.send(e, { topic: "x", payload: "A", messageId: "A" });
      await until(async () => (await h.rt.loadState(e, h.rt.systemOptions()))?.status === "failed");
      fixed = true;
      const reopened = await h.rt.resumeAs(e, "w", { eventType: "Retry", payload: null }, {
        strategy: "operator-ack",
        system: true,
      } as never);
      await reopened.waitForSuspend();
      const res = await h.rt.send(e, { topic: "x", payload: "B", messageId: "B" });
      expect(res.inboxSeq).toBeGreaterThan(BASE); // not restarted at BASE under the cursor
      await done(h, e);
      expect((await h.rt.loadState(e, h.rt.systemOptions()))?.variables._output).toEqual([
        "A",
        "B",
      ]);
    });

    it("operator discard works per topic stream (through a topic-range sequence)", async () => {
      const h = mk();
      await enable(h);
      const e = id();
      await parkOn(h, gated("cold", 1), e);
      const ms = [];
      for (const p of [1, 2, 3])
        ms.push(await h.rt.send(e, { topic: "cold", payload: p, messageId: `c${p}` }));
      const res = await h.rt.discardInbox(
        e,
        { topic: "cold", throughSeq: (ms[1] as { inboxSeq: number }).inboxSeq },
        { principal: OPS }
      );
      expect(res.skipped).toBe(2);
      // beyond the topic stream's head: refused
      await expect(
        h.rt.discardInbox(e, { topic: "cold", throughSeq: BASE + 50 }, { principal: OPS })
      ).rejects.toThrow(/beyond the stream's head/);
      await h.rt.resume(e, { eventType: "Go", payload: null });
      await done(h, e);
      expect((await h.rt.loadState(e))?.variables._output).toEqual([3]);
    });

    it("TTL expiry works per topic stream and journals the expiry in the topic range", async () => {
      const clock = { t: 9_000_000 };
      const h = mk({ now: () => clock.t, inboxMessageTtlMs: { topics: { cold: 5_000 } } });
      await enable(h);
      const e = id();
      await parkOn(h, gated("hot", 1), e);
      const m = await h.rt.send(e, { topic: "cold", payload: "STALE", messageId: "c" });
      expect(m.inboxSeq).toBeGreaterThanOrEqual(BASE);
      clock.t += 10_000;
      await new TimerService(h.rt, h.timers).tick(clock.t);
      const facts = (await eventsOf(h.eventStore, e, "MESSAGE_CONSUMED")).map(
        (x) => x.payload as Record<string, unknown>
      );
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ topic: "cold", inboxSeq: m.inboxSeq, reason: "expired" });
      expect(cursorsOf((await h.rt.loadState(e))?.variables ?? {}).cold).toBe(m.inboxSeq);
    });

    it("an orphan topic stream of a finished chain is reclaimed by the sweep, registry and all", async () => {
      const h = mk();
      await enable(h);
      const e = id();
      const f = flow("w", async () => "done");
      await parkOn(h, f, e);
      await until(
        async () => (await h.rt.loadState(e, h.rt.systemOptions()))?.status === "completed"
      );
      // A crashed sender's leftovers: registered topic + message, after the owner's own delete.
      await registerInboxTopic(h.eventStore, e, "late", 64, Date.now);
      await appendInboxMessage(
        h.eventStore,
        e,
        { topic: "late", messageId: "z", payload: "left behind", sender: {} },
        Date.now,
        true
      );
      expect(await raw(h.eventStore, inboxTopicStreamId(e, "late"))).toHaveLength(1);
      const summary = await recoverAbandoned(h.rt, {
        source: h.eventStore,
        isAbandoned: () => false,
      });
      expect(summary.inboxReclaimed).toBeGreaterThanOrEqual(1);
      expect(await raw(h.eventStore, inboxTopicStreamId(e, "late"))).toEqual([]);
      expect(await raw(h.eventStore, inboxRegistryStreamId(e))).toEqual([]);
    });

    it("the log is unchanged by the layout: a per-topic run and a legacy run fold to the same shape", async () => {
      const shape = async (perTopic: boolean) => {
        const h = mk({ inboxTopicStreams: perTopic });
        if (perTopic) await enable(h);
        const e = id();
        await parkOn(h, gated("t", 2), e);
        for (const p of ["a", "b"]) await h.rt.send(e, { topic: "t", payload: p, messageId: p });
        await h.rt.resume(e, { eventType: "Go", payload: null });
        await done(h, e);
        return {
          kinds: await kinds(h.eventStore, e),
          out: (await h.rt.loadState(e))?.variables._output,
          consumed: (await eventsOf(h.eventStore, e, "MESSAGE_CONSUMED")).map((x) => {
            const p = x.payload as Record<string, unknown>;
            return { ...p, inboxSeq: (p.inboxSeq as number) >= BASE ? "topic" : "legacy" };
          }),
        };
      };
      const legacy = await shape(false);
      const topic = await shape(true);
      expect(topic.kinds).toEqual(legacy.kinds);
      expect(topic.out).toEqual(legacy.out);
      expect(topic.consumed.map((c) => (c as { messageId: string }).messageId)).toEqual(
        legacy.consumed.map((c) => (c as { messageId: string }).messageId)
      );
      expect(new Set(topic.consumed.map((c) => (c as { inboxSeq: string }).inboxSeq))).toEqual(
        new Set(["topic"])
      );
    });
  });
}
