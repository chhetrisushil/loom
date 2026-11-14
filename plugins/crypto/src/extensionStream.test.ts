import type { EventEnvelope } from "@loomwork/core";
import {
  InMemoryAsyncEventStore,
  isKeyUnavailable,
  isPayloadShredded,
} from "@loomwork/event-runtime";
import { InMemoryContentStore } from "@loomwork/plugin-content";
import { describe, expect, it } from "vitest";
import { EncryptingContentStore } from "./EncryptingContentStore";
import { EncryptingEventStore } from "./EncryptingEventStore";
import { InMemoryKeyStore } from "./keystore";
import { shredSubject } from "./shred";

// ── A reserved EXTENSION stream is erased with its owner ──────────────────────────────────────
//
// A package built on loom can keep its own log in a stream under the reserved `__loom_` prefix,
// so enumerators of real executions skip it (loom-ui's lineage writes `__loom_ui_lineage__:<id>`).
// Such a stream is not an execution, so no default maps it to a person. The host's `subjectOf`
// is called with the STREAM id on every append and read, and with the `ContentAccess` on every
// content put/get, so the host names the owner there and the stream is sealed under, and erased
// with, that owner's key. These tests pin that no new API is needed for it.

const STREAM = "__loom_ui_lineage__:exp-1";
const owners = new Map([[STREAM, "user:ann"]]);
/** The host's mapping: an extension stream to its owner's subject; an execution to itself. */
const subjectOf = (e: { executionId: string }): string =>
  owners.get(e.executionId) ?? e.executionId;

const SECRET = "Ann's diagnosis summary";

function event(sequence: number): EventEnvelope {
  return {
    id: `${STREAM}-${sequence}`,
    workflowId: "loom-ui-lineage",
    executionId: STREAM,
    eventType: "LINEAGE_COMMITTED",
    sequence,
    timestamp: 0,
    payload: { ops: [{ label: SECRET }], parents: ["abc"] },
  } as EventEnvelope;
}

function setup() {
  const keys = new InMemoryKeyStore();
  const raw = new InMemoryAsyncEventStore();
  const events = new EncryptingEventStore(raw, keys, {
    sensitive: { LINEAGE_COMMITTED: ["ops"] },
    subjectOf,
  });
  const content = new EncryptingContentStore(new InMemoryContentStore(), keys, { subjectOf });
  const access = { executionId: STREAM, workflowId: "loom-ui-lineage" };
  return { keys, raw, events, content, access };
}

describe("a reserved extension stream sealed through the host's subjectOf", () => {
  it("seals the stream's marked paths under the OWNER's key, not a key named after the stream", async () => {
    const { keys, raw, events } = setup();
    await events.append(event(1));

    const stored = JSON.stringify((await raw.read(STREAM))[0]?.payload);
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("abc"); // unmarked paths stay plain
    expect(await keys.get("user:ann")).not.toBeNull();
    expect(await keys.get(STREAM)).toBeNull();

    const [read] = await events.read(STREAM);
    expect(JSON.stringify(read?.payload)).toContain(SECRET);
  });

  it("destroying the owner's key makes both the stream's events and its blobs unreadable", async () => {
    const { keys, raw, events, content, access } = setup();
    await events.append(event(1));
    const ref = await content.put(new TextEncoder().encode(SECRET), access);

    // `shredSubject` refuses to TOMBSTONE a reserved stream (it is not an execution), so the
    // stream is erased by the key alone: pass the owner's real executions, or [].
    await expect(
      shredSubject(keys, raw, STREAM, { subjectId: "user:ann", executionIds: [STREAM] })
    ).rejects.toThrow(/reserved stream/);
    await shredSubject(keys, raw, STREAM, { subjectId: "user:ann", executionIds: [] });

    const eventErr = await events.read(STREAM).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isKeyUnavailable(eventErr)).toBe(true);
    const blobErr = await content.get(ref, access).then(
      () => undefined,
      (e: unknown) => e
    );
    // InMemoryKeyStore records the destruction, so the blob read can say "erased"; the stream
    // has no tombstone, so its read cannot (KeyUnavailableError above).
    expect(isPayloadShredded(blobErr)).toBe(true);
    // The ciphertext is still in the raw store, but nothing in it is the plaintext.
    expect(JSON.stringify((await raw.read(STREAM))[0]?.payload)).not.toContain(SECRET);
  });
});
