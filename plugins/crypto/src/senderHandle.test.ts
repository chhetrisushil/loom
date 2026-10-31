import { randomBytes } from "node:crypto";
import type { EventEnvelope } from "@loom/core";
import {
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
  buildReservedSegment,
} from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { EncryptingArchiveStore } from "./EncryptingArchiveStore";
import { EncryptingEventStore } from "./EncryptingEventStore";
import { InMemoryKeyStore } from "./keystore";
import {
  SenderEraseIncompleteError,
  SenderErasedError,
  SenderMasterLostError,
  isSealedSender,
} from "./senderSeal";

// ADR 0139 N6/N7/N3 - the sender of an inbox message is sealed BY DEFAULT under an opaque, keyed handle that
// erasing the sender makes unlinkable; the sealed sender is bound to its message; two erased senders stay
// two senders.

const CHAIN = "chain-1";
const STREAM = `__loom_inbox__:${CHAIN}`;
const message = (seq: number, actor: string): EventEnvelope => ({
  id: `${STREAM}-${seq}`,
  workflowId: "__loom_inbox__",
  executionId: STREAM,
  eventType: "INBOX_MESSAGE",
  sequence: seq,
  timestamp: 1_000 + seq,
  payload: {
    topic: "t",
    messageId: `m${seq}`,
    payload: `body ${seq}`,
    sender: { actor, tenant: "t1" },
  },
});
const senderOf = (e: EventEnvelope | undefined): unknown =>
  (e?.payload as { sender?: unknown } | undefined)?.sender;

function make(keys = new InMemoryKeyStore(), options: { senderSubjectOf?: false } = {}) {
  const inner = new InMemoryAsyncEventStore();
  const store = new EncryptingEventStore(inner, keys, { sensitive: {}, ...options });
  return { inner, store, keys };
}

