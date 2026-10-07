import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { UnsupportedModalityError } from "@loom/llm";
import { describe, expect, it, vi } from "vitest";
import { ReasoningRuntime } from "./ReasoningRuntime";
import type { ReasoningCache } from "./types";

// ── R5 — media refs on the reasoning path ─────────────────────────────────────
//
// Resolving a ref before the route's capability check fetched bytes for a request that was about to
// be refused, and a cache key built from the RESOLVED request put whole images into key strings.

const ok: LlmResponse = { content: "seen", stopReason: "end_turn" };
const refRequest = (address: string): { messages: LlmRequest["messages"] } => ({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", mediaType: "image/png", source: { kind: "ref", ref: { address } } },
      ],
    },
  ],
});

describe("ReasoningRuntime and media refs (R5)", () => {
  it("checks the chosen route's capabilities BEFORE resolving any ref", async () => {
    const resolve = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const provider: LlmProvider = { complete: vi.fn(async () => ok) }; // declares no media
    const runtime = new ReasoningRuntime({ routes: [{ id: "text-only", provider, tier: 0 }] });
    await expect(
      runtime.reason(refRequest("sha256:a"), {
        resolveContent: resolve,
        resolveContext: { executionId: "e" },
      })
    ).rejects.toBeInstanceOf(UnsupportedModalityError);
    expect(resolve).not.toHaveBeenCalled();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("keys the cache on addresses, not on resolved bytes, and resolves once for a repeated request", async () => {
    const keys: string[] = [];
    const store = new Map<string, LlmResponse>();
    const cache: ReasoningCache = {
      get: (k) => {
        keys.push(k);
        return store.get(k);
      },
      set: (k, v) => void store.set(k, v),
    };
    const resolve = vi.fn(async () => new Uint8Array(1024).fill(7)); // 1 KiB -> ~1.4 KiB of base64
    const provider: LlmProvider = {
      capabilities: { image: ["image/png"] },
      complete: vi.fn(async (r: LlmRequest) => {
        // the provider DOES receive inline bytes
        expect(JSON.stringify(r)).toContain('"kind":"data"');
        return ok;
      }),
    };
    const runtime = new ReasoningRuntime({ routes: [{ id: "vision", provider, tier: 0 }], cache });
    await runtime.reason(refRequest("sha256:abc"), {
      resolveContent: resolve,
      resolveContext: { executionId: "e" },
    });
    await runtime.reason(refRequest("sha256:abc"), {
      resolveContent: resolve,
      resolveContext: { executionId: "e" },
    });
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(keys[0]).toContain("sha256:abc");
    expect(keys[0]?.length).toBeLessThan(600); // no base64 of the 1 KiB blob in the key
  });

  it("passes the resolve context through so the store can authorize", async () => {
    const seen: unknown[] = [];
    const provider: LlmProvider = {
      capabilities: { image: ["image/png"] },
      complete: async () => ok,
    };
    const runtime = new ReasoningRuntime({ routes: [{ id: "vision", provider, tier: 0 }] });
    await runtime.reason(refRequest("sha256:abc"), {
      resolveContent: async (_ref, c) => {
        seen.push(c);
        return new Uint8Array(1);
      },
      resolveContext: { executionId: "exec-9", stepId: "s" },
    });
    expect(seen[0]).toMatchObject({ executionId: "exec-9", stepId: "s", origin: "app" });
  });

  it("a resolver without a context is a type error AND refused at runtime — it could not authorize the read", async () => {
    const resolve = vi.fn(async () => new Uint8Array(1));
    const provider: LlmProvider = {
      capabilities: { image: ["image/png"] },
      complete: async () => ok,
    };
    const runtime = new ReasoningRuntime({ routes: [{ id: "vision", provider, tier: 0 }] });
    await expect(
      // @ts-expect-error resolveContent requires resolveContext
      runtime.reason(refRequest("sha256:a"), { resolveContent: resolve })
    ).rejects.toThrow(/cannot authorize a read it cannot attribute/);
    expect(resolve).not.toHaveBeenCalled();
  });
});
