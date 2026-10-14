import { unwrapTainted } from "@loom/classify";
import {
  EncryptingEventStore,
  EncryptingSnapshotStore,
  InMemoryKeyStore,
  type KeyStore,
} from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import {
  OP,
  SECRET,
  SENSITIVE,
  consumedOf,
  eventsByKind,
  keyOf,
  kindsOf,
  put,
} from "./__tests__/quarantineHarness";
import { inboxBackends } from "./__tests__/r2Backends";
import { build, echo, flow, until } from "./__tests__/r2Harness";
import { SealGuardedEventStore, isSealedUnreadable } from "./sealGuard";
import { InboxQuarantineRefusedError } from "./types";

// ADR 0130 S5b round 3 (P3-1): the quarantine verbs read the owner's log past a sealed
// `MESSAGE_CONSUMED.payload` on EVERY path of the owner fold, not only after a sealed checkpoint:
// no snapshot at all, a plaintext snapshot followed by a sealed tail, and a crypto-decorated node
// WITHOUT the key (the typical "incapable" node), which must not even ask its KeyStore.

const [memory] = inboxBackends("quarantine-logfold-reads");

/** Records every ask of the KeyStore (a node WITHOUT the key must not even ask for a stepped-over seal). */
class SpyKeys implements KeyStore {
  readonly asked: string[] = [];
  readonly inner = new InMemoryKeyStore();
  getOrCreate(s: string) {
    this.asked.push(s);
    return this.inner.getOrCreate(s);
  }
  get(s: string) {
    this.asked.push(s);
    return this.inner.get(s);
  }
  destroy(s: string) {
    return this.inner.destroy(s);
  }
}

async function scene(opts: { sealSnaps?: boolean } = {}) {
  const raw = memory.make();
  const keys = new SpyKeys();
  const sealing = new EncryptingEventStore(raw.eventStore, keys, {
    sensitive: { ...SENSITIVE },
    subjectOf: (e: { executionId: string }) => e.executionId,
  } as never);
  // A's snapshots are PLAINTEXT (no sealState): the sealed content lives only in the log.
  const a = build(
    {
      inboxAutoRelease: false,
      // A's checkpoints are PLAINTEXT on purpose (the sealed content lives only in the log)
      ...(opts.sealSnaps !== true && { allowPlaintextCheckpoints: true }),
    },
    {
      ...raw,
      eventStore: sealing,
      ...(opts.sealSnaps === true && {
        snapshotStore: new EncryptingSnapshotStore(raw.snapshotStore, keys, { sealState: true }),
      }),
    }
  );
  const f = flow("lf-reads", async (ctx) => {
    await ctx.run(echo, {});
    const got: unknown[] = [];
    while (got.length < 3) got.push(unwrapTainted((await ctx.receive<unknown>("a")) as never));
    return got;
  });
  a.rt.registerFlow(f.definition, f.runner);
  const e = `logfold-reads-${Math.random().toString(36).slice(2, 8)}`;
  await (await a.rt.start(f, {}, { executionId: e })).waitForSuspend();
  await until(async () => (await a.rt.loadState(e))?.status === "suspended");
  await put(a.eventStore, e, { topic: "a", messageId: "a0", payload: { ssn: SECRET } });
  await a.rt.notifyInbox(e);
  await until(async () =>
    consumedOf(await raw.eventStore.read(e)).some((c) => c.messageId === keyOf("a0"))
  );
  await until(async () => (await a.rt.loadState(e))?.status === "suspended");
  await put(a.eventStore, e, { topic: "a", messageId: "a1", payload: { ssn: SECRET } });
  const consumed = (await eventsByKind(raw.eventStore, e, "MESSAGE_CONSUMED"))[0];
  expect(consumed?.metadata?.seal).toBeDefined();
  const consumedSeq = consumed?.sequence as number;
  const register = (h: { rt: { registerFlow: (...a: never[]) => void } }) =>
    h.rt.registerFlow(f.definition as never, f.runner as never);
  return { raw, keys, a, e, consumedSeq, register };
}

