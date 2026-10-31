import { unwrapTainted } from "@loom/classify";
import {
  type ArchiveStore,
  type EventStore,
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
} from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { LogLifecycle } from "./LogLifecycle";
import { build, flow, settle, until } from "./__tests__/r2Harness";
import { ReservedStreamArchiveRequiredError } from "./checkpointGuard";
import { appendInboxMessage, inboxStreamId } from "./inbox";

// ADR 0139 (#728) end to end: the runtime trims the consumed prefix and deletes a retired chain's streams
// only by MOVING them into the archive; without one it trims and deletes nothing and says so.

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const recv3 = () =>
  flow("w", async (ctx) => {
    const got: string[] = [];
    for (let i = 0; i < 3; i++) got.push(unwrapTainted(await ctx.receive<string>("a")));
    await ctx.suspend({ on: "hold" });
    return got;
  });

async function park(h: ReturnType<typeof build>, f: ReturnType<typeof recv3>, e: string) {
  h.rt.registerFlow(f.definition, f.runner);
  await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
}

async function sendDirect(store: EventStore, e: string, n: number) {
  for (let i = 0; i < n; i++) {
    await appendInboxMessage(
      store,
      e,
      {
        topic: "a",
        messageId: `m${i}`,
        payload: `p${i}`,
        sender: { actor: "alice", tenant: "t1" },
      },
      Date.now
    );
  }
}

describe("the runtime moves the inbox's reserved stream into the archive", () => {
  it("trim and terminal delete: archive u surviving == the original stream, byte-exact", async () => {
    const inner = new InMemoryAsyncEventStore();
    const h = build({}, { eventStore: inner });
    const e = "arch-1";
    await park(h, recv3(), e);
    await sendDirect(inner, e, 5);
    const stream = inboxStreamId(e);
    const original = clone(await inner.read(stream));
    await h.rt.notifyInbox(e).then((x) => x && settle(x));
    // the trim runs after the park's drain, in the background: wait for it
    await until(async () => (await h.archive.headers(stream)).length > 0, 8000);
    await until(async () => !(await inner.read(stream)).some((x) => x.sequence === 1), 8000);
    const life = new LogLifecycle(inner, h.snapshotStore, { compactionArchive: h.archive });
    expect(clone(await life.readReservedWithArchive(stream))).toEqual(original);

    // the owner finishes: the chain's streams are retired AFTER being moved
    await until(async () => (await h.rt.loadState(e))?.suspendedOn?.on === "hold", 8000);
    const fence = await inner.acquireFence(e);
    await h.rt.resume(e, { eventType: "hold", payload: { ok: true } }, { fence });
    await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
    await until(async () => (await inner.read(stream)).length === 0, 8000);
    expect(clone(await life.readReservedWithArchive(stream))).toEqual(original);
    expect(h.storageErrors).toEqual([]);
  });

  it("retention: a plain delete removes the chain's archived reserved segments with it; a KEPT execution leaves them", async () => {
    for (const keep of [false, true]) {
      const inner = new InMemoryAsyncEventStore();
      const h = build({}, { eventStore: inner });
      const e = keep ? "arch-keep" : "arch-gone";
      await park(h, recv3(), e);
      await sendDirect(inner, e, 5);
      const stream = inboxStreamId(e);
      await h.rt.notifyInbox(e).then((x) => x && settle(x));
      await until(async () => (await h.archive.headers(stream)).length > 0, 8000);
      await until(async () => (await h.rt.loadState(e))?.suspendedOn?.on === "hold", 8000);
      const fence = await inner.acquireFence(e);
      await h.rt.resume(e, { eventType: "hold", payload: { ok: true } }, { fence });
      await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
      await until(async () => (await inner.read(stream)).length === 0, 8000);
      expect((await h.archive.headers(stream)).length).toBeGreaterThan(0);
      const life = new LogLifecycle(inner, h.snapshotStore, {
        compactionArchive: h.archive,
        ...(keep && { archive: { eventStore: new InMemoryAsyncEventStore() } }),
      });
      expect(await life.applyRetention(e, { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
        "reclaimed"
      );
      // plain delete: the execution is gone, and so is the chain's archived inbox; kept: it stays readable
      expect((await h.archive.headers(stream)).length > 0).toBe(keep);
    }
  });

  it("without an archive nothing is trimmed or deleted, once-per-chain error, and the stream is intact", async () => {
    const inner = new InMemoryAsyncEventStore();
    const h = build({}, { eventStore: inner, archive: null });
    const e = "arch-2";
    await park(h, recv3(), e);
    await sendDirect(inner, e, 5);
    const stream = inboxStreamId(e);
    const original = clone(await inner.read(stream));
    await h.rt.notifyInbox(e).then((x) => x && settle(x));
    await until(
      async () => h.storageErrors.some((x) => x instanceof ReservedStreamArchiveRequiredError),
      8000
    );
    await until(async () => (await h.rt.loadState(e))?.suspendedOn?.on === "hold", 8000);
    expect(clone(await inner.read(stream))).toEqual(original); // untrimmed

    const fence = await inner.acquireFence(e);
    await h.rt.resume(e, { eventType: "hold", payload: { ok: true } }, { fence });
    await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
    // the terminal's delete is refused too: the stream (envelope ids, timestamps, senders) is kept
    await until(
      async () =>
        h.storageErrors.some(
          (x) => x instanceof ReservedStreamArchiveRequiredError && x.op === "delete"
        ),
      8000
    );
    expect(clone(await inner.read(stream))).toEqual(original);
    // more advances of the same chain: still one report (it is a standing misconfiguration, not an event)
    const state = await h.rt.loadState(e);
    const advance = (h.rt as unknown as { maybeTrimInbox(c: string, s: unknown): Promise<void> })
      .maybeTrimInbox;
    for (let i = 0; i < 3; i++) await advance.call(h.rt, e, state);
    // said once per chain for the trim, not once per advance
    expect(
      h.storageErrors.filter(
        (x) => x instanceof ReservedStreamArchiveRequiredError && x.op === "trim"
      )
    ).toHaveLength(1);
  });

  it("hot path: the archive adds one header read, one range read and one append per trim, none per message", async () => {
    const calls = { headers: 0, append: 0, read: 0 };
    const archive: ArchiveStore = new InMemoryArchiveStore();
    const counting = new Proxy(archive, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv) as unknown;
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          if (prop === "headers") calls.headers++;
          if (prop === "append") calls.append++;
          if (prop === "read") calls.read++;
          return (v as (...x: unknown[]) => unknown).apply(target, a);
        };
      },
    }) as ArchiveStore;
    const inner = new InMemoryAsyncEventStore();
    const h = build({}, { eventStore: inner, archive: counting });
    const e = "arch-3";
    const f = flow("w", async (ctx) => {
      let n = 0;
      for (let i = 0; i < 30; i++) n += unwrapTainted(await ctx.receive<number>("a"));
      return n;
    });
    h.rt.registerFlow(f.definition, f.runner);
    await (await h.rt.start(f, {}, { executionId: e })).waitForSuspend();
    await sendDirect(inner, e, 30);
    await h.rt.notifyInbox(e).then((x) => x && settle(x));
    await until(async () => (await h.rt.loadState(e))?.status === "completed", 15000);
    // the owner consumed 30 messages in ONE advance: every trim is a batch, so the archive saw a handful
    // of calls, not 30 x anything (the per-message cost of the archive is zero by construction)
    expect(calls.append).toBeLessThanOrEqual(4);
    expect(calls.headers).toBeLessThanOrEqual(12);
    expect(calls.read).toBe(0); // the resume/trim path never READS the archive bodies
  });
});
