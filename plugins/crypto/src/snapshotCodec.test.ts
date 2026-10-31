import type { ExecutionState } from "@loom/core";
import {
  InMemoryAsyncSnapshotStore,
  ProfilingSnapshotStore,
  type Snapshot,
  zstdAvailable,
} from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { EncryptingSnapshotStore } from "./EncryptingSnapshotStore";
import { decryptValue, encryptValue } from "./crypto";
import { SnapshotUndecryptableError } from "./errors";
import { InMemoryKeyStore } from "./keystore";

// ADR 0140 - the snapshot codec runs BEFORE sealing. Skipped on a Node without zlib.zstd (>= 22.15).
const zstd = describe.skipIf(!zstdAvailable());

const words = "the customer ticket refund order invoice payment failed retry approval".split(" ");
function snapshot(sequence = 3, tag = "t"): Snapshot {
  const steps = Object.fromEntries(
    Array.from({ length: 400 }, (_, i) => [
      `s${i}`,
      {
        text: Array.from({ length: 30 }, (_, j) => words[(i + j * 3) % words.length]).join(" "),
        i,
      },
    ])
  );
  const state = {
    executionId: "e1",
    workflowId: "wf",
    workflowVersion: "1",
    status: "running",
    frames: steps,
    variables: { _input: { ssn: "123-45-6789", tag }, _waitAnswers: { "w-1": { a: "secret" } } },
    sequence,
    startedAt: 0,
    updatedAt: 0,
  } as unknown as ExecutionState;
  return {
    id: `s-${sequence}`,
    executionId: "e1",
    workflowId: "wf",
    sequence,
    state,
    createdAt: 5,
  };
}

describe("EncryptingSnapshotStore codec option (ADR 0140), validation", () => {
  it("is off by default and reports it", () => {
    const s = new EncryptingSnapshotStore(
      new InMemoryAsyncSnapshotStore(),
      new InMemoryKeyStore(),
      {
        sealState: true,
      }
    );
    expect(s.snapshotCodec).toBe("none");
  });

  it("only applies with sealState", () => {
    expect(
      () =>
        new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), new InMemoryKeyStore(), {
          sensitive: ["variables._input.ssn"],
          codec: "zstd",
        })
    ).toThrow(/only applies with `sealState: true`/);
  });

  it("rejects an unknown codec", () => {
    expect(
      () =>
        new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), new InMemoryKeyStore(), {
          sealState: true,
          codec: "gzip" as never,
        })
    ).toThrow(TypeError);
  });
});

describe("default (codec off) seals byte-identically to before", () => {
  it("the envelope plaintext is the bare JSON text", async () => {
    const keys = new InMemoryKeyStore();
    const inner = new InMemoryAsyncSnapshotStore();
    const store = new EncryptingSnapshotStore(inner, keys, { sealState: true });
    const snap = snapshot();
    await store.save(snap);
    const sealed = (await inner.loadLatest("e1"))?.state as unknown as Record<string, unknown>;
    expect(sealed.__loomEnc).toBeDefined();
    const key = (await keys.get("e1")) as Buffer;
    // decrypt by hand: plaintext must be JSON text with no frame byte
    const env = sealed as unknown as { iv: string; tag: string; data: string; aad: string };
    const { createDecipheriv } = await import("node:crypto");
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
    d.setAAD(Buffer.from(`${env.aad}|e1|3`));
    d.setAuthTag(Buffer.from(env.tag, "base64"));
    const pt = Buffer.concat([d.update(Buffer.from(env.data, "base64")), d.final()]);
    expect(pt.toString("utf-8")).toBe(JSON.stringify(snap.state));
  });
});

