import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, HumanEffect, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { recoverAbandoned } from "./recoverAbandoned";
import {
  ApprovalRejectedError,
  EFFECT_INDOUBT_RESOLVED,
  ResumePayloadValidationError,
  ResumeRefusedError,
} from "./types";
import type { FlowRunner } from "./types";

// ── ADR 0104 — every `_resumePayloads` entry answers exactly one suspend point ──
//
// A gate passthrough is positional: the i-th suspend point in a re-run is served entry i.
// So any resume recorded as an entry that no suspend point consumes is served to the NEXT
// gate as its answer. Three writers did that besides recovery: an in-doubt verdict (the
// park is thrown from `ctx.run`, never `ctx.suspend`), a HumanEffect step's answer (same),
// and `resumeAs` onto a terminal execution (nothing was parked at all).

const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;
const stepA = step$({ id: "a", name: "A", toolId: "tool-a", inputSchema: io, outputSchema: io });
const stepB = step$({ id: "b", name: "B", toolId: "tool-b", inputSchema: io, outputSchema: io });
const human = step$({ id: "h", name: "H", toolId: "human", inputSchema: io, outputSchema: io });

type Stores = { eventStore: InMemoryAsyncEventStore; snapshotStore: InMemoryAsyncSnapshotStore };
const never = () =>
  new Promise<Record<string, unknown>>(() => {
    /* the worker that owned this effect is gone */
  });
const tick = () => new Promise((r) => setTimeout(r, 20));
const types = async (s: Stores, id: string) =>
  (await s.eventStore.read(id)).map((e: EventEnvelope) => e.eventType);

function boot(opts: {
  shared?: Stores;
  runner: FlowRunner<Record<string, unknown>, Record<string, unknown>>;
  steps: ReturnType<typeof step$>[];
  tool?: () => Promise<Record<string, unknown>>;
  toolB?: () => Promise<Record<string, unknown>>;
  idempotentA?: boolean;
  resumeSchemas?: FlowDefinition["resumeSchemas"];
  id?: string;
}) {
  const calls = { a: 0 };
  const effects = new EffectRuntime();
  effects.register(
    "tool-a",
    new ToolEffect(
      async () => {
        calls.a++;
        return (opts.tool ?? (async () => ({ ok: true })))();
      },
      opts.idempotentA === undefined ? {} : { idempotent: opts.idempotentA }
    )
  );
  effects.register("tool-b", new ToolEffect(opts.toolB ?? (async () => ({ ok: true }))));
  effects.register("human", new HumanEffect({ on: "Approve" }));
  const stores: Stores = opts.shared ?? {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  const runtime = new WorkflowRuntime({ ...stores, effectRuntime: effects, onWarn: () => {} });
  const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
    _tag: "FlowDefinition",
    id: opts.id ?? "f",
    name: "f",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: opts.steps,
    ...(opts.resumeSchemas !== undefined && { resumeSchemas: opts.resumeSchemas }),
  };
  runtime.registerFlow(definition, opts.runner);
  return { runtime, stores, calls, flow: { definition, runner: opts.runner } };
}

