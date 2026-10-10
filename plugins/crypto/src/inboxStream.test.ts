import type { EventEnvelope } from "@loom/core";
import {
  InMemoryAsyncEventStore,
  inboxRegistryStreamId,
  inboxTopicStreamId,
} from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { EncryptingEventStore, isShredded } from "./EncryptingEventStore";
import { OwnerUnresolvedError, PayloadShreddedError, PayloadUndecryptableError } from "./errors";
import { InMemoryKeyStore } from "./keystore";

// ADR 0110 follow-up — a chain's inbox stream (`__loom_inbox__:<chainId>`) is sealed under the
// OWNER's subject and is never read loudly after a shred.

const until = async (pred: () => boolean): Promise<void> => {
  for (let i = 0; i < 4000 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!pred()) throw new Error("until: timed out");
};

const SECRET = "123-45-6789";
const subjectOf = (e: { executionId: string }): string =>
  e.executionId.startsWith("alice-") ? "alice" : e.executionId;

function msg(stream: string, sequence: number, payload: unknown): EventEnvelope {
  return {
    id: `${stream}-${sequence}`,
    workflowId: "__loom_inbox__",
    executionId: stream,
    eventType: "INBOX_MESSAGE",
    sequence,
    timestamp: 1,
    payload: { topic: "t", messageId: `m${sequence}`, payload, sender: {} },
  };
}

function setup(onShredded?: "throw" | "tolerate") {
  const inner = new InMemoryAsyncEventStore();
  const keys = new InMemoryKeyStore();
  const store = new EncryptingEventStore(inner, keys, {
    sensitive: { INBOX_MESSAGE: ["payload"], STEP_COMPLETED: ["output.ssn"] },
    subjectOf,
    ...(onShredded !== undefined && { onShredded }),
  });
  return { inner, keys, store };
}

