import { createHash } from "node:crypto";
import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  type ClaimCheckEnvelope,
  claimCheckMiddleware,
  isClaimCheck,
  resolveClaimCheck,
  resolveClaimCheckBytes,
  streamResult,
} from "./claimCheck";

/** Minimal content-addressed store matching the ADR 0046 contract. */
class FakeContentStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<{ __loomContent: string }> {
    const address = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    this.blobs.set(address, bytes);
    return { __loomContent: address };
  }
  async putStream(stream: AsyncIterable<Uint8Array>): Promise<{ __loomContent: string }> {
    const hash = createHash("sha256");
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      hash.update(chunk);
      chunks.push(chunk);
    }
    const address = `sha256:${hash.digest("hex")}`;
    this.blobs.set(address, Buffer.concat(chunks));
    return { __loomContent: address };
  }
  async get(ref: { __loomContent: string }): Promise<Uint8Array | null> {
    return this.blobs.get(ref.__loomContent) ?? null;
  }
}

const ctx = (toolId?: string): EffectContext => ({
  executionId: "exec-1",
  stepId: "step-1",
  workflowId: "wf-1",
  attempt: 1,
  ...(toolId !== undefined && { toolId }),
  emit: () => {},
});

const big = (marker: string) => ({
  marker,
  rows: Array.from({ length: 64 }, (_, i) => `row-${i}`),
});

describe("claimCheckMiddleware", () => {
  it("records results at or under the cap inline, untouched (same reference)", async () => {
    const store = new FakeContentStore();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 1024 });
    const result = { small: true };
    const out = await mw(ctx("t"), {}, async () => result);
    expect(out).toBe(result);
    expect(store.blobs.size).toBe(0);
  });

  it("offloads over-cap results: the envelope IS the recorded value", async () => {
    const store = new FakeContentStore();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 128 });
    const result = big("a");
    const out = (await mw(ctx("t"), {}, async () => result)) as ClaimCheckEnvelope;
    expect(isClaimCheck(out)).toBe(true);
    expect(out.ref.__loomContent).toMatch(/^sha256:/);
    expect(out.size).toBeGreaterThan(128);
    expect(out.digest).toBeUndefined(); // no digest declared for "t"
    expect(store.blobs.size).toBe(1);
  });

  it("applies the declared digest for the invoking toolId (CC-2)", async () => {
    const store = new FakeContentStore();
    const mw = claimCheckMiddleware({
      store,
      inlineCapBytes: 128,
      digests: {
        "pg.snapshot": (r) => ({ rowCount: (r as { rows: unknown[] }).rows.length }),
        "other.tool": () => "wrong",
      },
    });
    const out = (await mw(ctx("pg.snapshot"), {}, async () => big("a"))) as ClaimCheckEnvelope;
    expect(out.digest).toEqual({ rowCount: 64 });
  });

  it("offloads without a digest when ctx carries no toolId (hand-built contexts)", async () => {
    const store = new FakeContentStore();
    const mw = claimCheckMiddleware({
      store,
      inlineCapBytes: 128,
      digests: { t: () => "d" },
    });
    const out = (await mw(ctx(), {}, async () => big("a"))) as ClaimCheckEnvelope;
    expect(isClaimCheck(out)).toBe(true);
    expect(out.digest).toBeUndefined();
  });

  it("is deterministic: identical results yield an identical envelope (content-addressed)", async () => {
    const store = new FakeContentStore();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 128 });
    const a = await mw(ctx("t"), {}, async () => big("same"));
    const b = await mw(ctx("t"), {}, async () => big("same"));
    expect(a).toEqual(b);
    expect(store.blobs.size).toBe(1); // idempotent put — stored once
  });

  it("never double-wraps an envelope (stacked wiring)", async () => {
    const store = new FakeContentStore();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 8 });
    const envelope: ClaimCheckEnvelope = {
      __loomClaimCheck: true,
      ref: { __loomContent: "sha256:abc" },
      size: 999,
    };
    const out = await mw(ctx("t"), {}, async () => envelope);
    expect(out).toBe(envelope);
    expect(store.blobs.size).toBe(0);
  });

  it("reports each offload via onOffload (CC-3)", async () => {
    const store = new FakeContentStore();
    const onOffload = vi.fn();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 128, onOffload });
    const out = (await mw(ctx("t"), {}, async () => big("a"))) as ClaimCheckEnvelope;
    expect(onOffload).toHaveBeenCalledTimes(1);
    expect(onOffload).toHaveBeenCalledWith({
      toolId: "t",
      stepId: "step-1",
      executionId: "exec-1",
      workflowId: "wf-1",
      size: out.size,
      contentAddress: out.ref.__loomContent,
    });
  });

  it("passes through results JSON cannot encode (circular, undefined)", async () => {
    const store = new FakeContentStore();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 8 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await mw(ctx("t"), {}, async () => circular)).toBe(circular);
    expect(await mw(ctx("t"), {}, async () => undefined)).toBeUndefined();
    expect(store.blobs.size).toBe(0);
  });

  it("resolveClaimCheck round-trips the payload and returns null on absence (CC-4)", async () => {
    const store = new FakeContentStore();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 128 });
    const result = big("round-trip");
    const envelope = (await mw(ctx("t"), {}, async () => result)) as ClaimCheckEnvelope;
    expect(await resolveClaimCheck(store, envelope)).toEqual(result);
    store.blobs.clear(); // erased (unpinned TTL) — invisible to replay, null to readers
    expect(await resolveClaimCheck(store, envelope)).toBeNull();
  });

  it("isClaimCheck rejects near-misses", () => {
    expect(isClaimCheck({ __loomClaimCheck: true, ref: {} })).toBe(false);
    expect(isClaimCheck({ __loomClaimCheck: 1, ref: { __loomContent: "x" } })).toBe(false);
    expect(isClaimCheck(null)).toBe(false);
    expect(isClaimCheck("sha256:abc")).toBe(false);
  });
});

