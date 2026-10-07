import { tainted } from "@loom/classify";
import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  UnsupportedModalityError,
  assertRequestSupported,
  mediaTypeAccepted,
} from "./capabilities";
import { createLlmEffect } from "./createLlmEffect";
import { assistantMessageOf, base64ByteLength, hasStructuredParts, textOf, toParts } from "./parts";
import { UnresolvedContentError, resolveRequestContent } from "./resolveContent";
import type { LlmContentPart, LlmProvider, LlmRequest } from "./types";
import {
  InvalidLlmRequestError,
  MAX_INLINE_BYTES,
  OversizedInlinePartError,
  UntrustedContentError,
  guardRequest,
} from "./untrusted";

const ctx = (): EffectContext => ({
  executionId: "e",
  stepId: "s",
  workflowId: "w",
  attempt: 1,
  emit: vi.fn(),
});

const img = (data = "AAAA") => ({
  type: "image" as const,
  mediaType: "image/png",
  source: { kind: "data" as const, data },
});
const ref = (address = "sha256:abc") => ({
  type: "image" as const,
  mediaType: "image/png",
  source: { kind: "ref" as const, ref: { address } },
});
const toolUse = { type: "tool_use" as const, id: "t1", name: "lookup", input: { q: 1 } };

describe("part helpers", () => {
  it("textOf / toParts / hasStructuredParts treat a string and its text part alike", () => {
    expect(textOf("hi")).toBe("hi");
    expect(toParts("hi")).toEqual([{ type: "text", text: "hi" }]);
    expect(hasStructuredParts("hi")).toBe(false);
    expect(hasStructuredParts([{ type: "text", text: "hi" }])).toBe(false);
    const parts: LlmContentPart[] = [
      { type: "text", text: "a" },
      img(),
      { type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "b" }, img()] },
    ];
    expect(textOf(parts)).toBe("ab");
    expect(hasStructuredParts(parts)).toBe(true);
  });

  it("assistantMessageOf puts text first, then one tool_use per call; never empty content", () => {
    expect(
      assistantMessageOf({ content: "hm", toolCalls: [{ id: "1", name: "n", input: {} }] })
    ).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "hm" },
        { type: "tool_use", id: "1", name: "n", input: {} },
      ],
    });
    expect(
      assistantMessageOf({ content: "", toolCalls: [{ id: "1", name: "n", input: 1 }] }).content
    ).toHaveLength(1);
    expect(assistantMessageOf({ content: "" }).content).toEqual([{ type: "text", text: "" }]);
  });

  it("base64ByteLength is exact and rejects malformed input", () => {
    expect(base64ByteLength("AAAA")).toBe(3);
    expect(base64ByteLength("AA==")).toBe(1);
    expect(base64ByteLength("AAA=")).toBe(2);
    expect(base64ByteLength("AAA")).toBeUndefined();
    expect(base64ByteLength("AA!=")).toBeUndefined();
  });
});

