import type { FlowDefinition } from "@loom/core";
import {
  CapabilityDeniedError,
  type Effect,
  type EffectContext,
  type EffectDelta,
  type EffectMiddleware,
  EffectRuntime,
  GrantTable,
  ToolEffect,
} from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  InMemoryKillSwitch,
  KillSwitchEngagedError,
  SafetyViolationError,
  killSwitchMiddleware,
  piiValidator,
  retryMiddleware,
  safetyMiddleware,
  schemaValidator,
} from "@loom/middleware";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";

// ADR 0119 — `DecideScope.invokeTransient(tool, input, { onDelta })`: a streaming effect's
// deltas reach THIS call's sink, under exactly the governance of a non-streaming call.

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;
const isTaintedShape = (v: unknown): boolean =>
  typeof v === "object" && v !== null && "__loomTainted" in v;
type R = FlowRunner<Record<string, unknown>, Record<string, unknown>>;

/** The taint wrapper's wire shape (@loom/classify), inlined: this package does not depend on it. */
const tv = (value: string) => ({ __loomTainted: { origin: "test" }, value });
/** What a UI tail does: unwrap explicitly. */
const text = (d: EffectDelta): string => d.delta.value;

/**
 * A stand-in streaming effect: emits per-call deltas, ends with usage. It deliberately does
 * NOT consult ctx.signal unless `honourSignal` — the runtime's own guarantees are under test.
 */
class StreamingEffect extends ToolEffect<{ words: string[] }, string> {
  constructor(runs: { n: number }, gate?: Promise<void>, honourSignal = false) {
    super(async (input: { words: string[] }, ctx: EffectContext) => {
      runs.n++;
      let out = "";
      for (const w of input.words) {
        if (honourSignal && ctx.signal?.aborted === true) {
          throw ctx.signal.reason ?? new Error("aborted");
        }
        out += w;
        ctx.onDelta?.({ delta: tv(w) });
        if (gate !== undefined && w === "b") await gate;
      }
      ctx.onDelta?.({
        delta: tv(""),
        done: true,
        usage: { inputTokens: 2, outputTokens: out.length },
      });
      return out;
    });
  }
}