describe("in-doubt verdicts answer the in-doubt park only (ADR 0104)", () => {
  const seen: unknown[] = [];
  const gated: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
    seen.length = 0;
    await ctx.run(stepA, {});
    seen.push(await ctx.suspend<unknown>({ on: "go1" }));
    return {};
  };

  /** Crash in non-idempotent step a, recover → parked in doubt. */
  async function parkedInDoubt(extra: Partial<Parameters<typeof boot>[0]> = {}) {
    const first = boot({
      runner: gated,
      steps: [stepA],
      idempotentA: false,
      tool: never,
      ...extra,
    });
    void first.runtime.start(first.flow, {}, { executionId: "e" });
    await tick();
    const second = boot({
      ...extra,
      runner: gated,
      steps: [stepA],
      idempotentA: false,
      shared: first.stores,
    });
    await recoverAbandoned(second.runtime, {
      source: first.stores.eventStore,
      isAbandoned: () => true,
    });
    const parked = await second.runtime.loadState("e");
    expect(parked?.suspendedOn?.on).toBe(EFFECT_INDOUBT_RESOLVED);
    return first.stores;
  }

  it("a verdict does not become go1's approval — go1 still needs its own resume and schema", async () => {
    const resumeSchemas = { go1: z.object({ approved: z.literal(true) }) };
    const stores = await parkedInDoubt({ resumeSchemas });
    const rt = boot({
      runner: gated,
      steps: [stepA],
      idempotentA: false,
      shared: stores,
      resumeSchemas,
    });
    const h = await rt.runtime.resume("e", {
      eventType: EFFECT_INDOUBT_RESOLVED,
      payload: { stepId: "a", resolution: "completed-with-result", output: { ok: 2 } },
    });
    const state = await h.waitForSuspend();
    expect(state.suspendedOn?.on).toBe("go1");
    expect(state.frames.a?.status).toBe("completed");
    expect(state.variables._resumePayloads).toBeUndefined();
    expect(seen).toEqual([]);

    await expect(rt.runtime.resume("e", { eventType: "go1", payload: {} })).rejects.toBeInstanceOf(
      ResumePayloadValidationError
    );
    const done = await rt.runtime.resume("e", { eventType: "go1", payload: { approved: true } });
    expect((await done.waitForCompletion()).status).toBe("completed");
    expect(seen).toEqual([{ approved: true }]);
  });

  it("a stale retry-fresh verdict does not re-run the tool after a SECOND crash — it re-parks", async () => {
    const stores = await parkedInDoubt();
    const retrying = boot({
      runner: gated,
      steps: [stepA],
      idempotentA: false,
      tool: never,
      shared: stores,
    });
    void retrying.runtime.resume("e", {
      eventType: EFFECT_INDOUBT_RESOLVED,
      payload: { stepId: "a", resolution: "retry-fresh" },
    });
    await tick();
    expect(retrying.calls.a).toBe(1); // the sanctioned retry — and it crashed too

    const third = boot({ runner: gated, steps: [stepA], idempotentA: false, shared: stores });
    const summary = await recoverAbandoned(third.runtime, {
      source: stores.eventStore,
      isAbandoned: () => true,
    });
    expect(summary.recovered).toBe(1);
    expect(third.calls.a).toBe(0); // NOT a silent third call
    const state = await third.runtime.loadState("e");
    expect(state?.suspendedOn?.on).toBe(EFFECT_INDOUBT_RESOLVED);
    const log = await types(stores, "e");
    expect(log.filter((t) => t === "EFFECT_INDOUBT")).toHaveLength(2);
  });

  it("a payload that is not a verdict for the parked step is refused, with nothing appended", async () => {
    const stores = await parkedInDoubt();
    const rt = boot({ runner: gated, steps: [stepA], idempotentA: false, shared: stores });
    const before = (await stores.eventStore.read("e")).length;
    for (const payload of [{ stepId: "zzz", resolution: "retry-fresh" }, { note: "later" }, null]) {
      await expect(
        rt.runtime.resume("e", { eventType: EFFECT_INDOUBT_RESOLVED, payload })
      ).rejects.toBeInstanceOf(ResumePayloadValidationError);
    }
    expect((await stores.eventStore.read("e")).length).toBe(before);
    expect((await rt.runtime.loadState("e"))?.suspendedOn?.on).toBe(EFFECT_INDOUBT_RESOLVED);
    expect(rt.calls.a).toBe(0);
  });
});

