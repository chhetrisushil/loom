import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
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