describe("guardRequest — structure and provenance of parts (R5)", () => {
  it("returns a string-only request with the same content (the compatibility path)", () => {
    const r = guardRequest({ messages: [{ role: "user", content: "plain" }], system: "s" });
    expect(r).toEqual({ messages: [{ role: "user", content: "plain" }], system: "s" });
  });

  it("fences tainted text inside a tool_result and keeps the part shape", () => {
    const r = guardRequest({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [toolUse] },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "t1", content: tainted("EVIL", "mcp:x") }],
        },
      ],
    });
    const part = (r.messages[2]?.content as LlmContentPart[])[0];
    expect(part).toMatchObject({ type: "tool_result", toolUseId: "t1" });
    const body = (part as { content: string }).content;
    expect(body).toContain('<untrusted-input origin="mcp:x">');
    expect(body).toContain("EVIL");
  });

  it("REFUSES tainted text in an assistant part and in a system part", () => {
    expect(() =>
      guardRequest({
        messages: [{ role: "assistant", content: [{ type: "text", text: tainted("x", "o") }] }],
      })
    ).toThrow(UntrustedContentError);
    expect(() =>
      guardRequest({
        messages: [{ role: "system", content: [{ type: "text", text: tainted("x", "o") }] }],
      })
    ).toThrow(UntrustedContentError);
  });

  it("REFUSES a tainted tool_use input (a forged model call)", () => {
    expect(() =>
      guardRequest({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "n", input: tainted({ a: 1 }, "o") }],
          },
        ],
      })
    ).toThrow(UntrustedContentError);
  });

  it("brackets untrusted media with fence tags in a user message and strips the flag", () => {
    const r = guardRequest({
      messages: [{ role: "user", content: [{ ...img(), untrusted: { origin: "mcp:render" } }] }],
    });
    expect(r.messages[0]?.content).toEqual([
      { type: "text", text: '<untrusted-input origin="mcp:render">' },
      img(),
      { type: "text", text: "</untrusted-input>" },
    ]);
  });

  it("REFUSES untrusted media outside a user message, and any media outside user", () => {
    expect(() =>
      guardRequest({
        messages: [{ role: "assistant", content: [{ ...img(), untrusted: { origin: "o" } }] }],
      })
    ).toThrow(UntrustedContentError);
    expect(() => guardRequest({ messages: [{ role: "system", content: [img()] }] })).toThrow(
      InvalidLlmRequestError
    );
    expect(() => guardRequest({ messages: [{ role: "assistant", content: [img()] }] })).toThrow(
      InvalidLlmRequestError
    );
  });

  it("enforces part/role structure: tool_use only assistant, tool_result only user", () => {
    expect(() => guardRequest({ messages: [{ role: "user", content: [toolUse] }] })).toThrow(
      InvalidLlmRequestError
    );
    expect(() =>
      guardRequest({
        messages: [
          { role: "assistant", content: [toolUse] },
          { role: "assistant", content: [{ type: "tool_result", toolUseId: "t1", content: "x" }] },
        ],
      })
    ).toThrow(InvalidLlmRequestError);
  });

  it("REFUSES a tool_result for a call no earlier assistant message made", () => {
    expect(() =>
      guardRequest({
        messages: [
          { role: "user", content: [{ type: "tool_result", toolUseId: "ghost", content: "x" }] },
        ],
      })
    ).toThrow(/ghost/);
  });

  it("REFUSES an inline part over the byte cap, accepts one at the cap, and points at the remedy", () => {
    const at = Buffer.alloc(MAX_INLINE_BYTES, 1).toString("base64");
    const over = Buffer.alloc(MAX_INLINE_BYTES + 1, 1).toString("base64");
    expect(() => guardRequest({ messages: [{ role: "user", content: [img(at)] }] })).not.toThrow();
    const err = (() => {
      try {
        guardRequest({ messages: [{ role: "user", content: [img(over)] }] });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OversizedInlinePartError);
    expect((err as Error).message).toContain("ContentStore");
    // a ref of any declared size is not "inline"
    expect(() => guardRequest({ messages: [{ role: "user", content: [ref()] }] })).not.toThrow();
    // the cap is configurable per call
    expect(() =>
      guardRequest({ messages: [{ role: "user", content: [img(at)] }] }, { maxInlineBytes: 10 })
    ).toThrow(OversizedInlinePartError);
  });

  it("REFUSES malformed base64, a mislabeled media type, and an empty ref address", () => {
    expect(() =>
      guardRequest({ messages: [{ role: "user", content: [img("not base64!")] }] })
    ).toThrow(InvalidLlmRequestError);
    expect(() =>
      guardRequest({
        messages: [{ role: "user", content: [{ ...img(), mediaType: "audio/wav" }] }],
      })
    ).toThrow(InvalidLlmRequestError);
    expect(() =>
      guardRequest({
        messages: [
          {
            role: "user",
            content: [{ ...ref(""), source: { kind: "ref", ref: { address: "" } } }],
          },
        ],
      })
    ).toThrow(InvalidLlmRequestError);
  });
});

describe("capabilities — fail closed before the wire (R5)", () => {
  const withImage: LlmRequest = {
    messages: [{ role: "user", content: [{ type: "text", text: "see" }, img()] }],
  };

  it("matches exact types, type wildcards and *", () => {
    expect(mediaTypeAccepted(["image/png"], "IMAGE/PNG")).toBe(true);
    expect(mediaTypeAccepted(["image/*"], "image/webp")).toBe(true);
    expect(mediaTypeAccepted(["*"], "application/pdf")).toBe(true);
    expect(mediaTypeAccepted(["image/png"], "image/gif")).toBe(false);
    expect(mediaTypeAccepted(undefined, "image/png")).toBe(false);
  });

  it("assertRequestSupported finds media nested in a tool_result", () => {
    const nested: LlmRequest = {
      messages: [
        { role: "assistant", content: [toolUse] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: [img()] }] },
      ],
    };
    expect(() => assertRequestSupported(nested, undefined)).toThrow(UnsupportedModalityError);
    expect(() => assertRequestSupported(nested, { image: ["image/png"] })).not.toThrow();
    expect(() => assertRequestSupported(nested, { image: ["image/jpeg"] })).toThrow(
      UnsupportedModalityError
    );
  });

  it("createLlmEffect refuses an undeclared modality WITHOUT calling the provider or the resolver", async () => {
    const complete = vi.fn(async () => ({ content: "x", stopReason: "end_turn" as const }));
    const resolveContent = vi.fn(async () => new Uint8Array([1]));
    const effect = createLlmEffect<LlmRequest, string>({
      provider: { complete },
      buildRequest: (r) => r,
      resolveContent,
    });
    await expect(
      effect.execute({ messages: [{ role: "user", content: [ref()] }] }, ctx())
    ).rejects.toBeInstanceOf(UnsupportedModalityError);
    await expect(effect.execute(withImage, ctx())).rejects.toBeInstanceOf(UnsupportedModalityError);
    expect(complete).not.toHaveBeenCalled();
    expect(resolveContent).not.toHaveBeenCalled();
  });

  it("passes a declared modality through", async () => {
    const complete = vi.fn(async () => ({ content: "seen", stopReason: "end_turn" as const }));
    const effect = createLlmEffect<LlmRequest, string>({
      provider: { capabilities: { image: ["image/png"] }, complete },
      buildRequest: (r) => r,
    });
    expect(await effect.execute(withImage, ctx())).toBe("seen");
    expect(complete).toHaveBeenCalledOnce();
  });
});

