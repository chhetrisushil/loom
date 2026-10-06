import { randomBytes } from "node:crypto";
import {
  runEventStoreDecoratorConformance,
  runSnapshotStoreDecoratorConformance,
} from "@loom/conformance";
import type { EventEnvelope } from "@loom/core";
import {
  CoalescingEventStore,
  type EventStore,
  InMemoryAsyncEventStore,
} from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { EncryptingEventStore } from "./EncryptingEventStore";
import { EncryptingSnapshotStore } from "./EncryptingSnapshotStore";
import { decryptValue, encryptValue, hasEnvelope, mapPaths } from "./crypto";
import { InMemoryKeyStore } from "./keystore";

describe("field-level AES-256-GCM envelope (K10.2)", () => {
  const key = randomBytes(32);

  it("round-trips arbitrary JSON values", () => {
    for (const value of ["ssn", 42, { a: [1, 2] }, null, true]) {
      expect(decryptValue(key, encryptValue(key, value))).toEqual(value);
    }
  });

  it("a wrong key fails (auth tag) — encryption is real, not obfuscation", () => {
    const env = encryptValue(key, "secret");
    expect(() => decryptValue(randomBytes(32), env)).toThrow();
  });

  it("decryptValue passes non-envelopes through untouched", () => {
    expect(decryptValue(key, "plain")).toBe("plain");
    expect(decryptValue(key, { a: 1 })).toEqual({ a: 1 });
  });

  it("hasEnvelope detects ciphertext anywhere in a structure", () => {
    expect(hasEnvelope({ output: { ssn: encryptValue(key, "x") } })).toBe(true);
    expect(hasEnvelope({ output: { ssn: "plain" } })).toBe(false);
  });

  it("mapPaths transforms only existing dot-paths, cloning (no input mutation)", () => {
    const input = { output: { ssn: "s", ok: true }, other: 1 };
    const out = mapPaths(input, ["output.ssn", "missing.path"], () => "X") as typeof input;
    expect(out.output.ssn).toBe("X");
    expect(out.output.ok).toBe(true);
    expect(out.other).toBe(1);
    expect(input.output.ssn).toBe("s"); // original untouched
  });

  it("structural sharing: two paths under one prefix both transform, untouched subtrees are shared by reference", () => {
    const input = {
      creds: { user: "u", pass: "p" },
      untouched: { big: [1, 2, 3] },
    };
    const out = mapPaths(input, ["creds.user", "creds.pass"], (v) => `X${v}`) as typeof input;

    // Both sibling paths under `creds` were transformed on the SAME copied node.
    expect(out.creds).toEqual({ user: "Xu", pass: "Xp" });
    // The original is untouched (no shared mutation up the spine).
    expect(input.creds).toEqual({ user: "u", pass: "p" });
    // The untouched subtree is shared by reference (no needless deep clone).
    expect(out.untouched).toBe(input.untouched);
  });

  it("does not mutate the original even when arrays are on the spine", () => {
    const input = { items: [{ secret: "a" }, { secret: "b" }] };
    const out = mapPaths(input, ["items.0.secret"], () => "REDACTED") as typeof input;
    expect(out.items[0]?.secret).toBe("REDACTED");
    expect(input.items[0]?.secret).toBe("a"); // original array + element untouched
    expect(out.items[1]).toBe(input.items[1]); // untouched element shared
  });

  it("encrypts EVERY element behind a `[]` path, and only the marked field (#260)", () => {
    const key = randomBytes(32);
    const input = {
      people: [
        { ssn: "111-11-1111", id: "a" },
        { ssn: "222-22-2222", id: "b" },
      ],
      note: "plain",
    };
    const out = mapPaths(input, ["people[].ssn"], (v) => encryptValue(key, v)) as typeof input;

    expect(Array.isArray(out.people)).toBe(true);
    expect(out.people).toHaveLength(2);
    for (const [i, person] of out.people.entries()) {
      expect(hasEnvelope(person.ssn)).toBe(true);
      // Round-trips to the original plaintext — the whole point of encrypting at append.
      expect(decryptValue(key, person.ssn)).toBe(input.people[i]?.ssn);
    }
    // Unmarked siblings untouched.
    expect(out.people[0]?.id).toBe("a");
    expect(out.note).toBe("plain");
    // Input never mutated.
    expect(input.people[0]?.ssn).toBe("111-11-1111");
  });

  it("leaves a `[]` path alone when it does not resolve", () => {
    const input = { people: "not-an-array", other: 1 };
    expect(mapPaths(input, ["people[].ssn"], () => "X")).toEqual(input);
    expect(mapPaths({ other: 1 }, ["people[].ssn"], () => "X")).toEqual({ other: 1 });
  });
});

// ── L1 / ADR 0074 Amendment — the decorators carry the whole optional SPI ────────────
//
// `sensitive` covers the kit's own event shape, so the conformance suite that runs THROUGH
// the decorator round-trips real ciphertext rather than a verbatim pass-through.

const KIT_SENSITIVE = { STEP_COMPLETED: ["sequence"] };

runEventStoreDecoratorConformance(
  "EncryptingEventStore",
  (inner) => new EncryptingEventStore(inner, new InMemoryKeyStore(), { sensitive: KIT_SENSITIVE })
);
runSnapshotStoreDecoratorConformance(
  "EncryptingSnapshotStore",
  (inner) =>
    new EncryptingSnapshotStore(inner, new InMemoryKeyStore(), { sensitive: ["workflowId"] })
);

