import type { EventEnvelope, ExecutionState } from "@loom/core";
import { InMemoryAsyncEventStore, KeyUnavailableError } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import type { Snapshot } from "@loom/snapshot-runtime";
import { InMemoryAsyncSnapshotStore, TenantScopedSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { EncryptingEventStore, isShredded } from "./EncryptingEventStore";
import { EncryptingSnapshotStore } from "./EncryptingSnapshotStore";
import { encryptValue } from "./crypto";
import { PayloadShreddedError } from "./errors";
import { InMemoryKeyStore } from "./keystore";
import { ShredIncompleteError, shredSubject } from "./shred";

/** No snapshots: these logs are never compacted, so the folded tip is the log head (ADR 0106). */
const NO_SNAPSHOTS = { loadLatest: async () => null };

const SENSITIVE = { STEP_COMPLETED: ["output.ssn"] };

function ev(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp: 1000 + sequence,
    payload,
  };
}

function setup() {
  const inner = new InMemoryAsyncEventStore();
  const keys = new InMemoryKeyStore();
  const store = new EncryptingEventStore(inner, keys, { sensitive: SENSITIVE });
  return { inner, keys, store };
}

describe("K10.2 — field-level crypto-shredding (events)", () => {
  it("encrypts only marked fields at rest; reads decrypt back to identical plaintext", async () => {
    const { inner, store } = setup();
    await store.append(ev("e1", 0, "EXECUTION_STARTED", { input: { name: "Ann" } }));
    await store.append(
      ev("e1", 1, "STEP_COMPLETED", { stepId: "s", output: { ssn: "123-45-6789", ok: true } })
    );

    // On disk (inner store): the marked field is an opaque envelope…
    const raw = await inner.read("e1");
    const rawOutput = (raw[1]?.payload as { output: { ssn: unknown; ok: unknown } }).output;
    expect(rawOutput.ssn).toMatchObject({ __loomEnc: "loom/aes-256-gcm" });
    expect(rawOutput.ok).toBe(true); // unmarked sibling stays plaintext (A4)
    // …unmarked event untouched.
    expect((raw[0]?.payload as { input: unknown }).input).toEqual({ name: "Ann" });

    // Through the wrapper: identical plaintext (P2 — replay folds the same).
    const decrypted = await store.read("e1");
    expect((decrypted[1]?.payload as { output: { ssn: string } }).output.ssn).toBe("123-45-6789");
  });

  it("shredding destroys the key + writes a PAYLOAD_SHREDDED tombstone; reads then fail LOUDLY", async () => {
    const { inner, keys, store } = setup();
    await store.append(ev("e1", 0, "EXECUTION_STARTED", { input: {} }));
    await store.append(ev("e1", 1, "STEP_COMPLETED", { stepId: "s", output: { ssn: "secret" } }));

    await shredSubject(keys, inner, "e1", { reason: "gdpr-erasure", snapshotStore: NO_SNAPSHOTS });

    // A3 — the tombstone is durably in the log at shred time.
    const raw = await inner.read("e1");
    const tombstone = raw.find((e) => e.eventType === "PAYLOAD_SHREDDED");
    expect(tombstone?.payload).toMatchObject({ subjectId: "e1", reason: "gdpr-erasure" });

    // Loud failure: the decrypting read cannot proceed (never silent divergence).
    await expect(store.read("e1")).rejects.toBeInstanceOf(PayloadShreddedError);

    // The ciphertext is unrecoverable from disk — the key is truly gone.
    const rawOutput = (raw[1]?.payload as { output: { ssn: unknown } }).output;
    expect(rawOutput.ssn).toMatchObject({ __loomEnc: "loom/aes-256-gcm" });
    expect(await keys.get("e1")).toBeNull();
  });

  it("the folded state records the erasure (variables._shredded)", async () => {
    const { inner, keys, store } = setup();
    await store.append(ev("e1", 0, "EXECUTION_STARTED", { input: {} }));
    await shredSubject(keys, inner, "e1", { snapshotStore: NO_SNAPSHOTS });
    // Fold the RAW log (tombstone included); the fact of shredding is recorded.
    const state = foldEvents(await inner.read("e1"));
    expect((state.variables._shredded as { subjectId?: string }).subjectId).toBe("e1");
  });

  it("K10-R4 — a tolerant read yields a { $shredded } placeholder instead of throwing", async () => {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    // Same store, but opted into tolerant reads (for deploy-sim / eval / export).
    const store = new EncryptingEventStore(inner, keys, {
      sensitive: SENSITIVE,
      onShredded: "tolerate",
    });
    await store.append(ev("e1", 0, "EXECUTION_STARTED", { input: {} }));
    await store.append(
      ev("e1", 1, "STEP_COMPLETED", { stepId: "s", output: { ssn: "secret", ok: true } })
    );

    await shredSubject(keys, inner, "e1", { snapshotStore: NO_SNAPSHOTS });

    // Does NOT throw — the erased field is a marked placeholder; unmarked fields survive.
    const events = await store.read("e1");
    const output = (events[1]?.payload as { output: { ssn: unknown; ok: boolean } }).output;
    expect(isShredded(output.ssn)).toBe(true);
    expect(output.ssn).toEqual({ $shredded: true });
    expect(output.ok).toBe(true);
    // The default (throw) is unchanged — tolerance is strictly opt-in (G1 default).
    const strict = new EncryptingEventStore(inner, keys, { sensitive: SENSITIVE });
    await expect(strict.read("e1")).rejects.toBeInstanceOf(PayloadShreddedError);
  });
});

