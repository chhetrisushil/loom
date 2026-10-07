import { flowContentHash, legacyFlowContentHash, step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { SuspendError } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { DivergenceMode } from "./DivergenceGuard";
import { WorkflowRuntime, orphanedFrames } from "./WorkflowRuntime";
import { settle } from "./__tests__/r2Harness";
import { recoverAbandoned } from "./recoverAbandoned";
import {
  FlowCodeMismatchError,
  FlowDivergenceError,
  FlowMigrationCheckError,
  FlowReplayDivergenceError,
} from "./types";
import type { FlowRunner } from "./types";

// ── R7 (ADR 0113) — body-aware fingerprint, replay-divergence detection, step families ──────────
//
// A flow is a function re-run from the top on every resume. These tests edit the BODY of a flow over
// an existing log (the structural hash is unchanged: same ids, same declared steps) and assert what the
// kernel does before anything new runs under it.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const A = step$({ id: "A", name: "A", toolId: "count", ...io });
const B = step$({ id: "B", name: "B", toolId: "count", ...io });
const C = step$({ id: "C", name: "C", toolId: "count", ...io });
const FLOW = "agent";

type Body = FlowRunner<unknown, unknown>;

interface Rig {
  store: InMemoryAsyncEventStore;
  snapshots: InMemoryAsyncSnapshotStore;
  /** A runtime over the shared stores, registered with `body` (a deploy). */
  deploy(
    body: Body,
    opts?: {
      mode?: DivergenceMode;
      fingerprint?: string;
      compatibleWith?: string[];
      stepFamilies?: (string | RegExp)[];
      steps?: (typeof A)[];
      extra?: Record<string, unknown>;
      deps?: Record<string, unknown>;
      /** Replaces the `count` tool's behaviour (e.g. to fail once). */
      tool?: (id: string) => unknown;
      /** A runtime with its OWN empty snapshot store: it folds the whole log. */
      freshSnapshots?: boolean;
    }
  ): { rt: WorkflowRuntime; ran: string[]; warnings: string[]; def: FlowDefinition };
}

function rig(existing?: InMemoryAsyncEventStore): Rig {
  const store = existing ?? new InMemoryAsyncEventStore();
  const snapshots = new InMemoryAsyncSnapshotStore();
  return {
    store,
    snapshots,
    deploy(body, opts = {}) {
      const ran: string[] = [];
      const warnings: string[] = [];
      const effects = new EffectRuntime();
      effects.register(
        "count",
        new ToolEffect(async (i: unknown) => {
          const id = String((i as { id?: string } | undefined)?.id ?? "?");
          ran.push(id);
          if (opts.tool !== undefined) return opts.tool(id) ?? i;
          return i;
        })
      );
      const rt = new WorkflowRuntime({
        eventStore: store,
        snapshotStore: opts.freshSnapshots === true ? new InMemoryAsyncSnapshotStore() : snapshots,
        effectRuntime: effects,
        onWarn: (m) => warnings.push(m),
        ...(opts.mode !== undefined && { divergence: opts.mode }),
        ...(opts.deps as object),
      });
      const def = {
        _tag: "FlowDefinition",
        id: FLOW,
        name: FLOW,
        version: "1.0.0",
        ...io,
        steps: opts.steps ?? [A, B],
        ...(opts.fingerprint !== undefined && { codeFingerprint: opts.fingerprint }),
        ...(opts.compatibleWith !== undefined && { compatibleWith: opts.compatibleWith }),
        ...(opts.stepFamilies !== undefined && { stepFamilies: opts.stepFamilies }),
      } as unknown as FlowDefinition;
      rt.registerFlow(def, body);
      return { rt, ran, warnings, def };
    },
  };
}

const run = (ctx: Parameters<Body>[0], s: typeof A) => ctx.run(s, { id: s.id });

/** v1: A, B, then park on "go". */
const v1: Body = async (ctx) => {
  await run(ctx, A);
  await run(ctx, B);
  await ctx.suspend({ on: "go" });
  return { done: true };
};

async function parkedOnV1(r: Rig, opts?: Parameters<Rig["deploy"]>[1]) {
  const d = r.deploy(v1, opts);
  const h = await d.rt.start({ definition: d.def, runner: v1 }, {}, { executionId: "x" });
  await h.waitForSuspend();
  return d;
}

const kindsOf = async (r: Rig): Promise<string[]> =>
  (await r.store.read("x")).map((e: EventEnvelope) => e.eventType);

/** Resume `x` on a redeployed `body`; resolves to the handle's rejection or its final state. */
async function resumeOn(
  r: Rig,
  body: Body,
  opts?: Parameters<Rig["deploy"]>[1]
): Promise<{ outcome: unknown; ran: string[]; warnings: string[]; before: number }> {
  const before = (await r.store.read("x")).length;
  const d = r.deploy(body, opts);
  const h = await d.rt.resume("x", { eventType: "go", payload: {} });
  const outcome = await settle(h).then(
    () => h.getState(),
    (e: unknown) => e
  );
  const rejected = await h.waitForCompletion().then(
    (s) => s,
    (e: unknown) => e
  );
  return {
    outcome: rejected instanceof Error ? rejected : outcome,
    ran: d.ran,
    warnings: d.warnings,
    before,
  };
}

/**
 * What the log gained after the resume's own bootstrap (the resume event and its answer), WITHOUT
 * the kernel's refusal park on the reserved gate (asserted on its own).
 */
async function appendedByBody(r: Rig, before: number): Promise<string[]> {
  const all = (await r.store.read("x")).slice(before);
  return all
    .filter((e) => !(e.eventType === "EXECUTION_SUSPENDED" && isDivergedPark(e)))
    .map((e) => e.eventType)
    .filter((k) => k !== "EXECUTION_RESUMED" && k !== "go");
}

function isDivergedPark(e: EventEnvelope): boolean {
  return (e.payload as { condition?: { on?: string } }).condition?.on === "__loom_diverged__";
}

describe("D3 — a diverged body is refused BEFORE its first live append, whatever the kind", () => {
  it("a step: the edit skips recorded A and starts C — C's effect never runs, nothing is appended", async () => {
    const r = rig();
    await parkedOnV1(r);
    const v2: Body = async (ctx) => {
      await run(ctx, C); // A and B were recorded; the new body does not ask for them
      return { done: true };
    };
    const { outcome, ran, before } = await resumeOn(r, v2, { mode: "fail" });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect(outcome).toBeInstanceOf(FlowDivergenceError);
    expect((outcome as FlowReplayDivergenceError).skippedSteps).toEqual(["A", "B"]);
    expect((outcome as FlowReplayDivergenceError).beforeEvent).toBe("STEP_STARTED");
    expect(ran).toEqual([]); // the NEGATIVE: the effect was not invoked
    expect(await appendedByBody(r, before)).toEqual([]); // no STEP_STARTED, no EXECUTION_FAILED
  });

  it("a decide is NOT judged (its decider is transient): the next step is refused before its effect", async () => {
    const r = rig();
    await parkedOnV1(r);
    let decided = 0;
    const v2: Body = async (ctx) => {
      await ctx.decide("route", () => {
        decided++;
        return "x";
      });
      await run(ctx, C);
      return { done: true };
    };
    const { outcome, ran, before } = await resumeOn(r, v2, { mode: "fail" });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect((outcome as FlowReplayDivergenceError).beforeEvent).toBe("STEP_STARTED");
    expect(decided).toBe(1); // documented: a decider may run under a diverged body
    expect(ran).toEqual([]); // but no step's effect does
    expect(await appendedByBody(r, before)).toEqual(["DECISION_RECORDED"]);
  });

  it("a caught decider failure on an UNCHANGED body is not refused (fix round 1, P1-1)", async () => {
    const r = rig();
    const flaky: Body = async (ctx) => {
      try {
        await ctx.decide("route", () => {
          throw new Error("model down");
        });
      } catch {
        /* fall back */
      }
      await run(ctx, A);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const d = r.deploy(flaky, { mode: "fail" });
    await (
      await d.rt.start({ definition: d.def, runner: flaky }, {}, { executionId: "x" })
    ).waitForSuspend();
    const { outcome, warnings } = await resumeOn(r, flaky, { mode: "fail" });
    expect((outcome as { status: string }).status).toBe("completed");
    expect(warnings).toEqual([]);
  });

  it("an emit is NOT judged: the next step is refused before its effect", async () => {
    const r = rig();
    await parkedOnV1(r);
    const v2: Body = async (ctx) => {
      ctx.emit("tick", { n: 1 });
      await run(ctx, C);
      return { done: true };
    };
    const { outcome, ran, before } = await resumeOn(r, v2, { mode: "fail" });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect((outcome as FlowReplayDivergenceError).beforeEvent).toBe("STEP_STARTED");
    expect(ran).toEqual([]);
    expect(await appendedByBody(r, before)).toEqual(["tick"]);
  });

  it("a re-appended emit before a recorded step on an UNCHANGED body is not refused (fix round 1, P1-2)", async () => {
    // An untyped failure makes every later emit non-provable, so it re-appends on every re-run.
    const r = rig();
    let first = true;
    const failOnce = (id: string): unknown => {
      if (id === "C" && first) {
        first = false;
        throw new Error("C fails untyped");
      }
      return undefined;
    };
    const body: Body = async (ctx) => {
      try {
        await run(ctx, C);
      } catch {
        /* carry on */
      }
      ctx.emit("progress", { n: 1 });
      await run(ctx, A);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const d = r.deploy(body, { mode: "fail", tool: failOnce });
    await (
      await d.rt.start({ definition: d.def, runner: body }, {}, { executionId: "x" })
    ).waitForSuspend();
    const { outcome, warnings } = await resumeOn(r, body, { mode: "fail" });
    expect((outcome as { status: string }).status).toBe("completed");
    expect(warnings).toEqual([]);
  });

  it("a park: the new body suspends somewhere else first — no EXECUTION_SUSPENDED is written", async () => {
    const r = rig();
    await parkedOnV1(r);
    const v2: Body = async (ctx) => {
      await ctx.suspend({ on: "go" }); // consumes the resume's answer
      await ctx.suspend({ on: "elsewhere" }); // a NEW park the log never had
      return { done: true };
    };
    const { outcome, before } = await resumeOn(r, v2, { mode: "fail" });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect((outcome as FlowReplayDivergenceError).beforeEvent).toBe("EXECUTION_SUSPENDED");
    expect(await appendedByBody(r, before)).toEqual([]);
  });

  it("a timer: sleep parks with a wake time — refused like any park", async () => {
    const r = rig();
    await parkedOnV1(r);
    const v2: Body = async (ctx) => {
      await ctx.suspend({ on: "go" }); // consumes the resume's answer
      await ctx.sleep(60_000);
      return { done: true };
    };
    const { outcome, before } = await resumeOn(r, v2, { mode: "fail" });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect((outcome as FlowReplayDivergenceError).beforeEvent).toBe("EXECUTION_SUSPENDED");
    expect(await appendedByBody(r, before)).toEqual([]);
  });

  it("completion: a body that returns without asking for a recorded step is refused at the end", async () => {
    const r = rig();
    await parkedOnV1(r);
    const v2: Body = async () => ({ done: "early" }); // appends nothing live until it completes
    const { outcome, before } = await resumeOn(r, v2, { mode: "fail" });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect((outcome as FlowReplayDivergenceError).beforeEvent).toBe("EXECUTION_COMPLETED");
    expect(await appendedByBody(r, before)).toEqual([]);
  });

  it("a continuation: no successor is started under a diverged body", async () => {
    const r = rig();
    await parkedOnV1(r, { deps: { continueAsNewEnabled: true } });
    const v2: Body = async (ctx) => ctx.continueAsNew({ gen: 1 });
    const { outcome, before } = await resumeOn(r, v2, {
      mode: "fail",
      deps: { continueAsNewEnabled: true },
    });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect((outcome as FlowReplayDivergenceError).beforeEvent).toBe("EXECUTION_CONTINUED");
    expect(await appendedByBody(r, before)).toEqual([]);
    expect(await r.store.read("x~1")).toEqual([]); // the successor was never started
  });

  it("a body that SWALLOWS the refusal stays refused, even after it visits every recorded step (the failure latches)", async () => {
    const r = rig();
    await parkedOnV1(r);
    const v2: Body = async (ctx) => {
      try {
        await run(ctx, C); // refused: A and B were not asked for yet
      } catch {
        /* the flow author catches everything */
      }
      await run(ctx, A); // now every recorded step has been visited...
      await run(ctx, B);
      await ctx.suspend({ on: "go" }); // ...but this run already diverged
      return { done: true };
    };
    const { outcome, ran, before } = await resumeOn(r, v2, { mode: "fail" });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect(ran).toEqual([]);
    expect(await appendedByBody(r, before)).toEqual([]);
  });
});

describe("D3 — a decision served from the log exempts EXACTLY the steps its decider ran", () => {
  // `agentLoop$` runs `ctx.execute({ id: "a#skills:select" })` INSIDE `ctx.decide("a#skills")`: on a
  // re-run the decision is served, the decider never runs, and its frame is never asked for. The
  // record carries `innerSteps` (kernel-stamped), so exactly those are exempt and nothing else.
  const inner = { _tag: "TaskDefinition", kind: "tool", id: "d#inner", toolId: "count" } as const;
  const viaDecider = async (ctx: Parameters<Body>[0]): Promise<void> => {
    await ctx.decide("d", async () => {
      await ctx.execute(inner, { id: "inner" });
      return "picked";
    });
  };

  it("the record carries the decider's steps, kernel-stamped", async () => {
    const r = rig();
    const body: Body = async (ctx) => {
      await viaDecider(ctx);
      await ctx.suspend({ on: "go" });
      return {};
    };
    const d = r.deploy(body, { mode: "fail" });
    await (
      await d.rt.start({ definition: d.def, runner: body }, {}, { executionId: "x" })
    ).waitForSuspend();
    const rec = (await r.store.read("x")).find((e) => e.eventType === "DECISION_RECORDED");
    expect((rec?.payload as { innerSteps?: string[] }).innerSteps).toEqual(["d#inner"]);
    expect(rec?.metadata?.kernel).toBe(true);
    const st = await d.rt.loadState("x");
    expect(
      (st?.variables._decisions as Record<string, { innerSteps?: string[] }>).d?.innerSteps
    ).toEqual(["d#inner"]);
  });

  it("an unchanged body whose decider ran a step resumes cleanly, even in fail mode", async () => {
    const r = rig();
    const body: Body = async (ctx) => {
      await run(ctx, A);
      await viaDecider(ctx);
      await run(ctx, B);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const d = r.deploy(body, { mode: "fail" });
    await (
      await d.rt.start({ definition: d.def, runner: body }, {}, { executionId: "x" })
    ).waitForSuspend();
    const { outcome, ran, warnings } = await resumeOn(r, body, { mode: "fail" });
    expect((outcome as { status: string }).status).toBe("completed");
    expect(ran).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("FN1: dropping A after a served decision is refused before any new effect", async () => {
    const r = rig();
    const v1b: Body = async (ctx) => {
      await viaDecider(ctx);
      await run(ctx, A);
      await run(ctx, B);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const d = r.deploy(v1b, { mode: "fail" });
    await (
      await d.rt.start({ definition: d.def, runner: v1b }, {}, { executionId: "x" })
    ).waitForSuspend();
    const v2: Body = async (ctx) => {
      await viaDecider(ctx);
      await run(ctx, B); // A dropped
      await run(ctx, C);
      return { done: true };
    };
    const { outcome, ran } = await resumeOn(r, v2, { mode: "fail" });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect((outcome as FlowReplayDivergenceError).skippedSteps).toEqual(["A"]);
    expect(ran).toEqual([]); // C never ran
  });

  it("FN2: a NEW step straight after a served decision, with A still unasked, is refused", async () => {
    const r = rig();
    const v1b: Body = async (ctx) => {
      await viaDecider(ctx);
      await run(ctx, A);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const d = r.deploy(v1b, { mode: "fail" });
    await (
      await d.rt.start({ definition: d.def, runner: v1b }, {}, { executionId: "x" })
    ).waitForSuspend();
    const v2: Body = async (ctx) => {
      await viaDecider(ctx);
      await run(ctx, C); // new, before A
      await run(ctx, A);
      return { done: true };
    };
    const { outcome, ran } = await resumeOn(r, v2, { mode: "fail" });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect(ran).toEqual([]);
  });

  it("a legacy record (no innerSteps) falls back to the <decisionId>:/# naming convention", async () => {
    const r = rig();
    const body: Body = async (ctx) => {
      await viaDecider(ctx);
      await run(ctx, A);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const d = r.deploy(body, { mode: "fail" });
    await (
      await d.rt.start({ definition: d.def, runner: body }, {}, { executionId: "x" })
    ).waitForSuspend();
    // strip the field, as a pre-R7 log would hold it
    const fresh = new InMemoryAsyncEventStore();
    for (const e of await r.store.read("x")) {
      if (e.eventType === "DECISION_RECORDED") {
        const { innerSteps: _drop, ...rest } = e.payload as Record<string, unknown>;
        const { kernel: _k, ...meta } = (e.metadata ?? {}) as Record<string, unknown>;
        await fresh.append({ ...e, payload: rest, metadata: meta });
      } else await fresh.append(e);
    }
    const r2 = rig(fresh);
    const { outcome, warnings } = await resumeOn(r2, body, { mode: "fail", freshSnapshots: true });
    expect((outcome as { status: string }).status).toBe("completed");
    expect(warnings).toEqual([]);
  });

  it("a crash between the decider's step and its record: the live decider revisits the step", async () => {
    const r = rig();
    const body: Body = async (ctx) => {
      await run(ctx, A);
      await viaDecider(ctx);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const d = r.deploy(body, { mode: "fail" });
    await (
      await d.rt.start({ definition: d.def, runner: body }, {}, { executionId: "x" })
    ).waitForSuspend();
    // cut the log back to just after the decider's step (A, d#inner done; no record, no park)
    const events = await r.store.read("x");
    const cut = events.findIndex((e) => e.eventType === "DECISION_RECORDED");
    const crashed = new InMemoryAsyncEventStore();
    for (const e of events.slice(0, cut)) await crashed.append(e);
    const r2 = rig(crashed);
    const d2 = r2.deploy(body, { mode: "fail", freshSnapshots: true });
    const h = await d2.rt.resume("x", { eventType: "EXECUTION_RECOVERED", payload: {} });
    await h.waitForSuspend();
    expect(d2.ran).toEqual([]); // both steps served; nothing ran twice, nothing refused
    expect(d2.warnings).toEqual([]);
  });
});

describe("D3 — modes", () => {
  const diverging: Body = async (ctx) => {
    await run(ctx, C);
    return { done: true };
  };

  it("warn (the DEFAULT): reports once, counts it, and proceeds", async () => {
    const r = rig();
    await parkedOnV1(r);
    const { outcome, ran, warnings } = await resumeOn(r, diverging); // no mode: the default
    expect((outcome as { status: string }).status).toBe("completed");
    expect(ran).toEqual(["C"]); // proceeded
    const w = warnings.filter((m) => m.includes("diverged from its log"));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/\[A, B\]/);
  });

  it("warn counts on the runtime", async () => {
    const r = rig();
    await parkedOnV1(r);
    const d = r.deploy(diverging);
    const h = await d.rt.resume("x", { eventType: "go", payload: {} });
    await h.waitForCompletion();
    expect(d.rt.divergenceWarnings).toBe(1);
  });

  it("off: silent, and proceeds", async () => {
    const r = rig();
    await parkedOnV1(r);
    const { outcome, ran, warnings } = await resumeOn(r, diverging, { mode: "off" });
    expect((outcome as { status: string }).status).toBe("completed");
    expect(ran).toEqual(["C"]);
    expect(warnings.filter((m) => m.includes("diverged"))).toEqual([]);
  });

  it("a bad mode is refused at construction", () => {
    expect(
      () =>
        new WorkflowRuntime({
          eventStore: new InMemoryAsyncEventStore(),
          snapshotStore: new InMemoryAsyncSnapshotStore(),
          effectRuntime: new EffectRuntime(),
          divergence: "strict" as never,
        })
    ).toThrow(/divergence must be/);
  });

  it("an unchanged body never trips it (fail mode), on resume and when it completes", async () => {
    const r = rig();
    await parkedOnV1(r);
    const { outcome, warnings } = await resumeOn(r, v1, { mode: "fail" });
    expect((outcome as { status: string }).status).toBe("completed");
    expect(warnings).toEqual([]);
  });
});

describe("D3 — membership only, set comparison in a scope, and the exemptions", () => {
  it("a pure reorder passes (membership, no order)", async () => {
    const r = rig();
    await parkedOnV1(r);
    const reordered: Body = async (ctx) => {
      await run(ctx, B);
      await run(ctx, A);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const { outcome, warnings } = await resumeOn(r, reordered, { mode: "fail" });
    expect((outcome as { status: string }).status).toBe("completed");
    expect(warnings).toEqual([]);
  });

  it("an added step AFTER every recorded one is not a divergence", async () => {
    const r = rig();
    await parkedOnV1(r);
    const extended: Body = async (ctx) => {
      await run(ctx, A);
      await run(ctx, B);
      await run(ctx, C); // new work, but the log's shape is intact
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const { outcome, ran } = await resumeOn(r, extended, { mode: "fail" });
    expect((outcome as { status: string }).status).toBe("completed");
    expect(ran).toEqual(["C"]);
  });

  it("an untyped failed step re-executed live beside a recorded one is not new work", async () => {
    // A step that failed untyped re-executes on EVERY re-run (legacy at-least-once). Its STEP_STARTED
    // can precede a recorded sibling's served frame in an unscoped Promise.all: the log already has
    // a frame for it, so it is part of the recorded shape, not new work under a changed one.
    const r = rig();
    const both: Body = async (ctx) => {
      await Promise.all([run(ctx, A).catch(() => undefined), run(ctx, B)]);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    let first = true;
    const failOnce = (id: string): unknown => {
      if (id === "A" && first) {
        first = false;
        throw new Error("A fails untyped");
      }
      return undefined;
    };
    const d = r.deploy(both, { mode: "fail", tool: failOnce });
    await (
      await d.rt.start({ definition: d.def, runner: both }, {}, { executionId: "x" })
    ).waitForSuspend();
    const { outcome, ran } = await resumeOn(r, both, { mode: "fail" });
    expect((outcome as { status: string }).status).toBe("completed");
    expect(ran).toEqual(["A"]); // A re-executed live; no divergence
  });

  it("parallel scope: branches interleave, the recorded steps are compared as a SET", async () => {
    const r = rig();
    const scoped = { deps: { scopes: true } };
    const first: Body = async (ctx) => {
      await ctx.parallel([
        [A, { id: "A" }],
        [B, { id: "B" }],
      ]);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const d = r.deploy(first, { mode: "fail", ...scoped });
    await (
      await d.rt.start({ definition: d.def, runner: first }, {}, { executionId: "x" })
    ).waitForSuspend();

    // v2: one branch does NEW work (C) before the sibling's recorded frame is asked for. A live
    // append inside the scope precedes B's visit — set semantics: no refusal, since B IS visited.
    const v2: Body = async (ctx) => {
      await ctx.parallel([
        async (b) => {
          await b.run(C, { id: "C" });
          await b.run(A, { id: "A" });
        },
        async (b) => {
          await new Promise((res) => setTimeout(res, 10));
          await b.run(B, { id: "B" });
        },
      ]);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const { outcome, ran } = await resumeOn(r, v2, { mode: "fail", ...scoped });
    expect((outcome as { status: string }).status).toBe("completed");
    expect(ran).toEqual(["C"]);
  });

  it("parallel scope: a recorded step the scope never asks for IS refused once the scope closes", async () => {
    const r = rig();
    const scoped = { deps: { scopes: true } };
    const first: Body = async (ctx) => {
      await ctx.parallel([
        [A, { id: "A" }],
        [B, { id: "B" }],
      ]);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const d = r.deploy(first, { mode: "fail", ...scoped });
    await (
      await d.rt.start({ definition: d.def, runner: first }, {}, { executionId: "x" })
    ).waitForSuspend();
    const v2: Body = async (ctx) => {
      await ctx.parallel([[A, { id: "A" }]]); // B dropped
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const { outcome, before } = await resumeOn(r, v2, { mode: "fail", ...scoped });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect((outcome as FlowReplayDivergenceError).skippedSteps).toEqual(["B"]);
    expect(await appendedByBody(r, before)).toEqual([]);
  });

  it("an execution migrated by resumeAs is not refused for the steps the migration removed", async () => {
    const r = rig();
    await parkedOnV1(r);
    const v2: Body = async (ctx) => {
      await run(ctx, C);
      await ctx.suspend({ on: "go" }); // answered by the migration's resume
      await ctx.suspend({ on: "again" });
      return { done: true };
    };
    const d = r.deploy(v2, { mode: "fail" });
    const h = await d.rt.resumeAs(
      "x",
      FLOW,
      { eventType: "go", payload: {} },
      { strategy: "operator-ack" }
    );
    await h.waitForSuspend();
    expect(d.ran).toEqual(["C"]);
    expect(await kindsOf(r)).toContain("EXECUTION_MIGRATED");

    // A LATER resume (a new process, from the log) — A and B predate the migration and stay exempt;
    // C, recorded after it, is asked for.
    const d2 = r.deploy(v2, { mode: "fail" });
    const h2 = await d2.rt.resume("x", { eventType: "again", payload: {} });
    expect((await h2.waitForCompletion()).status).toBe("completed");
    expect(d2.warnings).toEqual([]);
  });

  it("…and a snapshot taken after the migration never causes a false refusal (fail-open: it hides WHEN the migration happened)", async () => {
    const r = rig();
    await parkedOnV1(r);
    const v2: Body = async (ctx) => {
      await run(ctx, C);
      await ctx.suspend({ on: "go" }); // answered by the migration's resume
      await ctx.suspend({ on: "again" });
      return { done: true };
    };
    const d = r.deploy(v2, { mode: "fail", deps: { snapshotEvery: 1 } });
    const h = await d.rt.resumeAs(
      "x",
      FLOW,
      { eventType: "go", payload: {} },
      { strategy: "operator-ack" }
    );
    await h.waitForSuspend();
    expect(await r.snapshots.loadLatest("x")).toBeDefined();
    const d2 = r.deploy(v2, { mode: "fail" });
    const h2 = await d2.rt.resume("x", { eventType: "again", payload: {} });
    expect((await h2.waitForCompletion()).status).toBe("completed");
  });

  it("after a migration, a recorded step that predates it is exempt but one recorded after it is not", async () => {
    const r = rig();
    await parkedOnV1(r);
    const v2: Body = async (ctx) => {
      await run(ctx, C);
      await ctx.suspend({ on: "go" }); // answered by the migration's resume
      await ctx.suspend({ on: "again" });
      return { done: true };
    };
    const d = r.deploy(v2, { mode: "fail" });
    await (
      await d.rt.resumeAs("x", FLOW, { eventType: "go", payload: {} }, { strategy: "operator-ack" })
    ).waitForSuspend();
    const v3: Body = async (ctx) => {
      await run(ctx, B); // not C: the post-migration step vanished
      await ctx.suspend({ on: "go" });
      await ctx.suspend({ on: "again" });
      return { done: true };
    };
    const d3 = r.deploy(v3, { mode: "fail", freshSnapshots: true });
    const h3 = await d3.rt.resume("x", { eventType: "again", payload: {} });
    const err = await h3.waitForCompletion().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowReplayDivergenceError);
    expect((err as FlowReplayDivergenceError).skippedSteps).toEqual(["C"]);
  });
});

describe("D2 — the body fingerprint", () => {
  it("is recorded on EXECUTION_STARTED.codeHash and folds into _codeHash", async () => {
    const r = rig();
    await parkedOnV1(r, { fingerprint: "fp1" });
    const started = (await r.store.read("x"))[0];
    expect((started?.payload as { codeHash?: string }).codeHash).toBe("fp1");
    const d = r.deploy(v1, { fingerprint: "fp1" });
    expect((await d.rt.loadState("x"))?.variables._codeHash).toBe("fp1");
  });

  it("a different fingerprint is a FlowCodeMismatchError — nothing is appended", async () => {
    const r = rig();
    await parkedOnV1(r, { fingerprint: "fp1" });
    const before = (await r.store.read("x")).length;
    const d = r.deploy(v1, { fingerprint: "fp2" });
    const err = await d.rt.resume("x", { eventType: "go", payload: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowCodeMismatchError);
    expect((err as FlowCodeMismatchError).kind).toBe("code");
    expect(String(err)).toMatch(/compatibleWith/);
    expect((await r.store.read("x")).length).toBe(before);
  });

  it("compatibleWith: the registered flow lists the recorded value — the resume proceeds", async () => {
    const r = rig();
    await parkedOnV1(r, { fingerprint: "fp1" });
    const d = r.deploy(v1, { fingerprint: "fp2", compatibleWith: ["fp1"], mode: "fail" });
    const h = await d.rt.resume("x", { eventType: "go", payload: {} });
    expect((await h.waitForCompletion()).status).toBe("completed");
  });

  it("compatibleWith lists a DIFFERENT value: still refused", async () => {
    const r = rig();
    await parkedOnV1(r, { fingerprint: "fp1" });
    const d = r.deploy(v1, { fingerprint: "fp3", compatibleWith: ["fp0"] });
    await expect(d.rt.resume("x", { eventType: "go", payload: {} })).rejects.toBeInstanceOf(
      FlowCodeMismatchError
    );
  });

  it("recovery is guarded too (the no-operator path)", async () => {
    const r = rig();
    await parkedOnV1(r, { fingerprint: "fp1" });
    const d = r.deploy(v1, { fingerprint: "fp2" });
    await expect(
      d.rt.resume("x", { eventType: "EXECUTION_RECOVERED", payload: {} })
    ).rejects.toBeInstanceOf(FlowCodeMismatchError);
  });

  it("absent on either side means no fingerprint: behaviour unchanged", async () => {
    const r = rig();
    await parkedOnV1(r); // none recorded
    const d = r.deploy(v1, { fingerprint: "fp-new" });
    expect(
      (await (await d.rt.resume("x", { eventType: "go", payload: {} })).waitForCompletion()).status
    ).toBe("completed");

    const r2 = rig();
    await parkedOnV1(r2, { fingerprint: "fp1" }); // recorded, none registered now
    const d2 = r2.deploy(v1);
    expect(
      (await (await d2.rt.resume("x", { eventType: "go", payload: {} })).waitForCompletion()).status
    ).toBe("completed");
  });

  it("a flow without a fingerprint writes the same EXECUTION_STARTED as before (no codeHash key)", async () => {
    const r = rig();
    const d = await parkedOnV1(r);
    const payload = (await r.store.read("x"))[0]?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["flowHash", "input", "principal"]);
    // the flag is OFF by default: the legacy generation is still what new starts record
    expect(payload.flowHash).toBe(legacyFlowContentHash(d.def));
  });

  it("a migration re-arms the fingerprint against the code it migrated TO (toCodeHash)", async () => {
    const r = rig();
    await parkedOnV1(r, { fingerprint: "fp1" });
    const v2: Body = async (ctx) => {
      await ctx.suspend({ on: "go" });
      await ctx.suspend({ on: "again" });
      return { done: true };
    };
    const d = r.deploy(v2, { fingerprint: "fp2", mode: "off" });
    await (
      await d.rt.resumeAs("x", FLOW, { eventType: "go", payload: {} }, { strategy: "operator-ack" })
    ).waitForSuspend();
    expect(((await d.rt.loadState("x"))?.variables as Record<string, unknown>)._codeHash).toBe(
      "fp2"
    );
    const d2 = r.deploy(v2, { fingerprint: "fp2", mode: "off" });
    const h = await d2.rt.resume("x", { eventType: "again", payload: {} });
    expect((await h.waitForCompletion()).status).toBe("completed");
  });

  it("…and a LATER deploy that changes the fingerprint is refused again (the check re-armed)", async () => {
    const r = rig();
    await parkedOnV1(r, { fingerprint: "fp1" });
    const v2: Body = async (ctx) => {
      await ctx.suspend({ on: "go" });
      await ctx.suspend({ on: "again" });
      return { done: true };
    };
    const d = r.deploy(v2, { fingerprint: "fp2", mode: "off" });
    await (
      await d.rt.resumeAs("x", FLOW, { eventType: "go", payload: {} }, { strategy: "operator-ack" })
    ).waitForSuspend();
    const d3 = r.deploy(v2, { fingerprint: "fp3", mode: "off" });
    await expect(d3.rt.resume("x", { eventType: "again", payload: {} })).rejects.toBeInstanceOf(
      FlowCodeMismatchError
    );
  });

  it("R1b: a continuation's successor records the fingerprint of the code registered NOW", async () => {
    const r = rig();
    const deps = { continueAsNewEnabled: true };
    const rotating: Body = async (ctx, input) => {
      if ((input as { gen?: number } | undefined)?.gen === undefined) {
        await ctx.suspend({ on: "go" });
        return ctx.continueAsNew({ gen: 1 });
      }
      await ctx.suspend({ on: "never" });
      return {};
    };
    const d = r.deploy(rotating, { fingerprint: "fp1", deps });
    await (
      await d.rt.start({ definition: d.def, runner: rotating }, {}, { executionId: "x" })
    ).waitForSuspend();
    // deploy v2 of the code, then let the predecessor rotate: the successor runs v2
    const v2 = r.deploy(rotating, { fingerprint: "fp2", compatibleWith: ["fp1"], deps });
    await v2.rt.resume("x", { eventType: "go", payload: {} });
    const until = async (): Promise<EventEnvelope[]> => {
      for (let i = 0; i < 400; i++) {
        const e = await r.store.read("x~1");
        if (e.length > 0) return e;
        await new Promise((res) => setTimeout(res, 5));
      }
      return [];
    };
    const succ = await until();
    expect((succ[0]?.payload as { codeHash?: string }).codeHash).toBe("fp2");
    expect(((await r.store.read("x"))[0]?.payload as { codeHash?: string }).codeHash).toBe("fp1");
  });
});

describe("D1 — SHA-256 structural hash, legacy fnv1a recordings still resume", () => {
  /** Rewrite the recorded flowHash to the pre-0113 form, as an in-flight execution would hold it. */
  async function legacyLog(): Promise<{ r: Rig; legacy: string }> {
    const r = rig();
    const d = await parkedOnV1(r);
    const legacy = legacyFlowContentHash(d.def);
    const fresh = new InMemoryAsyncEventStore();
    for (const e of await r.store.read("x")) {
      const p = e.payload as Record<string, unknown>;
      await fresh.append(
        e.eventType === "EXECUTION_STARTED" ? { ...e, payload: { ...p, flowHash: legacy } } : e
      );
    }
    return { r: rig(fresh), legacy };
  }

  it("new starts record sha256:, a fnv1a: recording is compared against the legacy hash and resumes", async () => {
    const { r, legacy } = await legacyLog();
    expect(legacy).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    const d = r.deploy(v1, { mode: "fail" });
    const h = await d.rt.resume("x", { eventType: "go", payload: {} });
    expect((await h.waitForCompletion()).status).toBe("completed");
  });

  it("…and a fnv1a: recording of DIFFERENT structure is still refused", async () => {
    const { r } = await legacyLog();
    const d = r.deploy(v1, { steps: [A, B, C] }); // a structural change
    await expect(d.rt.resume("x", { eventType: "go", payload: {} })).rejects.toBeInstanceOf(
      FlowCodeMismatchError
    );
  });
});

describe("D4 — replay-check understands step families", () => {
  const dynamic: Body = async (ctx) => {
    // the ADR 0061 interpreter pattern: ids minted at runtime, `base#n`
    await ctx.run({ ...A, id: "A#0" }, { id: "A#0" });
    await ctx.run({ ...A, id: "A#1" }, { id: "A#1" });
    await ctx.run({ ...B, id: "loop#turn:0:tool:1" }, { id: "t" });
    await ctx.suspend({ on: "go" });
    return { done: true };
  };

  async function parkedDynamic(r: Rig) {
    const d = r.deploy(dynamic, { steps: [A, B, { ...B, id: "loop" } as typeof B] });
    await (
      await d.rt.start({ definition: d.def, runner: dynamic }, {}, { executionId: "x" })
    ).waitForSuspend();
  }

  it("a dynamic-id agent passes replay-check (family A and loop are declared)", async () => {
    const r = rig();
    await parkedDynamic(r);
    const d = r.deploy(dynamic, { steps: [A, B, { ...B, id: "loop" } as typeof B], mode: "off" });
    const h = await d.rt.resumeAs(
      "x",
      FLOW,
      { eventType: "go", payload: {} },
      { strategy: "replay-check" }
    );
    expect((await h.waitForCompletion()).status).toBe("completed");
  });

  it("a VANISHED family still fails, reported per family with a count", async () => {
    const r = rig();
    await parkedDynamic(r);
    const d = r.deploy(dynamic, { steps: [B, { ...B, id: "loop" } as typeof B], mode: "off" }); // A gone
    const err = await d.rt
      .resumeAs("x", FLOW, { eventType: "go", payload: {} }, { strategy: "replay-check" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowMigrationCheckError);
    expect((err as FlowMigrationCheckError).orphanedStepIds).toEqual(["A#* (2 frames)"]);
    expect((await r.store.read("x")).map((e) => e.eventType)).not.toContain("EXECUTION_MIGRATED");
  });

  it("stepFamilies (string and RegExp) cover ids that do not follow the # convention", async () => {
    expect(
      orphanedFrames(["tool.call.1", "tool.call.2", "other"], ["A"], ["other", /^tool\.call\./])
    ).toEqual([]);
    expect(orphanedFrames(["tool.call.1", "gone"], ["A"], [/^tool\.call\./])).toEqual(["gone"]);
  });

  it("orphanedFrames: exact ids, families, and the leading-# edge", () => {
    expect(orphanedFrames(["A", "B"], ["A", "B"], undefined)).toEqual([]);
    expect(orphanedFrames(["A#0", "A#1", "B#0"], ["A"], undefined)).toEqual(["B#* (1 frame)"]);
    expect(orphanedFrames(["#0"], ["A"], undefined)).toEqual(["#0"]); // no family before the #
    expect(orphanedFrames(["a#1#2"], ["a"], undefined)).toEqual([]); // first # names the family
  });
});

describe("D3 — the refusal PARKS on the reserved gate (fix round 1, P1-4)", () => {
  const diverging: Body = async (ctx) => {
    await run(ctx, C);
    return { done: true };
  };

  it("commits an ordinary EXECUTION_SUSPENDED on the reserved gate, no EXECUTION_FAILED, and signals", async () => {
    const r = rig();
    await parkedOnV1(r);
    const { outcome, warnings } = await resumeOn(r, diverging, { mode: "fail" });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    const kinds = await kindsOf(r);
    expect(kinds).not.toContain("EXECUTION_FAILED");
    expect(kinds.at(-1)).toBe("EXECUTION_SUSPENDED");
    const d = r.deploy(v1);
    const st = await d.rt.loadState("x");
    expect(st?.status).toBe("suspended");
    expect(st?.suspendedOn?.on).toBe("__loom_diverged__");
    expect(st?.suspendedOn?.correlationKey).toMatch(/skipped 2: A,B/);
    expect(warnings.some((m) => m.includes("PARKED on"))).toBe(true); // signalled, not silent
  });

  it("retryDiverged re-runs it once the code is fixed (status-only: no stray answer for the body's gates)", async () => {
    const r = rig();
    await parkedOnV1(r);
    await resumeOn(r, diverging, { mode: "fail" });
    // the fix: the original body is deployed again
    const d = r.deploy(v1, { mode: "fail" });
    const h = await d.rt.retryDiverged("x");
    // v1 re-asks A, B (served) and takes the ORIGINAL "go" answer: the retry added no stray one
    const done = await h.waitForCompletion();
    expect(done.status).toBe("completed");
    expect(d.ran).toEqual([]);
    expect(done.variables._resumePayloads).toEqual([{}]);
  });

  it("a plain resume naming the reserved gate with a payload is also status-only (nothing for the body's gates)", async () => {
    const r = rig();
    await parkedOnV1(r);
    await resumeOn(r, diverging, { mode: "fail" });
    const d = r.deploy(v1, { mode: "fail" });
    const h = await d.rt.resume("x", { eventType: "__loom_diverged__", payload: { sneaky: 1 } });
    const done = await h.waitForCompletion();
    expect(done.variables._resumePayloads).toEqual([{}]);
  });

  it("a retry that still diverges parks again (no spam: one park per call)", async () => {
    const r = rig();
    await parkedOnV1(r);
    await resumeOn(r, diverging, { mode: "fail" });
    const d = r.deploy(diverging, { mode: "fail" });
    const h = await d.rt.retryDiverged("x");
    await expect(h.waitForCompletion()).rejects.toBeInstanceOf(FlowReplayDivergenceError);
    const parks = (await r.store.read("x")).filter(
      (e) => e.eventType === "EXECUTION_SUSPENDED" && isDivergedPark(e)
    );
    expect(parks).toHaveLength(2);
  });

  it("only the reserved gate is retryable: an execution parked elsewhere is refused", async () => {
    const r = rig();
    const d = await parkedOnV1(r);
    await expect(d.rt.retryDiverged("x")).rejects.toMatchObject({ reason: "gate-mismatch" });
  });

  it("a body cannot park on the reserved gate", async () => {
    const r = rig();
    const sneaky: Body = async (ctx) => {
      await ctx.suspend({ on: "__loom_diverged__" });
      return {};
    };
    const d = r.deploy(sneaky, { mode: "fail" });
    const h = await d.rt.start({ definition: d.def, runner: sneaky }, {}, { executionId: "s" });
    await expect(h.waitForCompletion()).rejects.toThrow(/reserved for the kernel/);
    const raw: Body = async () => {
      throw new SuspendError({ on: "__loom_diverged__" });
    };
    const d2 = r.deploy(raw, { mode: "fail" });
    const h2 = await d2.rt.start({ definition: d2.def, runner: raw }, {}, { executionId: "s2" });
    await h2.waitForCompletion().catch(() => undefined);
    expect((await r.store.read("s2")).map((e) => e.eventType)).toContain("EXECUTION_FAILED");
  });

  it("recoverAbandoned reports a refused re-drive as failed + onError, and skips the park afterwards", async () => {
    const r = rig();
    await parkedOnV1(r);
    // a crash after the steps, before the park: the log ends at B's completion (status running)
    const crashed = new InMemoryAsyncEventStore();
    for (const e of await r.store.read("x")) {
      if (e.eventType === "EXECUTION_SUSPENDED") break;
      await crashed.append(e);
    }
    const r2 = rig(crashed);
    const d = r2.deploy(diverging, { mode: "fail", freshSnapshots: true });
    const errors: unknown[] = [];
    const run1 = await recoverAbandoned(d.rt, {
      source: crashed,
      isAbandoned: () => true,
      onError: (_id, e) => errors.push(e),
    });
    expect(run1).toMatchObject({ recovered: 0, failed: 1 });
    expect(errors[0]).toBeInstanceOf(FlowReplayDivergenceError);
    // parked now: later passes do not re-drive it (and so do not append EXECUTION_RECOVERED forever)
    const before = (await crashed.read("x")).length;
    const run2 = await recoverAbandoned(d.rt, { source: crashed, isAbandoned: () => true });
    expect(run2).toMatchObject({ candidates: 0, recovered: 0 });
    expect((await crashed.read("x")).length).toBe(before);
  });
});

describe("P2-1 — new steps do not run before the refusal", () => {
  it("(a) a step added to an open parallel scope does not run while an earlier recorded step is unasked", async () => {
    const r = rig();
    const scoped = { deps: { scopes: true } };
    const first: Body = async (ctx) => {
      await run(ctx, A);
      await ctx.parallel([
        [B, { id: "B" }],
        [C, { id: "C" }],
      ]);
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const d = r.deploy(first, { mode: "fail", ...scoped });
    await (
      await d.rt.start({ definition: d.def, runner: first }, {}, { executionId: "x" })
    ).waitForSuspend();
    const D = step$({ id: "D", name: "D", toolId: "count", ...io });
    const v2: Body = async (ctx) => {
      await ctx.parallel([
        [B, { id: "B" }],
        [C, { id: "C" }],
        [D, { id: "D" }],
      ]); // A dropped, D added
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const { outcome, ran } = await resumeOn(r, v2, { mode: "fail", ...scoped });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect((outcome as FlowReplayDivergenceError).skippedSteps).toEqual(["A"]);
    expect(ran).not.toContain("D");
  });

  it("(b) a recorded failed step re-run with new input does not run while an earlier recorded step is dropped", async () => {
    const r = rig();
    let first = true;
    const failB = (id: string): unknown => {
      if (id === "B" && first) {
        first = false;
        throw new Error("B fails untyped");
      }
      return undefined;
    };
    const v1b: Body = async (ctx) => {
      await run(ctx, A);
      try {
        await run(ctx, B);
      } catch {
        /* carry on */
      }
      await ctx.suspend({ on: "go" });
      return { done: true };
    };
    const d = r.deploy(v1b, { mode: "fail", tool: failB });
    await (
      await d.rt.start({ definition: d.def, runner: v1b }, {}, { executionId: "x" })
    ).waitForSuspend();
    const v2: Body = async (ctx) => {
      await ctx.run(B, { id: "B", from: "diverged" }); // A dropped; B re-run with new input
      return { done: true };
    };
    const { outcome, ran } = await resumeOn(r, v2, { mode: "fail" });
    expect(outcome).toBeInstanceOf(FlowReplayDivergenceError);
    expect((outcome as FlowReplayDivergenceError).skippedSteps).toEqual(["A"]);
    expect(ran).toEqual([]);
  });
});

describe("D1 — the sha256 flag (fix round 1, P2-2)", () => {
  it("OFF (default): new starts record fnv1a:, and either form is read", async () => {
    const r = rig();
    const d = await parkedOnV1(r);
    expect(((await r.store.read("x"))[0]?.payload as { flowHash: string }).flowHash).toBe(
      legacyFlowContentHash(d.def)
    );
    const h = await r.deploy(v1, { deps: { sha256FlowHash: true } }).rt.resume("x", {
      eventType: "go",
      payload: {},
    });
    expect((await h.waitForCompletion()).status).toBe("completed"); // fnv1a log, flag-on node
  });

  it("ON: new starts record sha256:, and a flag-off node resuming it is the documented hazard", async () => {
    const r = rig();
    const d = await parkedOnV1(r, { deps: { sha256FlowHash: true } });
    const rec = ((await r.store.read("x"))[0]?.payload as { flowHash: string }).flowHash;
    expect(rec).toBe(flowContentHash(d.def));
    expect(rec).toMatch(/^sha256:/);
    // a node of THIS version reads it either way
    const h = await r.deploy(v1).rt.resume("x", { eventType: "go", payload: {} });
    expect((await h.waitForCompletion()).status).toBe("completed");
  });

  it("a migration records the hash in the flag's generation, and a continuation successor too", async () => {
    const r = rig();
    await parkedOnV1(r, { deps: { sha256FlowHash: true } });
    const v2: Body = async (ctx) => {
      await ctx.suspend({ on: "go" });
      return {};
    };
    const d = r.deploy(v2, { mode: "off", deps: { sha256FlowHash: true } });
    await (
      await d.rt.resumeAs("x", FLOW, { eventType: "go", payload: {} }, { strategy: "operator-ack" })
    ).waitForCompletion();
    const mig = (await r.store.read("x")).find((e) => e.eventType === "EXECUTION_MIGRATED");
    expect((mig?.payload as { toHash: string }).toHash).toMatch(/^sha256:/);
  });
});
