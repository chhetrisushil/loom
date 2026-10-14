import type { EventEnvelope } from "@loom/core";
import {
  InMemoryAsyncEventStore,
  KEY_UNAVAILABLE_CODE,
  KeyUnavailableError,
  type SealMarker,
} from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptingEventStore } from "./EncryptingEventStore";
import { EncryptingSnapshotStore } from "./EncryptingSnapshotStore";
import { PayloadShreddedError } from "./errors";
import * as main from "./index";
import { InMemoryKeyStore } from "./keystore";
import { shredSubject } from "./shred";
import { seededIvSource } from "./testing";

// ADR 0130 residuals D7 - the capability marker (`metadata.seal`), the live `sealingCapability`, the
// key-unavailable vs shredded split, and the deterministic cipher seam.

const SECRET = "123-45-6789";

function ev(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown,
  metadata?: Record<string, unknown>
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "w",
    executionId,
    eventType,
    sequence,
    timestamp: 1,
    payload,
    ...(metadata !== undefined && { metadata }),
  };
}

function setup(
  sensitive: Record<string, readonly string[]> = {
    STEP_COMPLETED: ["output.ssn", "output.email"],
    EXECUTION_STARTED: ["principal.identity"],
  }
) {
  const inner = new InMemoryAsyncEventStore();
  const keys = new InMemoryKeyStore();
  const store = new EncryptingEventStore(inner, keys, { sensitive });
  return { inner, keys, store };
}

const sealOf = async (inner: InMemoryAsyncEventStore, id: string, i: number) =>
  (await inner.read(id))[i]?.metadata?.seal as SealMarker | undefined;

describe("metadata.seal is exact (stamped only where a field was sealed)", () => {
  it("lists exactly the paths sealed in THIS envelope, sorted, with the cipher id", async () => {
    const { inner, store } = setup();
    await store.append(ev("e1", 0, "STEP_COMPLETED", { output: { ssn: SECRET, email: "a@b" } }));
    await store.append(ev("e1", 1, "STEP_COMPLETED", { output: { ssn: SECRET } }));
    expect(await sealOf(inner, "e1", 0)).toEqual({
      v: 1,
      cipher: "loom/aes-256-gcm",
      covers: ["STEP_COMPLETED.output.email", "STEP_COMPLETED.output.ssn"],
    });
    // email absent from THIS payload: not claimed
    expect(await sealOf(inner, "e1", 1)).toEqual({
      v: 1,
      cipher: "loom/aes-256-gcm",
      covers: ["STEP_COMPLETED.output.ssn"],
    });
  });

  it("has no marker on an envelope with nothing sealed (an unmarked type, or no marked path present)", async () => {
    const { inner, store } = setup();
    await store.append(ev("e2", 0, "STEP_STARTED", { stepId: "s" }));
    await store.append(ev("e2", 1, "STEP_COMPLETED", { output: { other: 1 } }));
    expect(await sealOf(inner, "e2", 0)).toBeUndefined();
    expect(await sealOf(inner, "e2", 1)).toBeUndefined();
    expect((await inner.read("e2"))[0]?.metadata).toBeUndefined();
  });

  it("keeps the envelope's other metadata and never carries key material, key id or subject", async () => {
    const { inner, store } = setup();
    await store.append(
      ev("e3", 0, "STEP_COMPLETED", { output: { ssn: SECRET } }, { fence: 7, trace: "x" })
    );
    const stored = (await inner.read("e3"))[0];
    expect(stored?.metadata).toMatchObject({ fence: 7, trace: "x" });
    expect(JSON.stringify(stored?.metadata?.seal)).not.toMatch(/key|subject|e3|iv|tag/i);
  });

  it("is stamped on EVERY append path: appendBatch, appendIfUnchanged and copyPrefix", async () => {
    const { inner, store } = setup();
    await store.append(
      ev("p", 0, "EXECUTION_STARTED", { principal: { identity: { tenant: "t" } } })
    );
    await store.appendBatch!([
      ev("b", 0, "STEP_COMPLETED", { output: { ssn: SECRET } }),
      ev("b", 1, "STEP_COMPLETED", { output: { nothing: 1 } }),
    ]);
    expect((await sealOf(inner, "b", 0))?.covers).toEqual(["STEP_COMPLETED.output.ssn"]);
    expect(await sealOf(inner, "b", 1)).toBeUndefined();

    await store.append(ev("i", 0, "STEP_STARTED", { stepId: "s" }));
    const seen = await store.appendIfUnchanged!("i", null);
    expect(seen.appended).toBe(false);
    const obs = seen as { head: number | null; fence: number; anchor: string | null };
    const r = await store.appendIfUnchanged!(
      "i",
      ev("i", 1, "STEP_COMPLETED", { output: { ssn: SECRET } }),
      {
        head: obs.head as number,
        fence: obs.fence,
        anchor: obs.anchor as string,
      }
    );
    expect(r.appended).toBe(true);
    expect((await sealOf(inner, "i", 1))?.covers).toEqual(["STEP_COMPLETED.output.ssn"]);
    expect(JSON.stringify((await inner.read("i"))[1]?.payload)).not.toContain(SECRET);

    // a fork copies the stored bytes, marker included
    await store.copyPrefix!("p", "p-fork", 0, { forked: true });
    expect((await sealOf(inner, "p-fork", 0))?.covers).toEqual([
      "EXECUTION_STARTED.principal.identity",
    ]);
  });

  it("an exempt erasure marker alone seals nothing and gets no marker", async () => {
    const { inner, store } = setup({ MESSAGE_CONSUMED: ["payload"] });
    await store.append(ev("m", 0, "MESSAGE_CONSUMED", { payload: { $shredded: true } }));
    expect(await sealOf(inner, "m", 0)).toBeUndefined();
  });
});

