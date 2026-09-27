import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { recoverAbandoned } from "./recoverAbandoned";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── ADR 0105 — a step failure the flow catches is not the execution's failure ──
//
// `STEP_FAILED` used to fold the EXECUTION status to "failed". A flow that caught the
// failure (try/catch around `ctx.run`, a saga compensation, a typed-failure fallback) kept
// running under a status that read terminal, so a crash after the catch left an execution
// `recoverAbandoned` skipped and `cancel` refused: unrecoverable and unstoppable. Only
// `EXECUTION_FAILED` — which the kernel commits when the failure escapes the runner — is the
// execution's failure.

const io = { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
const stepFlaky = step$({ id: "flaky", name: "Flaky", toolId: "tool-flaky", ...io });
const stepB = step$({ id: "b", name: "B", toolId: "tool-b", ...io });
const stepC = step$({ id: "c", name: "C", toolId: "tool-c", ...io });

interface Stores {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
}

/**
 * `catches: true` wraps the failing step in try/catch and carries on; `false` lets it escape.
 * `gated: true` strands the run inside `b` forever — what a SIGKILLed supervisor leaves.
 * Recovery is driven by a SECOND boot over the same stores (a different process).
 */
function boot(opts: {
  shared?: Stores;
  gated?: boolean;
  catches: boolean;
  snapshotEvery?: number;
}) {
  const ran: string[] = [];
  const effects = new EffectRuntime();
  effects.register(
    "tool-flaky",
    new ToolEffect(async () => {
      ran.push("flaky");
      throw new Error("downstream 503");
    })
  );
  effects.register(
    "tool-b",
    new ToolEffect(async () => {
      ran.push("b");
      if (opts.gated) await new Promise<void>(() => {});
      return { ok: true };
    })
  );
  effects.register(
    "tool-c",
    new ToolEffect(async () => {
      ran.push("c");
      return { ok: true };
    })
  );

  const stores: Stores = opts.shared ?? {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  const runtime = new WorkflowRuntime({
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    effectRuntime: effects,
    ...(opts.snapshotEvery !== undefined && { snapshotEvery: opts.snapshotEvery }),
  });

  const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => {
    if (opts.catches) {
      try {
        await ctx.run(stepFlaky, {});
      } catch {
        // fall back — the flow decided this failure is not fatal
      }
    } else {
      await ctx.run(stepFlaky, {});
    }
    await ctx.run(stepB, {});
    return ctx.run(stepC, {});
  };
  const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id: "catching",
    name: "catching",
    version: "1.0.0",
    inputSchema: io.inputSchema,
    outputSchema: io.outputSchema,
    steps: [stepFlaky, stepB, stepC],
  };
  const flow: RegisteredFlow<Record<string, never>, { ok: boolean }> = { definition, runner };
  runtime.registerFlow(definition, runner);
  return { runtime, flow, ran, stores };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("a caught step failure is not the execution's failure (ADR 0105)", () => {
  it("a flow that catches a failed step reads `running` while it carries on", async () => {
    const a = boot({ gated: true, catches: true });
    void a.runtime.start(a.flow, {}, { executionId: "caught-live" });
    await settle();

    const state = await a.runtime.loadState("caught-live");
    // The step's own frame still records its failure…
    expect(state?.frames.flaky?.status).toBe("failed");
    // …but the execution is alive, and says so.
    expect(state?.status).toBe("running");
    expect(a.ran).toEqual(["flaky", "b"]);
  });

  it("a crash after the catch is recovered by `recoverAbandoned` and runs to completion", async () => {
    const a = boot({ gated: true, catches: true });
    void a.runtime.start(a.flow, {}, { executionId: "caught-crash" });
    await settle();

    const b = boot({ shared: a.stores, catches: true });
    const summary = await recoverAbandoned(b.runtime, {
      source: b.stores.eventStore,
      isAbandoned: () => true,
    });
    expect(summary).toMatchObject({ candidates: 1, recovered: 1, failed: 0 });

    const final = await b.runtime.loadState("caught-crash");
    expect(final?.status).toBe("completed");
    expect(final?.variables._output).toEqual({ ok: true });
    // The untyped failure re-executes on replay (legacy at-least-once), is caught again, and
    // the run carries on from the step the crash stranded.
    expect(b.ran).toEqual(["flaky", "b", "c"]);
  });

  it("a mid-run snapshot taken after the catch records `running`, and recovery through it completes", async () => {
    // snapshotEvery: 1 checkpoints right after STEP_FAILED — the snapshot that used to carry the
    // bogus terminal status into every later load.
    const a = boot({ gated: true, catches: true, snapshotEvery: 1 });
    void a.runtime.start(a.flow, {}, { executionId: "caught-snap" });
    await settle();
    expect((await a.stores.snapshotStore.loadLatest("caught-snap"))?.state.status).toBe("running");

    const b = boot({ shared: a.stores, catches: true });
    const summary = await recoverAbandoned(b.runtime, {
      source: b.stores.eventStore,
      isAbandoned: () => true,
    });
    expect(summary.recovered).toBe(1);
    expect((await b.runtime.loadState("caught-snap"))?.status).toBe("completed");
  });

  it("a crashed execution that caught a failure can still be cancelled", async () => {
    const a = boot({ gated: true, catches: true });
    void a.runtime.start(a.flow, {}, { executionId: "caught-cancel" });
    await settle();

    // A different process has no live handle, so cancel folds the log to decide.
    const b = boot({ shared: a.stores, catches: true });
    expect(await b.runtime.cancel("caught-cancel", "operator")).toBe(true);
    expect((await b.runtime.loadState("caught-cancel"))?.status).toBe("cancelled");
  });

  it("negative: a failure that escapes the runner still folds to `failed` and is never re-driven", async () => {
    const a = boot({ catches: false });
    const handle = await a.runtime.start(a.flow, {}, { executionId: "escaped" });
    await expect(handle.waitForCompletion()).rejects.toThrow(/downstream 503/);

    const events = await a.stores.eventStore.read("escaped");
    expect(events.map((e) => e.eventType).slice(-2)).toEqual(["STEP_FAILED", "EXECUTION_FAILED"]);
    const state = await a.runtime.loadState("escaped");
    expect(state?.status).toBe("failed");
    expect(state?.variables._error).toMatch(/downstream 503/);

    const asked: string[] = [];
    const summary = await recoverAbandoned(a.runtime, {
      source: a.stores.eventStore,
      isAbandoned: (c) => {
        asked.push(c.executionId);
        return true;
      },
    });
    expect(asked).toEqual([]);
    expect(summary).toMatchObject({ candidates: 0, recovered: 0 });
    expect(await a.runtime.cancel("escaped")).toBe(false);
  });
});