describe("a HumanEffect step consumes its own answer (ADR 0104)", () => {
  const seen: unknown[] = [];
  const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
    seen.length = 0;
    seen.push(await ctx.run(human, {}));
    seen.push(await ctx.suspend<unknown>({ on: "go1" }));
    seen.push(await ctx.suspend<unknown>({ on: "go2" }));
    return {};
  };

  it("the human step completes with its answer; go1 is not answered by it", async () => {
    const { runtime, stores, flow } = boot({ runner, steps: [human] });
    const parked = await (await runtime.start(flow, {}, { executionId: "e" })).waitForSuspend();
    expect(parked.suspendedOn?.on).toBe("Approve");
    // W2-0: the commit-site strip keeps a KERNEL-built human park's `stepId` (ADR 0104 attribution).
    expect((parked.suspendedOn as { stepId?: string } | undefined)?.stepId).toBeDefined();

    const afterHuman = await (
      await runtime.resume("e", { eventType: "Approve", payload: { by: "alice" } })
    ).waitForSuspend();
    expect(afterHuman.suspendedOn?.on).toBe("go1");
    expect(afterHuman.frames.h?.status).toBe("completed");
    expect(seen).toEqual([{ by: "alice" }]);

    // A replay past the COMPLETED human step still skips its entry: go1 gets ITS payload.
    const afterGo1 = await (
      await runtime.resume("e", { eventType: "go1", payload: { n: 1 } })
    ).waitForSuspend();
    expect(afterGo1.suspendedOn?.on).toBe("go2");
    expect(seen).toEqual([{ by: "alice" }, { n: 1 }]);

    const fresh = boot({ runner, steps: [human], shared: stores });
    const done = await fresh.runtime.resume("e", { eventType: "go2", payload: { n: 2 } });
    expect((await done.waitForCompletion()).status).toBe("completed");
    expect(seen).toEqual([{ by: "alice" }, { n: 1 }, { n: 2 }]);
  });
});

describe("resumeAs onto a terminal execution (ADR 0104)", () => {
  const recover: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
    try {
      await ctx.run(stepA, {});
    } catch {
      /* fixed code tolerates a */
    }
    await ctx.run(stepB, {});
    await ctx.suspend({ on: "go1" });
    return {};
  };
  const original: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
    await ctx.run(stepA, {});
    return {};
  };

  it("re-opens it (status running) without answering a gate, and a crash after is recoverable", async () => {
    const first = boot({
      runner: original,
      steps: [stepA],
      tool: async () => {
        throw new Error("boom");
      },
    });
    await (await first.runtime.start(first.flow, {}, { executionId: "x" }))
      .waitForCompletion()
      .catch(() => {});
    expect((await first.runtime.loadState("x"))?.status).toBe("failed");

    const fixer = boot({
      runner: recover,
      steps: [stepA, stepB],
      toolB: never,
      shared: first.stores,
      id: "f2",
    });
    fixer.runtime.registerFlow(first.flow.definition, original);
    void fixer.runtime.resumeAs(
      "x",
      "f2",
      { eventType: "Fix", payload: { smuggled: true } },
      {
        strategy: "operator-ack",
      }
    );
    await tick();
    const mid = await fixer.runtime.loadState("x");
    expect(mid?.status).toBe("running"); // re-opened
    expect(mid?.variables._resumePayloads).toBeUndefined(); // …answering nothing

    const rescuer = boot({
      runner: recover,
      steps: [stepA, stepB],
      shared: first.stores,
      id: "f2",
    });
    rescuer.runtime.registerFlow(first.flow.definition, original);
    const summary = await recoverAbandoned(rescuer.runtime, {
      source: first.stores.eventStore,
      isAbandoned: () => true,
    });
    expect(summary.recovered).toBe(1);
    expect((await rescuer.runtime.loadState("x"))?.suspendedOn?.on).toBe("go1");
  });
});

// ── Fix round 2 ────────────────────────────────────────────────────────────────