describe("the owner fold past a sealed MESSAGE_CONSUMED on every read path (P3-1)", () => {
  it("NO snapshot at all + a sealed tail: the incapable node quarantines and releases", async () => {
    const s = await scene();
    const b = build({}, { ...s.raw, snapshotStore: new InMemoryAsyncSnapshotStore() });
    s.register(b);
    expect(isSealedUnreadable(await b.rt.loadState(s.e).catch((x) => x))).toBe(true); // D7 unchanged
    const q = await b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
    expect(q).toMatchObject({ executionId: s.e, topic: "a", messageId: "a1" });
    const r = await b.rt.releaseInbox(
      s.e,
      { topic: "a", messageId: "a1", disposition: "discard" },
      { principal: OP }
    );
    expect(r).toMatchObject({ disposition: "discard", changed: true });
    expect(await eventsByKind(s.raw.eventStore, s.e, "INBOX_QUARANTINED")).toHaveLength(1);
  });

  it("a PLAINTEXT snapshot followed by a sealed tail: the incapable node quarantines", async () => {
    const s = await scene();
    const early = await s.raw.snapshotStore.loadLatestBefore(s.e, s.consumedSeq);
    expect(early, "precondition: a snapshot older than the sealed event").not.toBeNull();
    const snaps = new InMemoryAsyncSnapshotStore();
    await snaps.save(early as never);
    const b = build({}, { ...s.raw, snapshotStore: snaps });
    s.register(b);
    expect(isSealedUnreadable(await b.rt.loadState(s.e).catch((x) => x))).toBe(true);
    const q = await b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
    expect(q).toMatchObject({ messageId: "a1" });
    expect(await kindsOf(s.raw.eventStore, s.e)).toContain("INBOX_QUARANTINED");
  });

  it("a crypto-decorated node WITHOUT the key reads the owner log past the seal and never asks its KeyStore for the owner", async () => {
    const s = await scene();
    const wrong = new SpyKeys();
    const wrongStore = new EncryptingEventStore(s.raw.eventStore, wrong, {
      sensitive: { ...SENSITIVE },
      subjectOf: (e: { executionId: string }) => e.executionId,
    } as never);
    const b = build(
      { allowPlaintextCheckpoints: true }, // the key-less node's own checkpoints are plaintext here
      { ...s.raw, eventStore: wrongStore, snapshotStore: new InMemoryAsyncSnapshotStore() }
    );
    s.register(b);
    // a plain node holds the sealed message (a wrong-key node reads an inbox payload as redacted and
    // refuses to quarantine it for that, correct, reason); the wrong-key node then DISCARDS it,
    // which folds the owner (classify, fold, release-fact search) through the view
    const p = build({}, { ...s.raw, snapshotStore: new InMemoryAsyncSnapshotStore() });
    s.register(p);
    await p.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
    const r = await b.rt.releaseInbox(
      s.e,
      { topic: "a", messageId: "a1", disposition: "discard" },
      { principal: OP }
    );
    expect(r).toMatchObject({ disposition: "discard", changed: true });
    // (that no key is asked is pinned at the VIEW level below: the stack of an awaited decrypt is not a reliable witness)
    expect(await eventsByKind(s.raw.eventStore, s.e, "INBOX_RELEASED")).toHaveLength(1);
  });

  it("VIEW LEVEL: read / readFrom / readRange / head of an admitted owner stream ask a key-less crypto node for NOTHING; without the at-rest reader they ask", async () => {
    const s = await scene();
    const total = (await s.raw.eventStore.read(s.e)).length;
    const asksFor = async (withAtRest: boolean): Promise<string[]> => {
      const spy = new SpyKeys(); // holds NO key for the owner
      const store = new EncryptingEventStore(s.raw.eventStore, spy, {
        sensitive: { ...SENSITIVE },
        subjectOf: (e: { executionId: string }) => e.executionId,
      } as never);
      if (!withAtRest) (store as { readAtRest?: unknown }).readAtRest = undefined;
      const view = new SealGuardedEventStore(store).quarantineReadView();
      const calls = [
        () => view.read(s.e),
        () => view.readFrom(s.e, 0),
        () => view.readRange!(s.e, 0, total - 1),
        () => view.head!(s.e),
      ];
      for (const call of calls) {
        // with the at-rest reader every call answers; without it a key-less node's decrypting read may
        // be refused (it asked for the key, which is the point), so only the asks are compared
        const out = await call().catch((x) => x);
        if (withAtRest) expect(out).not.toBeInstanceOf(Error);
      }
      return spy.asked;
    };
    expect(await asksFor(true)).toEqual([]);
    expect((await asksFor(false)).length).toBeGreaterThan(0);
  });

  it("the guarded runtime view does not hand out the at-rest reader (D7)", async () => {
    const s = await scene();
    expect(s.a.rt.events.readAtRest).toBeUndefined();
    expect((s.a.rt.events as { inner?: unknown }).inner).toBeDefined();
  });

  it("POSITIVE CONTROL: with the at-rest reader absent the same verb asks the KeyStore MORE (so a zero-asks pin cannot go stale silently)", async () => {
    // The stack regex of `SpyKeys` cannot see a walk behind an awaited decrypt (async frames are
    // lost), so the control is comparative and independent of stack shape: the SAME verb on a node that
    // holds the key asks strictly more without the at-rest view than with it, and it asks about the
    // owner at all only through the walks the view replaced.
    const asksFor = async (withAtRest: boolean): Promise<number> => {
      const s = await scene();
      const spy = new SpyKeys();
      (spy as { inner: KeyStore }).inner = s.keys.inner;
      const store = new EncryptingEventStore(s.raw.eventStore, spy, {
        sensitive: { ...SENSITIVE },
        subjectOf: (e: { executionId: string }) => e.executionId,
      } as never);
      if (!withAtRest) (store as { readAtRest?: unknown }).readAtRest = undefined;
      const n = build(
        { allowPlaintextCheckpoints: true },
        { ...s.raw, eventStore: store, snapshotStore: new InMemoryAsyncSnapshotStore() }
      );
      s.register(n);
      const p = build({}, { ...s.raw, snapshotStore: new InMemoryAsyncSnapshotStore() });
      s.register(p);
      await p.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP });
      spy.asked.length = 0;
      await n.rt.releaseInbox(
        s.e,
        { topic: "a", messageId: "a1", disposition: "discard" },
        { principal: OP }
      );
      return spy.asked.length;
    };
    const withView = await asksFor(true);
    const without = await asksFor(false);
    expect(without).toBeGreaterThan(withView);
  });

  it("a crypto-decorated node with a STEP_COMPLETED seal the view cannot step over still refuses (no key, typed denial)", async () => {
    const s = await scene();
    const wrong = new SpyKeys();
    const wrongStore = new EncryptingEventStore(s.raw.eventStore, wrong, {
      sensitive: { ...SENSITIVE, MESSAGE_CONSUMED: ["payload"] },
      subjectOf: (e: { executionId: string }) => e.executionId,
    } as never);
    // add a second sealed kind into the owner log through the capable node's key
    const mixed = new EncryptingEventStore(s.raw.eventStore, s.keys, {
      sensitive: { ...SENSITIVE, STEP_COMPLETED: ["output"] },
      subjectOf: (e: { executionId: string }) => e.executionId,
    } as never);
    const tip = (await s.raw.eventStore.read(s.e)).at(-1)?.sequence as number;
    await mixed.append({
      id: `${s.e}-${tip + 1}`,
      executionId: s.e,
      workflowId: (await s.raw.eventStore.read(s.e))[0]?.workflowId as string,
      sequence: tip + 1,
      eventType: "STEP_COMPLETED",
      timestamp: Date.now(),
      payload: { stepId: "x", output: { ssn: SECRET } },
    } as never);
    const b = build(
      { allowPlaintextCheckpoints: true }, // the key-less node's own checkpoints are plaintext here
      { ...s.raw, eventStore: wrongStore, snapshotStore: new InMemoryAsyncSnapshotStore() }
    );
    s.register(b);
    const before = await kindsOf(s.raw.eventStore, s.e);
    const err = await b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP }).catch((x) => x);
    expect(isSealedUnreadable(err)).toBe(true);
    expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before);
  });
});

