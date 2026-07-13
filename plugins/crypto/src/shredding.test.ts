import type { EventEnvelope, ExecutionState } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import type { Snapshot } from "@loom/snapshot-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { EncryptingEventStore, isShredded } from "./EncryptingEventStore";
import { EncryptingSnapshotStore } from "./EncryptingSnapshotStore";
import { PayloadShreddedError } from "./errors";
import { InMemoryKeyStore } from "./keystore";
import { shredSubject } from "./shred";

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

    await shredSubject(keys, inner, "e1", { reason: "gdpr-erasure" });

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
    await shredSubject(keys, inner, "e1");
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

    await shredSubject(keys, inner, "e1");

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
    const snaps = new EncryptingSnapshotStore(innerSnaps, keys, {
      sensitive: ["variables._input.ssn"],
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
    await shredSubject(keys, innerEvents, "e1");
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
