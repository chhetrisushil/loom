import { step$ } from "@loomwork/core";
import type { EventEnvelope, FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import {
  InMemoryAsyncEventStore,
  InMemoryLeaseStore,
  brandPayloadShredded,
} from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { orphanCensus } from "./orphanCensus";
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

  /**
   * Erased executions listed BEFORE the abandoned one: each read throws the branded
   * PayloadShreddedError a decrypting store raises once the subject's key is destroyed, carrying the
   * redacted view (status is plaintext), as `EncryptingEventStore` does.
   */
  async function withErased(
    stores: Stores,
    erased: Record<string, "running" | "completed">,
    shredLater?: { id: string; now: () => boolean }
  ) {
    const raw = stores.eventStore;
    const views = new Map<string, EventEnvelope[]>();
    for (const [id, status] of Object.entries(erased)) {
      const evs: EventEnvelope[] = [
        {
          id: `${id}-0`,
          workflowId: "guarded",
          executionId: id,
          eventType: "EXECUTION_STARTED",
          sequence: 0,
          timestamp: 1,
          payload: { input: {} },
        },
      ];
      if (status === "completed") {
        evs.push({
          ...evs[0]!,
          id: `${id}-1`,
          eventType: "EXECUTION_COMPLETED",
          sequence: 1,
          payload: { output: { ok: true } },
        });
      }
      for (const e of evs) await raw.append(e);
      views.set(id, evs);
    }
    const shredded = (redacted: EventEnvelope[]) =>
      brandPayloadShredded(
        Object.assign(new Error("shredded"), { name: "PayloadShreddedError", redacted })
      );
    const erasing = Object.create(raw) as InMemoryAsyncEventStore;
    erasing.read = async (id: string, ...rest: unknown[]) => {
      const view = views.get(id);
      if (view !== undefined) throw shredded(view);
      if (shredLater?.id === id && shredLater.now()) {
        throw shredded(await (raw.read as (i: string) => Promise<EventEnvelope[]>)(id));
      }
      return (raw.read as (i: string, ...r: unknown[]) => Promise<EventEnvelope[]>)(id, ...rest);
    };
    // The re-drive bookkeeping reads a RANGE of the log, not the whole stream.
    for (const m of ["readFrom", "readRange"] as const) {
      const orig = (raw as unknown as Record<string, unknown>)[m];
      if (typeof orig !== "function") continue;
      (erasing as unknown as Record<string, unknown>)[m] = async (
        id: string,
        ...rest: unknown[]
      ) => {
        if (shredLater?.id === id && shredLater.now()) {
          throw shredded(await (raw.read as (i: string) => Promise<EventEnvelope[]>)(id));
        }
        return (orig as (...a: unknown[]) => unknown).call(raw, id, ...rest);
      };
    }
    const appended: string[] = [];
    erasing.append = async (e: EventEnvelope) => {
      appended.push(e.executionId);
      return raw.append(e);
    };
    return { erasing, appended };
  }

  it("ERASED executions listed first are skipped and the pass recovers the ones after them; one left RUNNING is reported, a finished one is silent", async () => {
    const { stores, executionId } = await abandonOne();
    expect("aa-erased" < executionId && "aa-done" < executionId).toBe(true);
    const { erasing, appended } = await withErased(stores, {
      "aa-erased": "running",
      "aa-done": "completed",
    });
    const b = boot({ shared: { eventStore: erasing, snapshotStore: stores.snapshotStore } });
    const errors: Array<[string, string]> = [];
    const summary = await recoverAbandoned(b.runtime, {
      source: erasing,
      isAbandoned: () => true,
      onError: (id, err) => errors.push([id, (err as Error).name]),
    });
    expect(summary.recovered).toBe(1);
    expect(summary.failed).toBe(0); // erased is not a failure: there is nothing to recover
    expect(summary.erasedNotTerminal).toBe(1);
    expect(errors).toEqual([["aa-erased", "ErasedNotTerminalError"]]);
    expect((await b.runtime.loadState(executionId))?.status).toBe("completed");
    expect(appended.filter((id) => id.startsWith("aa-"))).toEqual([]); // nothing written to them
    expect(await b.runtime.erasedStatus("aa-done")).toBe("completed");
  });

  it("an execution erased MID-PASS (after its load) is skipped too, not the end of the pass", async () => {
    const { stores, executionId } = await abandonOne();
    let shred = false;
    const { erasing } = await withErased(stores, {}, { id: executionId, now: () => shred });
    const b = boot({ shared: { eventStore: erasing, snapshotStore: stores.snapshotStore } });
    const summary = await recoverAbandoned(b.runtime, {
      source: erasing,
      maxRecoveries: 3,
      isAbandoned: () => {
        shred = true; // the shred lands between the load and the re-drive bookkeeping
        return true;
      },
    });
    expect(summary).toMatchObject({ recovered: 0, failed: 0, erasedNotTerminal: 1 });
  });

  it("orphanCensus counts an erased non-terminal execution apart and keeps counting past it", async () => {
    const { stores } = await abandonOne();
    const { erasing } = await withErased(stores, {
      "aa-erased": "running",
      "aa-done": "completed",
    });
    const b = boot({ shared: { eventStore: erasing, snapshotStore: stores.snapshotStore } });
    const census = await orphanCensus(b.runtime.systemStateReader(), { source: erasing });
    expect(census.scanned).toBe(3);
    expect(census.inFlight).toBe(1); // the abandoned one, listed after both erased ones
    expect(census.erasedNotTerminal).toEqual({ count: 1, sample: ["aa-erased"] });
  });

  it("an UNBRANDED store failure still aborts the pass (only erasure is skipped)", async () => {
    const { stores } = await abandonOne();
    const raw = stores.eventStore;
    const failing = Object.create(raw) as InMemoryAsyncEventStore;
    failing.read = async () => {
      throw Object.assign(new Error("disk gone"), { name: "PayloadShreddedError" }); // name only
    };
    const b = boot({ shared: { eventStore: failing, snapshotStore: stores.snapshotStore } });
    await expect(
      recoverAbandoned(b.runtime, { source: failing, isAbandoned: () => true })
    ).rejects.toThrow("disk gone");
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

// ── L28: lease expiry is judged on the clock that stamped it ─────────────────
describe("recoverAbandoned lease clock (L28)", () => {
  it("does not re-drive a live lease under a simulated clock, and does once sim passes expiry", async () => {
    let sim = 1000;
    const leases = new InMemoryLeaseStore({ now: () => sim });
    const { stores, executionId } = await abandonOne();
    // A healthy holder somewhere else: expiry = 1000 + 60000 on the SIM clock.
    expect(await leases.acquire(executionId, "holder", 60_000)).not.toBeNull();

    const b = boot({ shared: stores });
    const pass = () =>
      recoverAbandoned(b.runtime, {
        leases: { store: leases, owner: "rec", ttlMs: 60_000 },
      });

    const live = await pass();
    expect(live.candidates).toBe(0);
    expect(live.recovered).toBe(0);
    expect(b.ran).toEqual([]);

    sim = 62_000;
    const after = await pass();
    expect(after.candidates).toBe(1);
    expect(after.recovered).toBe(1);
  });
});