describe("K10.2 / A1 — shredding covers snapshots (no erasure theater)", () => {
  it("a shredded execution's snapshot ALSO fails loudly — the secret is not left in the fold", async () => {
    const innerEvents = new InMemoryAsyncEventStore();
    const innerSnaps = new InMemoryAsyncSnapshotStore();
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(innerEvents, keys, { sensitive: SENSITIVE });
    // `events`: a caller outside the kernel gets the exact erasure error only with the raw log.
    const snaps = new EncryptingSnapshotStore(innerSnaps, keys, {
      sensitive: ["variables._input.ssn"],
      events: innerEvents,
    });

    await events.append(ev("e1", 0, "EXECUTION_STARTED", { input: { ssn: "secret" } }));
    await events.append(ev("e1", 1, "STEP_COMPLETED", { stepId: "s", output: { ssn: "secret" } }));
    const state = {
      executionId: "e1",
      workflowId: "wf",
      workflowVersion: "1.0.0",
      status: "suspended",
      frames: {},
      variables: { _input: { ssn: "secret", ok: true } },
      sequence: 0,
      startedAt: 0,
      updatedAt: 0,
    } as unknown as ExecutionState;
    await snaps.save({
      id: "s1",
      executionId: "e1",
      workflowId: "wf",
      sequence: 0,
      state,
      createdAt: 0,
    });

    // The snapshot decrypts before shredding…
    const before = await snaps.loadLatest("e1");
    expect((before?.state.variables._input as { ssn: string }).ssn).toBe("secret");

    // On disk the snapshot's marked field is ciphertext (not plaintext).
    const rawSnap = (await innerSnaps.loadLatest("e1")) as Snapshot;
    expect((rawSnap.state.variables._input as { ssn: unknown }).ssn).toMatchObject({
      __loomEnc: "loom/aes-256-gcm",
    });

    // …after shredding the SAME subject, BOTH the event log and the snapshot
    // fail loudly. The A1 hole (snapshot retains plaintext) is closed.
    await shredSubject(keys, innerEvents, "e1", { snapshotStore: innerSnaps });
    await expect(events.read("e1")).rejects.toBeInstanceOf(PayloadShreddedError);
    await expect(snaps.loadLatest("e1")).rejects.toBeInstanceOf(PayloadShreddedError);
  });
});