describe("EncryptingEventStore — a chain's inbox stream", () => {
  it("seals the payload under the OWNER's subject, not under the stream's own id", async () => {
    const { inner, keys, store } = setup();
    await store.append(msg("__loom_inbox__:alice-1", 0, SECRET));
    expect(JSON.stringify(await inner.read("__loom_inbox__:alice-1"))).not.toContain(SECRET);
    expect(await keys.get("alice")).not.toBeNull();
    expect(await keys.get("__loom_inbox__:alice-1")).toBeNull();
    const [read] = await store.read("__loom_inbox__:alice-1");
    expect((read?.payload as { payload: unknown }).payload).toBe(SECRET);
    // The topic, id and sender are not sensitive: they stay readable for routing and dedupe.
    expect((read?.payload as { topic: string }).topic).toBe("t");
  });

  it("ADR 0110 D10b: a TOPIC stream and the registry resolve to the same owner subject and read as the marker after a shred", async () => {
    const { inner, keys, store } = setup("throw");
    const topic = inboxTopicStreamId("alice-1", "t");
    await store.append(msg(topic, 2 ** 40, SECRET));
    expect(JSON.stringify(await inner.read(topic))).not.toContain(SECRET);
    expect(await keys.get("alice")).not.toBeNull(); // the OWNER's key, not the stream's own id
    expect(await keys.get(topic)).toBeNull();
    // The registry is routing data (no sensitive path), but it maps to the same chain too.
    await store.append({
      ...msg(inboxRegistryStreamId("alice-1"), 0, null),
      eventType: "INBOX_TOPIC",
      payload: { topic: "t" },
    });
    await keys.destroy("alice");
    const [read] = await store.read(topic);
    expect(isShredded((read?.payload as { payload: unknown }).payload)).toBe(true);
    expect(await store.read(inboxRegistryStreamId("alice-1"))).toHaveLength(1); // never throws
  });

  it("after the subject's key is destroyed the payload reads as the marker even in the default 'throw' mode", async () => {
    const { keys, store } = setup("throw");
    await store.append(msg("__loom_inbox__:alice-1", 0, SECRET));
    await store.append(msg("__loom_inbox__:alice-1", 1, "second"));
    await keys.destroy("alice");
    for (const read of [
      () => store.read("__loom_inbox__:alice-1"),
      () => store.readFrom("__loom_inbox__:alice-1", 0),
      () => store.readRange!("__loom_inbox__:alice-1", 0, 1),
    ]) {
      const events = await read();
      expect(events).toHaveLength(2);
      for (const e of events) {
        const p = e.payload as { topic: string; messageId: string; payload: unknown };
        expect(isShredded(p.payload)).toBe(true);
        expect(p.topic).toBe("t"); // routing fields survive
      }
    }
  });

  it("P3-7: a key that EXISTS but cannot open the ciphertext is a typed error, never the erasure marker", async () => {
    const { inner, store } = setup();
    await store.append(msg("__loom_inbox__:alice-1", 0, SECRET));
    // A KeyStore that minted a FRESH key for the subject (or a subjectOf that drifted) hands the
    // reader a key that cannot open the older ciphertext: that is a defect, not an erasure.
    const reminted = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
      sensitive: { INBOX_MESSAGE: ["payload"] },
      subjectOf,
    });
    await reminted.keys.getOrCreate("alice");
    for (const read of [
      () => reminted.read("__loom_inbox__:alice-1"),
      () => reminted.readFrom("__loom_inbox__:alice-1", 0),
      () => reminted.readRange!("__loom_inbox__:alice-1", 0, 0),
    ]) {
      const err = await read().then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(PayloadUndecryptableError);
      expect(err).not.toBeInstanceOf(PayloadShreddedError);
    }
  });

  it("P3-7: a tampered row is the same typed error", async () => {
    const { inner, store } = setup();
    await store.append(msg("__loom_inbox__:alice-1", 0, SECRET));
    const [row] = await inner.read("__loom_inbox__:alice-1");
    const sealedPayload = row?.payload as { payload: { data: string } };
    sealedPayload.payload.data = Buffer.from("tampered tampered!").toString("base64");
    await expect(store.read("__loom_inbox__:alice-1")).rejects.toBeInstanceOf(
      PayloadUndecryptableError
    );
  });

  it("P3-7: subscribe hands the marker, not ciphertext, once the key is destroyed", async () => {
    const { keys, store } = setup();
    const seen: EventEnvelope[] = [];
    await store.subscribe("__loom_inbox__:alice-1", (e) => seen.push(e));
    await store.append(msg("__loom_inbox__:alice-1", 0, SECRET));
    await until(() => seen.length === 1);
    expect((seen[0]?.payload as { payload: unknown }).payload).toBe(SECRET);
    await keys.destroy("alice");
    // (the in-memory inner store publishes the SEALED envelope; a second append after a shred is
    // refused by the key store, so replay the sealed one through the inner store directly)
    const sealedRow = await (store as unknown as { inner: InMemoryAsyncEventStore }).inner.read(
      "__loom_inbox__:alice-1"
    );
    expect(JSON.stringify(sealedRow)).not.toContain(SECRET);
    const late: EventEnvelope[] = [];
    const inner2 = new InMemoryAsyncEventStore();
    const store2 = new EncryptingEventStore(inner2, keys, {
      sensitive: { INBOX_MESSAGE: ["payload"] },
      subjectOf,
    });
    await store2.subscribe("__loom_inbox__:alice-1", (e) => late.push(e));
    await inner2.append(sealedRow[0] as EventEnvelope);
    await until(() => late.length === 1);
    expect(isShredded((late[0]?.payload as { payload: unknown }).payload)).toBe(true);
    expect(JSON.stringify(late)).not.toContain("loomEnc");
  });

  it("P3-6: subjectOf is asked with the OWNER's workflow id, not the stream's reserved one", async () => {
    const inner = new InMemoryAsyncEventStore();
    const asked: Array<{ executionId: string; workflowId: string }> = [];
    const store = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
      sensitive: { INBOX_MESSAGE: ["payload"] },
      subjectOf: (e) => {
        asked.push({ executionId: e.executionId, workflowId: e.workflowId });
        return e.workflowId === "billing" ? "acct" : e.executionId;
      },
    });
    await inner.append({
      id: "o-0",
      workflowId: "billing",
      executionId: "owner-1",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: {},
    });
    await store.append(msg("__loom_inbox__:owner-1", 0, SECRET));
    expect(asked.at(-1)).toEqual({ executionId: "owner-1", workflowId: "billing" });
    expect(await store.keys.get("acct")).not.toBeNull();
    expect(asked.some((a) => a.workflowId === "__loom_inbox__")).toBe(false);
  });

  it("review P3: an UNRESOLVABLE owner is never sealed under a guessed subject: a workflow-keyed subjectOf makes the write FAIL", async () => {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const store = new EncryptingEventStore(inner, keys, {
      sensitive: { INBOX_MESSAGE: ["payload"] },
      subjectOf: (e) => (e.workflowId === "billing" ? "acct" : e.executionId),
    });
    // the owner has no log yet: nothing to read the workflow id from
    await expect(store.append(msg("__loom_inbox__:ghost-1", 0, SECRET))).rejects.toBeInstanceOf(
      OwnerUnresolvedError
    );
    expect(await inner.read("__loom_inbox__:ghost-1")).toEqual([]); // no row, sealed or not
    expect(await keys.get("")).toBeNull(); // nothing minted under the blank subject
    // a subjectOf that keys on the execution id never reads the workflow id: unaffected
    const plain = new EncryptingEventStore(inner, keys, {
      sensitive: { INBOX_MESSAGE: ["payload"] },
      subjectOf,
    });
    await plain.append(msg("__loom_inbox__:ghost-1", 0, SECRET));
    expect(await inner.read("__loom_inbox__:ghost-1")).toHaveLength(1);
  });

  it('review P3: a TRANSIENT readRange failure fails the send (nothing sealed under ""); the retry seals under the right subject', async () => {
    const inner = new InMemoryAsyncEventStore();
    await inner.append({
      id: "o-0",
      workflowId: "billing",
      executionId: "owner-1",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: {},
    });
    let failures = 1;
    const flaky = Object.create(inner) as InMemoryAsyncEventStore;
    flaky.readRange = async (id, from, to) => {
      if (failures-- > 0) throw new Error("connection reset");
      return inner.readRange(id, from, to);
    };
    const keys = new InMemoryKeyStore();
    const store = new EncryptingEventStore(flaky, keys, {
      sensitive: { INBOX_MESSAGE: ["payload"] },
      subjectOf: (e) => (e.workflowId === "billing" ? "acct" : e.executionId),
    });
    const err = await store.append(msg("__loom_inbox__:owner-1", 0, SECRET)).catch((x) => x);
    expect(err).toBeInstanceOf(OwnerUnresolvedError);
    expect((err as OwnerUnresolvedError).cause).toBeInstanceOf(Error);
    expect(await inner.read("__loom_inbox__:owner-1")).toEqual([]);
    expect(await keys.get("")).toBeNull();
    expect(await keys.get("owner-1")).toBeNull();
    // the failure was not cached as "unresolvable": the retry succeeds under the owner's subject
    await store.append(msg("__loom_inbox__:owner-1", 0, SECRET));
    expect(await keys.get("acct")).not.toBeNull();
    expect(JSON.stringify(await inner.read("__loom_inbox__:owner-1"))).not.toContain(SECRET);
  });

  it('review P3: the crypto layer refuses "" as a sealing subject (every such record would share one key)', async () => {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const store = new EncryptingEventStore(inner, keys, {
      sensitive: { STEP_COMPLETED: ["output.ssn"] },
      subjectOf: () => "",
    });
    await expect(
      store.append({
        id: "x-1",
        workflowId: "w",
        executionId: "x",
        eventType: "STEP_COMPLETED",
        sequence: 1,
        timestamp: 1,
        payload: { output: { ssn: SECRET } },
      })
    ).rejects.toThrow(/refuses to seal under/);
    expect(await inner.read("x")).toEqual([]);
    expect(await keys.get("")).toBeNull();
  });

  it("review P3: the verbatim erasure-marker exception is scoped to MESSAGE_CONSUMED.payload; the same bytes anywhere else are DATA and are sealed", async () => {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const store = new EncryptingEventStore(inner, keys, {
      sensitive: {
        STEP_COMPLETED: ["output.a"],
        INBOX_MESSAGE: ["payload"],
        MESSAGE_CONSUMED: ["payload", "extra"],
      },
      subjectOf,
    });
    const marker = { $shredded: true };
    await store.append({
      id: "alice-1-1",
      workflowId: "w",
      executionId: "alice-1",
      eventType: "STEP_COMPLETED",
      sequence: 1,
      timestamp: 1,
      payload: { output: { a: marker } },
    });
    await store.append(msg("__loom_inbox__:alice-1", 0, marker));
    const consumed = (sequence: number, payload: unknown, extra?: unknown): EventEnvelope => ({
      id: `alice-1-${sequence}`,
      workflowId: "w",
      executionId: "alice-1",
      eventType: "MESSAGE_CONSUMED",
      sequence,
      timestamp: 1,
      payload: {
        waitId: "#0",
        topic: "t",
        messageId: "m",
        inboxSeq: 0,
        sender: {},
        payload,
        extra,
      },
    });
    await store.append(consumed(2, marker, marker));
    // the step output and the inbox message hold ciphertext, not the plaintext marker
    const rawStep = (await inner.read("alice-1"))[0]?.payload as { output: { a: unknown } };
    expect(JSON.stringify(rawStep.output.a)).toContain("loomEnc");
    const rawMsg = (await inner.read("__loom_inbox__:alice-1"))[0]?.payload as { payload: unknown };
    expect(JSON.stringify(rawMsg.payload)).toContain("loomEnc");
    // MESSAGE_CONSUMED.payload is the one verbatim exception; a second marked path is sealed
    const rawConsumed = (await inner.read("alice-1"))[1]?.payload as {
      payload: unknown;
      extra: unknown;
    };
    expect(rawConsumed.payload).toEqual(marker);
    expect(JSON.stringify(rawConsumed.extra)).toContain("loomEnc");
    // and the live subject reads its OWN marker-shaped value back as data, not as erased
    const [step] = await store.read("alice-1");
    expect((step?.payload as { output: { a: unknown } }).output.a).toEqual(marker);
    // after the erasure the sealed step is unreadable (the old behaviour left it plaintext)
    await keys.destroy("alice");
    await expect(store.read("alice-1")).rejects.toBeInstanceOf(PayloadShreddedError);
  });

  it("P3-2: a record that carries only the erasure marker is stored verbatim, so a shredded owner can still journal it", async () => {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const store = new EncryptingEventStore(inner, keys, {
      sensitive: { MESSAGE_CONSUMED: ["payload"] },
      subjectOf,
    });
    const consumed = (sequence: number, payload: unknown): EventEnvelope => ({
      id: `alice-9-${sequence}`,
      workflowId: "w",
      executionId: "alice-9",
      eventType: "MESSAGE_CONSUMED",
      sequence,
      timestamp: 1,
      payload: {
        waitId: "#0",
        topic: "t",
        messageId: "m",
        inboxSeq: sequence,
        sender: {},
        payload,
      },
    });
    // plaintext written BEFORE the path was registered stays readable beside sealed new writes
    const early = new EncryptingEventStore(inner, keys, { sensitive: {}, subjectOf });
    await early.append(consumed(0, "old plaintext"));
    await store.append(consumed(1, SECRET));
    expect(JSON.stringify(await inner.read("alice-9"))).not.toContain(SECRET);
    expect(JSON.stringify(await inner.read("alice-9"))).toContain("old plaintext");
    const both = await store.read("alice-9");
    expect(both.map((e) => (e.payload as { payload: unknown }).payload)).toEqual([
      "old plaintext",
      SECRET,
    ]);
    await keys.destroy("alice");
    // the marker alone needs no key; anything else is refused (nothing sealable without one)
    await store.append(consumed(2, { $shredded: true }));
    await expect(store.append(consumed(3, "late"))).rejects.toThrow(/destroyed/);
    // a marker with data smuggled beside it is NOT the marker: it is sealed like any value
    await expect(store.append(consumed(4, { $shredded: true, ssn: SECRET }))).rejects.toThrow(
      /destroyed/
    );
  });

  it("every other stream still fails loudly after a shred (the authoritative fold must not diverge)", async () => {
    const { keys, store } = setup("throw");
    const step: EventEnvelope = {
      id: "alice-2-1",
      workflowId: "w",
      executionId: "alice-2",
      eventType: "STEP_COMPLETED",
      sequence: 1,
      timestamp: 1,
      payload: { output: { ssn: SECRET } },
    };
    await store.append(step);
    await keys.destroy("alice");
    await expect(store.read("alice-2")).rejects.toBeInstanceOf(PayloadShreddedError);
  });

  it("an unrelated chain's stream is untouched by another subject's shred", async () => {
    const { keys, store } = setup();
    await store.append(msg("__loom_inbox__:bob-1", 0, "bob's"));
    await store.append(msg("__loom_inbox__:alice-1", 0, "alice's"));
    await keys.destroy("alice");
    const [bob] = await store.read("__loom_inbox__:bob-1");
    expect((bob?.payload as { payload: unknown }).payload).toBe("bob's");
  });
});