zstd("compress BEFORE sealing", () => {
  it("round-trips through every read path, and the plaintext inside the envelope is a zstd frame", async () => {
    const keys = new InMemoryKeyStore();
    const inner = new InMemoryAsyncSnapshotStore();
    const store = new EncryptingSnapshotStore(inner, keys, { sealState: true, codec: "zstd" });
    const a = snapshot(3, "a");
    const b = snapshot(7, "b");
    await store.save(a);
    await store.save(b);
    expect((await store.loadLatest("e1"))?.state).toEqual(b.state);
    expect((await store.loadAt("e1", 3))?.state).toEqual(a.state);
    expect((await store.loadLatestBefore("e1", 5))?.state).toEqual(a.state);
    // sealed read: still ciphertext, no plaintext leaks
    const sealed = JSON.stringify((await store.loadLatestSealed("e1"))?.state);
    expect(sealed).not.toContain("123-45-6789");
    expect(sealed).not.toContain("secret");
    // the opened plaintext is a codec frame (first byte 0x02), proven via the low-level helpers
    const key = (await keys.get("e1")) as Buffer;
    const env = (await inner.loadAt("e1", 3))?.state;
    expect(decryptValue(key, env, "e1|3")).toEqual(a.state);
  });

  it("an encrypting deployment actually gets the size win (stored bytes, not just the plaintext)", async () => {
    const stored = async (
      sealOptions: { codec?: "zstd" },
      innerCodec: "none" | "zstd"
    ): Promise<number> => {
      const profile = new ProfilingSnapshotStore(
        new InMemoryAsyncSnapshotStore({ codec: innerCodec }),
        { measure: "stored" }
      );
      const store = new EncryptingSnapshotStore(profile, new InMemoryKeyStore(), {
        sealState: true,
        ...sealOptions,
      });
      await store.save(snapshot());
      return profile.profile().maxBytes;
    };
    const baseline = await stored({}, "none"); // today: sealed JSON, base64
    const backendOnly = await stored({}, "zstd"); // a codec BELOW the seal sees only ciphertext
    const beforeSeal = await stored({ codec: "zstd" }, "none"); // compress, then seal
    const both = await stored({ codec: "zstd" }, "zstd");
    // Ciphertext is incompressible: a backend codec recovers only base64's 25%.
    expect(backendOnly).toBeGreaterThan(baseline * 0.7);
    // Compressing before sealing is the real win on this repetitive state.
    expect(beforeSeal).toBeLessThan(baseline / 4);
    expect(beforeSeal).toBeLessThan(backendOnly / 3);
    // ...and adding a backend codec on top only trims the base64 overhead.
    expect(both).toBeLessThanOrEqual(beforeSeal);
    expect(both).toBeGreaterThan(beforeSeal * 0.6);
  });

  it("opens pre-codec envelopes (mixed old/new at rest) and a codec-off store opens frames", async () => {
    const keys = new InMemoryKeyStore();
    const inner = new InMemoryAsyncSnapshotStore();
    const old = new EncryptingSnapshotStore(inner, keys, { sealState: true });
    const next = new EncryptingSnapshotStore(inner, keys, { sealState: true, codec: "zstd" });
    const a = snapshot(3, "old");
    const b = snapshot(7, "new");
    await old.save(a);
    await next.save(b);
    for (const store of [old, next]) {
      expect((await store.loadAt("e1", 3))?.state).toEqual(a.state);
      expect((await store.loadAt("e1", 7))?.state).toEqual(b.state);
    }
  });

  it("the frame is authenticated: moving a sealed envelope to another slot still fails", async () => {
    const keys = new InMemoryKeyStore();
    const inner = new InMemoryAsyncSnapshotStore();
    const store = new EncryptingSnapshotStore(inner, keys, { sealState: true, codec: "zstd" });
    await store.save(snapshot(3));
    const moved = { ...(await inner.loadAt("e1", 3))!, sequence: 4, id: "s-4" };
    await inner.save(moved);
    await expect(store.loadAt("e1", 4)).rejects.toBeInstanceOf(SnapshotUndecryptableError);
  });

  it("encryptValue without a codec is unchanged; with one it decrypts through decryptValue", () => {
    const key = Buffer.alloc(32, 7);
    const value = { a: [1, 2, { b: "x".repeat(2000) }] };
    const plain = encryptValue(key, value);
    const framed = encryptValue(key, value, undefined, undefined, "zstd");
    expect(decryptValue(key, plain)).toEqual(value);
    expect(decryptValue(key, framed)).toEqual(value);
    expect(framed.data.length).toBeLessThan(plain.data.length / 4);
  });
});
