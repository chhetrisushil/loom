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
import { SANDBOX_ERRORS, type SandboxSpec } from "./types";

// ── ADR 0064 — the sandbox security test list (the audit's executable form) ──
//
// ADR 0089 added a second place scripts can run. The list below is therefore run
// against BOTH engines rather than copied: a guard that holds in-process and not
// on a worker is the exact failure the shared `evalInFreshRuntime` exists to make
// impossible, and only running it twice proves it.

const encoder = new TextEncoder();

const ENGINES: { name: string; workers: NonNullable<SandboxSpec["workers"]> }[] = [
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

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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

  it("has no ambient I/O: fetch/require/process/setTimeout are ReferenceErrors on scriptError", async () => {
    // Still capability-empty: nothing but `input` exists in the VM. What changed is the
    // channel — referencing a global that does not exist is the script's own bug, and the
    // VM cannot tell `fetch` from a typo, so it completes on `scriptError` like any throw.
    const { scripts, effects } = await bootEngine();
    for (const code of [
      `fetch("http://example.com")`,
      `require("node:fs")`,
      "process.env.SECRET",
      "setTimeout(() => {}, 1)",
    ]) {
      const ref = await put(scripts, code);
      const failure = await expectChannel(
        effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
        "scriptError"
      );
      expect(failure.payload).toMatchObject({ name: "ReferenceError" });
      expect((failure.payload as { message: string }).message).toMatch(/not defined/);
    }
  });

  it("a script's own Error completes on scriptError with its name and message — no stack", async () => {
    const { scripts, effects } = await bootEngine();
    const ref = await put(scripts, `throw new TypeError("bad row " + input.i)`);
    const failure = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref, input: { i: 3 } }, baseCtx),
      "scriptError"
    );
    // Exactly these keys: a stack names engine internals and is never carried.
    expect(failure.payload).toStrictEqual({ name: "TypeError", message: "bad row 3" });
    // The legacy text survives in the error message for anything that logged it.
    expect(failure.message).toBe("sandbox script failed: TypeError: bad row 3");
  });

  it("a non-Error throw completes on scriptError with no name", async () => {
    const { scripts, effects } = await bootEngine();
    const cases: [string, unknown][] = [
      ["throw 42", { message: "42" }],
      [`throw "nope"`, { message: "nope" }],
      ["throw null", { message: "null" }],
      ["throw undefined", { message: "undefined" }],
      ["throw { code: 7 }", { message: '{"code":7}' }],
      // Error-LIKE objects: a string `name`/`message` is read; anything else is not.
      [`throw { name: "Custom", message: "m" }`, { name: "Custom", message: "m" }],
      ["throw { name: 5, message: {} }", { message: '{"name":5,"message":{}}' }],
    ];
    for (const [code, payload] of cases) {
      const ref = await put(scripts, code);
      const failure = await expectChannel(
        effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
        "scriptError"
      );
      expect(failure.payload, code).toStrictEqual(payload);
    }
  });

  it("a syntax error is the script's own fault: scriptError { name: SyntaxError }", async () => {
    const { scripts, effects } = await bootEngine();
    const ref = await put(scripts, "(() => { return input.; })()");
    const failure = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
      "scriptError"
    );
    expect(failure.payload).toMatchObject({ name: "SyntaxError" });
  });

  it("bounds script-authored text: name ≤ 128, message ≤ 2048 characters", async () => {
    const { scripts, effects } = await bootEngine();
    const ref = await put(
      scripts,
      `const e = new Error("m".repeat(100000)); e.name = "n".repeat(10000); throw e;`
    );
    const failure = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
      "scriptError"
    );
    const payload = failure.payload as { name: string; message: string };
    expect(payload.name).toBe("n".repeat(128));
    expect(payload.message).toBe("m".repeat(2048));
    expect(SANDBOX_ERRORS.scriptError.safeParse(payload).success).toBe(true);
  });

  it("a script's own text naming a limit is scriptError, not limitExceeded", async () => {
    const { scripts, effects } = await bootEngine();
    for (const [code, name] of [
      [`throw new Error("connection interrupted")`, "Error"],
      [`throw new Error("out of memory")`, "Error"],
      [`throw new RangeError("memory limit of the widget reached")`, "RangeError"],
      [`throw { name: "Oops", message: "interrupted" }`, "Oops"],
      [`throw "out of memory"`, undefined],
    ] as const) {
      const ref = await put(scripts, code);
      const failure = await expectChannel(
        effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
        "scriptError"
      );
      expect((failure.payload as { name?: string }).name, code).toBe(name);
    }
  });

  it("an InternalError reads as a CPU kill only when its whole message is `interrupted`", async () => {
    const { scripts, effects } = await bootEngine();
    const exact = await put(scripts, `throw new InternalError("interrupted")`);
    const kill = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: exact }, baseCtx),
      "limitExceeded"
    );
    expect(kill.payload).toEqual({ kind: "cpu" });

    const partial = await put(scripts, `throw new InternalError("request was interrupted")`);
    const own = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: partial }, baseCtx),
      "scriptError"
    );
    expect(own.payload).toMatchObject({
      name: "InternalError",
      message: "request was interrupted",
    });
  });

  it("the engine's own InternalError for memory is still limitExceeded; a stack overflow is the script's", async () => {
    const { scripts, effects } = await bootEngine({
      limits: { memoryBytes: 4 * 1024 * 1024, interruptBudget: 1_000_000, wallClockMs: 60_000 },
    });
    const oom = await put(scripts, `let a = "x"; while (true) { a += a; } a`);
    const kill = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: oom }, baseCtx),
      "limitExceeded"
    );
    expect(kill.payload).toEqual({ kind: "memory" });

    const recursion = await put(scripts, "function f() { return f(); } f()");
    const overflow = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: recursion }, baseCtx),
      "scriptError"
    );
    expect(overflow.payload).toMatchObject({ name: "InternalError" });
  });

  it("hostile thrown values yield a bounded, schema-valid payload and never a host throw", async () => {
    // Generous wall clock: 10 MB of text is slow on a loaded host, and this test is about
    // the payload, not the clock.
    const { scripts, effects } = await bootEngine({ limits: { wallClockMs: 60_000 } });
    const cases = [
      // A Proxy whose every trap throws.
      "throw new Proxy({}, { get() { throw 3; }, ownKeys() { throw 4; }, getOwnPropertyDescriptor() { throw 5; } })",
      // Throwing getters for the very fields that are read.
      `throw { get message() { throw new Error("g"); }, get name() { throw 1; } }`,
      // Throwing toString and toJSON.
      "throw { toString() { throw 1; }, toJSON() { throw 2; } }",
      // A cyclic object (no JSON encoding).
      "const o = {}; o.o = o; throw o",
      // 10 MB of text, as a string and as an Error message.
      `throw "y".repeat(10 * 1024 * 1024)`,
      `throw new Error("x".repeat(10 * 1024 * 1024))`,
      // A getter returning a megabyte-long name.
      `throw { get name() { return "N".repeat(1e6); }, message: "m" }`,
      "throw Symbol('s')",
      "throw 10n",
      "throw function f() {}",
    ];
    for (const code of cases) {
      const ref = await put(scripts, code);
      const failure = await expectChannel(
        effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
        "scriptError"
      );
      const parsed = SANDBOX_ERRORS.scriptError.safeParse(failure.payload);
      expect(parsed.success, code).toBe(true);
      expect(
        Object.keys(failure.payload as object).every((k) => k === "name" || k === "message")
      ).toBe(true);
    }
    // Looping while being inspected is caught by the guards that are still armed. A small
    // CPU budget and a huge wall clock, so the kind is deterministic under load.
    const looping = await bootEngine({ limits: { interruptBudget: 50, wallClockMs: 60_000 } });
    for (const code of [
      "throw { toJSON() { for (;;) {} } }",
      "throw new Proxy({}, { get() { for (;;) {} } })",
    ]) {
      const ref = await put(looping.scripts, code);
      const failure = await expectChannel(
        looping.effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
        "limitExceeded"
      );
      expect(failure.payload, code).toEqual({ kind: "cpu" });
    }
  });

  it("text is well-formed: truncation never splits a surrogate pair, lone surrogates and NUL become U+FFFD", async () => {
    const { scripts, effects } = await bootEngine();
    // Script SOURCE carries `\u` escapes (String.raw), so the surrogates are made by the
    // script at run time — a literal lone surrogate would not survive UTF-8 encoding of the
    // source and would prove nothing.
    const cases: [string, string][] = [
      // A pair straddling the 2048 cut is dropped whole, never halved.
      [String.raw`throw new Error("a".repeat(2047) + "\u{1F600}")`, "a".repeat(2047)],
      // A pair inside the bound survives intact.
      [String.raw`throw new Error("ok \u{1F600}")`, "ok \u{1F600}"],
      // Lone surrogates from the script itself, and NUL (both unstorable in Postgres jsonb).
      [String.raw`throw new Error("x\uD800y\uDC00z\u0000")`, "x\uFFFDy\uFFFDz\uFFFD"],
      [String.raw`throw "\uD83D"`, "\uFFFD"],
    ];
    for (const [code, expected] of cases) {
      const ref = await put(scripts, code);
      const failure = await expectChannel(
        effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
        "scriptError"
      );
      const { message } = failure.payload as { message: string };
      expect(message, code).toBe(expected);
      expect(LONE_SURROGATE.test(message)).toBe(false);
      expect(LONE_SURROGATE.test(failure.message)).toBe(false);
    }
    const named = await put(
      scripts,
      String.raw`const e = new Error("m"); e.name = "n".repeat(127) + "\u{1F600}"; throw e`
    );
    const failure = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: named }, baseCtx),
      "scriptError"
    );
    expect((failure.payload as { name: string }).name).toBe("n".repeat(127));
  });

  it("a guard kill stays limitExceeded even when the script catches and rethrows", async () => {
    const { scripts, effects } = await bootEngine({
      limits: { interruptBudget: 50, wallClockMs: 60_000 },
    });
    const ref = await put(
      scripts,
      `try { while (true) {} } catch (e) { throw new Error("swallowed the kill"); }`
    );
    const failure = await expectChannel(
      effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx),
      "limitExceeded"
    );
    expect(failure.payload).toEqual({ kind: "cpu" });
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

describe("sandboxEval — scriptError vs infrastructure", () => {
  it("a worker-pool failure is NOT scriptError: it stays an untyped Error", async () => {
    const { scripts, effects, effect } = await boot({ workers: { count: 1 } });
    const ref = await put(scripts, `throw new Error("never runs")`);
    await effect.close();
    const err = await effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypedFailure);
    expect((err as Error).message).toMatch(/worker pool closed/);
  });

  it("an integrity failure (bytes do not match the pinned address) is NOT scriptError", async () => {
    const scripts = new InMemoryContentStore();
    const ref = await put(scripts, `throw new Error("x")`);
    const effects = new EffectRuntime();
    registerSandboxEval(effects, { get: async () => encoder.encode(`throw new Error("y")`) });
    const err = await effects.execute(SANDBOX_TOOL_ID, { scriptRef: ref }, baseCtx).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).not.toBeInstanceOf(TypedFailure);
    expect((err as Error).message).toMatch(/do not match their content address/);
  });
});

