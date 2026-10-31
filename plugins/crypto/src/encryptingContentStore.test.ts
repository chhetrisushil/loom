import { createDecipheriv, createHmac } from "node:crypto";
import { runContentStoreConformance } from "@loom/conformance";
import { isKeyUnavailable, isPayloadShredded } from "@loom/event-runtime";
import {
  type ContentRef,
  type ContentStore,
  InMemoryContentStore,
  contentAddress,
} from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { EncryptingContentStore } from "./EncryptingContentStore";
import {
  ContentAccessRequiredError,
  ContentUndecryptableError,
  PayloadShreddedError,
} from "./errors";
import { InMemoryKeyStore, type KeyStore } from "./keystore";

// ADR 0143 - the EncryptingContentStore: per-subject sealing, subject-scoped addresses, fail closed.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null): string | null =>
  b === null ? null : new TextDecoder().decode(b);
const ann = { executionId: "ann", workflowId: "wf" };
const bob = { executionId: "bob", workflowId: "wf" };

// The whole ContentStore conformance kit, run PER SUBJECT (the kit binds the owner to every call).
runContentStoreConformance(
  () => new EncryptingContentStore(new InMemoryContentStore(), new InMemoryKeyStore()),
  "EncryptingContentStore",
  {
    access: ann,
    clocked: (now) =>
      new EncryptingContentStore(new InMemoryContentStore({ now }), new InMemoryKeyStore()),
  }
);

/** An inner store whose stored bytes a test can read and overwrite (tamper / swap). */
class TamperableStore extends InMemoryContentStore {
  readonly overrides = new Map<string, Uint8Array>();
  override async get(ref: ContentRef): Promise<Uint8Array | null> {
    return this.overrides.get(ref.__loomContent) ?? super.get(ref);
  }
  override async getMany(refs: readonly ContentRef[]): Promise<(Uint8Array | null)[]> {
    return Promise.all(refs.map((r) => this.get(r)));
  }
}

function make(keys: KeyStore = new InMemoryKeyStore()) {
  const inner = new TamperableStore();
  return { inner, keys, store: new EncryptingContentStore(inner, keys) };
}

describe("round trip and addresses", () => {
  it("round-trips per subject and the inner store never holds the plaintext", async () => {
    const { inner, store } = make();
    const secret = "the customer's diagnosis is lymphoma";
    const ref = await store.put(enc(secret), ann);
    expect(dec(await store.get(ref, ann))).toBe(secret);
    expect(ref.size).toBe(secret.length);
    const stored = await inner.get(ref);
    expect(Buffer.from(stored as Uint8Array).includes(Buffer.from(secret))).toBe(false);
    expect(ref.__loomContent).toBe(contentAddress(stored as Uint8Array)); // the inner store's own address
  });

  it("the same plaintext under TWO subjects has different addresses (no cross-subject equality or dedupe)", async () => {
    const { inner, store } = make();
    const a = await store.put(enc("identical"), ann);
    const b = await store.put(enc("identical"), bob);
    expect(a.__loomContent).not.toBe(b.__loomContent);
    expect(inner.size).toBe(2);
  });

  it("the same plaintext within one subject dedupes (even from another execution of it)", async () => {
    const { inner, store, keys } = make();
    const a = await store.put(enc("again"), ann);
    const b = await store.put(enc("again"), ann);
    const sameSubject = new EncryptingContentStore(inner, keys, { subjectOf: () => "ann" });
    const c = await sameSubject.put(enc("again"), { executionId: "ann-fork", workflowId: "wf" });
    expect(b.__loomContent).toBe(a.__loomContent);
    expect(c.__loomContent).toBe(a.__loomContent);
    expect(inner.size).toBe(1);
  });

  it("sealing is deterministic per (subject key, plaintext): a crash re-run reproduces the envelope", async () => {
    const keys = new InMemoryKeyStore();
    const one = new EncryptingContentStore(new InMemoryContentStore(), keys);
    const two = new EncryptingContentStore(new InMemoryContentStore(), keys);
    expect((await one.put(enc("x"), ann)).__loomContent).toBe(
      (await two.put(enc("x"), ann)).__loomContent
    );
  });

  it("getMany is element-wise get and aligned (null for an absent address)", async () => {
    const { store } = make();
    const a = await store.put(enc("one"), ann);
    const b = await store.put(enc("two"), ann);
    const got = await store.getMany([a, { __loomContent: "sha256:dead" }, b], ann);
    expect(got.map(dec)).toEqual(["one", null, "two"]);
  });
});