describe("N6: a sealing deployment seals the sender by DEFAULT under an opaque keyed handle", () => {
  it("the stored sender is ciphertext, the clear-text handle is not the identity, and a read opens it", async () => {
    const { inner, store } = make();
    await store.append(message(1, "alice"));
    const raw = (await inner.read(STREAM))[0];
    const stored = senderOf(raw);
    expect(isSealedSender(stored)).toBe(true);
    const at = JSON.stringify(raw);
    expect(at).not.toContain("alice");
    expect(at).not.toContain("t1");
    const handle = (stored as { subject: string }).subject;
    expect(handle).toMatch(/^sbj-[0-9a-f]{32}$/);
    expect(handle).not.toContain("alice");
    expect(store.senderSealing).toBe("default");
    expect(senderOf((await store.read(STREAM))[0])).toEqual({ actor: "alice", tenant: "t1" });
  });

  it("the handle is KEYED: stable under one KeyStore, different under another (not a hash of the identity)", async () => {
    const a = make();
    const b = make();
    await a.store.append(message(1, "alice"));
    await a.store.append(message(2, "alice"));
    await b.store.append(message(1, "alice"));
    const handle = async (x: ReturnType<typeof make>, seq: number) =>
      (
        senderOf((await x.inner.read(STREAM)).find((e) => e.sequence === seq)) as {
          subject: string;
        }
      ).subject;
    expect(await handle(a, 1)).toBe(await handle(a, 2));
    expect(await handle(a, 1)).not.toBe(await handle(b, 1));
  });

  it("senderSubjectOf: false is the explicit opt-out (plaintext sender, said so)", async () => {
    const { inner, store } = make(new InMemoryKeyStore(), { senderSubjectOf: false });
    await store.append(message(1, "alice"));
    expect(senderOf((await inner.read(STREAM))[0])).toEqual({ actor: "alice", tenant: "t1" });
    expect(store.senderSealing).toBe("disabled");
  });

  it("erasing the sender makes their identity unreadable AND the handle unlinkable (the seed it derives from is gone)", async () => {
    const { inner, store, keys } = make();
    await store.append(message(1, "alice"));
    await store.append(message(2, "bob"));
    const handleOf = async (seq: number) =>
      (senderOf((await inner.read(STREAM)).find((e) => e.sequence === seq)) as { subject: string })
        .subject;
    const aliceHandle = await handleOf(1);
    expect(await store.eraseSender({ actor: "alice", tenant: "t1" })).toBe(true);
    const [a, b] = await store.read(STREAM);
    expect(senderOf(a)).toEqual({ erased: true, ref: aliceHandle });
    expect(JSON.stringify(a)).not.toContain("alice");
    expect(senderOf(b)).toEqual({ actor: "bob", tenant: "t1" }); // others untouched
    // the sealing key and the seed are both destroyed: the handle cannot be re-derived from the identity
    expect(await keys.get(aliceHandle)).toBeNull();
    expect(await keys.wasDestroyed?.(aliceHandle)).toBe(true);
    await expect(store.senderHandles?.subjectOf({ actor: "alice", tenant: "t1" })).rejects.toThrow(
      SenderErasedError
    );
    // an erased sender cannot send again (loud, typed)
    await expect(store.append(message(3, "alice"))).rejects.toThrow(SenderErasedError);
    // idempotent; a sender that never sent is a no-op
    expect(await store.eraseSender({ actor: "alice", tenant: "t1" })).toBe(false);
    expect(await store.eraseSender({ actor: "nobody" })).toBe(false);
  });

  it("N3: two DIFFERENT erased senders keep two different stable references, one sender keeps one", async () => {
    const { store } = make();
    await store.append(message(1, "alice"));
    await store.append(message(2, "bob"));
    await store.append(message(3, "alice"));
    await store.eraseSender({ actor: "alice", tenant: "t1" });
    await store.eraseSender({ actor: "bob", tenant: "t1" });
    const refs = (await store.read(STREAM)).map((e) => (senderOf(e) as { ref: string }).ref);
    expect(refs[0]).toBe(refs[2]);
    expect(refs[0]).not.toBe(refs[1]);
  });

  it("the archive seals the sender by default too, under the SAME handle, and erasing the sender reaches it", async () => {
    const keys = new InMemoryKeyStore();
    const { inner, store } = make(keys);
    const raw = new InMemoryArchiveStore();
    const archive = new EncryptingArchiveStore(raw, keys);
    const e = message(1, "alice");
    await archive.append(STREAM, buildReservedSegment([e], "inc"));
    expect(JSON.stringify(await raw.read(STREAM))).not.toContain("alice");
    const [back] = await archive.read(STREAM);
    expect(senderOf(back?.envelopes[0])).toEqual({ actor: "alice", tenant: "t1" });
    // the event store's handle for alice is the archive's (one KeyStore, one mapping): erasing once erases both
    await store.append(message(1, "alice"));
    expect(inner).toBeDefined();
    await store.eraseSender({ actor: "alice", tenant: "t1" });
    const [after] = await archive.read(STREAM);
    expect(senderOf(after?.envelopes[0])).toMatchObject({ erased: true });
  });
});

describe("N7: a sealed sender is bound to its message (a swap is detected)", () => {
  it("pasting one message's sealed sender into another fails to authenticate, never reads as that sender", async () => {
    const { inner, store } = make();
    await store.append(message(1, "alice"));
    await store.append(message(2, "bob"));
    const raw = await inner.read(STREAM);
    const swapped = raw.map((e) =>
      e.sequence === 1
        ? { ...e, payload: { ...(e.payload as object), sender: senderOf(raw[1]) } }
        : e
    );
    const tampered = new InMemoryAsyncEventStore();
    for (const e of swapped) await tampered.append(e);
    const reader = new EncryptingEventStore(
      tampered,
      (store as unknown as { keys: InMemoryKeyStore }).keys,
      {
        sensitive: {},
      }
    );
    await expect(reader.read(STREAM)).rejects.toThrow();
  });

  it("the same sealed sender at the same message position still opens (a verbatim quarantine copy keeps opening)", async () => {
    const { inner, store, keys } = make();
    await store.append(message(1, "alice"));
    const [orig] = await inner.read(STREAM);
    const copy = new InMemoryAsyncEventStore();
    const quarantineStream = `__loom_quarantine__:${CHAIN}`;
    await copy.append({
      ...(orig as EventEnvelope),
      id: "q-1",
      executionId: quarantineStream,
      sequence: 7,
      metadata: { quarantine: { topic: "t", inboxSeq: 1 } },
    });
    const reader = new EncryptingEventStore(copy, keys, { sensitive: {} });
    expect(senderOf((await reader.read(quarantineStream))[0])).toEqual({
      actor: "alice",
      tenant: "t1",
    });
  });
});

