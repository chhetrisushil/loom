import type { FlowDefinition } from "@loom/core";
import { TypedFailure, fail, step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── DE-4 (ADR 0060) — typed failure channels ─────────────────────────────────
//
// A TypedFailure on a DECLARED `errors:` channel is a first-class domain
// outcome: logged as STEP_FAILED { channel, payload } (payload schema-validated)
// and SUBSTITUTED on replay/re-invocation — the failure twin of the completed
// short-circuit. Undeclared channels degrade to the legacy untyped failure
// (at-least-once re-execution), byte-identically to pre-1.17 behavior (G2).

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;

const DriftPayload = z.object({
  toolName: z.string(),
  observedHash: z.string(),
});

function makeFlow(
  runner: FlowRunner<Record<string, unknown>, Record<string, unknown>>,
  id = "typed-failure-flow"
): RegisteredFlow<Record<string, unknown>, Record<string, unknown>> {
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [],
  };
  return { definition, runner };
}

function boot(register: (effects: EffectRuntime) => void) {
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const effectRuntime = new EffectRuntime();
  register(effectRuntime);
  const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime });
  return { runtime, eventStore, snapshotStore, effectRuntime };
}

/** A step whose contract declares the schemaDrift channel. (`z.unknown()` I/O —
 * ctx.parallel's element type is StepDefinition<unknown, …>.) */
const driftyStep = step$({
  id: "hydrate-widget",
  toolId: "drifty-tool",
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  errors: { schemaDrift: DriftPayload },
});