describe("crypto-shred makes every blob of the subject unreadable", () => {
  it("shredding A: A's blobs fail typed, B's identical blob stays readable, and A can put no more", async () => {
    const { store, keys } = make();
    const a = await store.put(enc("same"), ann);
    const b = await store.put(enc("same"), bob);
    await keys.destroy("ann");
    await expect(store.get(a, ann)).rejects.toBeInstanceOf(PayloadShreddedError);
    await expect(store.getMany([a], ann)).rejects.toSatisfy(isPayloadShredded);
    expect(dec(await store.get(b, bob))).toBe("same");
    await expect(store.put(enc("new"), ann)).rejects.toBeInstanceOf(PayloadShreddedError);
  });

  it("a key merely absent from this node (never destroyed here) is KeyUnavailable, not an erasure", async () => {
    const { store, inner } = make();
    const a = await store.put(enc("x"), ann);
    const other = new EncryptingContentStore(inner, new InMemoryKeyStore());
    await expect(other.get(a, ann)).rejects.toSatisfy(isKeyUnavailable);
  });
});

describe("fail closed", () => {
  it("every data call without the owner is refused", async () => {
    const { store } = make();
    const ref = await store.put(enc("x"), ann);
    await expect(store.put(enc("x"))).rejects.toBeInstanceOf(ContentAccessRequiredError);
    await expect(store.get(ref)).rejects.toBeInstanceOf(ContentAccessRequiredError);
    await expect(store.getMany([ref])).rejects.toBeInstanceOf(ContentAccessRequiredError);
  });

  it("an empty subject is refused", async () => {
    const store = new EncryptingContentStore(new InMemoryContentStore(), new InMemoryKeyStore(), {
      subjectOf: () => "",
    });
    await expect(store.put(enc("x"), ann)).rejects.toThrow(/resolved to ""/);
  });

  it("a tampered blob is a typed error, never garbage", async () => {
    const { inner, store } = make();
    const ref = await store.put(enc("payload"), ann);
    const bytes = Uint8Array.from((await inner.get(ref)) as Uint8Array);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
    inner.overrides.set(ref.__loomContent, bytes);
    await expect(store.get(ref, ann)).rejects.toBeInstanceOf(ContentUndecryptableError);
  });

  it("a blob swapped under another address is refused (the address names the ciphertext)", async () => {
    const { inner, store } = make();
    const x = await store.put(enc("x"), ann);
    const y = await store.put(enc("y"), ann);
    inner.overrides.set(x.__loomContent, (await inner.get(y)) as Uint8Array);
    await expect(store.get(x, ann)).rejects.toBeInstanceOf(ContentUndecryptableError);
  });

  it("another subject's blob will not open under this subject (separate keys)", async () => {
    const { store } = make();
    const b = await store.put(enc("bobs"), bob);
    await store.put(enc("anns"), ann);
    await expect(store.get(b, ann)).rejects.toBeInstanceOf(ContentUndecryptableError);
  });

  it("the AAD binds the subject: even under ONE key a blob does not open for another subject", async () => {
    // every subject gets the SAME key, so only the AAD can tell them apart
    const shared = Buffer.alloc(32, 7);
    const keys: KeyStore = {
      getOrCreate: async () => shared,
      get: async () => shared,
      destroy: async () => {},
    };
    const store = new EncryptingContentStore(new InMemoryContentStore(), keys);
    const a = await store.put(enc("anns"), ann);
    expect(dec(await store.get(a, ann))).toBe("anns");
    await expect(store.get(a, bob)).rejects.toBeInstanceOf(ContentUndecryptableError);
  });

  it("does not offer putStream (a stream would have to be buffered)", () => {
    expect((make().store as ContentStore).putStream).toBeUndefined();
  });
});

