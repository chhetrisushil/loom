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
