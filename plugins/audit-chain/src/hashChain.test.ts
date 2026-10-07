import { runEventStoreDecoratorConformance } from "@loom/conformance";
import type { EventEnvelope } from "@loom/core";
import {
  CoalescingEventStore,
  type EventStore,
  InMemoryAsyncEventStore,
  refusalsOf,
} from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { canonicalize, hashChainedEventStore } from "./hashChain";

const ev = (
  executionId: string,
  sequence: number,
  payload: unknown = { n: sequence }
): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "w",
  executionId,
  eventType: sequence === 0 ? "EXECUTION_STARTED" : "STEP_COMPLETED",
  sequence,
  timestamp: 1000 + sequence,
  payload,
});

async function appendChain(
  store: { append: (e: EventEnvelope) => Promise<void> },
  id: string,
  n: number
) {
  for (let i = 0; i < n; i++) await store.append(ev(id, i));
}

describe("canonicalize", () => {
  it("is stable regardless of key order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });
  it("distinguishes different values and omits undefined", () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
  it("handles nested arrays/objects and primitives", () => {
    expect(canonicalize([{ y: 2, x: 1 }, "s", 3])).toBe('[{"x":1,"y":2},"s",3]');
  });
});

describe("hashChainedEventStore", () => {
  it("stamps a genesis-rooted chain that verifies", async () => {
    const inner = new InMemoryAsyncEventStore();
    const chained = hashChainedEventStore(inner);
    await appendChain(chained, "e1", 4);

    const events = await inner.read("e1");
    expect(events[0]?.metadata?.auditChain).toMatchObject({ prevHash: "" });
    // Each event's prevHash is the previous event's hash.
    for (let i = 1; i < events.length; i++) {
      const prev = (events[i - 1]?.metadata as { auditChain: { hash: string } }).auditChain.hash;
      const cur = (events[i]?.metadata as { auditChain: { prevHash: string } }).auditChain.prevHash;
      expect(cur).toBe(prev);
    }
    // `signaturesChecked: false` is load-bearing (#382): this chain has no secret and no
    // verifier, so the hashes chain but nothing was established about WHO wrote them.
    expect(await chained.verifyChain("e1")).toEqual({
      ok: true,
      length: 4,
      signaturesChecked: false,
    });
  });

  it("detects a tampered payload", async () => {
    const inner = new InMemoryAsyncEventStore();
    const chained = hashChainedEventStore(inner);
    await appendChain(chained, "e1", 4);

    // Mutate a persisted event in place (the attacker edits the log).
    const events = await inner.read("e1");
    (events[2] as EventEnvelope).payload = { n: 999 };

    const v = await chained.verifyChain("e1");
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(2);
    expect(v.reason).toContain("tampered");
  });

  it("detects a dropped event (prevHash mismatch)", async () => {
    const inner = new InMemoryAsyncEventStore();
    const chained = hashChainedEventStore(inner);
    await appendChain(chained, "e1", 4);

    // Splice out an event from the middle of the durable log.
    await inner.deleteExecution("e1");
    const kept = [ev("e1", 0), ev("e1", 1), ev("e1", 3)];
    // Re-stamp using a fresh chained store would recompute — instead re-append the
    // ORIGINAL stamped events minus one, simulating a drop. Rebuild from a full run:
    const inner2 = new InMemoryAsyncEventStore();
    const chained2 = hashChainedEventStore(inner2);
    await appendChain(chained2, "e2", 4);
    const full = await inner2.read("e2");
    const dropped = [full[0], full[1], full[3]] as EventEnvelope[]; // event #2 removed
    const inner3 = new InMemoryAsyncEventStore();
    for (const e of dropped) await inner3.append(e);
    const verifier = hashChainedEventStore(inner3);
    const v = await verifier.verifyChain("e2");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("dropped or reordered");
    expect(kept.length).toBe(3); // (kept is illustrative)
  });

  it("with an HMAC secret, rejects a re-chained forgery", async () => {
    const inner = new InMemoryAsyncEventStore();
    const chained = hashChainedEventStore(inner, { hmacSecret: "s3cret" });
    await appendChain(chained, "e1", 3);
    expect((await chained.verifyChain("e1")).ok).toBe(true);

    // Attacker edits an event AND re-chains hashes (no secret) to hide the edit.
    const inner2 = new InMemoryAsyncEventStore();
    const reChainNoSecret = hashChainedEventStore(inner2); // forger lacks the secret
    await reChainNoSecret.append(ev("e1", 0));
    await reChainNoSecret.append(ev("e1", 1, { n: 666 })); // the edit
    await reChainNoSecret.append(ev("e1", 2));
    // Verified WITH the secret: hashes recompute fine, but signatures are missing/invalid.
    const v = await hashChainedEventStore(inner2, { hmacSecret: "s3cret" }).verifyChain("e1");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("signature");
  });

  it("continues the chain across a cold start (recovery reads the tail)", async () => {
    const inner = new InMemoryAsyncEventStore();
    await appendChain(hashChainedEventStore(inner), "e1", 2);
    // A fresh wrapper instance (new process) appends more — must chain onto the tail.
    const revived = hashChainedEventStore(inner);
    await revived.append(ev("e1", 2));
    expect((await revived.verifyChain("e1")).ok).toBe(true);
  });

  it("is fold-invisible: the payload/sequence stream is unchanged, only metadata grows", async () => {
    const plainInner = new InMemoryAsyncEventStore();
    const chainInner = new InMemoryAsyncEventStore();
    for (let i = 0; i < 3; i++) await plainInner.append(ev("e1", i));
    await appendChain(hashChainedEventStore(chainInner), "e1", 3);

    const plain = await plainInner.read("e1");
    const chained = await chainInner.read("e1");
    for (let i = 0; i < plain.length; i++) {
      expect(chained[i]?.payload).toEqual(plain[i]?.payload);
      expect(chained[i]?.sequence).toBe(plain[i]?.sequence);
      expect(chained[i]?.eventType).toBe(plain[i]?.eventType);
      // The ONLY difference is the added chain metadata.
      expect((chained[i]?.metadata as { auditChain?: unknown }).auditChain).toBeDefined();
    }
  });

  it("forwards optional store capabilities", async () => {
    const chained = hashChainedEventStore(new InMemoryAsyncEventStore());
    expect(typeof chained.readRange).toBe("function");
    expect(typeof chained.acquireFence).toBe("function");
  });

  it("rejects a signature that is not valid hex (no silent truncation)", async () => {
    const inner = new InMemoryAsyncEventStore();
    const chained = hashChainedEventStore(inner, { hmacSecret: "s3cret" });
    await appendChain(chained, "e1", 2);

    // Corrupt a stored signature to a non-hex value.
    const events = await inner.read("e1");
    (events[1]?.metadata as { auditChain: { sig: string } }).auditChain.sig = "not-hex!!";

    const v = await chained.verifyChain("e1");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("signature");
  });

  it("chains transparently across a terminal event (cache eviction is invisible)", async () => {
    const inner = new InMemoryAsyncEventStore();
    const chained = hashChainedEventStore(inner);
    await chained.append(ev("e1", 0));
    await chained.append({ ...ev("e1", 1), eventType: "EXECUTION_COMPLETED" }); // terminal → cache dropped
    // A late audit fact after the terminal must still chain (via a cold tail read).
    await chained.append({ ...ev("e1", 2), eventType: "EXECUTION_DENIED" });
    expect((await chained.verifyChain("e1")).ok).toBe(true);
  });
});

describe("hashChainedEventStore — a continued predecessor (ADR 0109)", () => {
  it("chains transparently across EXECUTION_CONTINUED, and a late outcome after it still chains", async () => {
    const inner = new InMemoryAsyncEventStore();
    const chained = hashChainedEventStore(inner, { hmacSecret: "s3cret" });
    await chained.append(ev("p", 0));
    await chained.append({
      ...ev("p", 1),
      eventType: "EXECUTION_CONTINUED",
      payload: { successorId: "p~1", chainId: "p", generation: 1 },
      metadata: { kernel: true },
    }); // terminal for the head cache: dropped
    // `recordOutcome` (ADR 0116) appends to a continued generation's log: a cold tail read chains it
    await chained.append({
      ...ev("p", 2),
      eventType: "OUTCOME_RECORDED",
      metadata: { kernel: true },
    });
    const verdict = await chained.verifyChain("p");
    expect(verdict.ok).toBe(true);
    // the successor is its own chain: it starts a fresh one and verifies on its own
    await chained.append(ev("p~1", 0));
    expect((await chained.verifyChain("p~1")).ok).toBe(true);
    // and the cache really dropped the predecessor's head: the metadata of the late append names
    // the stored tail, not a stale cached one
    const log = await inner.read("p");
    const chainMeta = (e: (typeof log)[number]) =>
      (e.metadata as { auditChain: { prevHash: string; hash: string } }).auditChain;
    expect(chainMeta(log[2] as never).prevHash).toBe(chainMeta(log[1] as never).hash);
  });
});

describe("hashChainedEventStore — the optional SPI (L1)", () => {
  it("a truncatePrefix-compacted log FAILS verifyChain — which is why the chain refuses truncatePrefix", async () => {
    // The probe that decided the plan. Compaction keeps sequence 0 and drops (0..through], so
    // the first surviving suffix event's prevHash names an event that no longer exists.
    const raw = new InMemoryAsyncEventStore();
    const chained = hashChainedEventStore(raw);
    await appendChain(chained, "x", 5);
    await raw.truncatePrefix("x", 2); // what compaction would do, one layer down
    const verdict = await chained.verifyChain("x");
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAt).toBe(3);
    expect(verdict.reason).toContain("prevHash mismatch");
    // So the chain does not offer it: a compaction pass sees a store it cannot compact
    // rather than one that silently breaks every later audit.
    expect(chained.truncatePrefix).toBeUndefined();
    expect(refusalsOf(chained).get("truncatePrefix")).toBe(
      "a truncated prefix breaks chain verification (ADR 0037)"
    );
  });

  it("keeps enumeration: listExecutions and listExecutionsPage are forwarded", async () => {
    const chained = hashChainedEventStore(new InMemoryAsyncEventStore());
    await appendChain(chained, "b", 1);
    await appendChain(chained, "a", 1);
    expect(new Set(await chained.listExecutions!())).toEqual(new Set(["a", "b"]));
    expect(await chained.listExecutionsPage!({ limit: 10 })).toEqual({ executionIds: ["a", "b"] });
  });

  it("appendBatch chains each execution in order, across interleaved executions, and verifies", async () => {
    const raw = new InMemoryAsyncEventStore();
    const chained = hashChainedEventStore(raw);
    await chained.append(ev("p", 0)); // p has a durable tail the batch must chain onto
    await chained.appendBatch!([ev("q", 0), ev("p", 1), ev("q", 1), ev("p", 2)]);
    expect((await chained.verifyChain("p")).ok).toBe(true);
    expect((await chained.verifyChain("q")).ok).toBe(true);
    // And an append after the batch continues from the batch's last hash.
    await chained.append(ev("p", 3));
    expect(await chained.verifyChain("p")).toMatchObject({ ok: true, length: 4 });
  });

  it("a rejected appendBatch does not advance the chain head", async () => {
    const raw = new InMemoryAsyncEventStore();
    const chained = hashChainedEventStore(raw);
    await chained.append(ev("r", 0));
    // A duplicate sequence inside the batch: the backend rejects the WHOLE batch.
    await expect(
      chained.appendBatch!([ev("r", 1), { ...ev("r", 1), id: "dup" }])
    ).rejects.toThrow();
    // Had the failed batch advanced the cached head, this append would chain onto a hash
    // that never became durable and verification would break at sequence 1.
    await chained.append(ev("r", 1));
    expect(await chained.verifyChain("r")).toMatchObject({ ok: true, length: 2 });
  });

  it("Coalescing(hashChained(backend)) batches — the backend never sees a single append", async () => {
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
    const chained = hashChainedEventStore(counting);
    const store = new CoalescingEventStore(chained);
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.append(ev(`c${i}`, 0))));
    expect(calls.appendBatch).toBeGreaterThanOrEqual(1);
    expect(calls.append).toBe(0);
    expect((await chained.verifyChain("c7")).ok).toBe(true);
    await store.close();
  });
});

runEventStoreDecoratorConformance(
  "hashChainedEventStore",
  (inner) => hashChainedEventStore(inner),
  {
    refused: { truncatePrefix: "a truncated prefix breaks chain verification (ADR 0037)" },
  }
);
