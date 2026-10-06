import { TypedFailure } from "@loom/core";
import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it, vi } from "vitest";
import { LLM_INTERRUPTED } from "./assembleStream";
import type { InterruptedGeneration } from "./assembleStream";
import { createLlmEffect } from "./createLlmEffect";
import type { LlmProvider, LlmStreamChunk } from "./types";

// ── R9 — the streaming LLM effect ─────────────────────────────────────────────
//
// The effect consumes `provider.stream` INTERNALLY, accumulates, and returns one
// assembled response. Deltas go to a transient sink; the journal sees exactly one
// outcome, identical to the completed path (R8 parity). An effect that returned a
// stream to the flow, or journalled deltas, would be ST-R and is rejected.

function makeCtx(signal?: AbortSignal): EffectContext {
  return {
    executionId: "exec-1",
    stepId: "llm",
    workflowId: "wf-1",
    attempt: 1,
    emit: vi.fn(),
    ...(signal !== undefined && { signal }),
  };
}

const OUTCOME = {
  toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
  stopReason: "tool_use" as const,
  usage: { inputTokens: 7, outputTokens: 3 },
};

/** A provider whose two paths agree, as R8's conformance contract requires. */
function provider(opts: { onAbort?: () => void } = {}): LlmProvider {
  return {
    async complete() {
      return { content: "Looking", ...OUTCOME };
    },
    async *stream(request) {
      yield { delta: "Look", done: false };
      if (request.signal?.aborted === true) {
        opts.onAbort?.();
        throw new Error("aborted");
      }
      yield { delta: "ing", done: false };
      yield { delta: "", done: true, ...OUTCOME };
    },
  };
}

const build = (over: Partial<Parameters<typeof createLlmEffect>[0]> = {}) =>
  createLlmEffect({
    provider: provider(),
    buildRequest: (input: unknown) => ({ messages: [{ role: "user", content: String(input) }] }),
    parseResponse: (r) => r as never,
    ...over,
  });