describe("the sealed format (ADR 0143 D3): an SIV over the subject, a version authenticated as AAD", () => {
  // The layout is pinned by opening a store-produced blob with an INDEPENDENT node:crypto implementation.
  const derive = (key: Buffer, label: string): Buffer =>
    createHmac("sha256", key).update(`loom/content/${label}/v1`).digest();

  it("the same plaintext, the same KeyStore key, two subjects: different IVs and different ciphertext", async () => {
    // one key for EVERY subject (the KeyStore shape ADR 0143 D3 defends): only the SIV input differs
    const shared = Buffer.alloc(32, 9);
    const keys: KeyStore = {
      getOrCreate: async () => shared,
      get: async () => shared,
      destroy: async () => {},
    };
    const inner = new TamperableStore();
    const store = new EncryptingContentStore(inner, keys);
    const a = await store.put(enc("identical plaintext"), ann);
    const b = await store.put(enc("identical plaintext"), bob);
    const sa = (await inner.get(a)) as Uint8Array;
    const sb = (await inner.get(b)) as Uint8Array;
    const iv = (x: Uint8Array) => Buffer.from(x.subarray(1, 13)).toString("hex");
    expect(iv(sa)).not.toBe(iv(sb)); // a (key, nonce) pair is never reused across subjects
    expect(Buffer.from(sa).equals(Buffer.from(sb))).toBe(false);
  });

  it("the layout and AAD are exactly [version][iv][tag][ct] with AAD = version || 'loom/content/v1|' || subject", async () => {
    const keys = new InMemoryKeyStore();
    const inner = new TamperableStore();
    const store = new EncryptingContentStore(inner, keys);
    const ref = await store.put(enc("layout"), ann);
    const stored = Buffer.from((await inner.get(ref)) as Uint8Array);
    const key = (await keys.get("ann")) as Buffer;
    const open = (aad: Buffer): string => {
      const d = createDecipheriv("aes-256-gcm", derive(key, "enc"), stored.subarray(1, 13));
      d.setAAD(aad);
      d.setAuthTag(stored.subarray(13, 29));
      return Buffer.concat([d.update(stored.subarray(29)), d.final()]).toString();
    };
    expect(open(Buffer.concat([Buffer.from([1]), Buffer.from("loom/content/v1|ann")]))).toBe(
      "layout"
    );
    // the version byte is part of the associated data: without it the tag does not verify
    expect(() => open(Buffer.from("loom/content/v1|ann"))).toThrow();
    // and the IV is the SIV: HMAC(ivKey, version || len(subject) || subject || plaintext)
    const len = Buffer.alloc(4);
    len.writeUInt32BE(3);
    const siv = createHmac("sha256", derive(key, "iv"))
      .update(Buffer.from([1]))
      .update(len)
      .update("ann")
      .update("layout")
      .digest()
      .subarray(0, 12);
    expect(stored.subarray(1, 13).equals(siv)).toBe(true);
  });

  it("a flipped version byte is refused (reads are strict)", async () => {
    const { inner, store } = make();
    const ref = await store.put(enc("v"), ann);
    const bytes = Uint8Array.from((await inner.get(ref)) as Uint8Array);
    bytes[0] = 2;
    inner.overrides.set(ref.__loomContent, bytes);
    await expect(store.get(ref, ann)).rejects.toBeInstanceOf(ContentUndecryptableError);
  });
});