describe("sealingCapability() is live from the sensitive map", () => {
  it("is defined even over an inner store that has none, sorted, deduped, with an exact cipher", () => {
    const { store } = setup();
    const cap = store.sealingCapability?.();
    expect(cap?.cipher).toBe("loom/aes-256-gcm");
    expect(cap?.covers).toEqual([
      "EXECUTION_STARTED.principal.identity",
      "STEP_COMPLETED.output.email",
      "STEP_COMPLETED.output.ssn",
    ]);
    expect(store.sealingCapability?.()?.covers).toEqual(cap?.covers);
    expect(store.sealingCapability?.()?.cipher).toBe(cap?.cipher);
  });

  it("reflects registerSensitive without rebuilding", () => {
    const { store } = setup({ STEP_COMPLETED: ["output.ssn"] });
    expect(store.sealingCapability?.()?.covers).toEqual(["STEP_COMPLETED.output.ssn"]);
    store.registerSensitive("OUTCOME_RECORDED", ["recordedBy"]);
    expect(store.sealingCapability?.()?.covers).toEqual([
      "OUTCOME_RECORDED.recordedBy",
      "STEP_COMPLETED.output.ssn",
    ]);
  });

  it("a store marking nothing seals and opens nothing (undefined)", () => {
    const { store } = setup({});
    expect(store.sealingCapability?.()).toBeUndefined();
  });

  it("opens(): a SUPERSET map opens an older, narrower marker; a narrower map, another cipher, a bad version do not", () => {
    const narrow: SealMarker = {
      v: 1,
      cipher: "loom/aes-256-gcm",
      covers: ["STEP_COMPLETED.output.ssn"],
    };
    const superset = setup({ STEP_COMPLETED: ["output.ssn", "output.email"] }).store;
    const same = setup({ STEP_COMPLETED: ["output.ssn"] }).store;
    const other = setup({ STEP_COMPLETED: ["output.email"] }).store;
    expect(superset.sealingCapability?.()?.opens(narrow)).toBe(true);
    expect(same.sealingCapability?.()?.opens(narrow)).toBe(true);
    expect(other.sealingCapability?.()?.opens(narrow)).toBe(false);
    expect(same.sealingCapability?.()?.opens({ ...narrow, cipher: "x/other" })).toBe(false);
    expect(same.sealingCapability?.()?.opens({ ...narrow, v: 2 } as never)).toBe(false);
    // a wider marker is NOT opened by the narrower node
    const wide: SealMarker = {
      ...narrow,
      covers: ["STEP_COMPLETED.output.email", "STEP_COMPLETED.output.ssn"],
    };
    expect(same.sealingCapability?.()?.opens(wide)).toBe(false);
  });
});

