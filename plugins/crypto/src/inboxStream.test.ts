import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { EncryptingEventStore, isShredded } from "./EncryptingEventStore";
import { PayloadShreddedError } from "./errors";
import { InMemoryKeyStore } from "./keystore";

// ADR 0110 follow-up — a chain's inbox stream (`__loom_inbox__:<chainId>`) is sealed under the
// OWNER's subject and is never read loudly after a shred.

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

  it("a payload no key opens (a key re-minted after the shred) is the marker, never an error or ciphertext", async () => {
    const { inner, store } = setup();
    await store.append(msg("__loom_inbox__:alice-1", 0, SECRET));
    // A KeyStore that minted a FRESH key for the destroyed subject would hand the reader a key that
    // cannot open the older ciphertext.
    const reminted = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
      sensitive: { INBOX_MESSAGE: ["payload"] },
      subjectOf,
    });
    const [read] = await reminted.read("__loom_inbox__:alice-1");
    expect(isShredded((read?.payload as { payload: unknown }).payload)).toBe(true);
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