describe("ownedBy: the ownership proof (ADR 0143 D5)", () => {
  it("true for the subject's own blob; false for another subject's, an absent one, and a corrupt one", async () => {
    const { inner, store } = make();
    const mine = await store.put(enc("mine"), ann);
    const theirs = await store.put(enc("theirs"), bob);
    expect(await store.ownedBy(mine, ann)).toBe(true);
    expect(await store.ownedBy(theirs, ann)).toBe(false);
    expect(await store.ownedBy({ __loomContent: "sha256:dead" }, ann)).toBe(false);
    const bytes = Uint8Array.from((await inner.get(mine)) as Uint8Array);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
    inner.overrides.set(mine.__loomContent, bytes);
    expect(await store.ownedBy(mine, ann)).toBe(false);
  });

  it("cannot decide (rejects) when the key is destroyed or not on this node; needs the access", async () => {
    const { inner, store, keys } = make();
    const ref = await store.put(enc("x"), ann);
    await expect(
      (store as unknown as { ownedBy(r: ContentRef): Promise<boolean> }).ownedBy(ref)
    ).rejects.toBeInstanceOf(ContentAccessRequiredError);
    const other = new EncryptingContentStore(inner, new InMemoryKeyStore());
    await expect(other.ownedBy(ref, ann)).rejects.toSatisfy(isKeyUnavailable);
    await keys.destroy("ann");
    await expect(store.ownedBy(ref, ann)).rejects.toSatisfy(isPayloadShredded);
  });
});

describe("hardening (ADR 0143 review)", () => {
  it("an address scheme this layer cannot verify is refused, never trusted unchecked", async () => {
    const { inner, store } = make();
    const ref = await store.put(enc("x"), ann);
    const stored = (await inner.get(ref)) as Uint8Array;
    const odd = { __loomContent: "md5:abc" };
    inner.overrides.set("md5:abc", stored); // a perfectly valid sealed blob under an unverifiable address
    await expect(store.get(odd, ann)).rejects.toBeInstanceOf(ContentUndecryptableError);
    await expect(store.getMany([odd], ann)).rejects.toBeInstanceOf(ContentUndecryptableError);
    expect(await store.ownedBy(odd, ann)).toBe(false);
  });

  it("a non-string subject is refused like an empty one", async () => {
    for (const bad of [undefined, null, 42, {}]) {
      const store = new EncryptingContentStore(new InMemoryContentStore(), new InMemoryKeyStore(), {
        subjectOf: (() => bad) as never,
      });
      await expect(store.put(enc("x"), ann)).rejects.toThrow(/non-string/);
      await expect(store.get({ __loomContent: "sha256:00" }, ann)).rejects.toThrow(/non-string/);
    }
  });

  it("a throwing wasDestroyed probe does not mask the original put failure (attached as its cause)", async () => {
    const original = new Error("keystore offline");
    const probe = new Error("probe also failed");
    const keys: KeyStore = {
      getOrCreate: async () => {
        throw original;
      },
      get: async () => null,
      destroy: async () => {},
      wasDestroyed: async () => {
        throw probe;
      },
    };
    const store = new EncryptingContentStore(new InMemoryContentStore(), keys);
    const err = await store.put(enc("x"), ann).catch((e: unknown) => e);
    expect(err).toBe(original);
    expect((err as Error).cause).toBe(probe);
  });
});

describe("forwarded optionals and markers", () => {
  it("declares sealsContent and forwards the SPI 1.3.0/1.4.0 optionals iff the inner store has them", () => {
    const full = make().store;
    expect(full.sealsContent).toBe(true);
    for (const m of ["deleteIfUntouchedSince", "listPage", "touchClock", "touch"] as const) {
      expect(typeof full[m]).toBe("function");
    }
    const bare = new EncryptingContentStore(
      { put: async () => ({ __loomContent: "x" }), get: async () => null, delete: async () => {} },
      new InMemoryKeyStore()
    );
    for (const m of ["deleteIfUntouchedSince", "listPage", "touchClock", "touch"] as const) {
      expect(bare[m]).toBeUndefined();
    }
  });
});