describe("key gone: KeyUnavailableError (no tombstone) vs PayloadShreddedError (a real shred)", () => {
  async function sealedStream() {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const writer = new EncryptingEventStore(inner, keys, {
      sensitive: { STEP_COMPLETED: ["output.ssn"] },
    });
    await writer.append(ev("x", 0, "STEP_COMPLETED", { output: { ssn: SECRET } }));
    return { inner, keys, writer };
  }

  it("a node whose KeyStore lacks the key raises KeyUnavailableError (stable code), carrying no ciphertext", async () => {
    const { inner } = await sealedStream();
    const wrong = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
      sensitive: { STEP_COMPLETED: ["output.ssn"] },
    });
    for (const read of [
      () => wrong.read("x"),
      () => wrong.readFrom("x", 0),
      () => wrong.readRange!("x", 0, 0),
    ]) {
      const err = await read().then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(KeyUnavailableError);
      expect(err).not.toBeInstanceOf(PayloadShreddedError);
      expect((err as KeyUnavailableError).code).toBe(KEY_UNAVAILABLE_CODE);
      expect(JSON.stringify(err)).not.toContain("__loomEnc");
      expect((err as Error).message).not.toContain("__loomEnc");
    }
  });

  it("a REAL shred (tombstone present) keeps raising PayloadShreddedError", async () => {
    const { inner, keys, writer } = await sealedStream();
    await shredSubject(keys, inner, "x", { snapshotStore: { loadLatest: async () => null } });
    await expect(writer.read("x")).rejects.toBeInstanceOf(PayloadShreddedError);
    // and a node with ANOTHER key store reads the tombstone and agrees it is an erasure
    const other = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
      sensitive: { STEP_COMPLETED: ["output.ssn"] },
    });
    await expect(other.read("x")).rejects.toBeInstanceOf(PayloadShreddedError);
  });

  it("a shred whose tombstone write failed reads key-unavailable until the retry completes, then shredded", async () => {
    const { inner, keys, writer } = await sealedStream();
    let fail = true;
    const flaky = Object.assign(Object.create(inner) as InMemoryAsyncEventStore, {
      append: async (e: EventEnvelope) => {
        if (e.eventType === "PAYLOAD_SHREDDED" && fail) throw new Error("write conflict");
        return inner.append(e);
      },
    });
    const opts = { snapshotStore: { loadLatest: async () => null } };
    await expect(shredSubject(keys, flaky, "x", opts)).rejects.toThrow();
    await expect(writer.read("x")).rejects.toBeInstanceOf(KeyUnavailableError);
    fail = false;
    await shredSubject(keys, flaky, "x", opts);
    await expect(writer.read("x")).rejects.toBeInstanceOf(PayloadShreddedError);
  });

  it("the snapshot store splits the same way (a folded shred record vs none)", async () => {
    const innerSnaps = new InMemoryAsyncSnapshotStore();
    const keys = new InMemoryKeyStore();
    const snaps = new EncryptingSnapshotStore(innerSnaps, keys, {
      sensitive: ["variables._input.ssn"],
    });
    const state = (extra: Record<string, unknown> = {}) =>
      ({
        executionId: "s",
        workflowId: "w",
        workflowVersion: "1",
        status: "suspended",
        sequence: 3,
        variables: { _input: { ssn: SECRET }, ...extra },
      }) as never;
    await snaps.save({
      id: "snap-3",
      executionId: "s",
      workflowId: "w",
      sequence: 3,
      state: state(),
      createdAt: 0,
    });
    // WITHOUT `events` nothing can prove "no tombstone": the old PayloadShreddedError stands (a real
    // shred must never read as a missing key).
    const noLog = new EncryptingSnapshotStore(innerSnaps, new InMemoryKeyStore(), {
      sensitive: ["variables._input.ssn"],
    });
    await expect(noLog.loadLatest("s")).rejects.toBeInstanceOf(PayloadShreddedError);
    // WITH the raw log, an empty log proves there is no tombstone: key-unavailable
    const wrong = new EncryptingSnapshotStore(innerSnaps, new InMemoryKeyStore(), {
      sensitive: ["variables._input.ssn"],
      events: new InMemoryAsyncEventStore(),
    });
    await expect(wrong.loadLatest("s")).rejects.toBeInstanceOf(KeyUnavailableError);
    // a snapshot that RECORDS the shred (compaction folded the tombstone into it) is an erasure
    await keys.destroy("s");
    const raw = await innerSnaps.loadLatest("s");
    await innerSnaps.save({
      ...(raw as NonNullable<typeof raw>),
      id: "snap-4",
      sequence: 4,
      state: {
        ...(raw?.state as object),
        variables: { ...(raw?.state.variables as object), _shredded: { subjectId: "s" } },
      } as never,
    });
    await expect(snaps.loadLatest("s")).rejects.toBeInstanceOf(PayloadShreddedError);
  });
});