describe("K10.2 / A2 — fork key lineage", () => {
  it("a fork sharing the parent's subject reads the copied ciphertext; shredding erases both", async () => {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    // subjectOf strips a "@fork" suffix → parent and child share ONE subject.
    const rootOf = (id: string) => id.split("@")[0] as string;
    const store = new EncryptingEventStore(inner, keys, {
      sensitive: SENSITIVE,
      subjectOf: (e) => rootOf(e.executionId),
    });

    await store.append(ev("p", 0, "EXECUTION_STARTED", { input: {} }));
    await store.append(ev("p", 1, "STEP_COMPLETED", { stepId: "s", output: { ssn: "shared" } }));
    // Fork: copy the parent's ciphertext prefix verbatim into the child.
    await store.copyPrefix?.("p", "p@fork", 1, { forkedFrom: "p" });

    // The child resolves to the parent's subject, so the copied ciphertext reads.
    const childEvents = await store.read("p@fork");
    expect((childEvents[1]?.payload as { output: { ssn: string } }).output.ssn).toBe("shared");

    // Shredding the shared subject erases parent AND child together (A2) — no
    // undocumented coupling, no orphaned readable copy.
    await shredSubject(keys, inner, "p", {
      snapshotStore: NO_SNAPSHOTS,
      subjectId: "p",
      executionIds: ["p", "p@fork"],
    });
    await expect(store.read("p")).rejects.toBeInstanceOf(PayloadShreddedError);
    await expect(store.read("p@fork")).rejects.toBeInstanceOf(PayloadShreddedError);
  });
});

describe("K10.2 — G2: unmarked stores are pass-throughs", () => {
  it("no sensitive fields ⇒ append/read are byte-identical to the inner store", async () => {
    const inner = new InMemoryAsyncEventStore();
    const store = new EncryptingEventStore(inner, new InMemoryKeyStore(), { sensitive: {} });
    await store.append(ev("e1", 0, "STEP_COMPLETED", { stepId: "s", output: { ssn: "plain" } }));
    expect(await store.read("e1")).toEqual(await inner.read("e1")); // untouched
  });
});

// ── A keystore that fails on the live path must not take the process down ────
//
// `subscribe` decrypts each delivered event, and the key lookup is a real one — a KMS or a
// table, not memory. Nothing awaits that decrypt (it runs from the inner store's subscribe
// callback), so a rejection escaping it is UNHANDLED and Node terminates the process by
// default. The sibling `ContentResolvingEventStore` already degrades to the raw envelope
// for a failed blob fetch; this is the same contract for a failed key.

describe("EncryptingEventStore.subscribe — a failing key lookup", () => {
  /** A keystore whose reads reject, as a network-backed one does on a bad day. */
  function brokenKeys() {
    const real = new InMemoryKeyStore();
    return {
      ...real,
      get: async (): Promise<never> => {
        throw new Error("kms unavailable");
      },
      getOrCreate: real.getOrCreate.bind(real),
      destroy: real.destroy.bind(real),
    };
  }

  it("delivers the raw envelope rather than rejecting into nothing", async () => {
    const inner = new InMemoryAsyncEventStore();
    const store = new EncryptingEventStore(inner, brokenKeys() as never, {
      sensitive: SENSITIVE,
    });

    const seen: EventEnvelope[] = [];
    await store.subscribe("x1", (e) => seen.push(e));
    // Append through the INNER store so the payload arrives already enveloped-or-not
    // without needing a working key to write it.
    // The tag must be the REAL one: `hasEnvelope` gates the decrypt path, so a placeholder
    // would take the early return and the test would pass without exercising the fix at all.
    await inner.append(
      ev("x1", 0, "STEP_COMPLETED", {
        output: { ssn: { __loomEnc: "loom/aes-256-gcm", iv: "", tag: "", data: "" } },
      })
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.executionId).toBe("x1");
  });
});