// ── ADR 0139 D22 - round 3 ───────────────────────────────────────────────────────────────────────────

/** A KeyStore whose create-if-absent is NOT atomic (get -> yield -> write, last writer wins): the KMS shape. */
class RacyKeys extends InMemoryKeyStore {
  private readonly table = new Map<string, Buffer>();
  override async getOrCreate(subjectId: string): Promise<Buffer> {
    const seen = this.table.get(subjectId);
    if (seen !== undefined) return seen;
    if ((await this.wasDestroyed(subjectId)) === true) throw new Error("destroyed");
    await new Promise((r) => setImmediate(r)); // another caller's get() lands here
    const key = randomBytes(32);
    this.table.set(subjectId, key); // upsert: last writer wins
    return key;
  }
  override async get(subjectId: string): Promise<Buffer | null> {
    return this.table.get(subjectId) ?? null;
  }
  override async destroy(subjectId: string): Promise<void> {
    this.table.delete(subjectId);
    await super.destroy(subjectId);
  }
}

describe("D22 blocker: concurrent first sends mint ONE seed, ONE handle", () => {
  it("Promise.all of first sends from one sender stores ONE handle, and erasing it reaches every message", async () => {
    const keys = new RacyKeys();
    const { inner, store } = make(keys);
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.append(message(i + 1, "alice"))));
    const handles = new Set(
      (await inner.read(STREAM)).map((e) => (senderOf(e) as { subject: string }).subject)
    );
    expect(handles.size).toBe(1);
    expect(await store.eraseSender({ actor: "alice", tenant: "t1" })).toBe(true);
    for (const e of await store.read(STREAM)) expect(senderOf(e)).toMatchObject({ erased: true });
  });

  it("two stores over one KeyStore (two nodes) with an atomic getOrCreate agree on the handle", async () => {
    const keys = new InMemoryKeyStore();
    const a = make(keys);
    const b = make(keys);
    await Promise.all([a.store.append(message(1, "alice")), b.store.append(message(2, "alice"))]);
    const h = async (x: ReturnType<typeof make>) =>
      (senderOf((await x.inner.read(STREAM))[0]) as { subject: string }).subject;
    expect(await h(a)).toBe(await h(b));
  });
});

