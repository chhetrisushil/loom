import type { ExecutionState } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { Snapshot } from "@loom/snapshot-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { EncryptingEventStore } from "./EncryptingEventStore";
import { EncryptingSnapshotStore } from "./EncryptingSnapshotStore";
import { decryptValue, encryptValue } from "./crypto";
import {
  PayloadShreddedError,
  PlaintextSnapshotRefusedError,
  SnapshotUndecryptableError,
} from "./errors";
import { InMemoryKeyStore } from "./keystore";
import { shredSubject } from "./shred";

// ADR 0130 D8 (residual b, 1P) — `sealState: true` seals the WHOLE folded state as one
// envelope, covering the dynamic `variables._waitAnswers.<waitId>` keys no static path can name.

const WAIT_SECRET = "hunter2-wait-answer";
const INPUT_SECRET = "123-45-6789";

function snapshot(executionId = "e1", sequence = 3): Snapshot {
  const state = {
    executionId,
    workflowId: "wf",
    workflowVersion: "1.0.0",
    status: "suspended",
    frames: {},
    variables: {
      _input: { ssn: INPUT_SECRET },
      _waitAnswers: { "wait-dynamic-77": { answer: WAIT_SECRET } },
    },
    sequence,
    startedAt: 0,
    updatedAt: 0,
  } as unknown as ExecutionState;
  return { id: `s-${sequence}`, executionId, workflowId: "wf", sequence, state, createdAt: 5 };
}

function make() {
  const inner = new InMemoryAsyncSnapshotStore();
  const keys = new InMemoryKeyStore();
  const snaps = new EncryptingSnapshotStore(inner, keys, { sealState: true });
  return { inner, keys, snaps };
}