describe("ADR 0106 — shredSubject is retry-safe and takes the app's ENCRYPTING snapshot store", () => {
  const snapState = (executionId: string, sequence: number) =>
    ({
      executionId,
      workflowId: "wf",
      workflowVersion: "1.0.0",
      status: "completed",
      frames: {},
      variables: { _input: { ssn: "secret" } },
      sequence,
      startedAt: 0,
      updatedAt: 0,
    }) as unknown as ExecutionState;

  /** Three executions of one subject, each compacted to `[0]` with its checkpoint at 5. */
  async function compactedSubject() {
    const inner = new InMemoryAsyncEventStore();
    const innerSnaps = new InMemoryAsyncSnapshotStore();
    const keys = new InMemoryKeyStore();
    const snaps = new EncryptingSnapshotStore(innerSnaps, keys, {
      sensitive: ["variables._input.ssn"],
      subjectOf: () => "subj",
    });
    const ids = ["a", "b", "c"];
    for (const id of ids) {
      await inner.append(ev(id, 0, "EXECUTION_STARTED", { input: {} }));
      await snaps.save({
        id: `cp-${id}`,
        executionId: id,
        workflowId: "wf",
        sequence: 5,
        state: snapState(id, 5),
        createdAt: 0,
      });
    }
    return { inner, snaps, keys, ids };
  }
  const tombstones = async (store: InMemoryAsyncEventStore, id: string) =>
    (await store.read(id)).filter((e) => e.eventType === "PAYLOAD_SHREDDED");

  it("resolves sequences before the key is gone: the encrypting snapshot store works", async () => {
    const { inner, snaps, keys, ids } = await compactedSubject();
    await keys.getOrCreate("subj");
    await shredSubject(keys, inner, "a", {
      subjectId: "subj",
      executionIds: ids,
      snapshotStore: snaps,
    });
    for (const id of ids) {
      const [t] = await tombstones(inner, id);
      expect(t?.sequence).toBe(7); // after the checkpoint at 5 and the erase intent at 6
    }
    expect(await keys.get("subj")).toBeNull();
  });

  it("an append conflict mid-list does not strand the rest; a re-run (key gone) writes only what is missing", async () => {
    const { inner, snaps, keys, ids } = await compactedSubject();
    await keys.getOrCreate("subj");
    let failB = true;
    const flaky = Object.assign(Object.create(inner) as InMemoryAsyncEventStore, {
      append: async (e: Parameters<InMemoryAsyncEventStore["append"]>[0]) => {
        if (e.executionId === "b" && e.eventType === "PAYLOAD_SHREDDED" && failB) {
          failB = false;
          throw new Error("write conflict");
        }
        return inner.append(e);
      },
    });
    await expect(
      shredSubject(keys, flaky, "a", { subjectId: "subj", executionIds: ids, snapshotStore: snaps })
    ).rejects.toBeInstanceOf(ShredIncompleteError);
    expect(await keys.get("subj")).toBeNull(); // erased regardless
    expect(await tombstones(inner, "a")).toHaveLength(1);
    expect(await tombstones(inner, "b")).toHaveLength(0);
    expect(await tombstones(inner, "c")).toHaveLength(1); // not stranded behind b

    // The retry: key already gone, encrypting snapshot store — still completes b, once.
    await shredSubject(keys, flaky, "a", {
      subjectId: "subj",
      executionIds: ids,
      snapshotStore: snaps,
    });
    for (const id of ids) expect(await tombstones(inner, id)).toHaveLength(1);
    expect((await tombstones(inner, "b"))[0]?.sequence).toBe(7);
  });

  it("tenant-scoped over encrypting: the retry after ShredIncompleteError still completes (loadLatestSealed is forwarded)", async () => {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const snaps = new TenantScopedSnapshotStore(
      new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), keys, {
        sensitive: ["variables._input.ssn"],
        subjectOf: () => "subj",
      }),
      "acme"
    );
    expect(snaps.loadLatestSealed).toBeDefined();
    for (const id of ["a", "b"]) {
      await inner.append(ev(id, 0, "EXECUTION_STARTED", { input: {} }));
      await snaps.save({
        id: `cp-${id}`,
        executionId: id,
        workflowId: "wf",
        sequence: 5,
        state: snapState(id, 5),
        createdAt: 0,
      });
    }
    await keys.getOrCreate("subj");
    let failB = true;
    const flaky = Object.assign(Object.create(inner) as InMemoryAsyncEventStore, {
      append: async (e: Parameters<InMemoryAsyncEventStore["append"]>[0]) => {
        if (e.executionId === "b" && e.eventType === "PAYLOAD_SHREDDED" && failB) {
          failB = false;
          throw new Error("write conflict");
        }
        return inner.append(e);
      },
    });
    const opts = { subjectId: "subj", executionIds: ["a", "b"], snapshotStore: snaps };
    await expect(shredSubject(keys, flaky, "a", opts)).rejects.toBeInstanceOf(ShredIncompleteError);
    // key gone, no tombstone yet on "b": the documented retry window reads as key-unavailable
    await expect(snaps.loadLatest("b")).rejects.toBeInstanceOf(KeyUnavailableError);
    await shredSubject(keys, flaky, "a", opts);
    for (const id of ["a", "b"]) {
      const t = await tombstones(inner, id);
      expect(t.map((e) => e.sequence)).toEqual([7]);
    }
  });

  it("a snapshot store that can only decrypt fails the retry with a clear error — no guessed sequence", async () => {
    const { inner, snaps, keys, ids } = await compactedSubject();
    await keys.destroy("subj"); // a previous run got this far
    const decryptOnly = { loadLatest: (id: string) => snaps.loadLatest(id) };
    await expect(
      shredSubject(keys, inner, "a", {
        subjectId: "subj",
        executionIds: ids,
        snapshotStore: decryptOnly,
      })
    ).rejects.toThrow(/loadLatestSealed/);
    for (const id of ids) expect(await tombstones(inner, id)).toHaveLength(0);
  });
});

