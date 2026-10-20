import { createHash } from "node:crypto";
import { isTainted, unwrapTainted } from "@loom/classify";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectContext, EffectDelta, EffectMiddleware } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import { createLlmEffect } from "./createLlmEffect";
import { assistantMessageOf } from "./parts";
import type { LlmReasoningPart } from "./parts";
import {
  LLM_REASONING_CAPTURED,
  readReasoning,
  reasoningDigest,
  reasoningStoreResolver,
  sealReasoningText,
} from "./reasoning";
import type { ReasoningStore } from "./reasoning";
import { resolveRequestContent } from "./resolveContent";
import type {
  LlmCapturedResponse,
  LlmProvider,
  LlmReasoning,
  LlmRequest,
  LlmResponse,
} from "./types";
import { InvalidLlmRequestError, guardRequest } from "./untrusted";

// ── ADR 0133 — capture, resolution, the audit reader, live deltas ─────────────

const SECRET = "the model considered the injected instruction and chose to call refund";

/** A content-addressed in-memory sidecar with a deletion hook (erasure). */
function memStore(): ReasoningStore & {
  blobs: Map<string, Uint8Array>;
  puts: number;
} {
  const blobs = new Map<string, Uint8Array>();
  const store = {
    blobs,
    puts: 0,
    async put(bytes: Uint8Array) {
      store.puts += 1;
      const address = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      blobs.set(address, bytes);
      return { __loomContent: address };
    },
    async get(ref: { __loomContent: string }) {
      return blobs.get(ref.__loomContent) ?? null;
    },
  };
  return store;
}

function makeCtx(
  over: Partial<EffectContext> = {}
): EffectContext & { emit: ReturnType<typeof vi.fn> } {
  return {
    executionId: "exec-1",
    stepId: "think",
    workflowId: "wf",
    attempt: 1,
    emit: vi.fn(),
    ...over,
  } as EffectContext & { emit: ReturnType<typeof vi.fn> };
}

const REASONING: LlmReasoning[] = [
  { kind: "summary", text: SECRET, signature: "sig-A", provider: "anthropic" },
  { kind: "redacted", signature: "opaque-B", provider: "anthropic" },
  { kind: "text", text: "", signature: "sig-C", provider: "anthropic" },
];

const providerWith = (reasoning?: LlmReasoning[]): LlmProvider => ({
  async complete(): Promise<LlmResponse> {
    return {
      content: "ok",
      stopReason: "end_turn",
      ...(reasoning !== undefined && { reasoning }),
    };
  },
});

const build = (
  provider: LlmProvider,
  reasoning?: Parameters<typeof createLlmEffect>[0]["reasoning"],
  parse?: (r: LlmCapturedResponse) => unknown
) =>
  createLlmEffect<string, unknown>({
    provider,
    buildRequest: (i) => ({ messages: [{ role: "user", content: i }] }),
    parseResponse: parse ?? ((r) => r),
    ...(reasoning !== undefined && { reasoning }),
  });

