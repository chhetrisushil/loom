import { type FlowDefinition, TypedFailure, step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectDelta, EffectMiddleware } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { LLM_INTERRUPTED, type LlmProvider, type LlmStreamChunk, createLlmEffect } from "@loom/llm";
import {
  SafetyViolationError,
  piiValidator,
  retryMiddleware,
  safetyMiddleware,
} from "@loom/middleware";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// ── ADR 0119, END TO END ─────────────────────────────────────────────────────
//
// The REAL `createLlmEffect({ stream: true })` — real `collectStream`, real taint, real
// safety/retry middleware — driven through `ctx.decide`'s scope inside a real
// `WorkflowRuntime`. `workflow-runtime` cannot depend on `@loom/llm`, so its own tests use
// a stand-in effect; this is where the two meet, and where a mismatch between what the
// effect sends and what the runtime expects would show.

const modelStep = step$({
  id: "model-step",
  name: "Model",
  toolId: "model",
  inputSchema: z.string(),
  outputSchema: z.string(),
});
const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;
type R = FlowRunner<Record<string, unknown>, Record<string, unknown>>;

const delta = (d: string): LlmStreamChunk => ({ delta: d, done: false });
const done = (): LlmStreamChunk => ({
  delta: "",
  done: true,
  usage: { inputTokens: 4, outputTokens: 9 },
});

function provider(
  streams: Array<() => AsyncGenerator<LlmStreamChunk>>,
  state: { calls: number } = { calls: 0 }
): LlmProvider {
  return {
    async complete() {
      throw new Error("complete() must not be used on the streamed path");
    },
    stream() {
      const make = streams[
        Math.min(state.calls, streams.length - 1)
      ] as () => AsyncGenerator<LlmStreamChunk>;
      state.calls += 1;
      return make();
    },
  };
}

function build(
  runner: R,
  prov: LlmProvider,
  middleware: EffectMiddleware[] = [],
  llmOpts: {
    onDelta?: (d: string) => void;
    onReset?: (n: number) => void;
    onToolDelta?: (d: { id: string; name?: string; inputDelta: string }) => void;
    onToolReset?: (n: number) => void;
  } = {}
) {
  const eventStore = new InMemoryAsyncEventStore();
  const warns: string[] = [];
  const effects = new EffectRuntime(middleware, { onWarn: (m) => warns.push(m) });
  effects.register(
    "model",
    createLlmEffect<string, string>({
      provider: prov,
      stream: true,
      buildRequest: (i) => ({ messages: [{ role: "user", content: i }] }),
      ...llmOpts,
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onWarn: () => {},
  });
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: "f",
    name: "f",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [],
  };
  runtime.registerFlow(definition, runner);
  const types = async (id: string) => (await eventStore.read(id)).map((e) => e.eventType);
  return { runtime, definition, types, warns };
}

const viewer = (chunks: EffectDelta[]): string => {
  let v = "";
  for (const c of chunks) v = c.reset === true ? "" : v + c.delta.value;
  return v;
};