describe("ADR 0107 — shredSubject never tombstones a reserved stream", () => {
  it('refuses "" and __loom_* as executionIds, before the key is destroyed', async () => {
    const { inner, keys, store } = setup();
    // A pre-0106 stream sealed under "" (the crypto layer no longer WRITES under it): seed it raw.
    await keys.getOrCreate("");
    await inner.append(
      ev("", 3, "STEP_COMPLETED", {
        stepId: "s",
        output: { ssn: encryptValue((await keys.get(""))!, "1") },
      })
    );
    const key = await keys.get("");
    expect(key).not.toBeNull();
    for (const executionIds of [[""], ["e1", "__loom_lifecycle__"]]) {
      await expect(
        shredSubject(keys, inner, "", { executionIds, snapshotStore: NO_SNAPSHOTS })
      ).rejects.toThrow(/reserved stream/);
    }
    // The default executionIds is the subject itself: "" is refused there too.
    await expect(shredSubject(keys, inner, "", { snapshotStore: NO_SNAPSHOTS })).rejects.toThrow(
      /reserved stream/
    );
    expect(await keys.get("")).toEqual(key);
    expect((await inner.read("")).map((e) => e.eventType)).toEqual(["STEP_COMPLETED"]);
  });

  it('still destroys the key of subject "" when no reserved stream is named', async () => {
    const { inner, keys, store } = setup();
    // A pre-0106 stream sealed under "" (the crypto layer no longer WRITES under it): seed it raw.
    await keys.getOrCreate("");
    await inner.append(
      ev("", 3, "STEP_COMPLETED", {
        stepId: "s",
        output: { ssn: encryptValue((await keys.get(""))!, "1") },
      })
    );
    await shredSubject(keys, inner, "", { executionIds: [], snapshotStore: NO_SNAPSHOTS });
    expect(await keys.get("")).toBeNull();
    // No tombstone is written into "" (it is no execution), so a read of it is key-unavailable, not
    // an erasure marker (ADR 0130 residuals D7): the key is gone, the log records no shred.
    await expect(store.read("")).rejects.toBeInstanceOf(KeyUnavailableError);
    expect(await inner.read("")).toHaveLength(1); // no tombstone written into ""
  });
});
