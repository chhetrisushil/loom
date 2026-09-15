import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryLeaseStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { type RecoverAbandonedOptions, recoverAbandoned } from "./recoverAbandoned";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── Recovering executions whose SUPERVISOR died (ADR 0004 amendment) ──────────
//
// ADR 0004 covers a dead worker: the dispatcher notices and redispatches. These tests cover
// the case it cannot — the process holding the dispatcher is gone, so the execution sits
// `running` in the log with nobody on it, indistinguishable from one that is healthy
// elsewhere. Hence the required predicate.

const io = { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
const stepA = step$({ id: "a", name: "A", toolId: "tool-a", ...io });
const stepB = step$({ id: "b", name: "B", toolId: "tool-b", ...io });
const stepC = step$({ id: "c", name: "C", toolId: "tool-c", ...io });

/**
 * A runtime over (optionally shared) stores. `gated: true` makes the middle step block
 * forever, so a run parks mid-flight exactly the way a SIGKILLed supervisor parks one:
 * durable events, status "running", and nothing alive that will ever finish it.
 *
 * Recovery is then driven by a SECOND boot over the SAME stores — a different process,
 * which is the only honest way to test this. Sharing only the stores (never the runtime or
 * the effects) mirrors `t1-schedules.test.ts`.
 */
function boot(opts: { shared?: Stores; gated?: boolean } = {}) {
  const ran: string[] = [];
  const gate = new Promise<void>(() => {
    /* never resolves — the abandoned worker is gone, not merely slow */
  });

  const effects = new EffectRuntime();
  effects.register(
    "tool-a",
    new ToolEffect(async () => {
      ran.push("a");
      return { ok: true };
    })
  );
  effects.register(
    "tool-b",
    new ToolEffect(async () => {
      ran.push("b");
      if (opts.gated) await gate;
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
  });

  const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => {
    await ctx.run(stepA, {});
    await ctx.run(stepB, {});
    return ctx.run(stepC, {});
  };
  const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id: "guarded",
    name: "guarded",
    version: "1.0.0",
    inputSchema: io.inputSchema,
    outputSchema: io.outputSchema,
    steps: [stepA, stepB, stepC],
  };
  const flow: RegisteredFlow<Record<string, never>, { ok: boolean }> = { definition, runner };
  runtime.registerFlow(definition, runner);

  return { runtime, flow, ran, stores, eventStore: stores.eventStore };
}

interface Stores {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
}

/**
 * Process A: start a run, let it commit `a`, and strand it inside `b` forever. Returns the
 * shared stores so a fresh process can be booted over them.
 */
async function abandonOne() {
  const a = boot({ gated: true });
  const executionId = "abandoned-1";
  // Deliberately not awaited, and never released — this is what a killed supervisor leaves.
  void a.runtime.start(a.flow, {}, { executionId });
  await settle();
  expect((await a.runtime.loadState(executionId))?.status).toBe("running");
  return { a, executionId, stores: a.stores };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("recoverAbandoned", () => {
  it("refuses without `isAbandoned` — the decision cannot be defaulted", async () => {
    const { runtime, eventStore } = boot();
    await expect(
      recoverAbandoned(runtime, { source: eventStore } as unknown as RecoverAbandonedOptions)
    ).rejects.toThrow(/`isAbandoned` is required/);
  });

  it("never asks about executions that are not running", async () => {
    const h = boot();
    const handle = await h.runtime.start(h.flow, {}, { executionId: "done-1" });
    await handle.waitForCompletion();

    const asked: string[] = [];
    const summary = await recoverAbandoned(h.runtime, {
      source: h.eventStore,
      isAbandoned: (c) => {
        asked.push(c.executionId);
        return true;
      },
    });

    // A completed execution is scanned but never a candidate — so even a predicate as blunt
    // as `() => true` cannot re-drive finished work.
    expect(asked).toEqual([]);
    expect(summary.scanned).toBe(1);
    expect(summary.candidates).toBe(0);
    expect(summary.recovered).toBe(0);
  });

  it("a false predicate leaves an abandoned execution alone", async () => {
    const { stores, executionId } = await abandonOne();
    const b = boot({ shared: stores }); // a fresh process over the same log
    const summary = await recoverAbandoned(b.runtime, {
      source: b.eventStore,
      isAbandoned: () => false,
    });
    expect(summary.candidates).toBe(1);
    expect(summary.recovered).toBe(0);
    expect(b.ran).toEqual([]);
    expect((await b.runtime.loadState(executionId))?.status).toBe("running");
  });

  it("a second process resumes it without re-running committed steps", async () => {
    const { a, stores, executionId } = await abandonOne();
    // Process A is still stranded in `b` and never will not be. Everything below happens in
    // a brand-new process that never saw the run start — only the log and an id.
    const b = boot({ shared: stores });

    const seen: number[] = [];
    const summary = await recoverAbandoned(b.runtime, {
      source: b.eventStore,
      isAbandoned: (c) => {
        seen.push(c.updatedAt);
        return true;
      },
    });

    expect(summary.recovered).toBe(1);
    expect(summary.failed).toBe(0);
    expect((await b.runtime.loadState(executionId))?.status).toBe("completed");
    // The candidate carries real folded data — what a staleness rule needs.
    expect(seen[0]).toBeGreaterThan(0);
    // THE POINT: `a` committed in process A and is served from the log, so process B never
    // runs it. Only the interrupted step `b` re-executes — the at-least-once ADR 0004
    // already accepts — plus the tail `c` that had never run at all.
    expect(b.ran).toEqual(["b", "c"]);
    expect(a.ran).toEqual(["a", "b"]);
  });

  // ── dryRun — the preview runs through the pass, not beside it ──────────────
  //
  // `loom retention` shipped the other arrangement once: a preview computed alongside the
  // real pass, which skipped a guard the pass applied and therefore promised an outcome the
  // run would not deliver. These assert the preview cannot drift, because it IS the pass.

  it("selects the same executions but changes nothing", async () => {
    const { stores, executionId } = await abandonOne();
    const b = boot({ shared: stores });
    const before = (await b.eventStore.read(executionId)).length;

    const seen: string[] = [];
    const summary = await recoverAbandoned(b.runtime, {
      source: b.eventStore,
      isAbandoned: () => true,
      dryRun: true,
      onCandidate: (id) => seen.push(id),
    });

    expect(seen).toEqual([executionId]); // found it
    expect(summary.candidates).toBe(1);
    expect(summary.recovered).toBe(0); // ...and left it alone
    expect(b.ran).toEqual([]); // no effect ran
    expect((await b.eventStore.read(executionId)).length).toBe(before); // no event appended
    expect((await b.runtime.loadState(executionId))?.status).toBe("running");
  });

  it("does not CLAIM during a preview — a dry run must not fence the real pass out", async () => {
    const { stores, executionId } = await abandonOne();
    const b = boot({ shared: stores });
    const leases = new InMemoryLeaseStore();

    await recoverAbandoned(b.runtime, {
      source: b.eventStore,
      isAbandoned: () => true,
      leases: { store: leases, owner: "preview", ttlMs: 60_000 },
      dryRun: true,
    });

    // Nothing owns it, so the recovery that follows can take it. A preview that claimed
    // would lock an execution for a ttl on behalf of a pass that never ran.
    const taken = await leases.acquire(executionId, "real-pass", 60_000);
    expect(taken).not.toBeNull();
  });

  it("bounds a preview by `limit` — `recovered` never rises, so it cannot be the bound", async () => {
    const a = boot({ gated: true });
    for (let i = 0; i < 3; i++) void a.runtime.start(a.flow, {}, { executionId: `d-${i}` });
    await settle();

    const b = boot({ shared: a.stores });
    const seen: string[] = [];
    const summary = await recoverAbandoned(b.runtime, {
      source: b.eventStore,
      isAbandoned: () => true,
      dryRun: true,
      limit: 2,
      onCandidate: (id) => seen.push(id),
    });
    expect(seen).toHaveLength(2);
    expect(summary.candidates).toBe(2);
  });

  it("honours `limit`", async () => {
    const a = boot({ gated: true });
    for (let i = 0; i < 3; i++) void a.runtime.start(a.flow, {}, { executionId: `e-${i}` });
    await settle();

    const b = boot({ shared: a.stores });
    const summary = await recoverAbandoned(b.runtime, {
      source: b.eventStore,
      isAbandoned: () => true,
      limit: 2,
    });
    expect(summary.recovered).toBe(2);
  });
});
