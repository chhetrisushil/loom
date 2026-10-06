import type { FlowDefinition } from "@loom/core";
import {
  CapabilityDeniedError,
  type EffectContext,
  type EffectDelta,
  EffectRuntime,
  GrantTable,
  ToolEffect,
} from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryKillSwitch, KillSwitchEngagedError, killSwitchMiddleware } from "@loom/middleware";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";

// ADR 0119 — `DecideScope.invokeTransient(tool, input, { onDelta })`: a streaming effect's
// deltas reach THIS call's sink, under exactly the governance of a non-streaming call.

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;
type R = FlowRunner<Record<string, unknown>, Record<string, unknown>>;

/** A stand-in streaming effect: honours ctx.signal, emits per-call deltas, ends with usage. */
class StreamingEffect extends ToolEffect<{ words: string[] }, string> {
  constructor(runs: { n: number }, gate?: Promise<void>) {
    super(async (input: { words: string[] }, ctx: EffectContext) => {
      runs.n++;
      let out = "";
      for (const w of input.words) {
        if (ctx.signal?.aborted === true) throw ctx.signal.reason ?? new Error("aborted");
        out += w;
        ctx.onDelta?.({ delta: w });
        if (gate !== undefined && w === "b") await gate;
      }
      ctx.onDelta?.({ delta: "", done: true, usage: { inputTokens: 2, outputTokens: out.length } });
      return out;
    });
  }
}

function setup(
  runner: R,
  opts: { authorizer?: GrantTable; kill?: InMemoryKillSwitch; gate?: Promise<void> } = {}
) {
  const eventStore = new InMemoryAsyncEventStore();
  const runs = { n: 0 };
  const warns: string[] = [];
  const effects = new EffectRuntime(
    opts.kill !== undefined ? [killSwitchMiddleware(opts.kill)] : [],
    {
      ...(opts.authorizer !== undefined && { authorizer: opts.authorizer }),
      onWarn: (m) => warns.push(m),
    }
  );
  effects.register("model", new StreamingEffect(runs, opts.gate));
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
    expect(got).toEqual([
      { delta: "a" },
      { delta: "b" },
      { delta: "c" },
      { delta: "", done: true, usage: { inputTokens: 2, outputTokens: 3 } },
    ]);
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
            { onDelta: (d) => d.delta !== "" && a.push(d.delta) }
          ),
          scope.invokeTransient(
            "model",
            { words: ["b1", "b2"] },
            { onDelta: (d) => d.delta !== "" && b.push(d.delta) }
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
              got.push(d.delta);
              if (d.delta === "a")
                queueMicrotask(() => ac.abort(new DOMException("stop", "AbortError")));
            },
          }
        )
      ),
    });
    const { runtime, definition, types } = setup(runner, { gate });
    const h = await runtime.start(definition, {}, { executionId: "e7" });
    setTimeout(release, 20);
    await expect(h.waitForCompletion()).rejects.toMatchObject({ name: "AbortError" });
    expect(got).not.toContain("c");
    expect(await types("e7")).not.toContain("DECISION_RECORDED");
  });
});