describe("the reserved `__loom_` decision namespace (ADR 0104)", () => {
  it("flow code cannot record a decision under it — ctx.decide or ctx.emit", async () => {
    const attempts: string[] = [];
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      try {
        await ctx.decide("__loom_indoubt__:a:1", () => ({
          stepId: "a",
          resolution: "completed-with-result",
          output: { forged: true },
        }));
      } catch (e) {
        attempts.push(`decide: ${(e as Error).message}`);
      }
      try {
        ctx.emit("DECISION_RECORDED", { decisionId: "__loom_anything", choice: 1 });
      } catch (e) {
        attempts.push(`emit: ${(e as Error).message}`);
      }
      await ctx.decide("ordinary", () => 1); // not reserved: fine
      return {};
    };
    const { runtime, stores, flow } = boot({ runner, steps: [] });
    await (await runtime.start(flow, {}, { executionId: "e" })).waitForCompletion();
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.includes("__loom_"))).toBe(true);
    const decisions = (await stores.eventStore.read("e"))
      .filter((e) => e.eventType === "DECISION_RECORDED")
      .map((e) => (e.payload as { decisionId: string }).decisionId);
    expect(decisions).toEqual(["ordinary"]);
  });

  it("a verdict decision with no EFFECT_INDOUBT fact for that attempt is not a verdict", async () => {
    // A verdict written straight into the log BEFORE the step was ever in doubt (the shape
    // ctx.decide could forge before the namespace was closed). The reader demands the kernel's
    // own in-doubt fact for the same step and attempt.
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      await ctx.run(stepA, {});
      return {};
    };
    const first = boot({ runner, steps: [stepA], idempotentA: false, tool: never });
    await first.stores.eventStore.append({
      id: "e-0",
      workflowId: "f",
      executionId: "e",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: Date.now(),
      payload: { input: {} },
    });
    await first.stores.eventStore.append({
      id: "e-1",
      workflowId: "f",
      executionId: "e",
      eventType: "DECISION_RECORDED",
      sequence: 1,
      timestamp: Date.now(),
      payload: {
        decisionId: "__loom_indoubt__:a:1",
        choice: { stepId: "a", resolution: "completed-with-result", output: { forged: true } },
        source: "operator",
      },
    });
    await first.stores.eventStore.append({
      id: "e-2",
      workflowId: "f",
      executionId: "e",
      eventType: "STEP_STARTED",
      sequence: 2,
      timestamp: Date.now(),
      payload: { stepId: "a", input: {} },
    });
    const second = boot({ runner, steps: [stepA], idempotentA: false, shared: first.stores });
    await recoverAbandoned(second.runtime, {
      source: first.stores.eventStore,
      isAbandoned: () => true,
    });
    const state = await second.runtime.loadState("e");
    expect(state?.suspendedOn?.on).toBe(EFFECT_INDOUBT_RESOLVED);
    expect(state?.frames.a?.status).toBe("running");
  });
});

