import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore, inboxChainOf, quarantineStreamId } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { EncryptingEventStore, isShredded } from "./EncryptingEventStore";
import { InMemoryKeyStore } from "./keystore";

// ADR 0130 residuals D9 - the quarantine stream `__loom_quarantine__:<chainId>` holds a VERBATIM copy of
// a sealed inbox message. The sealing decorator must (a) not seal an already-sealed value again,
// (b) keep `metadata.seal`, (c) map the stream to the chain's OWNER subject, so a shred destroys the
// copy with the original, and (d) read it non-loudly like the inbox (a missing key => redacted).

const SECRET = "123-45-6789";
const subjectOf = (e: { executionId: string }): string => e.executionId;

function msg(stream: string, sequence: number, payload: unknown): EventEnvelope {
  return {
    id: `${stream}-${sequence}`,
    workflowId: "__loom_inbox__",
    executionId: stream,
    eventType: "INBOX_MESSAGE",
    sequence,
    timestamp: 1,
    payload: { topic: "t", messageId: "m1", payload, sender: {} },
  };
}

function setup(keys = new InMemoryKeyStore()) {
  const inner = new InMemoryAsyncEventStore();
  const store = new EncryptingEventStore(inner, keys, {
    sensitive: { INBOX_MESSAGE: ["payload"] },
    subjectOf,
  });
  return { inner, keys, store };
}

/** Copy the stored (sealed) inbox envelope into the owner's quarantine stream, as the kernel does. */
async function quarantineCopy(inner: InMemoryAsyncEventStore, chain: string) {
  const [original] = await inner.read(`__loom_inbox__:${chain}`);
  if (original === undefined) throw new Error("no original");
  const copy: EventEnvelope = {
    ...original,
    id: "quarantine:k",
    executionId: quarantineStreamId(chain),
    sequence: 0,
  };
  return { original, copy };
}

describe("EncryptingEventStore - the quarantine stream", () => {
  it("maps the stream to the chain's owner subject", () => {
    expect(inboxChainOf(quarantineStreamId("owner-1"))).toBe("owner-1");
  });

  it("stores a verbatim copy of a sealed message as given: not sealed twice, marker kept, readable by the owner's key", async () => {
    const { inner, store } = setup();
    await store.append(msg("__loom_inbox__:own", 0, { ssn: SECRET }));
    const { original, copy } = await quarantineCopy(inner, "own");
    expect(original.metadata?.seal).toBeDefined();
    await store.append(copy);
    const [stored] = await inner.read(quarantineStreamId("own"));
    expect(stored?.payload).toEqual(original.payload); // byte-identical ciphertext, no nesting
    expect(stored?.metadata?.seal).toEqual(original.metadata?.seal);
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    const [opened] = await store.read(quarantineStreamId("own"));
    expect((opened?.payload as { payload: unknown }).payload).toEqual({ ssn: SECRET });
    // the same through a batch
    await store.appendBatch?.([{ ...copy, id: "quarantine:k2", sequence: 1 }]);
    const both = await inner.read(quarantineStreamId("own"));
    expect(both[1]?.payload).toEqual(original.payload);
    expect(both[1]?.metadata?.seal).toEqual(original.metadata?.seal);
  });

  it("a PLAIN value written into the stream is still sealed (the exemption is only for pre-sealed values)", async () => {
    const { inner, store } = setup();
    await store.append(msg(quarantineStreamId("own"), 0, { ssn: SECRET }));
    const [stored] = await inner.read(quarantineStreamId("own"));
    expect(JSON.stringify(stored)).toContain("__loomEnc");
    expect(JSON.stringify(stored)).not.toContain(SECRET);
  });

  it("a shred of the owner's subject destroys the copy with the original: both read as redacted, never loudly", async () => {
    const { inner, keys, store } = setup();
    await store.append(msg("__loom_inbox__:own", 0, { ssn: SECRET }));
    const { copy } = await quarantineCopy(inner, "own");
    await store.append(copy);
    await keys.destroy("own");
    const [original] = await store.read("__loom_inbox__:own");
    const [held] = await store.read(quarantineStreamId("own"));
    expect(isShredded((original?.payload as { payload: unknown }).payload)).toBe(true);
    expect(isShredded((held?.payload as { payload: unknown }).payload)).toBe(true);
  });

  it("a node whose key store lacks the owner's key reads the copy as REDACTED, never as ciphertext and never loudly", async () => {
    const { inner, store } = setup();
    await store.append(msg("__loom_inbox__:own", 0, { ssn: SECRET }));
    const { copy } = await quarantineCopy(inner, "own");
    await store.append(copy);
    const wrong = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
      sensitive: { INBOX_MESSAGE: ["payload"] },
      subjectOf,
    });
    const [held] = await wrong.read(quarantineStreamId("own"));
    expect(isShredded((held?.payload as { payload: unknown }).payload)).toBe(true);
    expect(JSON.stringify(held)).not.toContain("__loomEnc");
  });
});