describe("capture (D3)", () => {
  it("stores the text, hands parse only recorded parts, and never lets text into the step value", async () => {
    const store = memStore();
    const seen: unknown[] = [];
    const out = await build(providerWith(REASONING), { store }, (r) => {
      seen.push(r);
      return r;
    }).execute("hi", makeCtx());

    const digest = reasoningDigest(new TextEncoder().encode(SECRET));
    // the stored blob is sealed to the execution, so its address is the sealed bytes' hash
    const address = [...store.blobs.keys()][0] as string;
    expect(out).toEqual({
      content: "ok",
      stopReason: "end_turn",
      reasoning: [
        {
          type: "reasoning",
          kind: "summary",
          provider: "anthropic",
          signature: "sig-A",
          textRef: { address, size: new TextEncoder().encode(SECRET).byteLength },
          digest,
        },
        { type: "reasoning", kind: "redacted", provider: "anthropic", signature: "opaque-B" },
        { type: "reasoning", kind: "text", provider: "anthropic", signature: "sig-C" },
      ],
    });
    // negative: the readable text is nowhere parse, or the step value, could see it
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.parse(new TextDecoder().decode(store.blobs.get(address)))).toEqual({
      e: "exec-1",
      t: SECRET,
    });
  });

  it("emits LLM_REASONING_CAPTURED with references and digests only: no text, no signature", async () => {
    const store = memStore();
    const ctx = makeCtx({ attempt: 2 });
    await build(providerWith(REASONING), { store, model: "claude-x" }).execute("hi", ctx);
    expect(ctx.emit).toHaveBeenCalledTimes(1);
    const [type, payload] = ctx.emit.mock.calls[0] as [string, unknown];
    expect(type).toBe(LLM_REASONING_CAPTURED);
    const digest = reasoningDigest(new TextEncoder().encode(SECRET));
    expect(payload).toEqual({
      stepId: "think",
      attempt: 2,
      provider: "anthropic",
      model: "claude-x",
      parts: [
        { kind: "summary", ref: [...store.blobs.keys()][0], digest, size: SECRET.length },
        { kind: "redacted" },
        { kind: "text" },
      ],
    });
    const json = JSON.stringify(payload);
    for (const leaked of [SECRET, "sig-A", "opaque-B", "sig-C"]) expect(json).not.toContain(leaked);
  });

  it("a rerun with the same bytes stores one blob (content-addressed)", async () => {
    const store = memStore();
    const effect = build(providerWith(REASONING), { store });
    await effect.execute("hi", makeCtx());
    await effect.execute("hi", makeCtx({ attempt: 2 }));
    expect(store.blobs.size).toBe(1);
  });

  it("with no store, text is dropped and the part keeps its signature, flagged omitted; nothing is emitted", async () => {
    const ctx = makeCtx();
    const out = (await build(providerWith(REASONING)).execute("hi", ctx)) as LlmCapturedResponse;
    expect(out.reasoning).toEqual([
      {
        type: "reasoning",
        kind: "summary",
        provider: "anthropic",
        signature: "sig-A",
        omitted: true,
      },
      { type: "reasoning", kind: "redacted", provider: "anthropic", signature: "opaque-B" },
      { type: "reasoning", kind: "text", provider: "anthropic", signature: "sig-C" },
    ]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it("capture: false is the explicit opt-out even with a store; a function decides per call", async () => {
    const store = memStore();
    const off = makeCtx();
    const o1 = (await build(providerWith(REASONING), { store, capture: false }).execute(
      "hi",
      off
    )) as LlmCapturedResponse;
    expect(store.puts).toBe(0);
    expect(off.emit).not.toHaveBeenCalled();
    expect(o1.reasoning?.[0]).toMatchObject({ omitted: true });

    const gate = vi.fn((c: EffectContext) => c.attempt > 1);
    const effect = build(providerWith(REASONING), { store, capture: gate });
    await effect.execute("hi", makeCtx());
    expect(store.puts).toBe(0);
    await effect.execute("hi", makeCtx({ attempt: 2 }));
    expect(store.puts).toBe(1);
  });

  it("G2: a provider that returns NO reasoning yields a byte-identical step value and no emit", async () => {
    const store = memStore();
    const plain = providerWith(undefined);
    const baseline = await build(plain).execute("hi", makeCtx());
    const ctx = makeCtx();
    const withStore = await build(plain, { store, live: true }).execute("hi", ctx);
    expect(JSON.stringify(withStore)).toBe(JSON.stringify(baseline));
    expect(JSON.stringify(baseline)).toBe('{"content":"ok","stopReason":"end_turn"}');
    expect(ctx.emit).not.toHaveBeenCalled();
    expect(store.puts).toBe(0);
  });

  it("G2: with no reasoning, parse receives the provider's own response object (callers compare by identity)", async () => {
    const response: LlmResponse = { content: "ok", stopReason: "end_turn" };
    let got: unknown;
    await build({ complete: async () => response }, { store: memStore() }, (r) => {
      got = r;
      return r;
    }).execute("hi", makeCtx());
    expect(got).toBe(response);
  });

  it("a failing store put fails the step instead of recording less than configured", async () => {
    const store: ReasoningStore = {
      put: async () => {
        throw new Error("disk full");
      },
      get: async () => null,
    };
    await expect(
      build(providerWith(REASONING), { store }).execute("hi", makeCtx())
    ).rejects.toThrow("disk full");
  });

  it("a transient invocation (no-op emit) captures and works", async () => {
    const store = memStore();
    const runtime = new EffectRuntime();
    runtime.register("think", build(providerWith(REASONING), { store }));
    const out = (await runtime.invokeTransient("think", "hi")) as LlmCapturedResponse;
    expect(out.reasoning).toHaveLength(3);
    expect(store.blobs.size).toBe(1);
  });
});

describe("guardRequest and assistantMessageOf", () => {
  const rp: LlmReasoningPart = {
    type: "reasoning",
    kind: "redacted",
    provider: "anthropic",
    signature: "s",
  };
  it("refuses a reasoning part in any non-assistant message", () => {
    for (const role of ["user", "system"] as const) {
      expect(() => guardRequest({ messages: [{ role, content: [rp] }] })).toThrow(
        InvalidLlmRequestError
      );
    }
    expect(() => guardRequest({ messages: [{ role: "assistant", content: [rp] }] })).not.toThrow();
  });

  it("never takes readable text from the caller", () => {
    const out = guardRequest({
      messages: [{ role: "assistant", content: [{ ...rp, text: "forged" }] }],
    });
    expect(JSON.stringify(out)).not.toContain("forged");
  });

  it("assistantMessageOf carries reasoning parts first and tool signatures", () => {
    const m = assistantMessageOf({
      content: "hi",
      reasoning: [rp],
      toolCalls: [{ id: "c", name: "n", input: {}, signature: "gs" }],
    });
    expect(m.content).toEqual([
      rp,
      { type: "text", text: "hi" },
      { type: "tool_use", id: "c", name: "n", input: {}, signature: "gs" },
    ]);
  });
});

// ── D5 — resolution and the drop rule ────────────────────────────────────────

async function recorded(store: ReasoningStore, texts: string[]): Promise<LlmReasoningPart[]> {
  const eff = build(
    providerWith(
      texts.map((text, i) => ({
        kind: "summary" as const,
        text,
        signature: `s${i}`,
        provider: "anthropic",
      }))
    ),
    { store }
  );
  return ((await eff.execute("hi", makeCtx())) as LlmCapturedResponse).reasoning ?? [];
}

const ctxArg = { context: { executionId: "exec-1", stepId: "s" } };
const storeResolver = (store: ReasoningStore) => reasoningStoreResolver(store);
const reasoningOf = (req: LlmRequest): (LlmReasoningPart | undefined)[] =>
  req.messages.flatMap((m) =>
    typeof m.content === "string"
      ? []
      : m.content.filter((p): p is LlmReasoningPart => p.type === "reasoning")
  );

describe("resolution + the drop rule (D5)", () => {
  it("resolves each part's text from the store for the provider to send back", async () => {
    const store = memStore();
    const parts = await recorded(store, ["first", "second"]);
    const req = await resolveRequestContent(
      { messages: [{ role: "assistant", content: parts }] },
      undefined,
      { ...ctxArg, reasoningResolver: storeResolver(store) }
    );
    expect(reasoningOf(req).map((p) => p?.text)).toEqual(["first", "second"]);
  });

  it("an erased part is dropped together with EVERY reasoning part after it, across messages", async () => {
    const store = memStore();
    const parts = await recorded(store, ["first", "second", "third"]);
    store.blobs.delete(parts[1]?.textRef?.address as string);
    const req = await resolveRequestContent(
      {
        messages: [
          {
            role: "assistant",
            content: [parts[0] as LlmReasoningPart, { type: "text", text: "a" }],
          },
          { role: "user", content: "next" },
          {
            role: "assistant",
            content: [
              parts[1] as LlmReasoningPart,
              parts[2] as LlmReasoningPart,
              { type: "tool_use", id: "c", name: "n", input: {}, signature: "keep-me" },
            ],
          },
        ],
      },
      undefined,
      { ...ctxArg, reasoningResolver: storeResolver(store) }
    );
    expect(reasoningOf(req).map((p) => p?.text)).toEqual(["first"]);
    // a call's own signature is never dropped by this rule
    expect(JSON.stringify(req)).toContain("keep-me");
  });

  it("a digest mismatch drops the part and those after it; earlier parts survive", async () => {
    const store = memStore();
    const parts = await recorded(store, ["first", "second", "third"]);
    store.blobs.set(parts[1]?.textRef?.address as string, sealReasoningText("tampered", "exec-1"));
    const req = await resolveRequestContent(
      { messages: [{ role: "assistant", content: parts }] },
      undefined,
      { ...ctxArg, reasoningResolver: storeResolver(store) }
    );
    expect(reasoningOf(req).map((p) => p?.text)).toEqual(["first"]);
  });

  it("a part whose non-empty text was never stored (omitted) is dropped with its successors; signature-only parts are kept", async () => {
    const parts: LlmReasoningPart[] = [
      { type: "reasoning", kind: "redacted", provider: "anthropic", signature: "r" },
      { type: "reasoning", kind: "summary", provider: "anthropic", signature: "s", omitted: true },
      { type: "reasoning", kind: "redacted", provider: "anthropic", signature: "after" },
    ];
    const req = await resolveRequestContent(
      { messages: [{ role: "assistant", content: parts }] },
      undefined,
      ctxArg
    );
    expect(reasoningOf(req).map((p) => p?.signature)).toEqual(["r"]);
  });

  it("no resolver at all: a part with a textRef is unresolvable and dropped", async () => {
    const store = memStore();
    const parts = await recorded(store, ["first"]);
    const req = await resolveRequestContent(
      { messages: [{ role: "assistant", content: parts }] },
      undefined,
      ctxArg
    );
    expect(reasoningOf(req)).toEqual([]);
  });

  it("a resolver that THROWS fails the call (an outage is not an erasure); null/undefined is erased and dropped", async () => {
    const store = memStore();
    const parts = await recorded(store, ["first", "second"]);
    const messages = [{ role: "assistant" as const, content: parts }];
    await expect(
      resolveRequestContent({ messages }, undefined, {
        ...ctxArg,
        reasoningResolver: async () => {
          throw new Error("store timeout");
        },
      })
    ).rejects.toThrow("store timeout");
    for (const answer of [null, undefined]) {
      const req = await resolveRequestContent({ messages }, undefined, {
        ...ctxArg,
        reasoningResolver: async () => answer as null,
      });
      expect(reasoningOf(req)).toEqual([]);
    }
  });

  it("createLlmEffect: a failing sidecar read fails the step before the provider is called", async () => {
    const store = memStore();
    const parts = await recorded(store, ["first"]);
    const provider = vi.fn(async () => ({ content: "ok", stopReason: "end_turn" as const }));
    const down: ReasoningStore = {
      put: store.put,
      get: async () => {
        throw new Error("sidecar down");
      },
    };
    await expect(
      createLlmEffect<string, unknown>({
        provider: { complete: provider },
        reasoning: { store: down },
        buildRequest: () => ({ messages: [{ role: "assistant", content: parts }] }),
      }).execute("hi", makeCtx())
    ).rejects.toThrow("sidecar down");
    expect(provider).not.toHaveBeenCalled();
  });

  it("a ref captured by ANOTHER execution is refused by the default resolver: dropped, never sent", async () => {
    const store = memStore();
    // execution A captures; its part is then (mis)used in execution B's transcript
    const parts = await recorded(store, ["A's private thoughts"]);
    let seen: LlmRequest | undefined;
    const provider: LlmProvider = {
      async complete(r) {
        seen = r;
        return { content: "ok", stopReason: "end_turn" };
      },
    };
    const eff = createLlmEffect<string, unknown>({
      provider,
      reasoning: { store },
      buildRequest: () => ({ messages: [{ role: "assistant", content: parts }] }),
    });
    await eff.execute("hi", makeCtx({ executionId: "exec-B" }));
    expect(reasoningOf(seen as LlmRequest)).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain("private thoughts");
    // negative control: the execution that captured it resolves it
    await eff.execute("hi", makeCtx({ executionId: "exec-1" }));
    expect(reasoningOf(seen as LlmRequest).map((p) => p?.text)).toEqual(["A's private thoughts"]);
  });

  it("a configured authorizing resolver is the seam: it is told origin 'reasoning' and the caller", async () => {
    const store = memStore();
    const parts = await recorded(store, ["first"]);
    const asked: { origin: string; executionId: string; stepId?: string }[] = [];
    let seen: LlmRequest | undefined;
    const eff = createLlmEffect<string, unknown>({
      provider: {
        async complete(r) {
          seen = r;
          return { content: "ok", stopReason: "end_turn" };
        },
      },
      reasoning: {
        store,
        resolve: async (ref, c) => {
          asked.push({
            origin: c.origin,
            executionId: c.executionId,
            ...(c.stepId && { stepId: c.stepId }),
          });
          return c.executionId === "exec-1" ? reasoningStoreResolver(store)(ref, c) : null;
        },
      },
      buildRequest: () => ({ messages: [{ role: "assistant", content: parts }] }),
    });
    await eff.execute("hi", makeCtx({ executionId: "exec-2" }));
    expect(reasoningOf(seen as LlmRequest)).toEqual([]); // denied -> a hole -> dropped
    await eff.execute("hi", makeCtx());
    expect(reasoningOf(seen as LlmRequest).map((p) => p?.text)).toEqual(["first"]);
    expect(asked.every((a) => a.origin === "reasoning" && a.stepId === "think")).toBe(true);
    expect(asked.map((a) => a.executionId)).toEqual(["exec-2", "exec-1"]);
  });

  it("readReasoning refuses a blob sealed to a different execution (digest-mismatch, no text)", async () => {
    const store = memStore();
    const log = await (async () => {
      const events: { eventType: string; payload: unknown }[] = [];
      await build(providerWith([{ kind: "summary", text: "mine", provider: "anthropic" }]), {
        store,
      }).execute(
        "hi",
        makeCtx({
          emit: ((t: string, p: unknown) => events.push({ eventType: t, payload: p })) as never,
        })
      );
      return { read: async () => events };
    })();
    const [step] = await readReasoning(log, store, { executionId: "someone-else" });
    expect(step?.attempts[0]?.parts[0]?.status).toBe("digest-mismatch");
    expect(step?.attempts[0]?.parts[0]).not.toHaveProperty("text");
  });

  it("an all-dropped assistant message keeps the empty-text shape providers accept", async () => {
    const store = memStore();
    const parts = await recorded(store, ["first"]);
    store.blobs.clear();
    const req = await resolveRequestContent(
      { messages: [{ role: "assistant", content: parts }] },
      undefined,
      { ...ctxArg, reasoningResolver: storeResolver(store) }
    );
    expect(req.messages[0]?.content).toEqual([{ type: "text", text: "" }]);
  });

  it("is a pure function of request + answers: a request with no reasoning is returned unchanged", async () => {
    const req: LlmRequest = { messages: [{ role: "user", content: "hi" }] };
    expect(await resolveRequestContent(req, undefined, ctxArg)).toBe(req);
  });

  it("createLlmEffect resolves from its own store before the provider call", async () => {
    const store = memStore();
    const parts = await recorded(store, ["first"]);
    let seen: LlmRequest | undefined;
    const provider: LlmProvider = {
      async complete(r) {
        seen = r;
        return { content: "ok", stopReason: "end_turn" };
      },
    };
    await createLlmEffect<string, unknown>({
      provider,
      reasoning: { store },
      buildRequest: () => ({ messages: [{ role: "assistant", content: parts }] }),
    }).execute("hi", makeCtx());
    expect(reasoningOf(seen as LlmRequest).map((p) => p?.text)).toEqual(["first"]);
  });
});

// ── D4 — the audit reader ────────────────────────────────────────────────────

describe("readReasoning (D4)", () => {
  async function logFor(store: ReasoningStore) {
    const events: { eventType: string; payload: unknown }[] = [];
    const run = async (attempt: number, text: string) => {
      const ctx = makeCtx({
        attempt,
        emit: ((t: string, p: unknown) => events.push({ eventType: t, payload: p })) as never,
      });
      await build(providerWith([{ kind: "summary", text, provider: "anthropic" }]), {
        store,
      }).execute("hi", ctx);
    };
    await run(1, "first attempt thoughts");
    await run(2, "second attempt thoughts");
    events.push({ eventType: "STEP_COMPLETED", payload: { stepId: "think", output: {} } });
    return { read: async () => events };
  }

  it("returns tainted text per part, grouped by step with attempts, marking the recorded attempt", async () => {
    const store = memStore();
    const log = await logFor(store);
    const [step] = await readReasoning(log, store, { executionId: "exec-1" });
    expect(step?.stepId).toBe("think");
    expect(step?.attempts.map((a) => [a.attempt, a.recorded])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(step?.recordedAttempt).toBe(2);
    const text = step?.attempts[1]?.parts[0]?.text;
    expect(isTainted(text)).toBe(true);
    expect(unwrapTainted(text as never)).toBe("second attempt thoughts");
    expect((text as { __loomTainted: { origin: string } }).__loomTainted.origin).toBe(
      "llm-reasoning:think"
    );
  });

  it("reports erased and digest-mismatch, with no text", async () => {
    const store = memStore();
    const log = await logFor(store);
    const [a1, a2] = [...store.blobs.keys()];
    store.blobs.delete(a1 as string);
    store.blobs.set(a2 as string, sealReasoningText("tampered", "exec-1"));
    const [step] = await readReasoning(log, store, { executionId: "exec-1" });
    const statuses = step?.attempts.map((a) => a.parts[0]?.status);
    expect(statuses).toEqual(["erased", "digest-mismatch"]);
    for (const a of step?.attempts ?? []) expect(a.parts[0]).not.toHaveProperty("text");
  });

  it("filters by stepId and does not mark a step that never completed", async () => {
    const store = memStore();
    const log = await logFor(store);
    expect(await readReasoning(log, store, { executionId: "exec-1", stepId: "other" })).toEqual([]);
    const events = (await log.read()).filter((e) => e.eventType !== "STEP_COMPLETED");
    const [step] = await readReasoning({ read: async () => events }, store, {
      executionId: "exec-1",
    });
    expect(step?.recordedAttempt).toBeUndefined();
    expect(step?.attempts.some((a) => a.recorded)).toBe(false);
  });
});

// ── D6 — the live view ───────────────────────────────────────────────────────

function streamingProvider(): LlmProvider {
  return {
    async complete() {
      return { content: "ok", stopReason: "end_turn", reasoning: REASONING };
    },
    async *stream() {
      yield { delta: "", done: false, reasoningDelta: "think " };
      yield { delta: "ok", done: false };
      yield { delta: "", done: false, reasoningDelta: "more" };
      yield { delta: "", done: true, stopReason: "end_turn", reasoning: REASONING };
    },
  };
}

const live = (
  over: { live?: boolean } = {},
  extra: Partial<Parameters<typeof createLlmEffect>[0]> = {}
) =>
  createLlmEffect<string, unknown>({
    provider: streamingProvider(),
    buildRequest: (i) => ({ messages: [{ role: "user", content: i }] }),
    stream: true,
    reasoning: { store: memStore(), ...over },
    ...extra,
  });

describe("live reasoning deltas (D6)", () => {
  it("delivers reasoning on its own tainted field, separate from text, when live", async () => {
    const chunks: EffectDelta[] = [];
    const runtime = new EffectRuntime();
    runtime.register("t", live({ live: true }));
    await runtime.invokeTransient("t", "hi", { onDelta: (c) => chunks.push(c) });
    const reasoning = chunks.filter((c) => c.reasoning !== undefined);
    expect(reasoning.map((c) => unwrapTainted(c.reasoning as never))).toEqual(["think ", "more"]);
    for (const c of reasoning) {
      expect(isTainted(c.reasoning)).toBe(true);
      expect(unwrapTainted(c.delta)).toBe(""); // not text
    }
    const text = chunks
      .filter((c) => c.reasoning === undefined && c.done !== true)
      .map((c) => unwrapTainted(c.delta));
    expect(text).toEqual(["ok"]);
  });

  it("is off by default: no reasoning delta is delivered at all", async () => {
    const chunks: EffectDelta[] = [];
    const runtime = new EffectRuntime();
    runtime.register("t", live({}));
    await runtime.invokeTransient("t", "hi", { onDelta: (c) => chunks.push(c) });
    expect(chunks.some((c) => c.reasoning !== undefined)).toBe(false);
  });

  it("the configured onDelta sink (text-only) never sees a reasoning delta", async () => {
    const configured: string[] = [];
    const runtime = new EffectRuntime();
    runtime.register("t", live({ live: true }, { onDelta: (d) => configured.push(d) }));
    await runtime.invokeTransient("t", "hi", { onDelta: () => {} });
    expect(configured).toEqual(["ok"]);
    // and directly: the deltaSink ignores a reasoning chunk even if handed one
    const effect = live({ live: true }, { onDelta: (d) => configured.push(d) });
    effect.deltaSink?.(
      {
        delta: { __loomTainted: { origin: "x" }, value: "" } as never,
        reasoning: { __loomTainted: { origin: "x" }, value: "secret" } as never,
      },
      makeCtx()
    );
    expect(configured).toEqual(["ok"]);
  });

  const guardMw = (log: string[], throwOn?: string): EffectMiddleware => {
    const mw = async (_c: EffectContext, _i: unknown, next: () => Promise<unknown>) => next();
    return Object.assign(mw, {
      deltaGuard: () => {
        let text = "";
        return (d: string) => {
          text += d;
          log.push(d);
          if (throwOn !== undefined && d === throwOn) throw new Error("guard severed");
        };
      },
    }) as unknown as EffectMiddleware;
  };

  it("a middleware deltaGuard sees reasoning deltas, in a guard instance apart from the text", async () => {
    const log: string[] = [];
    const runtime = new EffectRuntime([guardMw(log)]);
    runtime.register("t", live({ live: true }));
    await runtime.invokeTransient("t", "hi", { onDelta: () => {} });
    expect(log).toEqual(expect.arrayContaining(["think ", "more", "ok"]));
  });

  it("a guard that throws on a reasoning delta severs the stream and the delta is never delivered", async () => {
    const log: string[] = [];
    const chunks: EffectDelta[] = [];
    const runtime = new EffectRuntime([guardMw(log, "more")]);
    runtime.register("t", live({ live: true }));
    await expect(
      runtime.invokeTransient("t", "hi", { onDelta: (c) => chunks.push(c) })
    ).rejects.toThrow("guard severed");
    const delivered = chunks
      .filter((c) => c.reasoning !== undefined)
      .map((c) => unwrapTainted(c.reasoning as never));
    expect(delivered).toEqual(["think "]);
  });

  it("inspectsOutput refuses streaming for the whole call: reasoning is not streamed past it", async () => {
    const chunks: EffectDelta[] = [];
    const mw = Object.assign(
      async (_c: EffectContext, _i: unknown, next: () => Promise<unknown>) => next(),
      {
        inspectsOutput: true as const,
      }
    ) as unknown as EffectMiddleware;
    const runtime = new EffectRuntime([mw], { onWarn: () => {} });
    runtime.register("t", live({ live: true }, { parseResponse: (r) => r }));
    const out = (await runtime.invokeTransient("t", "hi", {
      onDelta: (c) => chunks.push(c),
    })) as LlmCapturedResponse;
    expect(chunks).toEqual([]);
    expect(out.reasoning).toBeDefined(); // the durable record is unaffected
  });

  it("reasoning deltas are never journaled (no emit besides the one audit event)", async () => {
    const ctx = makeCtx({ onDelta: () => {} });
    await live({ live: true }).execute("hi", ctx);
    expect(ctx.emit.mock.calls.map((c) => c[0])).toEqual([LLM_REASONING_CAPTURED]);
  });
  it("durable path (no per-call sink): the configured reasoning sink gets tainted increments, only when live", async () => {
    const got: string[] = [];
    const sink = (d: unknown): void => {
      expect(isTainted(d)).toBe(true);
      got.push(unwrapTainted(d as never));
    };
    const ctx = makeCtx(); // ctx.onDelta undefined, as under ctx.execute
    await live(
      { live: true },
      { reasoning: { store: memStore(), live: true, onDelta: sink } }
    ).execute("hi", ctx);
    expect(got).toEqual(["think ", "more"]);
    got.length = 0;
    await live({}, { reasoning: { store: memStore(), onDelta: sink } }).execute("hi", makeCtx());
    expect(got).toEqual([]); // off by default, even with a sink configured
  });

  it("a throwing configured reasoning sink cannot fail the model call", async () => {
    const out = (await live(
      {},
      {
        reasoning: {
          store: memStore(),
          live: true,
          onDelta: () => {
            throw new Error("tail broke");
          },
        },
        parseResponse: (r) => r,
      }
    ).execute("hi", makeCtx())) as LlmCapturedResponse;
    expect(out.content).toBe("ok");
  });
});

describe("observability.reasoning: false is a default, not an override (ADR 0133 D7)", () => {
  const run = async (own: Parameters<typeof build>[1]) => {
    const store = memStore();
    const eff = build(
      providerWith(REASONING),
      own === undefined ? undefined : { ...own, store: own.store ?? store }
    );
    eff.reasoning?.adopt(false);
    const ctx = makeCtx();
    const out = (await eff.execute("hi", ctx)) as LlmCapturedResponse;
    return { out, ctx, eff, store };
  };

  it("an effect with its own store keeps capturing", async () => {
    const own = memStore();
    const eff = build(providerWith(REASONING), { store: own });
    eff.reasoning?.adopt(false);
    const ctx = makeCtx();
    const out = (await eff.execute("hi", ctx)) as LlmCapturedResponse;
    expect(own.puts).toBe(1);
    expect(out.reasoning?.[0]?.textRef).toBeDefined();
    expect(ctx.emit).toHaveBeenCalledWith(LLM_REASONING_CAPTURED, expect.anything());
    expect(eff.reasoning?.posture()).toBe("keeps");
  });

  it("an effect with its own capture choice keeps it (capture: true with a store)", async () => {
    const r = await run({ capture: true });
    expect(r.store.puts).toBe(1);
  });

  it("an effect with no reasoning config of its own is opted out", async () => {
    const eff = build(providerWith(REASONING));
    eff.reasoning?.adopt(false);
    const ctx = makeCtx();
    const out = (await eff.execute("hi", ctx)) as LlmCapturedResponse;
    expect(out.reasoning?.[0]?.omitted).toBe(true);
    expect(ctx.emit).not.toHaveBeenCalled();
    expect(eff.reasoning?.posture()).toBe("off");
  });

  it("an effect that set capture: false itself stays off", async () => {
    const r = await run({ capture: false });
    expect(r.store.puts).toBe(0);
  });
});