describe("EncryptingEventStore under the coalescer (ADR 0074 Amendment)", () => {
  const evt = (executionId: string, sequence: number): EventEnvelope => ({
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType: "STEP_COMPLETED",
    sequence,
    timestamp: 1000 + sequence,
    payload: { sequence, ssn: `ssn-${executionId}` },
  });

  it("Coalescing(Encrypting(backend)) batches — the backend never sees a single append", async () => {
    const raw = new InMemoryAsyncEventStore();
    const calls = { append: 0, appendBatch: 0 };
    const counting: EventStore = {
      append: (e) => {
        calls.append++;
        return raw.append(e);
      },
      appendBatch: (es) => {
        calls.appendBatch++;
        return raw.appendBatch(es);
      },
      read: (id) => raw.read(id),
      readFrom: (id, f) => raw.readFrom(id, f),
      subscribe: (id, h) => raw.subscribe(id, h),
      close: () => raw.close(),
    };
    const store = new CoalescingEventStore(
      new EncryptingEventStore(counting, new InMemoryKeyStore(), {
        sensitive: { STEP_COMPLETED: ["ssn"] },
      })
    );
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.append(evt(`x${i}`, 0))));
    expect(calls.appendBatch).toBeGreaterThanOrEqual(1);
    expect(calls.append).toBe(0);
    // Ciphertext at rest, plaintext through the decorator.
    expect(hasEnvelope((await raw.read("x3"))[0]?.payload)).toBe(true);
    expect((await store.read("x3"))[0]?.payload).toEqual({ sequence: 0, ssn: "ssn-x3" });
    await store.close();
  });

  it("appendBatch resolves each DISTINCT subject's key once, not once per envelope", async () => {
    const keys = new InMemoryKeyStore();
    const lookups: string[] = [];
    const counted = Object.assign(Object.create(keys) as InMemoryKeyStore, {
      getOrCreate: (subject: string) => {
        lookups.push(subject);
        return keys.getOrCreate(subject);
      },
    });
    const store = new EncryptingEventStore(new InMemoryAsyncEventStore(), counted, {
      sensitive: { STEP_COMPLETED: ["ssn"] },
      subjectOf: (e) => (e.executionId.startsWith("a") ? "subject-a" : "subject-b"),
    });
    await store.appendBatch!([
      evt("a1", 0),
      evt("a2", 0),
      evt("b1", 0),
      evt("a1", 1),
      evt("b1", 1),
    ]);
    expect(lookups.sort()).toEqual(["subject-a", "subject-b"]);
    // Order preserved and every envelope readable.
    expect((await store.read("a1")).map((e) => e.sequence)).toEqual([0, 1]);
    expect((await store.read("b1")).map((e) => e.payload)).toEqual([
      { sequence: 0, ssn: "ssn-b1" },
      { sequence: 1, ssn: "ssn-b1" },
    ]);
  });

  it("forwards deleteExecution and truncatePrefix (ciphertext only shrinks) — the LogLifecycle key rule guards what leaves", async () => {
    const raw = new InMemoryAsyncEventStore();
    const store = new EncryptingEventStore(raw, new InMemoryKeyStore(), {
      sensitive: { STEP_COMPLETED: ["ssn"] },
    });
    for (let i = 0; i < 4; i++) await store.append(evt("t", i));
    await store.truncatePrefix!("t", 2);
    expect((await raw.read("t")).map((e) => e.sequence)).toEqual([0, 3]);
    await store.deleteExecution!("t");
    expect(await raw.read("t")).toEqual([]);
  });
});

describe("registerSensitive (R3k, ADR 0111 D1)", () => {
  it("adds paths after construction (union, no mutation of the caller's map) for events and snapshots", async () => {
    const sensitive = { STEP_COMPLETED: ["output.ssn"] };
    const keys = new InMemoryKeyStore();
    const inner = new InMemoryAsyncEventStore();
    const store = new EncryptingEventStore(inner, keys, { sensitive });
    store.registerSensitive("EXECUTION_STARTED", ["principal.identity.actor"]);
    store.registerSensitive("STEP_COMPLETED", ["output.ssn", "output.email"]);
    expect(sensitive).toEqual({ STEP_COMPLETED: ["output.ssn"] }); // caller's map untouched

    await store.append({
      id: "e-0",
      workflowId: "w",
      executionId: "e",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { principal: { v: 1, identity: { actor: "alice", tenant: "acme" } } },
    });
    const raw = (await inner.read("e"))[0]?.payload as {
      principal: { identity: { actor: unknown; tenant: unknown } };
    };
    expect(raw.principal.identity.actor).toMatchObject({ __loomEnc: "loom/aes-256-gcm" });
    expect(raw.principal.identity.tenant).toBe("acme"); // only the registered path
    // an anonymous record has none of the paths: nothing to encrypt, nothing thrown
    await store.append({
      id: "f-0",
      workflowId: "w",
      executionId: "f",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { principal: { v: 1 } },
    });
    expect((await store.read("f"))[0]?.payload).toEqual({ principal: { v: 1 } });
    expect((await store.read("e"))[0]?.payload).toEqual({
      principal: { v: 1, identity: { actor: "alice", tenant: "acme" } },
    });
  });
});