function setup(
  runner: R,
  opts: {
    authorizer?: GrantTable;
    kill?: InMemoryKillSwitch;
    gate?: Promise<void>;
    honourSignal?: boolean;
    middleware?: EffectMiddleware[];
    effect?: Effect;
  } = {}
) {
  const eventStore = new InMemoryAsyncEventStore();
  const runs = { n: 0 };
  const warns: string[] = [];
  const effects = new EffectRuntime(
    [
      ...(opts.kill !== undefined ? [killSwitchMiddleware(opts.kill)] : []),
      ...(opts.middleware ?? []),
    ],
    {
      ...(opts.authorizer !== undefined && { authorizer: opts.authorizer }),
      onWarn: (m) => warns.push(m),
    }
  );
  effects.register(
    "model",
    opts.effect ?? new StreamingEffect(runs, opts.gate, opts.honourSignal ?? false)
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
  return { runtime, definition, types, runs, warns };
}

describe("ctx.decide scope: streaming deltas (ADR 0119)", () => {
  it("delivers deltas in order to the call's sink, usage on the terminal chunk, nothing journaled but the decision", async () => {
    const got: EffectDelta[] = [];
    const runner: R = async (ctx) => ({
      r: await ctx.decide("pick", (scope) =>
        scope.invokeTransient("model", { words: ["a", "b", "c"] }, { onDelta: (d) => got.push(d) })
      ),
    });
    const { runtime, definition, types } = setup(runner);
    const h = await runtime.start(definition, {}, { executionId: "e1" });
    await h.waitForCompletion();
    expect(got.map(text)).toEqual(["a", "b", "c", ""]);
    expect(got.slice(0, 3).every((d) => isTaintedShape(d.delta))).toBe(true);
    expect(got[3]).toMatchObject({ done: true, usage: { inputTokens: 2, outputTokens: 3 } });
    expect(got.some((d) => d.reset === true)).toBe(false);
    const t = await types("e1");
    expect(t.filter((x) => x === "DECISION_RECORDED")).toHaveLength(1);
    expect(t).not.toContain("STEP_STARTED");
  });

  it("NEGATIVE: a denying authorizer refuses a streamed call — no deltas, no run", async () => {
    const got: EffectDelta[] = [];
    const runner: R = async (ctx) => ({
      r: await ctx.decide("pick", (scope) =>
        scope.invokeTransient("model", { words: ["a"] }, { onDelta: (d) => got.push(d) })
      ),
    });
    const { runtime, definition, runs, types } = setup(runner, {
      authorizer: new GrantTable({ other: ["model"] }),
    });
    const h = await runtime.start(definition, {}, { executionId: "e2" });
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(got).toEqual([]);
    expect(runs.n).toBe(0);
    expect(await types("e2")).not.toContain("DECISION_RECORDED");
  });

  it("NEGATIVE: an engaged kill switch refuses a streamed call — no deltas, no run", async () => {
    const kill = new InMemoryKillSwitch();
    kill.stopAll("halt");
    const got: EffectDelta[] = [];
    const runner: R = async (ctx) => ({
      r: await ctx.decide("pick", (scope) =>
        scope.invokeTransient("model", { words: ["a"] }, { onDelta: (d) => got.push(d) })
      ),
    });
    const { runtime, definition, runs } = setup(runner, { kill });
    const h = await runtime.start(definition, {}, { executionId: "e3" });
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(KillSwitchEngagedError);
    expect(got).toEqual([]);
    expect(runs.n).toBe(0);
  });

  it("per-call isolation: two concurrent calls each see only their own deltas", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const runner: R = async (ctx) => ({
      r: await ctx.decide("pick", async (scope) => {
        await Promise.all([
          scope.invokeTransient(
            "model",
            { words: ["a1", "a2"] },
            { onDelta: (d) => text(d) !== "" && a.push(text(d)) }
          ),
          scope.invokeTransient(
            "model",
            { words: ["b1", "b2"] },
            { onDelta: (d) => text(d) !== "" && b.push(text(d)) }
          ),
        ]);
        return 1;
      }),
    });
    const { runtime, definition } = setup(runner);
    await (await runtime.start(definition, {}, { executionId: "e4" })).waitForCompletion();
    expect(a).toEqual(["a1", "a2"]);
    expect(b).toEqual(["b1", "b2"]);
  });

  it("a throwing sink is swallowed and warned; the call still completes", async () => {
    const runner: R = async (ctx) => ({
      r: await ctx.decide("pick", (scope) =>
        scope.invokeTransient(
          "model",
          { words: ["a", "b"] },
          {
            onDelta: () => {
              throw new Error("sink boom");
            },
          }
        )
      ),
    });
    const { runtime, definition, warns } = setup(runner);
    const h = await runtime.start(definition, {}, { executionId: "e5" });
    await h.waitForCompletion();
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toContain("sink boom");
  });

  it("replay serves the recorded decision: no call, no deltas", async () => {
    const got: EffectDelta[] = [];
    const runner: R = async (ctx) => {
      const r = await ctx.decide("pick", (scope) =>
        scope.invokeTransient("model", { words: ["a"] }, { onDelta: (d) => got.push(d) })
      );
      await ctx.suspend({ on: "go" });
      return { r };
    };
    const { runtime, definition, runs } = setup(runner);
    const h = await runtime.start(definition, {}, { executionId: "e6" });
    await h.waitForSuspend();
    const before = got.length;
    expect([runs.n, before]).toEqual([1, 2]);
    await (await runtime.resume("e6", { eventType: "go", payload: {} })).waitForCompletion();
    expect([runs.n, got.length]).toEqual([1, before]);
  });

  it("abort mid-stream: the decider's signal severs the call, AbortError-shaped rejection, nothing recorded", async () => {
    const ac = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const got: string[] = [];
    const runner: R = async (ctx) => ({
      r: await ctx.decide("pick", (scope) =>
        scope.invokeTransient(
          "model",
          { words: ["a", "b", "c"] },
          {
            signal: ac.signal,
            onDelta: (d) => {
              got.push(text(d));
              if (text(d) === "a")
                queueMicrotask(() => ac.abort(new DOMException("stop", "AbortError")));
            },
          }
        )
      ),
    });
    const { runtime, definition, types } = setup(runner, { gate, honourSignal: true });
    const h = await runtime.start(definition, {}, { executionId: "e7" });
    setTimeout(release, 20);
    await expect(h.waitForCompletion()).rejects.toMatchObject({ name: "AbortError" });
    expect(got).not.toContain("c");
    expect(await types("e7")).not.toContain("DECISION_RECORDED");
  });

  // ── review round 1 ──────────────────────────────────────────────────────────

  /** Run `words` through the scope under `middleware`, collecting what the sink saw. */
  async function streamed(
    id: string,
    words: string[],
    opts: Parameters<typeof setup>[1] = {}
  ): Promise<{ got: EffectDelta[]; outcome: PromiseSettledResult<unknown>; warns: string[] }> {
    const got: EffectDelta[] = [];
    const runner: R = async (ctx) => ({
      r: await ctx.decide("pick", (scope) =>
        scope.invokeTransient("model", { words }, { onDelta: (d) => got.push(d) })
      ),
    });
    const { runtime, definition, warns } = setup(runner, opts);
    const h = await runtime.start(definition, {}, { executionId: id });
    const [outcome] = await Promise.allSettled([h.waitForCompletion()]);
    return { got, outcome, warns };
  }

  it("delta validator: a PII pattern SPLIT across deltas severs the stream before the completing delta is delivered", async () => {
    const { got, outcome } = await streamed("d1", ["hi ", "joe@", "ex.com", " tail"], {
      middleware: [safetyMiddleware({ validators: [piiValidator()] })],
    });
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(SafetyViolationError);
    expect(got.map(text)).toEqual(["hi ", "joe@"]); // "ex.com" completed the email: never delivered
    expect(got.some((d) => d.done === true)).toBe(false);
  });

  it("delta validator: clean text streams in full under the same default config", async () => {
    const { got, outcome } = await streamed("d2", ["all ", "clean"], {
      middleware: [safetyMiddleware({ validators: [piiValidator()] })],
    });
    expect(outcome.status).toBe("fulfilled");
    expect(got.map(text)).toEqual(["all ", "clean", ""]);
  });

  it("FAIL-CLOSED: an output validator with NO delta form refuses the sink; the call still completes non-streamed", async () => {
    const { got, outcome, warns } = await streamed("d3", ["x", "y"], {
      middleware: [safetyMiddleware({ validators: [schemaValidator(z.string())] })],
    });
    expect(got).toEqual([]);
    expect(outcome.status).toBe("fulfilled");
    expect(warns.some((w) => w.includes("streaming disabled"))).toBe(true);
  });

  it("FAIL-CLOSED: one uncovered output validator among covered ones still refuses the sink", async () => {
    const { got, outcome } = await streamed("d4", ["x"], {
      middleware: [safetyMiddleware({ validators: [piiValidator(), schemaValidator(z.string())] })],
    });
    expect(got).toEqual([]);
    expect(outcome.status).toBe("fulfilled");
  });

  it("done is NOT sent when the call fails after the effect finished (middleware output phase)", async () => {
    const failAfter: EffectMiddleware = async (_c, _i, next) => {
      await next();
      throw new Error("output rejected");
    };
    const { got, outcome } = await streamed("d5", ["a", "b"], { middleware: [failAfter] });
    expect(outcome.status).toBe("rejected");
    expect(got.map(text)).toEqual(["a", "b"]);
    expect(got.some((d) => d.done === true)).toBe(false);
  });

  it("retry: a reset chunk precedes the retried attempt, and viewer-side reconstruction equals the decision", async () => {
    let attempt = 0;
    const flaky = new ToolEffect<{ words: string[] }, string>(async (_i, ctx: EffectContext) => {
      attempt++;
      const words = attempt === 1 ? ["bad", "-start"] : ["good", "-end"];
      for (const w of words) ctx.onDelta?.({ delta: tv(w) });
      ctx.onDelta?.({ delta: tv(""), done: true });
      if (attempt === 1) throw new Error("transient");
      return words.join("");
    });
    const got: EffectDelta[] = [];
    let decided: unknown;
    const runner: R = async (ctx) => {
      decided = await ctx.decide("pick", (scope) =>
        scope.invokeTransient("model", { words: [] }, { onDelta: (d) => got.push(d) })
      );
      return { r: decided };
    };
    const { runtime, definition } = setup(runner, {
      effect: flaky,
      middleware: [retryMiddleware({ jitter: false, sleep: async () => {} })],
    });
    await (await runtime.start(definition, {}, { executionId: "d6" })).waitForCompletion();
    expect(got.map((d) => d.reset === true)).toEqual([false, false, true, false, false, false]);
    expect(got.find((d) => d.reset)?.attempt).toBe(2);
    // The viewer: clear on reset, append otherwise.
    let view = "";
    for (const d of got) view = d.reset === true ? "" : view + text(d);
    expect(view).toBe(decided);
    expect(view).toBe("good-end");
    expect(got.filter((d) => d.done === true)).toHaveLength(1); // one terminal, after the success
  });

  it("abort: a signal-IGNORING effect cannot deliver after the signal aborted (the runtime drops it)", async () => {
    const ac = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const got: string[] = [];
    const runner: R = async (ctx) => ({
      r: await ctx.decide("pick", (scope) =>
        scope.invokeTransient(
          "model",
          { words: ["a", "b", "c"] },
          { signal: ac.signal, onDelta: (d) => got.push(text(d)) }
        )
      ),
    });
    const { runtime, definition } = setup(runner, { gate, honourSignal: false });
    const h = await runtime.start(definition, {}, { executionId: "d7" });
    setTimeout(() => ac.abort(new DOMException("stop", "AbortError")), 5); // while parked at "b"
    setTimeout(release, 25);
    await Promise.allSettled([h.waitForCompletion()]);
    expect(got).toEqual(["a", "b"]); // "c" and the terminal chunk were dropped
  });
});