describe("sandboxEval — scriptError replay", () => {
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

  /** Catch whatever the step threw, wait for a gate, and report what was caught. */
  const runnerFor =
    (scriptRef: { __loomContent: string }): FlowRunner<
      Record<string, unknown>,
      Record<string, unknown>
    > =>
    async (ctx) => {
      try {
        await ctx.run(sandboxEval$("reshape#0"), { scriptRef });
        return { branch: "success" };
      } catch (err) {
        await (ctx.suspend({ on: "RepairDone" }) as Promise<unknown>);
        return {
          branch: err instanceof TypedFailure ? `typed:${err.channel}` : "untyped",
        };
      }
    };

  it("a scriptError is recorded typed and replays with ZERO re-evaluation", async () => {
    const scripts = new InMemoryContentStore();
    const ref = await put(scripts, `throw new RangeError("row 9 out of range")`);
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const runtimeCounting = (counter: { reads: number }) => {
      const effects = new EffectRuntime();
      registerSandboxEval(effects, {
        get: (r) => {
          counter.reads++;
          return scripts.get(r);
        },
      });
      const rt = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime: effects });
      rt.registerFlow(flowDef, runnerFor(ref));
      return rt;
    };

    const first = { reads: 0 };
    const rt1 = runtimeCounting(first);
    const started = await rt1.start(
      { definition: flowDef, runner: runnerFor(ref) },
      {},
      { executionId: "se-1" }
    );
    await started.waitForSuspend();
    expect(first.reads).toBe(1);
    const failed = (await eventStore.read("se-1")).filter((e) => e.eventType === "STEP_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({
      stepId: "reshape#0",
      channel: "scriptError",
      payload: { name: "RangeError", message: "row 9 out of range" },
    });

    const second = { reads: 0 };
    const done = await runtimeCounting(second).resume("se-1", {
      eventType: "RepairDone",
      payload: {},
    });
    const state = await done.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(state.variables._output).toEqual({ branch: "typed:scriptError" });
    expect(second.reads).toBe(0); // substituted, never re-evaluated
  });

  it("an OLD log's untyped script failure is not retroactively typed: its event and fold are untouched, and it keeps legacy re-execution", async () => {
    const scripts = new InMemoryContentStore();
    const ref = await put(scripts, `throw new Error("x")`);
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();

    // Record the log exactly as the pre-scriptError effect did: a plain Error, no channel.
    const legacy = new EffectRuntime();
    legacy.register(SANDBOX_TOOL_ID, {
      kind: "tool",
      idempotent: true,
      async execute() {
        throw new Error("sandbox script failed: Error: x");
      },
    });
    const rt1 = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime: legacy });
    rt1.registerFlow(flowDef, runnerFor(ref));
    const started = await rt1.start(
      { definition: flowDef, runner: runnerFor(ref) },
      {},
      { executionId: "old-1" }
    );
    await started.waitForSuspend();
    const recorded = await eventStore.read("old-1");
    const oldFailure = recorded.find((e) => e.eventType === "STEP_FAILED");
    expect(oldFailure?.payload).toEqual({
      stepId: "reshape#0",
      error: "Error: sandbox script failed: Error: x",
    });

    // Resume under the NEW effect. An untyped frame has no errorChannel, so it is
    // never substituted as scriptError — ADR 0060 G2 legacy re-execution applies, and
    // the recorded prefix is left exactly as written.
    const reads = { n: 0 };
    const current = new EffectRuntime();
    registerSandboxEval(current, {
      get: (r) => {
        reads.n++;
        return scripts.get(r);
      },
    });
    const rt2 = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime: current });
    rt2.registerFlow(flowDef, runnerFor(ref));
    const done = await rt2.resume("old-1", { eventType: "RepairDone", payload: {} });
    const state = await done.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(reads.n).toBe(1); // re-executed, as every untyped failure always was
    // The re-execution's outcome is today's effect's — typed now. That is what legacy
    // re-execution has always meant: an untyped failure was never a recorded outcome.
    expect(state.variables._output).toEqual({ branch: "typed:scriptError" });

    const after = await eventStore.read("old-1");
    expect(after.slice(0, recorded.length)).toEqual(recorded); // the old prefix is byte-identical
  });
});