describe("D22 erase verifies, and fails loud on a lost master", () => {
  /** Drop a key as a store that LOST it would (no tombstone). */
  const lose = (keys: InMemoryKeyStore, subject: string) =>
    (keys as unknown as { keys: Map<string, Buffer> }).keys.delete(subject);

  it("a master lost while sealed senders exist is a loud SenderMasterLostError, never a quiet false", async () => {
    const keys = new InMemoryKeyStore();
    const { store } = make(keys);
    await store.append(message(1, "alice"));
    lose(keys, "__loom_sender_master__");
    const restarted = make(keys); // a fresh node: no cached master
    await expect(restarted.store.eraseSender({ actor: "alice", tenant: "t1" })).rejects.toThrow(
      SenderMasterLostError
    );
    // and a send does not silently mint a NEW master either
    await expect(restarted.store.append(message(2, "alice"))).rejects.toThrow(
      SenderMasterLostError
    );
  });

  it("a destroyed master is SenderMasterLostError, not SenderErasedError", async () => {
    const keys = new InMemoryKeyStore();
    const { store } = make(keys);
    await store.append(message(1, "alice"));
    await keys.destroy("__loom_sender_master__");
    const restarted = make(keys);
    const err = await restarted.store
      .eraseSender({ actor: "alice", tenant: "t1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SenderMasterLostError);
    expect(err).not.toBeInstanceOf(SenderErasedError);
  });

  it("a store that never sealed a sender still answers false (no master, no marker)", async () => {
    const { store } = make();
    expect(await store.eraseSender({ actor: "alice", tenant: "t1" })).toBe(false);
  });

  it("the crash window between the two destroys surfaces SenderErasedError on a send", async () => {
    const keys = new InMemoryKeyStore();
    const { inner, store } = make(keys);
    await store.append(message(1, "alice"));
    const handle = (senderOf((await inner.read(STREAM))[0]) as { subject: string }).subject;
    await keys.destroy(handle); // crash after the first destroy: the seed is still live
    await expect(store.append(message(2, "alice"))).rejects.toThrow(SenderErasedError);
    // and the retry of the erase finishes it
    expect(await store.eraseSender({ actor: "alice", tenant: "t1" })).toBe(true);
  });

  it("fails loud when a destroy did not take (a live key remains)", async () => {
    class Stubborn extends InMemoryKeyStore {
      override async destroy(subjectId: string): Promise<void> {
        if (subjectId.startsWith("__loom_sender_seed__:")) return; // silently keeps the seed
        await super.destroy(subjectId);
      }
    }
    const { store } = make(new Stubborn());
    await store.append(message(1, "alice"));
    await expect(store.eraseSender({ actor: "alice", tenant: "t1" })).rejects.toThrow(
      SenderEraseIncompleteError
    );
  });
});

describe("N7+: the sealed sender is bound to the message id too", () => {
  it("a sealed sender pasted onto a message at the same position with another messageId fails to open", async () => {
    const { inner, store, keys } = make();
    await store.append(message(1, "alice"));
    const [orig] = await inner.read(STREAM);
    const forged = new InMemoryAsyncEventStore();
    await forged.append({
      ...(orig as EventEnvelope),
      payload: { ...((orig as EventEnvelope).payload as object), messageId: "other" },
    });
    const reader = new EncryptingEventStore(forged, keys, { sensitive: {} });
    await expect(reader.read(STREAM)).rejects.toThrow();
  });
});

describe("D22 owner ruling: an erased sender stays blocked until an operator reinstates them", () => {
  it("erased -> blocked -> reinstated -> sends under a NEW handle; old messages stay erased and unlinkable", async () => {
    const { inner, store, keys } = make();
    await store.append(message(1, "alice"));
    const oldHandle = (senderOf((await inner.read(STREAM))[0]) as { subject: string }).subject;
    await store.eraseSender({ actor: "alice", tenant: "t1" });
    await expect(store.append(message(2, "alice"))).rejects.toThrow(SenderErasedError);

    const result = await store.reinstateSender({ actor: "alice", tenant: "t1" });
    expect(result).toMatchObject({ reinstated: true, epoch: 1 });
    expect(JSON.stringify(result)).not.toContain("alice");

    await store.append(message(2, "alice"));
    const raw = await inner.read(STREAM);
    const newHandle = (senderOf(raw[1]) as { subject: string }).subject;
    expect(newHandle).not.toBe(oldHandle);
    const [oldMsg, newMsg] = await store.read(STREAM);
    expect(senderOf(oldMsg)).toEqual({ erased: true, ref: oldHandle });
    expect(senderOf(newMsg)).toEqual({ actor: "alice", tenant: "t1" });
    expect(await keys.get(oldHandle)).toBeNull();

    // idempotent: already reinstated, and a live sender is not "reinstated"
    expect(await store.reinstateSender({ actor: "alice", tenant: "t1" })).toMatchObject({
      reinstated: false,
    });
    // erasing again erases the NEW epoch, and a second reinstate opens epoch 2
    expect(await store.eraseSender({ actor: "alice", tenant: "t1" })).toBe(true);
    await expect(store.append(message(3, "alice"))).rejects.toThrow(SenderErasedError);
    expect(await store.reinstateSender({ actor: "alice", tenant: "t1" })).toMatchObject({
      reinstated: true,
      epoch: 2,
    });
    await store.append(message(3, "alice"));
  });

  it("reinstating a sender who never sent, or one that is live, does nothing", async () => {
    const { store } = make();
    expect((await store.reinstateSender({ actor: "nobody" })).reinstated).toBe(false);
    await store.append(message(1, "alice"));
    expect((await store.reinstateSender({ actor: "alice", tenant: "t1" })).reinstated).toBe(false);
    await expect(store.append(message(2, "alice"))).resolves.toBeUndefined();
  });
});