describe("typed failure channels (DE-4, ADR 0060)", () => {
  it("declared channel: STEP_FAILED carries {channel, payload} and the flow branches on the typed catch", async () => {
    const { runtime, eventStore } = boot((effects) =>
      effects.register(
        "drifty-tool",
        new ToolEffect(async () =>
          fail("schemaDrift", { toolName: "listMetrics", observedHash: "fnv1a64:beef" })
        )
      )
    );

    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      try {
        await ctx.run(driftyStep, {});
        return { branch: "success" };
      } catch (err) {
        if (err instanceof TypedFailure && err.channel === "schemaDrift") {
          return { branch: "repair", payload: err.payload };
        }
        throw err;
      }
    };
    runtime.registerFlow(makeFlow(runner).definition, runner);

    const handle = await runtime.start(makeFlow(runner), {}, { executionId: "typed-1" });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    const events = await eventStore.read("typed-1");
    const failed = events.filter((e) => e.eventType === "STEP_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({
      stepId: "hydrate-widget",
      channel: "schemaDrift",
      payload: { toolName: "listMetrics", observedHash: "fnv1a64:beef" },
    });
    // The frame folds the typed failure (this is what replay substitutes from).
    expect(state.frames["hydrate-widget"]).toMatchObject({
      status: "failed",
      errorChannel: "schemaDrift",
      errorPayload: { toolName: "listMetrics", observedHash: "fnv1a64:beef" },
    });
  });

  it("replay substitution: resuming past a recorded typed failure re-invokes NOTHING and re-takes the same branch", async () => {
    const seen: unknown[] = [];
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      try {
        await ctx.run(driftyStep, {});
        return { branch: "success" };
      } catch (err) {
        if (err instanceof TypedFailure && err.channel === "schemaDrift") {
          seen.push(err.payload);
          const verdict = await (ctx.suspend({ on: "RepairDone" }) as Promise<unknown>);
          return { branch: "repaired", verdict };
        }
        throw err;
      }
    };

    // Run 1: the effect drifts once; the flow catches and parks for repair.
    const stores = boot((effects) =>
      effects.register(
        "drifty-tool",
        new ToolEffect(async () => fail("schemaDrift", { toolName: "t", observedHash: "h1" }))
      )
    );
    stores.runtime.registerFlow(makeFlow(runner).definition, runner);
    const started = await stores.runtime.start(makeFlow(runner), {}, { executionId: "typed-2" });
    await started.waitForSuspend();

    // Run 2: a FRESH runtime over the same log, with an effect that must never run.
    const spy = vi.fn(async () => ({ never: true }));
    const eventStore = stores.eventStore;
    const effectRuntime = new EffectRuntime();
    effectRuntime.register("drifty-tool", new ToolEffect(spy));
    const runtime2 = new WorkflowRuntime({
      eventStore,
      snapshotStore: stores.snapshotStore,
      effectRuntime,
    });
    runtime2.registerFlow(makeFlow(runner).definition, runner);

    seen.length = 0;
    const done = await runtime2.resume("typed-2", {
      eventType: "RepairDone",
      payload: { repaired: true },
    });
    const state = await done.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(spy).not.toHaveBeenCalled(); // zero effect re-invocation on replay
    expect(seen).toEqual([{ toolName: "t", observedHash: "h1" }]); // same branch, same payload
    // No duplicate step events appended by the replay pass.
    const events = await eventStore.read("typed-2");
    expect(events.filter((e) => e.eventType === "STEP_FAILED")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "STEP_STARTED")).toHaveLength(1);
  });

  it("live re-invocation of a typed-failed id substitutes too; a fresh id re-executes (the identity rule)", async () => {
    let calls = 0;
    const { runtime } = boot((effects) =>
      effects.register(
        "drifty-tool",
        new ToolEffect(async () => {
          calls++;
          return fail("schemaDrift", { toolName: "t", observedHash: `h${calls}` });
        })
      )
    );

    const retryStep = step$({
      id: "hydrate-widget#retry:1",
      toolId: "drifty-tool",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      errors: { schemaDrift: DriftPayload },
    });

    const observed: unknown[] = [];
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      for (const step of [driftyStep, driftyStep, retryStep]) {
        try {
          await ctx.run(step, {});
        } catch (err) {
          if (err instanceof TypedFailure) observed.push(err.payload);
        }
      }
      return { done: true };
    };
    runtime.registerFlow(makeFlow(runner).definition, runner);
    const handle = await runtime.start(makeFlow(runner), {}, { executionId: "typed-3" });
    await handle.waitForCompletion();

    // Second call with the SAME id was served from the recorded failure; the
    // deliberately re-minted id ran the effect again.
    expect(calls).toBe(2);
    expect(observed).toEqual([
      { toolName: "t", observedHash: "h1" },
      { toolName: "t", observedHash: "h1" },
      { toolName: "t", observedHash: "h2" },
    ]);
  });

  it("undeclared channel: degrades to the legacy untyped STEP_FAILED and re-executes on re-invocation", async () => {
    let calls = 0;
    const { runtime, eventStore } = boot((effects) =>
      effects.register(
        "drifty-tool",
        new ToolEffect(async () => {
          calls++;
          return fail("somethingElse", { calls });
        })
      )
    );

    // Same step shape but WITHOUT the channel declared.
    const undeclared = step$({
      id: "undeclared-step",
      toolId: "drifty-tool",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    });
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      for (let i = 0; i < 2; i++) {
        try {
          await ctx.run(undeclared, {});
        } catch {
          // swallow and loop — legacy semantics re-execute the same id
        }
      }
      return { done: true };
    };
    runtime.registerFlow(makeFlow(runner).definition, runner);
    const handle = await runtime.start(makeFlow(runner), {}, { executionId: "typed-4" });
    const state = await handle.waitForCompletion();

    expect(calls).toBe(2); // no substitution for untyped failures
    const failed = (await eventStore.read("typed-4")).filter((e) => e.eventType === "STEP_FAILED");
    expect(failed).toHaveLength(2);
    for (const e of failed) {
      expect(e.payload).not.toHaveProperty("channel");
    }
    expect(state.frames["undeclared-step"]).not.toHaveProperty("errorChannel");
  });

  it("schema-invalid payload on a declared channel degrades loudly to an untyped failure", async () => {
    const { runtime, eventStore } = boot((effects) =>
      effects.register(
        "drifty-tool",
        // Payload violates DriftPayload (missing observedHash).
        new ToolEffect(async () => fail("schemaDrift", { toolName: 42 }))
      )
    );
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      try {
        await ctx.run(driftyStep, {});
      } catch {
        return { caught: true };
      }
      return { caught: false };
    };
    runtime.registerFlow(makeFlow(runner).definition, runner);
    const handle = await runtime.start(makeFlow(runner), {}, { executionId: "typed-5" });
    const state = await handle.waitForCompletion();

    const failed = (await eventStore.read("typed-5")).filter((e) => e.eventType === "STEP_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).not.toHaveProperty("channel");
    expect(String((failed[0]?.payload as { error?: unknown }).error)).toContain(
      'channel "schemaDrift" failed validation'
    );
    expect(state.frames["hydrate-widget"]).not.toHaveProperty("errorChannel");
  });

  it("effect-registry fallback: a step without its own errors map inherits the registered effect's channels", async () => {
    const { runtime, eventStore } = boot((effects) =>
      effects.register(
        "drifty-tool",
        new ToolEffect(async () => fail("schemaDrift", { toolName: "t", observedHash: "h" }), {
          errors: { schemaDrift: DriftPayload },
        })
      )
    );
    const bare = step$({
      id: "bare-step",
      toolId: "drifty-tool",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    });
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      try {
        await ctx.run(bare, {});
        return { branch: "success" };
      } catch (err) {
        if (err instanceof TypedFailure) return { branch: "typed" };
        throw err;
      }
    };
    runtime.registerFlow(makeFlow(runner).definition, runner);
    const handle = await runtime.start(makeFlow(runner), {}, { executionId: "typed-6" });
    await handle.waitForCompletion();

    const failed = (await eventStore.read("typed-6")).filter((e) => e.eventType === "STEP_FAILED");
    expect(failed[0]?.payload).toMatchObject({ channel: "schemaDrift" });
  });

  it("ctx.parallel: one branch failing typed rejects the join with the TypedFailure; the sibling settles and is logged", async () => {
    const { runtime, eventStore } = boot((effects) => {
      effects.register(
        "drifty-tool",
        new ToolEffect(async () => fail("schemaDrift", { toolName: "t", observedHash: "h" }))
      );
      effects.register(
        "ok-tool",
        new ToolEffect(async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { ok: true };
        })
      );
    });

    const okStep = step$({
      id: "ok-step",
      toolId: "ok-tool",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
    });
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      try {
        await ctx.parallel([
          [driftyStep, {}],
          [okStep, {}],
        ]);
        return { branch: "success" };
      } catch (err) {
        if (err instanceof TypedFailure && err.channel === "schemaDrift") {
          // The join rejected fail-fast while the sibling was still in flight;
          // it runs to settlement and logs its own terminal event as long as
          // the run is still open. Hold the run open long enough to observe it.
          await new Promise((r) => setTimeout(r, 25));
          return { branch: "typed" };
        }
        throw err;
      }
    };
    runtime.registerFlow(makeFlow(runner).definition, runner);
    const handle = await runtime.start(makeFlow(runner), {}, { executionId: "typed-7" });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe("completed");
    const events = await eventStore.read("typed-7");
    expect(
      events.some(
        (e) =>
          e.eventType === "STEP_FAILED" &&
          (e.payload as { channel?: string }).channel === "schemaDrift"
      )
    ).toBe(true);
    // The in-flight sibling ran to settlement and logged its own terminal event.
    expect(
      events.some(
        (e) =>
          e.eventType === "STEP_COMPLETED" &&
          (e.payload as { stepId?: string }).stepId === "ok-step"
      )
    ).toBe(true);
  });
});