describe("pre-0104 human-step logs are refused, not guessed (ADR 0104)", () => {
  const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
    await ctx.run(human, {});
    await ctx.suspend({ on: "go1" });
    return {};
  };
  async function legacy(types: Array<[string, unknown]>) {
    const { runtime, stores } = boot({ runner, steps: [human] });
    let sequence = 0;
    for (const [eventType, payload] of types) {
      sequence++;
      await stores.eventStore.append({
        id: `e-${sequence}`,
        workflowId: "f",
        executionId: "e",
        eventType,
        sequence,
        timestamp: Date.now(),
        payload,
      });
    }
    return { runtime, stores };
  }
  const park = ["EXECUTION_SUSPENDED", { condition: { on: "Approve" } }] as [string, unknown];
  const startH = ["STEP_STARTED", { stepId: "h", input: {} }] as [string, unknown];

  it("a human step the old kernel re-parked after an answer: refused, nothing appended", async () => {
    const { runtime, stores } = await legacy([
      ["EXECUTION_STARTED", { input: {} }],
      startH,
      park,
      ["Approve", { by: "alice" }],
      ["EXECUTION_RESUMED", { by: "alice" }],
      startH,
      park,
    ]);
    const before = (await stores.eventStore.read("e")).length;
    const err = await runtime
      .resume("e", { eventType: "Approve", payload: { by: "bob" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumeRefusedError);
    expect((err as ResumeRefusedError).reason).toBe("ambiguous-legacy-answers");
    expect((await stores.eventStore.read("e")).length).toBe(before);
  });

  it("a pre-0104 recovery {} before an open human park: refused (it would become the answer)", async () => {
    const { runtime } = await legacy([
      ["EXECUTION_STARTED", { input: {} }],
      ["EXECUTION_RECOVERED", {}],
      ["EXECUTION_RESUMED", {}],
      startH,
      park,
    ]);
    await expect(
      runtime.resume("e", { eventType: "Approve", payload: { by: "bob" } })
    ).rejects.toBeInstanceOf(ResumeRefusedError);
  });

  it("a clean pre-0104 human park (parked once, never answered) resumes normally", async () => {
    const { runtime } = await legacy([["EXECUTION_STARTED", { input: {} }], startH, park]);
    const h = await runtime.resume("e", { eventType: "Approve", payload: { by: "bob" } });
    const state = await h.waitForSuspend();
    expect(state.suspendedOn?.on).toBe("go1");
    expect(state.frames.h?.output).toEqual({ by: "bob" });
  });
});

describe("resumeAs onto a gate-parked execution answers THAT gate, under its rules (ADR 0104)", () => {
  const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
    await ctx.suspend({ on: "go1" });
    return {};
  };
  const resumeSchemas = { go1: z.object({ approved: z.literal(true) }) };

  it("refuses another event name, checks go1's schema, and runs the authenticator", async () => {
    const { runtime, flow } = boot({ runner, steps: [], resumeSchemas });
    await (await runtime.start(flow, {}, { executionId: "x" })).waitForSuspend();
    const ack = { strategy: "operator-ack" as const };

    const renamed = await runtime
      .resumeAs("x", "f", { eventType: "Other", payload: {} }, ack)
      .catch((e: unknown) => e);
    expect(renamed).toBeInstanceOf(ResumeRefusedError);
    expect((renamed as ResumeRefusedError).reason).toBe("gate-mismatch");

    await expect(
      runtime.resumeAs("x", "f", { eventType: "go1", payload: {} }, ack)
    ).rejects.toBeInstanceOf(ResumePayloadValidationError);

    const h = await runtime.resumeAs(
      "x",
      "f",
      { eventType: "go1", payload: { approved: true } },
      ack
    );
    expect((await h.waitForCompletion()).status).toBe("completed");
  });

  it("a rejecting ResumeAuthenticator refuses resumeAs exactly as it refuses resume", async () => {
    const effects = new EffectRuntime();
    const stores = {
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    };
    const runtime = new WorkflowRuntime({
      ...stores,
      effectRuntime: effects,
      resumeAuthenticator: {
        verify: () => ({ status: "rejected", reason: "unsigned" }),
      },
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
    await (await runtime.start({ definition, runner }, {}, { executionId: "x" })).waitForSuspend();
    await expect(
      runtime.resumeAs("x", "f", { eventType: "go1", payload: {} }, { strategy: "operator-ack" })
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
  });
});

describe("a terminal execution with an unspent pre-0104 stray warns when resumeAs re-opens it", () => {
  it("warns at-risk on the reopen", async () => {
    const warnings: string[] = [];
    const effects = new EffectRuntime();
    const eventStore = new InMemoryAsyncEventStore();
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
      onWarn: (m) => warnings.push(m),
    });
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      await ctx.suspend({ on: "go1" });
      return {};
    };
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
    const ev = (sequence: number, eventType: string, payload: unknown) => ({
      id: `x-${sequence}`,
      workflowId: "f",
      executionId: "x",
      eventType,
      sequence,
      timestamp: Date.now(),
      payload,
    });
    await eventStore.append(ev(1, "EXECUTION_STARTED", { input: {} }));
    await eventStore.append(ev(2, "EXECUTION_RECOVERED", {}));
    await eventStore.append(ev(3, "EXECUTION_RESUMED", {}));
    await eventStore.append(ev(4, "EXECUTION_FAILED", { error: "boom" }));
    const h = await runtime.resumeAs(
      "x",
      "f",
      { eventType: "Fix", payload: {} },
      {
        strategy: "operator-ack",
      }
    );
    await h.waitForCompletion().catch(() => undefined);
    expect(warnings.some((w) => w.includes("NOT yet spent"))).toBe(true);
  });
});
