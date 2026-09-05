import { TypedFailure } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryContentStore } from "@loom/plugin-content";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SANDBOX_TOOL_ID, registerSandboxEval, sandboxEval$ } from "./sandboxEval$";
import { shapeHash } from "./shape";
import type { SandboxSpec } from "./types";

// ── ADR 0064 — the sandbox security test list (the audit's executable form) ──
//
// ADR 0089 added a second place scripts can run. The list below is therefore run
// against BOTH engines rather than copied: a guard that holds in-process and not
// on a worker is the exact failure the shared `evalInFreshRuntime` exists to make
// impossible, and only running it twice proves it.

const encoder = new TextEncoder();

const ENGINES: { name: string; workers: SandboxSpec["workers"] }[] = [
  { name: "in-process", workers: {} },
  { name: "worker pool", workers: { count: 2 } },
];

/** Effects that may hold live threads; closed after each test or vitest never exits. */
const opened: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((e) => e.close()));
});

async function boot(spec: SandboxSpec = {}) {
  const scripts = new InMemoryContentStore();
  const effects = new EffectRuntime();
  const effect = registerSandboxEval(effects, scripts, spec);
  opened.push(effect);
  await effect.warm();
  return { scripts, effects, effect };
}

const baseCtx: EffectContext = {
  executionId: "x-1",
  stepId: "reshape#0",
  workflowId: "w-1",
  attempt: 1,
  emit: () => {},
};

async function put(scripts: InMemoryContentStore, code: string) {
  return scripts.put(encoder.encode(code));
}

async function expectChannel(p: Promise<unknown>, channel: string): Promise<TypedFailure> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TypedFailure);
    expect((err as TypedFailure).channel).toBe(channel);
    return err as TypedFailure;
  }
  throw new Error(`expected typed failure on channel "${channel}"`);
}

describe.each(ENGINES)("sandboxEval (ADR 0064) — $name", ({ workers }) => {
  const bootEngine = (spec: SandboxSpec = {}) => boot({ ...spec, workers });

  it("evaluates a reshaping script deterministically over the injected input", async () => {
    const { scripts, effects } = await bootEngine();
    const ref = await put(
      scripts,
      "(() => ({ series: input.rows.map((r) => ({ t: r[0], v: r[1] * 2 })) }))()"
    );
    const input = {
      scriptRef: ref,
      input: {
        rows: [
          [1, 10],
          [2, 20],
        ],
      },
    };
    const first = await effects.execute(SANDBOX_TOOL_ID, input, baseCtx);
    const second = await effects.execute(SANDBOX_TOOL_ID, input, baseCtx);
    expect(first).toEqual({
      series: [
        { t: 1, v: 20 },
        { t: 2, v: 40 },
      ],
    });
    expect(second).toEqual(first); // pure function of (script, input)
  });

  it("kills a runaway loop on the CPU interrupt budget", async () => {
    const { scripts, effects } = await bootEngine({
      limits: { interruptBudget: 50, wallClockMs: 60_000 },
    });
    const ref = await put(scripts, "while (true) {}");
    const failure = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
      "limitExceeded"
    );
    expect(failure.payload).toEqual({ kind: "cpu" });
  });

  it("kills an allocation bomb on the memory limit", async () => {
    const { scripts, effects } = await bootEngine({
      limits: { memoryBytes: 4 * 1024 * 1024, interruptBudget: 1_000_000, wallClockMs: 60_000 },
    });
    const ref = await put(scripts, `let a = "x"; while (true) { a += a; } a`);
    const failure = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
      "limitExceeded"
    );
    expect(failure.payload).toEqual({ kind: "memory" });
  });

  it("kills on the wall clock when the interrupt budget is generous", async () => {
    const { scripts, effects } = await bootEngine({
      limits: { interruptBudget: Number.MAX_SAFE_INTEGER, wallClockMs: 50 },
    });
    const ref = await put(scripts, "while (true) {}");
    const failure = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
      "limitExceeded"
    );
    expect(failure.payload).toEqual({ kind: "wallClock" });
  });

  it("has no ambient I/O: fetch/require/process/setTimeout are ReferenceErrors (deliberately untyped)", async () => {
    const { scripts, effects } = await bootEngine();
    for (const code of [
      `fetch("http://example.com")`,
      `require("node:fs")`,
      "process.env.SECRET",
      "setTimeout(() => {}, 1)",
    ]) {
      const ref = await put(scripts, code);
      await expect(effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx)).rejects.toThrow(
        /sandbox script failed:.*not defined/
      );
    }
  });

  it("validates the output shape against the pinned hash and fails typed on mismatch", async () => {
    const { scripts, effects } = await bootEngine();
    const ref = await put(scripts, `(() => ({ type: "timeseries", data: [{ t: 1, v: 2 }] }))()`);
    const expected = shapeHash({ type: "timeseries", data: [{ t: 1, v: 2 }] });

    // Matching pin passes (shape, not values — different numbers, same skeleton).
    const ok = await effects.execute(
      SANDBOX_TOOL_ID,
      { scriptRef: ref, expectedOutputShapeHash: expected },
      baseCtx
    );
    expect(ok).toEqual({ type: "timeseries", data: [{ t: 1, v: 2 }] });

    // A drifted pin fails typed with both hashes.
    const stale = shapeHash({ type: "timeseries", data: [{ t: 1, v: 2, unit: "ms" }] });
    const failure = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref, expectedOutputShapeHash: stale }, baseCtx),
      "shapeMismatch"
    );
    expect(failure.payload).toEqual({ expected: stale, observed: expected });
  });

  it("MEM-MEDIUM: a script completing with a Promise does not crash on double-dispose", async () => {
    const { scripts, effects } = await bootEngine();
    // `vm.dump` of a Promise disposes the handle itself (quickjs-emscripten 0.31);
    // the alive-guard must prevent QuickJSUseAfterFree.
    const ref = await put(scripts, "Promise.resolve(42)");
    const output = await effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx);
    // The host never drains the VM job queue, so a Promise completion value is
    // surfaced as its pending/settled descriptor — odd output, never a crash.
    expect(output).toBeTypeOf("object");
  });

  it("fails typed on an erased script (scriptMissing)", async () => {
    const { scripts, effects } = await bootEngine();
    const ref = await put(scripts, "1 + 1");
    await scripts.delete(ref);
    const failure = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
      "scriptMissing"
    );
    expect(failure.payload).toEqual({ ref: ref.__loomContent });
  });
});