describe("EncryptingSnapshotStore sealState (ADR 0130 D8)", () => {
  it("exposes the structural sealsWholeState marker, and only in sealState mode", () => {
    const { snaps, keys } = make();
    expect((snaps as { sealsWholeState?: unknown }).sealsWholeState).toBe(true);
    const legacy = new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), keys, {
      sensitive: ["variables._input.ssn"],
    });
    expect((legacy as { sealsWholeState?: unknown }).sealsWholeState).not.toBe(true);
  });

  it("hides dynamic _waitAnswers values: no plaintext anywhere in the stored snapshot", async () => {
    const { snaps, inner } = make();
    await snaps.save(snapshot());
    const raw = (await inner.loadLatest("e1")) as Snapshot;
    // JSON-quoted values: random base64 can contain short bare substrings (loom #581).
    const bytes = JSON.stringify(raw);
    expect(bytes).not.toContain(JSON.stringify(WAIT_SECRET));
    expect(bytes).not.toContain(WAIT_SECRET);
    expect(bytes).not.toContain(JSON.stringify(INPUT_SECRET));
    expect(bytes).not.toContain("_waitAnswers");
    expect(bytes).not.toContain("wait-dynamic-77");
    // Whole state is ONE envelope; the index fields stay in the clear.
    expect(raw.state).toMatchObject({ __loomEnc: "loom/aes-256-gcm" });
    expect(raw).toMatchObject({ id: "s-3", executionId: "e1", workflowId: "wf", sequence: 3 });
  });

  it("round-trips through loadLatest, loadAt and loadLatestBefore", async () => {
    const { snaps } = make();
    const snap = snapshot();
    await snaps.save(snap);
    expect((await snaps.loadLatest("e1"))?.state).toEqual(snap.state);
    expect((await snaps.loadAt("e1", 3))?.state).toEqual(snap.state);
    expect((await snaps.loadLatestBefore("e1", 9))?.state).toEqual(snap.state);
    expect(await snaps.loadLatest("nope")).toBeNull();
  });

  it("a shredded subject makes the snapshot unreadable, like the event payloads", async () => {
    const innerEvents = new InMemoryAsyncEventStore();
    const inner = new InMemoryAsyncSnapshotStore();
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(innerEvents, keys, {
      sensitive: { STEP_COMPLETED: ["output.ssn"] },
    });
    const snaps = new EncryptingSnapshotStore(inner, keys, {
      sealState: true,
      events: innerEvents, // outside the kernel the exact erasure error needs the raw log
    });
    await events.append({
      id: "e1-0",
      workflowId: "wf",
      executionId: "e1",
      eventType: "STEP_COMPLETED",
      sequence: 0,
      payload: { stepId: "s", output: { ssn: INPUT_SECRET } },
      timestamp: 0,
    } as never);
    await snaps.save(snapshot());
    await shredSubject(keys, innerEvents, "e1", { snapshotStore: snaps });
    await expect(snaps.loadLatest("e1")).rejects.toBeInstanceOf(PayloadShreddedError);
    await expect(snaps.loadAt("e1", 3)).rejects.toBeInstanceOf(PayloadShreddedError);
    await expect(events.read("e1")).rejects.toBeInstanceOf(PayloadShreddedError);
    // The at-rest read still answers (sequence only) and holds no plaintext.
    const sealed = await snaps.loadLatestSealed("e1");
    expect(sealed?.sequence).toBe(3);
    expect(JSON.stringify(sealed)).not.toContain(WAIT_SECRET);
  });

  it("loads a legacy plaintext snapshot as-is, and re-seals it on the next save", async () => {
    const { snaps, inner } = make();
    await inner.save(snapshot("old", 1)); // written by a store without sealState
    const loaded = await snaps.loadLatest("old");
    expect(loaded?.state).toEqual(snapshot("old", 1).state);
    await snaps.save({ ...(loaded as Snapshot), id: "s-2", sequence: 2 });
    const raw = (await inner.loadLatest("old")) as Snapshot;
    expect(raw.sequence).toBe(2);
    expect(JSON.stringify(raw)).not.toContain(WAIT_SECRET);
  });

  it("a sealState store opens a snapshot written with static sensitive paths", async () => {
    const inner = new InMemoryAsyncSnapshotStore();
    const keys = new InMemoryKeyStore();
    const staticStore = new EncryptingSnapshotStore(inner, keys, {
      sensitive: ["variables._input.ssn"],
    });
    await staticStore.save(snapshot("st", 1));
    const sealer = new EncryptingSnapshotStore(inner, keys, { sealState: true });
    expect((await sealer.loadLatest("st"))?.state).toEqual(snapshot("st", 1).state);
  });

  it("a snapshot written with sealState still loads through a static-path store (same keys)", async () => {
    const { snaps, inner, keys } = make();
    await snaps.save(snapshot());
    const staticStore = new EncryptingSnapshotStore(inner, keys, {
      sensitive: ["variables._input.ssn"],
    });
    expect((await staticStore.loadLatest("e1"))?.state).toEqual(snapshot().state);
  });

  it("registerSensitive is a no-op in sealState mode (everything is already sealed)", async () => {
    const { snaps, inner } = make();
    snaps.registerSensitive(["variables._principal.identity.id"]);
    await snaps.save(snapshot());
    const raw = (await inner.loadLatest("e1")) as Snapshot;
    expect(raw.state).toMatchObject({ __loomEnc: "loom/aes-256-gcm" });
  });

  it("sealState together with sensitive is a config error", () => {
    expect(
      () =>
        new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), new InMemoryKeyStore(), {
          sealState: true,
          sensitive: ["variables._input.ssn"],
        } as never)
    ).toThrow(/sealState.*sensitive|sensitive.*sealState/);
  });

  it("refuses an empty subject, as the static mode does", async () => {
    const { inner, keys } = make();
    const snaps = new EncryptingSnapshotStore(inner, keys, {
      sealState: true,
      subjectOf: () => "",
    });
    await expect(snaps.save(snapshot())).rejects.toBeInstanceOf(TypeError);
  });
  // ── P2-1a: AAD binding ────────────────────────────────────────────────────
  it("binds the envelope to (executionId, sequence): the marker is self-describing", async () => {
    const { snaps, inner } = make();
    await snaps.save(snapshot("e1", 3));
    const raw = (await inner.loadLatest("e1")) as Snapshot;
    expect((raw.state as unknown as { aad?: string }).aad).toBe("loom-snap-v1");
  });

  it("refuses A's sealed row copied into B's slot with a typed error, not raw GCM text", async () => {
    const { snaps, inner } = make();
    await snaps.save(snapshot("A", 3));
    const a = (await inner.loadLatest("A")) as Snapshot;
    // Same subject key (a shared subjectOf), attacker re-labels the row as B / same sequence.
    const shared = new EncryptingSnapshotStore(inner, make().keys, {
      sealState: true,
      subjectOf: () => "shared",
    });
    await shared.save(snapshot("A", 3));
    const sharedA = (await inner.loadAt("A", 3)) as Snapshot;
    await inner.save({ ...sharedA, id: "b-3", executionId: "B" });
    const err = await shared.loadLatest("B").catch((e) => e);
    expect(err).toBeInstanceOf(SnapshotUndecryptableError);
    expect(String((err as Error).message)).not.toMatch(/unable to authenticate/i);
    expect(a.state).toBeDefined();
  });

  it("refuses an older sealed snapshot rolled into a newer sequence slot", async () => {
    const { snaps, inner } = make();
    await snaps.save(snapshot("e1", 3));
    const old = (await inner.loadAt("e1", 3)) as Snapshot;
    await inner.save({ ...old, id: "s-9", sequence: 9 });
    await expect(snaps.loadAt("e1", 9)).rejects.toBeInstanceOf(SnapshotUndecryptableError);
    // The original row is untouched and still loads.
    expect((await snaps.loadAt("e1", 3))?.state).toEqual(snapshot("e1", 3).state);
  });

  it("an envelope without the AAD marker is refused for a whole-state load", async () => {
    const { snaps, inner, keys } = make();
    const key = await keys.getOrCreate("e1");
    const snap = snapshot("e1", 3);
    await inner.save({ ...snap, state: encryptValue(key, snap.state) as never });
    await expect(snaps.loadLatest("e1")).rejects.toBeInstanceOf(SnapshotUndecryptableError);
  });

  it("crypto: AAD is optional and backward compatible (no AAD = old behaviour)", () => {
    const key = Buffer.alloc(32, 7);
    const plain = encryptValue(key, { a: 1 });
    expect("aad" in plain).toBe(false);
    expect(decryptValue(key, plain)).toEqual({ a: 1 });
    const bound = encryptValue(key, { a: 1 }, { v: "t1", bind: "x" });
    expect(decryptValue(key, bound, "x")).toEqual({ a: 1 });
    expect(() => decryptValue(key, bound, "y")).toThrow();
    expect(() => decryptValue(key, bound)).toThrow();
  });

  // ── P2-1b: downgrade ──────────────────────────────────────────────────────
  it("legacyPlaintext defaults to 'load': an envelope-free state loads", async () => {
    const { snaps, inner } = make();
    await inner.save(snapshot("old", 1));
    expect((await snaps.loadLatest("old"))?.state).toEqual(snapshot("old", 1).state);
  });

  it("legacyPlaintext: 'refuse' throws a typed error on an envelope-free state", async () => {
    const inner = new InMemoryAsyncSnapshotStore();
    const keys = new InMemoryKeyStore();
    const strict = new EncryptingSnapshotStore(inner, keys, {
      sealState: true,
      legacyPlaintext: "refuse",
    });
    await inner.save(snapshot("old", 1));
    await expect(strict.loadLatest("old")).rejects.toBeInstanceOf(PlaintextSnapshotRefusedError);
    await expect(strict.loadAt("old", 1)).rejects.toBeInstanceOf(PlaintextSnapshotRefusedError);
    // Its own sealed snapshots still load.
    await strict.save(snapshot("new", 2));
    expect((await strict.loadLatest("new"))?.state).toEqual(snapshot("new", 2).state);
  });

  it("legacyPlaintext without sealState is a config error", () => {
    expect(
      () =>
        new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), new InMemoryKeyStore(), {
          sensitive: ["variables._input.ssn"],
          legacyPlaintext: "refuse",
        } as never)
    ).toThrow(/legacyPlaintext/);
  });

  // ── P3-1: legacy opening of nested envelopes ─────────────────────────────
  it("an app value sealed under a DIFFERENT key stays as it is (no raw GCM failure)", async () => {
    const { snaps, inner, keys } = make();
    const appKey = Buffer.alloc(32, 9);
    const appCipher = encryptValue(appKey, "app-secret");
    const snap = snapshot("app", 1);
    // A legacy (static-path) row: input sealed under the subject key, plus an app ciphertext.
    const subjectKey = await keys.getOrCreate("app");
    const state = {
      ...(snap.state as object),
      variables: {
        _input: { ssn: encryptValue(subjectKey, INPUT_SECRET) },
        appBlob: appCipher,
      },
    };
    await inner.save({ ...snap, state: state as never });
    const loaded = await snaps.loadLatest("app");
    const vars = (loaded?.state as unknown as { variables: Record<string, unknown> }).variables;
    expect((vars._input as { ssn: string }).ssn).toBe(INPUT_SECRET);
    expect(vars.appBlob).toEqual(appCipher);
  });

  it("legacySensitive restricts legacy opening to the named paths", async () => {
    const inner = new InMemoryAsyncSnapshotStore();
    const keys = new InMemoryKeyStore();
    const key = await keys.getOrCreate("lp");
    const snap = snapshot("lp", 1);
    const other = encryptValue(key, "same-key-app-value");
    const state = {
      ...(snap.state as object),
      variables: { _input: { ssn: encryptValue(key, INPUT_SECRET) }, other },
    };
    await inner.save({ ...snap, state: state as never });
    const store = new EncryptingSnapshotStore(inner, keys, {
      sealState: true,
      legacySensitive: ["variables._input.ssn"],
    });
    const vars = (
      (await store.loadLatest("lp"))?.state as unknown as { variables: Record<string, unknown> }
    ).variables;
    expect((vars._input as { ssn: string }).ssn).toBe(INPUT_SECRET);
    expect(vars.other).toEqual(other); // not a path the old config named: left sealed
  });

  // ── P3-4: shred idempotence ──────────────────────────────────────────────
  it("shredSubject run twice under sealState writes exactly one PAYLOAD_SHREDDED", async () => {
    const innerEvents = new InMemoryAsyncEventStore();
    const inner = new InMemoryAsyncSnapshotStore();
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(innerEvents, keys, {
      sensitive: { STEP_COMPLETED: ["output.ssn"] },
    });
    const snaps = new EncryptingSnapshotStore(inner, keys, { sealState: true });
    await events.append({
      id: "e1-0",
      workflowId: "wf",
      executionId: "e1",
      eventType: "STEP_COMPLETED",
      sequence: 0,
      payload: { stepId: "s", output: { ssn: INPUT_SECRET } },
      timestamp: 0,
    } as never);
    await snaps.save(snapshot());
    await shredSubject(keys, innerEvents, "e1", { snapshotStore: snaps });
    await shredSubject(keys, innerEvents, "e1", { snapshotStore: snaps });
    const log = await innerEvents.read("e1");
    expect(log.filter((e) => e.eventType === "PAYLOAD_SHREDDED")).toHaveLength(1);
  });
});