describe("resolving claim-checked content at call time (R5)", () => {
  const provider = (seen: LlmRequest[]): LlmProvider => ({
    capabilities: { image: ["image/png"] },
    async complete(r) {
      seen.push(r);
      return { content: "ok", stopReason: "end_turn" };
    },
  });
  const request = (...addresses: string[]): LlmRequest => ({
    messages: [{ role: "user", content: addresses.map((a) => ref(a)) }],
  });

  it("hands the provider inline bytes, fetching each distinct address once", async () => {
    const seen: LlmRequest[] = [];
    const resolveContent = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const effect = createLlmEffect<LlmRequest, string>({
      provider: provider(seen),
      buildRequest: (r) => r,
      resolveContent,
    });
    await effect.execute(request("sha256:a", "sha256:a", "sha256:b"), ctx());
    expect(resolveContent).toHaveBeenCalledTimes(2);
    const content = seen[0]?.messages[0]?.content as { source: unknown }[];
    expect(content.map((p) => p.source)).toEqual([
      { kind: "data", data: "AQID" },
      { kind: "data", data: "AQID" },
      { kind: "data", data: "AQID" },
    ]);
  });

  it("fails loudly when the blob is absent (erased) and never calls the provider", async () => {
    const seen: LlmRequest[] = [];
    const effect = createLlmEffect<LlmRequest, string>({
      provider: provider(seen),
      buildRequest: (r) => r,
      resolveContent: async () => null,
    });
    await expect(effect.execute(request("sha256:gone"), ctx())).rejects.toThrow(/sha256:gone/);
    expect(seen).toHaveLength(0);
  });

  it("refuses a ref when no resolver is configured", async () => {
    const seen: LlmRequest[] = [];
    const effect = createLlmEffect<LlmRequest, string>({
      provider: provider(seen),
      buildRequest: (r) => r,
    });
    await expect(effect.execute(request("sha256:a"), ctx())).rejects.toBeInstanceOf(
      UnresolvedContentError
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses a request whose declared or resolved bytes exceed the total cap, before/after fetch", async () => {
    const fetched = vi.fn(async () => new Uint8Array(10));
    const declared = {
      messages: [
        {
          role: "user" as const,
          content: [
            {
              ...ref("sha256:big"),
              source: { kind: "ref" as const, ref: { address: "sha256:big", size: 1e9 } },
            },
          ],
        },
      ],
    };
    await expect(resolveRequestContent(declared, fetched, { maxBytes: 100 })).rejects.toThrow(
      /over the 100-byte cap/
    );
    expect(fetched).not.toHaveBeenCalled(); // an admitted-too-big ref is refused before any fetch
    await expect(
      resolveRequestContent(request("sha256:a", "sha256:b"), fetched, { maxBytes: 15 })
    ).rejects.toThrow(/over the 15-byte cap/);
  });

  it("returns the very same request object when there is nothing to resolve", async () => {
    const r: LlmRequest = { messages: [{ role: "user", content: "x" }] };
    expect(await resolveRequestContent(r, undefined)).toBe(r);
  });
});

describe("streamed tool-call input (R5)", () => {
  const provider: LlmProvider = {
    async *stream() {
      yield { delta: "", done: false, toolDelta: { id: "t1", name: "lookup", inputDelta: "" } };
      yield { delta: "", done: false, toolDelta: { id: "t1", inputDelta: '{"a":1}' } };
      yield {
        delta: "",
        done: true,
        toolCalls: [{ id: "t1", name: "lookup", input: { a: 1 } }],
        stopReason: "tool_use",
      };
    },
    async complete() {
      return { content: "", stopReason: "end_turn" };
    },
  };

  it("reaches onToolDelta transiently while the journaled outcome stays the assembled call", async () => {
    const seen: unknown[] = [];
    const effect = createLlmEffect<string, import("./types").LlmResponse>({
      provider,
      stream: true,
      buildRequest: (s) => ({ messages: [{ role: "user", content: s }] }),
      parseResponse: (r) => r,
      onToolDelta: (d) => seen.push(d),
    });
    const res = await effect.execute("go", ctx());
    expect(seen).toEqual([
      { id: "t1", name: "lookup", inputDelta: "" },
      { id: "t1", inputDelta: '{"a":1}' },
    ]);
    expect(res.toolCalls).toEqual([{ id: "t1", name: "lookup", input: { a: 1 } }]);
    expect(JSON.stringify(res)).not.toContain("toolDelta");
  });
});
