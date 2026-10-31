import { unwrapTainted } from "@loom/classify";
import { EffectRuntime } from "@loom/effect-runtime";
import {
  type ArchiveStore,
  type EventStore,
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
} from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { SqliteEventStore } from "@loom/plugin-sqlite";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { build, flow, settle, until } from "./__tests__/r2Harness";
import { InboxArchiveRequiredError, ReservedStreamArchiveRequiredError } from "./checkpointGuard";
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
    expect(clone((await life.readReservedWithArchive(stream)).events)).toEqual(original);

    // the owner finishes: the chain's streams are retired AFTER being moved
    await until(async () => (await h.rt.loadState(e))?.suspendedOn?.on === "hold", 8000);
    const fence = await inner.acquireFence(e);
    await h.rt.resume(e, { eventType: "hold", payload: { ok: true } }, { fence });
    await until(async () => (await h.rt.loadState(e))?.status === "completed", 8000);
    await until(async () => (await inner.read(stream)).length === 0, 8000);
    expect(clone((await life.readReservedWithArchive(stream)).events)).toEqual(original);
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

describe("resume never reads the archive (ADR 0139)", () => {
  it("a crash and a fresh runtime over the same stores resume and drain the inbox with zero archive reads", async () => {
    const calls = { read: 0, headers: 0, append: 0 };
    const real = new InMemoryArchiveStore();
    const counting = new Proxy(real, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv) as unknown;
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          if (prop === "read") calls.read++;
          if (prop === "headers") calls.headers++;
          if (prop === "append") calls.append++;
          return (v as (...x: unknown[]) => unknown).apply(target, a);
        };
      },
    }) as ArchiveStore;
    const inner = new InMemoryAsyncEventStore();
    const h = build({}, { eventStore: inner, archive: counting });
    const e = "arch-resume";
    const f = recv3();
    await park(h, f, e);
    await sendDirect(inner, e, 5);
    await h.rt.notifyInbox(e).then((x) => x && settle(x));
    await until(async () => (await real.headers(inboxStreamId(e))).length > 0, 8000);
    await until(async () => (await h.rt.loadState(e))?.suspendedOn?.on === "hold", 8000);
    // "crash": a brand-new runtime over the same stores; archive counters from here on
    calls.read = 0;
    const second = h.sibling();
    second.registerFlow(f.definition, f.runner);
    // the new node folds the log (replay), drives the inbox, runs the recovery sweep over it
    expect((await second.loadState(e))?.suspendedOn?.on).toBe("hold");
    await second.notifyInbox(e).then((x) => x && settle(x));
    await sendDirect(inner, e, 1); // a message arriving after the crash is appended and woken for
    await second.notifyInbox(e).then((x) => x && settle(x));
    expect((await second.loadState(e))?.suspendedOn?.on).toBe("hold");
    expect(calls.read).toBe(0); // replay, the recovery sweep and a send never read the archive bodies
  });
});

describe("the inbox archive is required, defaulted or explicitly declined (ADR 0139 M1)", () => {
  const bare = (eventStore: EventStore, extra: Record<string, unknown> = {}) =>
    new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      inboxEnabled: true,
      ...extra,
    } as never);

  it("a durable store with the inbox on and NO archive refuses to construct, naming the fix", () => {
    expect(() => bare(new SqliteEventStore(":memory:"))).toThrow(InboxArchiveRequiredError);
    expect(() => bare(new SqliteEventStore(":memory:"))).toThrow(/inboxArchive/);
  });

  it("an in-memory store defaults an in-memory archive; a sealing one gets it sealed under its KeyStore", () => {
    const plain = bare(new InMemoryAsyncEventStore());
    expect((plain as unknown as { reservedArchive?: unknown }).reservedArchive).toBeDefined();
    const sealing = new EncryptingEventStore(
      new InMemoryAsyncEventStore(),
      new InMemoryKeyStore(),
      {
        sensitive: { INBOX_MESSAGE: ["payload"] },
      }
    );
    const rt = bare(sealing, { allowPlaintextCheckpoints: true });
    const archive = (rt as unknown as { reservedArchive: { archive: object } }).reservedArchive
      .archive as { sealsSegments?: boolean; keys?: unknown };
    expect(archive.sealsSegments).toBe(true);
    expect(archive.keys).toBe(sealing.keys);
  });

  it('"none" is the explicit opt-out: said at boot, and every skipped maintenance reaches onWarn when onStorageError is unwired', async () => {
    const warnings: string[] = [];
    const inner = new InMemoryAsyncEventStore();
    const h = build(
      { onStorageError: undefined as never, onWarn: (m: string) => warnings.push(m) },
      { eventStore: inner, archive: null }
    );
    expect(warnings.some((m) => /inboxArchive: "none"/.test(m))).toBe(true);
    const e = "arch-m1";
    await park(h, recv3(), e);
    await sendDirect(inner, e, 5);
    await h.rt.notifyInbox(e).then((x) => x && settle(x));
    await until(
      async () => warnings.some((m) => /inbox maintenance of chain "arch-m1" failed/.test(m)),
      8000
    );
    expect(h.storageErrors).toEqual([]); // nothing was wired, nothing was swallowed
  });

  it("InboxFullError names the missing archive when that is why the inbox fills", () => {
    const h = build({}, { archive: null });
    const err = (
      h.rt as unknown as { inboxFullError(e: string, f: { unconsumed: number }): Error }
    ).inboxFullError("x", { unconsumed: 3 });
    expect(err.message).toMatch(/no inboxArchive is configured/);
  });
});
