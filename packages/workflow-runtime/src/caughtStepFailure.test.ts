import { StorageWriteError, fail, step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
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
// `recoverAbandoned` skipped and `cancel` refused: unrecoverable and unstoppable. A parallel
// sibling failing AFTER the flow parked did the same to a suspended execution: its gate could
// no longer be resumed. Only `EXECUTION_FAILED` — which the kernel commits when the failure
// escapes the runner — is the execution's failure.

const io = { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
const Outage = z.object({ code: z.number() });
// `errors: { outage }` declares the typed channel the `typed: true` boots fail on. It does NOT
// make the default boots typed: their tool throws a plain `Error`, which is an UNTYPED failure
// (no channel) and keeps the legacy at-least-once re-execution — only `fail("outage", …)` is
// recorded with a channel and substituted on replay.
const stepFlaky = step$({
  id: "flaky",
  name: "Flaky",
  toolId: "tool-flaky",
  ...io,
  errors: { outage: Outage },
});
const stepB = step$({ id: "b", name: "B", toolId: "tool-b", ...io });
const stepC = step$({ id: "c", name: "C", toolId: "tool-c", ...io });

interface Stores {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
}

/** An event store whose disk refuses one event type (and, like a real one, nothing after it). */
class Refuses extends InMemoryAsyncEventStore {
  readonly refusal = new Error("disk full");
  constructor(private readonly refusedType: string) {
    super();
  }
  override async append(envelope: EventEnvelope): Promise<void> {
    if (envelope.eventType === this.refusedType) throw this.refusal;
    return super.append(envelope);
  }
  override async appendBatch(envelopes: readonly EventEnvelope[]): Promise<void> {
    if (envelopes.some((e) => e.eventType === this.refusedType)) throw this.refusal;
    return super.appendBatch(envelopes);
  }
}

/**
 * `catches: true` wraps the failing step in try/catch and carries on; `false` lets it escape.
 * `typed: true` fails it on the declared `outage` channel (ADR 0060) instead of throwing.
 * `gated: true` strands the run inside `b` forever — what a SIGKILLed supervisor leaves.
 * Recovery is driven by a SECOND boot over the same stores (a different process).
 */
function boot(opts: {
  shared?: Stores;
  gated?: boolean;
  catches: boolean;
  typed?: boolean;
  snapshotEvery?: number;
  eventStore?: InMemoryAsyncEventStore;
}) {
  const ran: string[] = [];
  const effects = new EffectRuntime();
  effects.register(
    "tool-flaky",
    new ToolEffect(async () => {
      ran.push("flaky");
      if (opts.typed) fail("outage", { code: 503 });
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
    eventStore: opts.eventStore ?? new InMemoryAsyncEventStore(),
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

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

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

  it("a TYPED caught failure recovers without re-invoking the failed effect", async () => {
    const a = boot({ gated: true, catches: true, typed: true });
    void a.runtime.start(a.flow, {}, { executionId: "typed-crash" });
    await settle();
    expect((await a.runtime.loadState("typed-crash"))?.status).toBe("running");

    const b = boot({ shared: a.stores, catches: true, typed: true });
    const summary = await recoverAbandoned(b.runtime, {
      source: b.stores.eventStore,
      isAbandoned: () => true,
    });
    expect(summary.recovered).toBe(1);
    expect((await b.runtime.loadState("typed-crash"))?.status).toBe("completed");
    // The recorded typed failure is SUBSTITUTED on replay (ADR 0060): the flow re-takes its
    // catch branch and the tool is never called again.
    expect(b.ran).toEqual(["b", "c"]);
  });

  it("a mid-run snapshot taken after the catch records `running`, and recovery through it completes", async () => {
    // snapshotEvery: 1 checkpoints after every event; the latest one lands after STEP_STARTED(b),
    // past the STEP_FAILED — so its stored status is whatever the fold said after the catch.
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

  it("a snapshot saved by a pre-1.21.0 fold (status `failed`, no `_error`) is read as running and recovered", async () => {
    const a = boot({ gated: true, catches: true });
    void a.runtime.start(a.flow, {}, { executionId: "legacy-snap" });
    await settle();
    const live = await a.runtime.loadState("legacy-snap");
    if (live === null) throw new Error("no state");
    // Hand-built: exactly what the old fold stored for this log.
    await a.stores.snapshotStore.save({
      id: "legacy",
      executionId: "legacy-snap",
      workflowId: live.workflowId,
      sequence: live.sequence,
      state: { ...live, status: "failed" },
      createdAt: Date.now(),
    });

    const b = boot({ shared: a.stores, catches: true });
    expect((await b.runtime.loadState("legacy-snap"))?.status).toBe("running");
    const summary = await recoverAbandoned(b.runtime, {
      source: b.stores.eventStore,
      isAbandoned: () => true,
    });
    expect(summary.recovered).toBe(1);
    expect((await b.runtime.loadState("legacy-snap"))?.status).toBe("completed");
  });

  it("restoreFromState repairs a preloaded pre-1.21.0 state the same way", async () => {
    const a = boot({ gated: true, catches: true });
    void a.runtime.start(a.flow, {}, { executionId: "legacy-restore" });
    await settle();
    const live = await a.runtime.loadState("legacy-restore");
    if (live === null) throw new Error("no state");

    const b = boot({ shared: a.stores, catches: true });
    const handle = await b.runtime.restoreFromState({ ...live, status: "failed" });
    // Seen at once, before the re-run settles: the preloaded fold is read as what it was.
    const seen = handle.getState().status;
    await handle.waitForCompletion();
    expect(seen).toBe("running");
    expect((await b.runtime.loadState("legacy-restore"))?.status).toBe("completed");
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

  it("an escaped failure whose EXECUTION_FAILED is not durable rejects with StorageWriteError, not the step's error", async () => {
    const eventStore = new Refuses("EXECUTION_FAILED");
    const a = boot({ catches: false, eventStore });
    const handle = await a.runtime.start(a.flow, {}, { executionId: "undurable" });
    const err = await handle.waitForCompletion().then(
      () => undefined,
      (e: unknown) => e
    );
    // The caller must not be told "failed": the log ends at the step failure, which folds
    // `running`, so a recovery pass would re-drive it.
    expect(err).toBeInstanceOf(StorageWriteError);
    expect((err as StorageWriteError).cause).toBe(eventStore.refusal);
    expect((await a.runtime.loadState("undurable"))?.status).toBe("running");
    // D4: the handle and `onEvent` are the IN-MEMORY view — the EXECUTION_FAILED was committed
    // (folded, published) before its write failed — while the log, which recovery reads, folds
    // `running`. The rejection is what tells the caller which one is durable.
    expect(handle.getState().status).toBe("failed");
  });
});

/** A flow whose parallel sibling fails AFTER the flow parks on `Approval`. */
function parkedBoot() {
  const effects = new EffectRuntime();
  effects.register(
    "tool-slow",
    new ToolEffect(async () => {
      await settle(30);
      throw new Error("late boom");
    })
  );
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const slow = step$({ id: "slow", name: "slow", toolId: "tool-slow", ...io });
  const definition: FlowDefinition<Record<string, never>, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id: "par",
    name: "par",
    version: "1.0.0",
    inputSchema: io.inputSchema,
    outputSchema: io.outputSchema,
    steps: [slow],
  };
  const runner: FlowRunner<Record<string, never>, { ok: boolean }> = async (ctx) => {
    const [, answer] = await Promise.all([
      ctx.run(slow, {}).catch(() => "caught"),
      ctx.suspend<{ ok: boolean }>({ on: "Approval" }),
    ]);
    return answer;
  };
  runtime.registerFlow(definition, runner);
  return { runtime, eventStore, flow: { definition, runner } };
}

describe("a parallel sibling that fails after the flow parked (ADR 0105)", () => {
  it("the execution stays suspended on its gate, and the gate can still be answered", async () => {
    const { runtime, eventStore, flow } = parkedBoot();
    const handle = await runtime.start(flow, {}, { executionId: "late" });
    await handle.waitForSuspend();
    await settle(80); // the sibling fails after the park

    const types = (await eventStore.read("late")).map((e) => e.eventType);
    expect(types.indexOf("STEP_FAILED")).toBeGreaterThan(types.indexOf("EXECUTION_SUSPENDED"));
    const parked = await runtime.loadState("late");
    expect(parked?.status).toBe("suspended");
    expect(parked?.suspendedOn?.on).toBe("Approval");

    const resumed = await runtime.resume("late", { eventType: "Approval", payload: { ok: true } });
    await expect(resumed.waitForCompletion()).resolves.toMatchObject({ status: "completed" });
  });
});

describe("the documented cost of the fail-closed rule (ADR 0105 D3)", () => {
  it("an explicit null answer to a gate whose sibling failed while parked re-parks the gate; the next answer lands", async () => {
    const { runtime, flow } = parkedBoot();
    const handle = await runtime.start(flow, {}, { executionId: "null-answer" });
    await handle.waitForSuspend();
    await settle(80); // the sibling fails after the park

    const nulled = await runtime.resume("null-answer", { eventType: "Approval", payload: null });
    const reparked = await nulled.waitForSuspend();
    expect(reparked.status).toBe("suspended");
    expect(reparked.suspendedOn?.on).toBe("Approval");
    // The null was status-only: it is not recorded as any gate's answer.
    expect(reparked.variables._resumePayloads).toBeUndefined();

    const answered = await runtime.resume("null-answer", {
      eventType: "Approval",
      payload: { ok: true },
    });
    await expect(answered.waitForCompletion()).resolves.toMatchObject({
      status: "completed",
      variables: { _output: { ok: true } },
    });
  });
});

describe("recoverAbandoned `maxRecoveries` (ADR 0105)", () => {
  async function strandedWithRecoveries(n: number) {
    const a = boot({ gated: true, catches: true });
    void a.runtime.start(a.flow, {}, { executionId: "poison" });
    await settle();
    // Earlier passes' re-drives, as they sit in the log.
    const log = await a.stores.eventStore.read("poison");
    const last = log[log.length - 1] as EventEnvelope;
    for (let i = 1; i <= n; i++) {
      await a.stores.eventStore.append({
        ...last,
        id: `poison-r${i}`,
        eventType: "EXECUTION_RECOVERED",
        sequence: last.sequence + i,
        payload: {},
      });
    }
    return a;
  }

  it("skips and reports an execution already re-driven `maxRecoveries` times", async () => {
    const a = await strandedWithRecoveries(2);
    const b = boot({ shared: a.stores, catches: true });
    const exhausted: Array<[string, number]> = [];
    const summary = await recoverAbandoned(b.runtime, {
      source: b.stores.eventStore,
      isAbandoned: () => true,
      maxRecoveries: 2,
      onExhausted: (id, n) => exhausted.push([id, n]),
    });
    expect(summary).toMatchObject({ candidates: 1, exhausted: 1, recovered: 0 });
    expect(exhausted).toEqual([["poison", 2]]);
    expect(b.ran).toEqual([]);
  });

  it("recovers below the bound, and the default stays unbounded", async () => {
    const a = await strandedWithRecoveries(2);
    const b = boot({ shared: a.stores, catches: true });
    const summary = await recoverAbandoned(b.runtime, {
      source: b.stores.eventStore,
      isAbandoned: () => true,
      maxRecoveries: 3,
    });
    expect(summary).toMatchObject({ exhausted: 0, recovered: 1 });

    const c = await strandedWithRecoveries(5);
    const d = boot({ shared: c.stores, catches: true });
    expect(
      await recoverAbandoned(d.runtime, { source: d.stores.eventStore, isAbandoned: () => true })
    ).toMatchObject({ exhausted: 0, recovered: 1 });
  });

  it("counts CONSECUTIVE re-drives without progress: recoveries that each moved on never exhaust", async () => {
    const a = boot({ gated: true, catches: true });
    void a.runtime.start(a.flow, {}, { executionId: "healthy" });
    await settle();
    // A long-lived execution recovered three times over its life, each re-drive completing work.
    let seq = (await a.stores.eventStore.read("healthy")).at(-1)?.sequence ?? 0;
    const base = (await a.stores.eventStore.read("healthy"))[0] as EventEnvelope;
    for (let i = 0; i < 3; i++) {
      for (const [eventType, payload] of [
        ["EXECUTION_RECOVERED", {}],
        ["STEP_COMPLETED", { stepId: `w${i}`, output: {} }],
      ] as const) {
        seq++;
        await a.stores.eventStore.append({
          ...base,
          id: `h-${seq}`,
          eventType,
          sequence: seq,
          payload,
        });
      }
    }
    const b = boot({ shared: a.stores, catches: true });
    const summary = await recoverAbandoned(b.runtime, {
      source: b.stores.eventStore,
      isAbandoned: () => true,
      maxRecoveries: 2,
    });
    expect(summary).toMatchObject({ exhausted: 0, recovered: 1 });
  });

  it("is checked only for claimed candidates: a live execution the predicate declines is never reported", async () => {
    const a = await strandedWithRecoveries(3);
    const b = boot({ shared: a.stores, catches: true });
    const exhausted: string[] = [];
    const summary = await recoverAbandoned(b.runtime, {
      source: b.stores.eventStore,
      isAbandoned: () => false,
      maxRecoveries: 1,
      onExhausted: (id) => exhausted.push(id),
    });
    expect(summary).toMatchObject({ candidates: 1, exhausted: 0, recovered: 0 });
    expect(exhausted).toEqual([]);
  });

  it("two REAL passes over a poison execution produce the count the third pass stops at", async () => {
    // The store refuses the step's failure record (as Postgres jsonb refuses a \u0000 in an
    // error text): every run dies with StorageWriteError, the log never records a terminal
    // outcome, and the execution stays `running` — the re-drive that crashes the same way forever.
    const store = new Refuses("STEP_FAILED");
    const a = boot({ catches: true, eventStore: store });
    const first = await a.runtime.start(a.flow, {}, { executionId: "poison-real" });
    await expect(first.waitForCompletion()).rejects.toBeInstanceOf(StorageWriteError);
    expect((await a.runtime.loadState("poison-real"))?.status).toBe("running");

    const pass = () => {
      const node = boot({ shared: a.stores, catches: true });
      const exhausted: Array<[string, number]> = [];
      return recoverAbandoned(node.runtime, {
        source: store,
        isAbandoned: () => true,
        maxRecoveries: 2,
        onExhausted: (id, n) => exhausted.push([id, n]),
      }).then((summary) => ({ summary, exhausted }));
    };
    expect((await pass()).summary).toMatchObject({ recovered: 1, exhausted: 0 });
    expect((await pass()).summary).toMatchObject({ recovered: 1, exhausted: 0 });
    const third = await pass();
    expect(third.summary).toMatchObject({ recovered: 0, exhausted: 1 });
    expect(third.exhausted).toEqual([["poison-real", 2]]);
    const recovered = (await store.read("poison-real")).filter(
      (e) => e.eventType === "EXECUTION_RECOVERED"
    );
    expect(recovered).toHaveLength(2);
  });

  it("refuses a malformed bound, including 0 (it would skip everything)", async () => {
    const a = boot({ catches: true });
    for (const maxRecoveries of [-1, 0, 1.5]) {
      await expect(
        recoverAbandoned(a.runtime, {
          source: a.stores.eventStore,
          isAbandoned: () => true,
          maxRecoveries,
        })
      ).rejects.toThrow(/integer ≥ 1/);
    }
  });
});