describe("sandboxEval — replay", () => {
  it("DE-4 integration: a recorded shapeMismatch replays with ZERO re-evaluation", async () => {
    const scripts = new InMemoryContentStore();
    const ref = await put(scripts, "(() => ({ ok: true }))()");
    const stale = shapeHash({ entirely: "different" });

    const makeRuntime = (reader: { get: typeof scripts.get; reads: number }) => {
      const effects = new EffectRuntime();
      registerSandboxEval(effects, {
        get: (r) => {
          reader.reads++;
          return scripts.get(r);
        },
      });
      return effects;
    };

    const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;
    const flowDef: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
      _tag: "FlowDefinition",
      id: "reshape-flow",
      name: "reshape-flow",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [],
    };
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      try {
        await ctx.run(sandboxEval$("reshape#0"), {
          scriptRef: ref,
          expectedOutputShapeHash: stale,
        });
        return { branch: "success" };
      } catch (err) {
        if (err instanceof TypedFailure && err.channel === "shapeMismatch") {
          await (ctx.suspend({ on: "RepairDone" }) as Promise<unknown>);
          return { branch: "repaired" };
        }
        throw err;
      }
    };

    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const reads1 = { get: scripts.get.bind(scripts), reads: 0 };
    const rt1 = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: makeRuntime(reads1),
    });
    rt1.registerFlow(flowDef, runner);
    const started = await rt1.start({ definition: flowDef, runner }, {}, { executionId: "sb-1" });
    await started.waitForSuspend();
    expect(reads1.reads).toBe(1);

    const reads2 = { get: scripts.get.bind(scripts), reads: 0 };
    const rt2 = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: makeRuntime(reads2),
    });
    rt2.registerFlow(flowDef, runner);
    const done = await rt2.resume("sb-1", { eventType: "RepairDone", payload: {} });
    const state = await done.waitForCompletion();

    expect(state.status).toBe("completed");
    expect(reads2.reads).toBe(0); // replay substituted the recorded typed failure — zero evaluation
  });
});