describe("P3-4: the checkpoint's sequence, not a log event's, decides completeness", () => {
  it("a key-unavailable checkpoint ABOVE the log's tip is refused as compacted even though the erasure probe named a lower LOG sequence", async () => {
    const s = await scene({ sealSnaps: true });
    const tip = (await s.raw.eventStore.read(s.e)).at(-1)?.sequence as number;
    const latest = await s.raw.snapshotStore.loadLatest(s.e);
    expect(JSON.stringify(latest?.state)).toContain("__loomEnc");
    await s.raw.snapshotStore.save({
      ...(latest as object),
      id: `${s.e}-ckpt-above`,
      sequence: tip + 5,
    } as never);
    // This node holds the snapshot decorator WITHOUT the key and a plain event store: the load is
    // key-unavailable, the probe reads the LOG and is refused at the sealed MESSAGE_CONSUMED
    // (a lower sequence than the checkpoint's).
    const b = build(
      {},
      {
        ...s.raw,
        snapshotStore: new EncryptingSnapshotStore(s.raw.snapshotStore, new InMemoryKeyStore(), {
          sealState: true,
        }),
      }
    );
    s.register(b);
    const before = await kindsOf(s.raw.eventStore, s.e);
    const err = await b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP }).catch((x) => x);
    expect(err).toBeInstanceOf(InboxQuarantineRefusedError);
    expect(err.reason).toBe("checkpoint-unreadable-log-compacted");
    expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before);
  });
});

describe("P3-5: a shredded subject is never folded for a verb", () => {
  const shred = async (s: Awaited<ReturnType<typeof scene>>) => {
    const log = await s.raw.eventStore.read(s.e);
    const tip = log.at(-1)?.sequence as number;
    await s.raw.eventStore.append({
      id: `${s.e}-${tip + 1}`,
      executionId: s.e,
      workflowId: log[0]?.workflowId as string,
      sequence: tip + 1,
      eventType: "PAYLOAD_SHREDDED",
      timestamp: Date.now(),
      payload: { subjectId: s.e, reason: "erasure" },
    } as never);
  };

  it("no snapshot: the transient fold raises the erasure error and appends nothing", async () => {
    const s = await scene();
    await shred(s);
    const b = build({}, { ...s.raw, snapshotStore: new InMemoryAsyncSnapshotStore() });
    s.register(b);
    const before = await kindsOf(s.raw.eventStore, s.e);
    const err = await b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP }).catch((x) => x);
    expect((err as Error).name).toBe("PayloadShreddedError");
    expect(await kindsOf(s.raw.eventStore, s.e)).toEqual(before);
  });

  it("sealed checkpoint on a node without the crypto decorator: same erasure error", async () => {
    const s = await scene({ sealSnaps: true });
    await shred(s);
    const b = build({}, { ...s.raw });
    s.register(b);
    const err = await b.rt.quarantineInbox(s.e, { topic: "a" }, { principal: OP }).catch((x) => x);
    expect((err as Error).name).toBe("PayloadShreddedError");
  });
});
