import { describe, expect, it } from "vitest";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import {
  INBOX_STREAM_PREFIX,
  INBOX_TOPIC_SEQ_BASE,
  QUARANTINE_STREAM_PREFIX,
  hasInboxStreamShape,
  inboxChainOf,
  inboxRegistryStreamId,
  inboxStreamsOfChain,
  inboxTopicHash,
  inboxTopicStreamId,
  isReservedStream,
  quarantineStreamId,
} from "./types";

// ADR 0110 amendment, D10b — the naming of a chain's inbox streams, shared by the runtime, the
// compliance purge and the crypto decorator.

describe("inbox stream naming", () => {
  it("a topic stream is the chain's stream plus # and 16 hex digits; all of them are reserved", () => {
    const s = inboxTopicStreamId("c1", "orders");
    expect(s).toMatch(/^__loom_inbox__:c1#[0-9a-f]{16}$/);
    expect(s.endsWith(inboxTopicHash("orders"))).toBe(true);
    expect(inboxTopicHash("orders")).not.toBe(inboxTopicHash("order"));
    for (const id of [s, inboxRegistryStreamId("c1"), `${INBOX_STREAM_PREFIX}c1`]) {
      expect(isReservedStream(id)).toBe(true);
    }
  });

  it("every stream of a chain maps back to the chain; other ids do not", () => {
    for (const id of [
      inboxTopicStreamId("c1", "t"),
      inboxRegistryStreamId("c1"),
      `${INBOX_STREAM_PREFIX}c1`,
    ]) {
      expect(inboxChainOf(id)).toBe("c1");
    }
    // a derived-child chain id contains # but is not a topic stream
    expect(inboxChainOf(`${INBOX_STREAM_PREFIX}parent::g#0`)).toBe("parent::g#0");
    expect(inboxChainOf(inboxTopicStreamId("parent::g#0", "t"))).toBe("parent::g#0");
    expect(inboxChainOf("c1")).toBeUndefined();
    expect(inboxChainOf("__loom_inbox_layout__")).toBeUndefined();
    expect(inboxChainOf(INBOX_STREAM_PREFIX)).toBeUndefined();
  });

  it("the reserved-id shape is exactly #<16 hex> or #reg", () => {
    expect(hasInboxStreamShape("x#0123456789abcdef")).toBe(true);
    expect(hasInboxStreamShape("x#reg")).toBe(true);
    for (const ok of ["x", "x#0", "x#0123456789abcde", "x#0123456789abcdeg", "x#regs", "x::g#0"]) {
      expect(hasInboxStreamShape(ok)).toBe(false);
    }
  });

  it("topic streams live above the legacy sequence space", () => {
    expect(INBOX_TOPIC_SEQ_BASE).toBeGreaterThan(2 ** 32);
    expect(Number.isSafeInteger(INBOX_TOPIC_SEQ_BASE * 2)).toBe(true);
  });

  it("inboxStreamsOfChain names the legacy stream, the registry (only when it has entries) and each topic once", async () => {
    const store = new InMemoryAsyncEventStore();
    expect(await inboxStreamsOfChain(store, "c1")).toEqual({
      legacy: `${INBOX_STREAM_PREFIX}c1`,
      registry: undefined,
      topics: [],
      quarantine: `${QUARANTINE_STREAM_PREFIX}c1`,
    });
    const registry = inboxRegistryStreamId("c1");
    let seq = 0;
    for (const topic of ["a", "b", "a"]) {
      await store.append({
        id: `${registry}-${seq}`,
        workflowId: "__loom_inbox__",
        executionId: registry,
        eventType: "INBOX_TOPIC",
        sequence: seq++,
        timestamp: 1,
        payload: { topic },
      });
    }
    expect(await inboxStreamsOfChain(store, "c1")).toEqual({
      legacy: `${INBOX_STREAM_PREFIX}c1`,
      registry,
      topics: [inboxTopicStreamId("c1", "a"), inboxTopicStreamId("c1", "b")],
      quarantine: `${QUARANTINE_STREAM_PREFIX}c1`,
    });
  });

  it("the quarantine stream (ADR 0130 residuals D9, reserved) is a reserved stream that belongs to its chain", () => {
    expect(quarantineStreamId("c1")).toBe("__loom_quarantine__:c1");
    expect(isReservedStream(quarantineStreamId("c1"))).toBe(true);
    // The crypto subject mapping (`inboxChainOf`) therefore resolves it to the same owner as the inbox.
    expect(inboxChainOf(quarantineStreamId("c1"))).toBe("c1");
    expect(inboxChainOf(QUARANTINE_STREAM_PREFIX)).toBeUndefined();
    expect(inboxChainOf(`${INBOX_STREAM_PREFIX}c1`)).toBe("c1");
  });
});