describe("stream-typed results (ST-2, ADR 0059)", () => {
  async function* chunksOf(text: string, chunkSize: number): AsyncGenerator<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += chunkSize) {
      yield bytes.slice(i, i + chunkSize);
    }
  }

  it("streams into the store: envelope matches put() of the same bytes; digest from the tool", async () => {
    const store = new FakeContentStore();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 128 });
    const text = "row,".repeat(5_000); // ~20 KB in 7-byte chunks — never one buffer
    const out = (await mw(ctx("dump.table"), {}, async () =>
      streamResult(chunksOf(text, 7), { digest: { rows: 5_000 } })
    )) as ClaimCheckEnvelope;

    expect(isClaimCheck(out)).toBe(true);
    expect(out.size).toBe(new TextEncoder().encode(text).byteLength);
    expect(out.codec).toBe("bytes");
    expect(out.digest).toEqual({ rows: 5_000 });
    // Content address identical to a whole-buffer put of the same bytes.
    const wholeRef = await new FakeContentStore().put(new TextEncoder().encode(text));
    expect(out.ref.__loomContent).toBe(wholeRef.__loomContent);
  });

  it("a store without putStream refuses loudly (the effect fails, nothing recorded silently)", async () => {
    const store = { put: new FakeContentStore().put.bind(new FakeContentStore()) };
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 128 });
    await expect(
      mw(ctx("dump.table"), {}, async () => streamResult(chunksOf("x", 1)))
    ).rejects.toThrow(/does not implement putStream/);
  });

  it("resolveClaimCheckBytes round-trips; resolveClaimCheck refuses a bytes codec", async () => {
    const store = new FakeContentStore();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 128 });
    const out = (await mw(ctx("dump.table"), {}, async () =>
      streamResult(chunksOf("hello stream", 3))
    )) as ClaimCheckEnvelope;
    const bytes = await resolveClaimCheckBytes(store, out);
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("hello stream");
    await expect(resolveClaimCheck(store, out)).rejects.toThrow(/resolveClaimCheckBytes/);
  });

  it("reports the offload with the streamed size (CC-3)", async () => {
    const store = new FakeContentStore();
    const seen: number[] = [];
    const mw = claimCheckMiddleware({
      store,
      inlineCapBytes: 128,
      onOffload: (info) => seen.push(info.size),
    });
    await mw(ctx("dump.table"), {}, async () => streamResult(chunksOf("abcdef", 2)));
    expect(seen).toEqual([6]);
  });
});

describe("stream source finalization (audit leak fix)", () => {
  it("a putStream failure mid-consumption finalizes the tool's source stream", async () => {
    let closed = false;
    async function* fileLikeSource(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < 100; i++) yield new Uint8Array(8);
      } finally {
        closed = true; // stands in for fs stream destroy / socket close
      }
    }
    const failingStore = {
      put: async () => ({ __loomContent: "sha256:unused" }),
      putStream: async (stream: AsyncIterable<Uint8Array>) => {
        let n = 0;
        for await (const _chunk of stream) {
          if (++n === 2) throw new Error("quota exceeded mid-upload");
        }
        return { __loomContent: "sha256:unreached" };
      },
    };
    const mw = claimCheckMiddleware({ store: failingStore });
    await expect(
      mw(ctx("dump.table"), {}, async () => streamResult(fileLikeSource()))
    ).rejects.toThrow(/quota exceeded/);
    expect(closed).toBe(true); // the source's finally ran — no handle leak
  });

  it("a fully-consumed stream is unaffected by the finalizer (no-op return)", async () => {
    const store = new FakeContentStore();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 8 });
    async function* two(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("ab");
      yield new TextEncoder().encode("cd");
    }
    const out = await mw(ctx("t"), {}, async () => streamResult(two()));
    expect((out as ClaimCheckEnvelope).size).toBe(4);
  });

  it("envelopesAreData force-offloads a result that NESTS a lookalike envelope (ADR 0140 D11)", async () => {
    const forgery = {
      note: "small",
      nested: {
        deep: [
          {
            __loomClaimCheck: true,
            ref: { __loomContent: "sha256:victim" },
            size: 1,
            retain: true,
          },
        ],
      },
    };
    const store = new FakeContentStore();
    const strict = claimCheckMiddleware({
      store,
      inlineCapBytes: 4096,
      envelopesAreData: true,
      retain: true,
    });
    const out = (await strict(ctx("t"), {}, async () => forgery)) as ClaimCheckEnvelope;
    expect(isClaimCheck(out)).toBe(true);
    expect(out.ref.__loomContent).not.toBe("sha256:victim");
    expect(out.retain).toBe(true);
    expect(store.blobs.size).toBe(1); // the forgery is DATA inside the blob
    const lax = claimCheckMiddleware({ store: new FakeContentStore(), inlineCapBytes: 4096 });
    expect(await lax(ctx("t"), {}, async () => forgery)).toBe(forgery); // default behaviour unchanged
  });
});
