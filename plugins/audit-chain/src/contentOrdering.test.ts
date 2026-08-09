import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  type ContentRef,
  ContentResolvingEventStore,
  type ContentStore,
  contentAddress,
} from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { hashChainedEventStore } from "./hashChain";

// ── Decorator ordering: audit-chain OUTSIDE content resolution ────────────────
//
// Both orderings type-check, both run, and both pass every test either plugin has on its own.
// They differ in exactly one thing — whether tampering with an externalized blob is detected —
// and the difference is invisible at the wiring site. So it is pinned here, executably, rather
// than left as a sentence in a doc.
//
// The chain hashes at APPEND, over the envelope it is handed, and `verifyChain` recomputes
// over whatever `inner.read()` returns:
//
//   hashChained(ContentResolving(raw))   chain sees the FULL payload; verify re-reads it
//                                        RESOLVED ⇒ tampered bytes break the hash.  ✅
//   ContentResolving(hashChained(raw))   chain only ever sees the REF STRING; the bytes are
//                                        outside everything it hashed ⇒ silent.     ❌
//
// This also settles why verify-on-read was NOT made a `ContentStore` SPI obligation: the
// correct ordering already buys blob integrity, paid once per write instead of on every read,
// and it covers the whole log rather than just the externalized fields.

const EXTERNALIZE = { STEP_COMPLETED: ["output.doc"] };

/** An in-memory content store whose bytes can be rewritten behind the address — an attacker
 *  with write access to the blob backend, which is the whole threat being modelled. */
class TamperableContentStore implements ContentStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<ContentRef> {
    const address = contentAddress(bytes);
    if (!this.blobs.has(address)) this.blobs.set(address, bytes);
    return { __loomContent: address, size: bytes.length };
  }

  async get(ref: ContentRef): Promise<Uint8Array | null> {
    return this.blobs.get(ref.__loomContent) ?? null;
  }

  async delete(ref: ContentRef): Promise<void> {
    this.blobs.delete(ref.__loomContent);
  }

  /** Replace the bytes at an address WITHOUT changing the address. */
  tamper(replacement: unknown): void {
    const [address] = [...this.blobs.keys()];
    if (address === undefined) throw new Error("nothing stored to tamper with");
    this.blobs.set(address, new TextEncoder().encode(JSON.stringify(replacement)));
  }
}

function evt(payload: unknown): EventEnvelope {
  return {
    id: "e1-0",
    workflowId: "wf",
    executionId: "e1",
    eventType: "STEP_COMPLETED",
    sequence: 0,
    timestamp: 1000,
    payload,
  };
}

const PAYLOAD = { output: { doc: { verdict: "approved", amount: 100 } } };
const FORGED = { verdict: "approved", amount: 1_000_000 };

describe("audit-chain × content externalization: decorator ordering", () => {
  it("chain OUTSIDE resolution detects a tampered blob", async () => {
    const raw = new InMemoryAsyncEventStore();
    const content = new TamperableContentStore();
    const store = hashChainedEventStore(
      new ContentResolvingEventStore(raw, content, { externalize: EXTERNALIZE })
    );

    await store.append(evt(PAYLOAD));
    expect((await store.verifyChain("e1")).ok).toBe(true);

    // The log is untouched — only the blob behind the ref changes.
    content.tamper(FORGED);

    const verdict = await store.verifyChain("e1");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("hash mismatch (event tampered)");
    expect(verdict.brokenAt).toBe(0);
  });

  it("chain INSIDE resolution does NOT — the ordering is load-bearing", async () => {
    const raw = new InMemoryAsyncEventStore();
    const content = new TamperableContentStore();
    const chained = hashChainedEventStore(raw);
    const store = new ContentResolvingEventStore(chained, content, { externalize: EXTERNALIZE });

    await store.append(evt(PAYLOAD));
    expect((await chained.verifyChain("e1")).ok).toBe(true);

    content.tamper(FORGED);

    // Still "ok": the chain hashed a ref string, and that string is unchanged. The forged
    // value reads back clean. This test exists to fail if someone ever "fixes" the ordering
    // guidance by inverting it.
    expect((await chained.verifyChain("e1")).ok).toBe(true);
    const [resolved] = await store.read("e1");
    expect((resolved?.payload as typeof PAYLOAD).output.doc).toEqual(FORGED);
  });

  it("the correct ordering still folds identically to a plain log (fold-invisible)", async () => {
    const raw = new InMemoryAsyncEventStore();
    const content = new TamperableContentStore();
    const store = hashChainedEventStore(
      new ContentResolvingEventStore(raw, content, { externalize: EXTERNALIZE })
    );
    await store.append(evt(PAYLOAD));

    // Externalization really happened underneath (the durable log holds a ref, not the doc)…
    const [stored] = await raw.read("e1");
    const durable = stored?.payload as { output: { doc: ContentRef } };
    expect(durable.output.doc.__loomContent).toMatch(/^sha256:/);

    // …and the read path still yields the original payload, chain metadata aside.
    const [resolved] = await store.read("e1");
    expect(resolved?.payload).toEqual(PAYLOAD);
  });
});