describe("streaming LLM effect (R9)", () => {
  it("returns the same outcome the completed path would (one durable result)", async () => {
    const streamed = await build({ stream: true }).execute("hi", makeCtx());
    const completed = await build({ stream: false }).execute("hi", makeCtx());
    // The journal shape must not depend on which path ran — switching `stream` on
    // cannot change what replay serves.
    expect(streamed).toEqual(completed);
    expect(streamed).toEqual({ content: "Looking", ...OUTCOME });
  });

  it("feeds deltas to the transient sink as they arrive", async () => {
    const seen: string[] = [];
    await build({ stream: true, onDelta: (d) => seen.push(d) }).execute("hi", makeCtx());
    expect(seen).toEqual(["Look", "ing"]);
  });

  it("never journals a delta", async () => {
    // The sink is transient BY CONSTRUCTION: chunks-as-events is the fold-economics
    // problem ST-R rejected, and `ctx.stream` is durable per delta.
    const ctx = makeCtx();
    await build({ stream: true, onDelta: () => {} }).execute("hi", ctx);
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it("keeps the partial text when the generation is interrupted", async () => {
    // This is what populates R6. On the `complete` path there is nothing to keep:
    // an abort throws with the response body unread.
    const controller = new AbortController();
    const p = provider({ onAbort: () => {} });
    const effect = createLlmEffect({
      provider: p,
      stream: true,
      buildRequest: () => ({ messages: [{ role: "user", content: "hi" }] }),
      parseResponse: (r) => r as never,
    });
    controller.abort();

    const err = await effect.execute("hi", makeCtx(controller.signal)).catch((e) => e);

    expect(err).toBeInstanceOf(TypedFailure);
    expect((err as TypedFailure).channel).toBe(LLM_INTERRUPTED);
    const payload = (err as TypedFailure).payload as InterruptedGeneration;
    expect(payload.content).toBe("Look"); // produced before the abort, not lost
  });

  it("lets a genuine transport failure stay untyped (K9 in-doubt, retried whole)", async () => {
    // A dead stream is not an interruption: the durable unit is the turn, and a
    // partial token stream is not a fact worth journaling. It must NOT arrive as
    // an interruption, or a network blip would read as a user stop.
    const dying: LlmProvider = {
      async complete() {
        return { content: "", stopReason: "end_turn" };
      },
      async *stream() {
        yield { delta: "half", done: false };
        throw new Error("connection reset");
      },
    };
    const err = await createLlmEffect({
      provider: dying,
      stream: true,
      buildRequest: () => ({ messages: [] }),
      parseResponse: (r) => r as never,
    })
      .execute("hi", makeCtx())
      .catch((e) => e);

    expect(err).not.toBeInstanceOf(TypedFailure);
    expect((err as Error).message).toBe("connection reset");
  });

  it("falls back to complete when the provider cannot stream", async () => {
    // A provider swap must not turn an opted-in effect into a runtime failure.
    const textOnly: LlmProvider = {
      async complete() {
        return { content: "completed", stopReason: "end_turn" };
      },
    };
    const res = await createLlmEffect({
      provider: textOnly,
      stream: true,
      buildRequest: () => ({ messages: [] }),
      parseResponse: (r) => r as never,
    }).execute("hi", makeCtx());
    expect(res).toEqual({ content: "completed", stopReason: "end_turn" });
  });

  it("does not stream unless asked (G2)", async () => {
    // Opt-in: the outcome is identical either way, but the wire call is not, and
    // an effect that silently changed which one it makes would surprise anyone
    // already running this.
    const calls: string[] = [];
    const spy: LlmProvider = {
      async complete() {
        calls.push("complete");
        return { content: "x", stopReason: "end_turn" };
      },
      async *stream(): AsyncIterable<LlmStreamChunk> {
        calls.push("stream");
        yield { delta: "x", done: true };
      },
    };
    await createLlmEffect({
      provider: spy,
      buildRequest: () => ({ messages: [] }),
      parseResponse: (r) => r as never,
    }).execute("hi", makeCtx());
    expect(calls).toEqual(["complete"]);
  });

  it("still guards the prompt boundary on the streamed path", async () => {
    // R2 must not be bypassable by opting into streaming.
    const seen: string[] = [];
    const capture: LlmProvider = {
      async complete() {
        return { content: "", stopReason: "end_turn" };
      },
      async *stream(request) {
        seen.push(request.messages[0]?.content ?? "");
        yield { delta: "", done: true };
      },
    };
    const { tainted } = await import("@loom/classify");
    await createLlmEffect({
      provider: capture,
      stream: true,
      buildRequest: () => ({
        messages: [{ role: "user", content: tainted("untrusted", "mcp:evil") }],
      }),
      parseResponse: (r) => r as never,
    }).execute("hi", makeCtx());

    expect(seen[0]).toContain("<untrusted-input");
  });
});

// ADR 0119 — the per-call sink on EffectContext.onDelta.
describe("createLlmEffect per-call delta sink (ADR 0119)", () => {
  it("calls ctx.onDelta per delta plus a terminal chunk with usage, in addition to options.onDelta", async () => {
    const configured: string[] = [];
    const perCall: unknown[] = [];
    const effect = createLlmEffect<string, string>({
      provider: provider(),
      buildRequest: (i) => ({ messages: [{ role: "user", content: i }] }),
      stream: true,
      onDelta: (d) => configured.push(d),
    });
    const ctx: EffectContext = { ...makeCtx(), onDelta: (c) => perCall.push(c) };
    await effect.execute("hi", ctx);
    expect(configured).toEqual(["Look", "ing"]);
    expect(perCall).toEqual([
      { delta: "Look" },
      { delta: "ing" },
      { delta: "", done: true, usage: { inputTokens: 7, outputTokens: 3 } },
    ]);
  });

  it("a per-call sink alone (no configured onDelta) still receives deltas", async () => {
    const perCall: string[] = [];
    const effect = createLlmEffect<string, string>({
      provider: provider(),
      buildRequest: (i) => ({ messages: [{ role: "user", content: i }] }),
      stream: true,
    });
    await effect.execute("hi", { ...makeCtx(), onDelta: (c) => perCall.push(c.delta) });
    expect(perCall).toEqual(["Look", "ing", ""]);
  });
});
