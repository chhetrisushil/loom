import { createHash } from "node:crypto";
import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  type ClaimCheckEnvelope,
  claimCheckMiddleware,
  isClaimCheck,
  resolveClaimCheck,
} from "./claimCheck";

/** Minimal content-addressed store matching the ADR 0046 contract. */
class FakeContentStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<{ __loomContent: string }> {
    const address = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    this.blobs.set(address, bytes);
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
