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
import { SenderErasedError, isSealedSender } from "./senderSeal";

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