describe("snapshot split is log-based when given the raw event store", () => {
  it("a shredded subject's snapshot load reports the shred (tombstone above the snapshot), a missing key without one reports key-unavailable", async () => {
    const innerSnaps = new InMemoryAsyncSnapshotStore();
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const opts = { sensitive: ["variables._input.ssn"], events: inner };
    const snaps = new EncryptingSnapshotStore(innerSnaps, keys, opts);
    await inner.append(ev("s", 0, "EXECUTION_STARTED", {}));
    await snaps.save({
      id: "snap-3",
      executionId: "s",
      workflowId: "w",
      sequence: 0,
      createdAt: 0,
      state: {
        executionId: "s",
        workflowId: "w",
        workflowVersion: "1",
        status: "suspended",
        sequence: 0,
        variables: { _input: { ssn: SECRET } },
      } as never,
    });
    const wrong = new EncryptingSnapshotStore(innerSnaps, new InMemoryKeyStore(), opts);
    await expect(wrong.loadLatest("s")).rejects.toBeInstanceOf(KeyUnavailableError);
    await shredSubject(keys, inner, "s", { snapshotStore: innerSnaps });
    await expect(snaps.loadLatest("s")).rejects.toBeInstanceOf(PayloadShreddedError);
    await expect(wrong.loadLatest("s")).rejects.toBeInstanceOf(PayloadShreddedError);
  });
});

describe("deterministic cipher seam (testing subpath)", () => {
  const prev = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = prev;
  });

  const run = async (seed: string | undefined) => {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    // one fixed key so two runs can be compared byte for byte
    const key = Buffer.alloc(32, 7);
    keys.getOrCreate = async () => key;
    keys.get = async () => key;
    const store = new EncryptingEventStore(inner, keys, {
      sensitive: { STEP_COMPLETED: ["output.ssn", "output.items[].v"] },
      ...(seed !== undefined && { ivSource: seededIvSource(seed) }),
    });
    await store.append(
      ev("d", 0, "STEP_COMPLETED", { output: { ssn: SECRET, items: [{ v: 1 }, { v: 2 }] } })
    );
    return JSON.stringify(await inner.read("d"));
  };

  it("two runs with the same seed produce byte-identical logs; another seed or the default differs", async () => {
    const a = await run("s1");
    expect(await run("s1")).toBe(a);
    expect(await run("s2")).not.toBe(a);
    expect(await run(undefined)).not.toBe(await run(undefined)); // randomBytes by default
  });

  it("each value of a wildcard path gets its own IV (no reuse within an envelope)", async () => {
    const parsed = JSON.parse(await run("s1")) as Array<{
      payload: { output: { items: Array<{ v: { iv: string } }> } };
    }>;
    const [a, b] = parsed[0]!.payload.output.items;
    expect(a!.v.iv).not.toBe(b!.v.iv);
  });

  it("the stores REFUSE a custom ivSource when NODE_ENV is production", () => {
    process.env.NODE_ENV = "production";
    const mk = () =>
      new EncryptingEventStore(new InMemoryAsyncEventStore(), new InMemoryKeyStore(), {
        sensitive: {},
        ivSource: seededIvSource("x"),
      });
    expect(mk).toThrow(/NODE_ENV.*production/);
    expect(
      () =>
        new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), new InMemoryKeyStore(), {
          sensitive: [],
          ivSource: seededIvSource("x"),
        })
    ).toThrow(/production/);
    // the default (no seam) is fine in production
    expect(
      () =>
        new EncryptingEventStore(new InMemoryAsyncEventStore(), new InMemoryKeyStore(), {
          sensitive: {},
        })
    ).not.toThrow();
  });

  it("the main entry does not export the seam", () => {
    expect(Object.keys(main)).not.toContain("seededIvSource");
    expect(Object.keys(main).some((k) => /ivsource/i.test(k))).toBe(false);
  });
});