describe("DecideScope.invokeTransient onDelta × real createLlmEffect (ADR 0119)", () => {
  it("streams tainted deltas, then done+usage after success; the decision equals the viewer's text", async () => {
    const got: EffectDelta[] = [];
    let decided: unknown;
    const runner: R = async (ctx) => {
      decided = await ctx.decide("pick", (s) =>
        s.invokeTransient<string, string>("model", "hi", { onDelta: (d) => got.push(d) })
      );
      return {};
    };
    const { runtime, definition, types } = build(
      runner,
      provider([
        async function* () {
          yield delta("Hel");
          yield delta("lo");
          yield done();
        },
      ])
    );
    await (await runtime.start(definition, {}, { executionId: "x1" })).waitForCompletion();
    expect(got.map((d) => d.delta.value)).toEqual(["Hel", "lo", ""]);
    expect(got.slice(0, 2).every((d) => "__loomTainted" in d.delta)).toBe(true);
    expect(got[2]).toMatchObject({ done: true, usage: { inputTokens: 4, outputTokens: 9 } });
    expect(viewer(got)).toBe(decided);
    expect((await types("x1")).filter((t) => t === "DECISION_RECORDED")).toHaveLength(1);
  });

  it("a PII delta validator severs the REAL stream: the provider generator is released, the sink never sees the leak", async () => {
    let released = false;
    const got: EffectDelta[] = [];
    const runner: R = async (ctx) => ({
      r: await ctx.decide("pick", (s) =>
        s.invokeTransient<string, string>("model", "hi", { onDelta: (d) => got.push(d) })
      ),
    });
    const { runtime, definition, types } = build(
      runner,
      provider([
        async function* () {
          try {
            yield delta("write to ");
            yield delta("bob@");
            yield delta("corp.io");
            yield delta(" please");
            yield done();
          } finally {
            released = true;
          }
        },
      ]),
      [safetyMiddleware({ validators: [piiValidator()] })]
    );
    const h = await runtime.start(definition, {}, { executionId: "x2" });
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(SafetyViolationError);
    expect(got.map((d) => d.delta.value)).toEqual(["write to ", "bob@"]);
    expect(released).toBe(true);
    expect(await types("x2")).not.toContain("DECISION_RECORDED");
  });

  it("retry: the real effect re-streams, the sink gets a reset, and the viewer matches the decision", async () => {
    const got: EffectDelta[] = [];
    let decided: unknown;
    const runner: R = async (ctx) => {
      decided = await ctx.decide("pick", (s) =>
        s.invokeTransient<string, string>("model", "hi", { onDelta: (d) => got.push(d) })
      );
      return {};
    };
    const { runtime, definition } = build(
      runner,
      provider([
        async function* () {
          yield delta("half-");
          yield delta("written");
          throw new Error("connection reset");
        },
        async function* () {
          yield delta("whole");
          yield delta(" answer");
          yield done();
        },
      ]),
      [retryMiddleware({ jitter: false, sleep: async () => {} })]
    );
    await (await runtime.start(definition, {}, { executionId: "x3" })).waitForCompletion();
    expect(got.filter((d) => d.reset === true)).toHaveLength(1);
    expect(viewer(got)).toBe("whole answer");
    expect(viewer(got)).toBe(decided);
  });

  it("abort relies on the RUNTIME: a provider that ignores every signal delivers nothing after the abort", async () => {
    const ac = new AbortController();
    const got: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner: R = async (ctx) => ({
      r: await ctx.decide("pick", (s) =>
        s.invokeTransient<string, string>("model", "hi", {
          signal: ac.signal,
          onDelta: (d) => got.push(d.delta.value),
        })
      ),
    });
    const { runtime, definition, types } = build(
      runner,
      provider([
        async function* () {
          yield delta("one");
          await gate; // the provider never looks at request.signal
          yield delta("two");
          yield delta("three");
          yield done();
        },
      ])
    );
    const h = await runtime.start(definition, {}, { executionId: "x4" });
    setTimeout(() => ac.abort(new DOMException("stop", "AbortError")), 5);
    setTimeout(release, 20);
    const [out] = await Promise.allSettled([h.waitForCompletion()]);
    expect(got).toEqual(["one"]);
    expect(out.status).toBe("rejected");
    const reason = (out as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(TypedFailure);
    expect((reason as TypedFailure).channel).toBe(LLM_INTERRUPTED);
    expect(await types("x4")).not.toContain("DECISION_RECORDED");
  });
});

describe("the CONFIGURED sink is guarded on every path (ADR 0119, review 2)", () => {
  const leaky = (): LlmProvider =>
    provider([
      async function* () {
        yield delta("write to ");
        yield delta("bob@");
        yield delta("corp.io");
        yield delta(" please");
        yield done();
      },
    ]);

  it("durable ctx.run: a PII delta guard severs the configured sink before the leak", async () => {
    const seen: string[] = [];
    const runner: R = async (ctx) => {
      try {
        await ctx.run(modelStep, "hi");
      } catch {
        /* the sever fails the step */
      }
      return {};
    };
    const { runtime, definition } = build(
      runner,
      leaky(),
      [safetyMiddleware({ validators: [piiValidator()] })],
      { onDelta: (d) => seen.push(d) }
    );
    await (await runtime.start(definition, {}, { executionId: "d1" })).waitForCompletion();
    expect(seen.join("")).not.toContain("corp.io");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("durable ctx.run: an output validator WITHOUT a delta form -> the configured sink gets nothing, the call completes", async () => {
    const seen: string[] = [];
    let out: unknown;
    const runner: R = async (ctx) => {
      out = await ctx.run(modelStep, "hi");
      return {};
    };
    const noDelta = safetyMiddleware({
      validators: [{ id: "len", phase: "output", check: () => ({ ok: true }) }],
    });
    const { runtime, definition, warns } = build(runner, leaky(), [noDelta], {
      onDelta: (d) => seen.push(d),
    });
    await (await runtime.start(definition, {}, { executionId: "d2" })).waitForCompletion();
    expect(seen).toEqual([]);
    expect(out).toBe("write to bob@corp.io please");
    expect(warns.join("\n")).toMatch(/streaming disabled: .* inspects output without a delta form/);
  });

  it("transient call WITHOUT a per-call sink: configured sink is still guarded; and refused per-call sink also silences it", async () => {
    const seen: string[] = [];
    const runner: R = async (ctx) => {
      await ctx.decide("a", (s) => s.invokeTransient<string, string>("model", "hi"));
      return {};
    };
    const noDelta = safetyMiddleware({
      validators: [{ id: "len", phase: "output", check: () => ({ ok: true }) }],
    });
    const { runtime, definition } = build(runner, leaky(), [noDelta], {
      onDelta: (d) => seen.push(d),
    });
    await (await runtime.start(definition, {}, { executionId: "d3" })).waitForCompletion();
    expect(seen).toEqual([]);

    const seen2: string[] = [];
    const caller: string[] = [];
    const runner2: R = async (ctx) => {
      await ctx.decide("a", (s) =>
        s.invokeTransient<string, string>("model", "hi", {
          onDelta: (d) => caller.push(d.delta.value),
        })
      );
      return {};
    };
    const b = build(runner2, leaky(), [noDelta], { onDelta: (d) => seen2.push(d) });
    await (await b.runtime.start(b.definition, {}, { executionId: "d4" })).waitForCompletion();
    expect(seen2).toEqual([]);
    expect(caller).toEqual([]);
  });

  it("a retry resets the configured sink too (onReset fires when attempt 2 begins)", async () => {
    const seen: string[] = [];
    const resets: number[] = [];
    const runner: R = async (ctx) => {
      await ctx.run(modelStep, "hi");
      return {};
    };
    const { runtime, definition } = build(
      runner,
      provider([
        async function* () {
          yield delta("par");
          throw new Error("boom");
        },
        async function* () {
          yield delta("whole");
          yield done();
        },
      ]),
      [retryMiddleware({ jitter: false, sleep: async () => {} })],
      { onDelta: (d) => seen.push(d), onReset: (n) => resets.push(n) }
    );
    await (await runtime.start(definition, {}, { executionId: "d5" })).waitForCompletion();
    expect(resets).toEqual([2]);
    expect(seen).toEqual(["par", "whole"]);
  });

  it("R5: a retry resets tool-input fragments too (onToolReset fires at attempt 2; no duplicated fragments)", async () => {
    const fragments: string[] = [];
    const resets: number[] = [];
    const runner: R = async (ctx) => {
      await ctx.run(modelStep, "hi");
      return {};
    };
    const toolDelta = (inputDelta: string): LlmStreamChunk => ({
      delta: "",
      done: false,
      toolDelta: { id: "t1", inputDelta },
    });
    const { runtime, definition } = build(
      runner,
      provider([
        async function* () {
          yield toolDelta('{"a"');
          throw new Error("boom");
        },
        async function* () {
          yield toolDelta('{"a":1}');
          yield done();
        },
      ]),
      [retryMiddleware({ jitter: false, sleep: async () => {} })],
      {
        onToolDelta: (d) => fragments.push(d.inputDelta),
        onToolReset: (n) => {
          resets.push(n);
          fragments.length = 0; // the consumer discards what the failed attempt delivered
        },
      }
    );
    await (await runtime.start(definition, {}, { executionId: "d6" })).waitForCompletion();
    expect(resets).toEqual([2]);
    expect(fragments).toEqual(['{"a":1}']);
  });
});
