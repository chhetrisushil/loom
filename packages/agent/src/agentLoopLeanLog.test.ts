import type { EventEnvelope, FlowDefinition, ToolDefinition } from "@loom/core";
import { TypedFailure, agent$, canonicalJson, sha256Hex, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryArchiveStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { LogLifecycle, WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentLoopConfig, agentLoop$ } from "./agentLoop$";
import { createAgentModelEffect } from "./createAgentModelEffect";
import { AGENT_INTERRUPTED, type InterruptedAgentRun } from "./interrupted";
import type { AgentOutput, AgentStep, LeanAgentStep } from "./types";
import { isLeanAgentStep } from "./types";

// ADR 0142 / issue #732 - `toolCallLog: "full" | "lean"`.

const mk = (id: string): ToolDefinition =>
  tool$({
    id,
    name: id,
    description: id,
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
  });
const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "lean",
  name: "lean",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};
const TURNS = 4;

interface Boot {
  config?: Partial<AgentLoopConfig>;
  store?: InMemoryAsyncEventStore;
  /** Wrap the loop so an `agentInterrupted` failure is returned, not thrown. */
  catchInterrupted?: boolean;
  abortOnTool?: AbortController;
  /** What the "big" tool returns (default: a plain object). */
  bigOutput?: (input: { n: number }) => unknown;
  /** Park on a gate after the loop, so a test can compact the finished log. */
  suspendAfter?: boolean;
  snapshotStore?: InMemoryAsyncSnapshotStore;
}

function boot(o: Boot = {}) {
  const provider: LlmProvider = {
    async complete(r): Promise<LlmResponse> {
      const n = r.messages.filter((m) => m.role === "assistant").length;
      return n < TURNS
        ? {
            content: `t${n}`,
            // turn 1 calls the flaky tool: its failure is fed back as an error, the run goes on
            toolCalls: [{ id: `c${n}`, name: n === 1 ? "flaky" : "big", input: { n } }],
            stopReason: "tool_use",
          }
        : { content: "done", stopReason: "end_turn" };
    },
  };
  const effects = new EffectRuntime([], {});
  effects.register("model", createAgentModelEffect(provider));
  effects.register(
    "big",
    new ToolEffect(async (input) => {
      o.abortOnTool?.abort();
      const n = (input as { n: number }).n;
      return o.bigOutput !== undefined ? o.bigOutput({ n }) : { n, b: [1, 2], a: "x".repeat(3000) };
    })
  );
  effects.register(
    "flaky",
    new ToolEffect(async () => {
      throw new Error("boom");
    })
  );
  const store = o.store ?? new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: o.snapshotStore ?? new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail",
    scopes: true,
  });
  const config: AgentLoopConfig = {
    definition: agent$({ id: "a", name: "A", tools: [mk("big"), mk("flaky")] }),
    modelToolId: "model",
    maxIterations: 20,
    ...o.config,
  };
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    try {
      const out = await agentLoop$(ctx, config, { prompt: "go" });
      if (o.suspendAfter === true) await ctx.suspend({ on: "go" });
      return out;
    } catch (e) {
      if (
        o.catchInterrupted === true &&
        e instanceof TypedFailure &&
        e.channel === AGENT_INTERRUPTED
      )
        return { interrupted: e.payload };
      throw e;
    }
  };
  runtime.registerFlow(flowDef, runner);
  return { runtime, store };
}
type Booted = ReturnType<typeof boot>;
const run = async (b: Booted, id = "e1") =>
  (await b.runtime.start(flowDef, {}, { executionId: id })).waitForCompletion();
const outputOf = (st: { variables: Record<string, unknown> }) =>
  st.variables._output as AgentOutput;
const logShape = (events: EventEnvelope[]) =>
  JSON.stringify(events.map((e) => ({ t: e.eventType, p: e.payload })));
const stepOf = (e: EventEnvelope): string =>
  String((e.payload as { stepId?: string }).stepId ?? "");

/** Crash after the log prefix before `fromTurn`, then resume on a fresh runtime with `config`. */
async function resumeWith(
  store: InMemoryAsyncEventStore,
  fromTurn: number,
  config: Boot["config"],
  extra: Pick<Boot, "bigOutput"> & { fresh?: () => InMemoryAsyncEventStore } = {}
) {
  const full = await store.read("e1");
  const cutoff = full.findIndex((e) => stepOf(e).startsWith(`a#turn:${fromTurn}`));
  expect(cutoff).toBeGreaterThan(0);
  const prefix = full.slice(0, cutoff);
  const crashed = extra.fresh?.() ?? new InMemoryAsyncEventStore();
  for (const e of prefix) await crashed.append(e);
  const folded = new ReplayVM(await crashed.read("e1"), {
    executionId: "e1",
    workflowId: "lean",
    workflowVersion: "1.0.0",
  }).getState();
  const b = boot({
    store: crashed,
    ...(config !== undefined && { config }),
    ...(extra.bigOutput !== undefined && { bigOutput: extra.bigOutput }),
  });
  return (await b.runtime.restoreFromState(folded)).waitForCompletion();
}

describe("toolCallLog: default is byte-identical", () => {
  it('unset returns the historical shape; explicit "full" differs only by its pin decision', async () => {
    const unset = boot();
    const full = boot({ config: { toolCallLog: "full" } });
    const a = await run(unset);
    const b = await run(full);
    expect(a.status).toBe("completed");
    const withoutPin = (await full.store.read("e1")).filter(
      (e) => (e.payload as { decisionId?: string }).decisionId !== "a#toolCallLog"
    );
    expect(logShape(withoutPin)).toBe(logShape(await unset.store.read("e1")));
    const log = outputOf(a).toolCallLog;
    expect(log).toHaveLength(TURNS);
    for (const s of log) {
      expect(Object.keys(s).sort()).toEqual(["iteration", "toolInput", "toolName", "toolOutput"]);
    }
    expect(JSON.stringify(outputOf(b))).toBe(JSON.stringify(outputOf(a)));
    // no decision is journaled for the mode in the default
    expect((await unset.store.read("e1")).some((e) => stepOf(e).includes("toolCallLog"))).toBe(
      false
    );
  });
});

describe("toolCallLog: lean", () => {
  it("describes each call: status, bytes, digest of the frame's output, resolvable stepId", async () => {
    const fullB = boot();
    const leanB = boot({ config: { toolCallLog: "lean" } });
    const full = outputOf(await run(fullB)).toolCallLog;
    const leanSt = await run(leanB);
    const lean = outputOf(leanSt).toolCallLog;
    expect(lean).toHaveLength(full.length);
    const events = await leanB.store.read("e1");
    for (const [i, s] of lean.entries()) {
      const f = full[i] as (typeof full)[number];
      if (!isLeanAgentStep(s)) throw new Error("lean expected");
      expect(Object.keys(s).sort()).toEqual([
        "bytes",
        "digest",
        "iteration",
        "status",
        "stepId",
        "toolInput",
        "toolName",
      ]);
      expect(s.toolName).toBe(f.toolName);
      expect(s.toolInput).toEqual(f.toolInput);
      expect(s.iteration).toBe(f.iteration);
      expect(s.stepId).toBe(`a#turn:${i}:tool:0`);
      // a failed tool consumed as feedback is "error", a normal result "ok"
      expect(s.status).toBe(f.toolName === "flaky" ? "error" : "ok");
      // the digest is sha256 of the canonical JSON of the full output
      const canon = canonicalJson(f.toolOutput);
      expect(s.digest).toBe(sha256Hex(canon));
      expect(s.bytes).toBe(new TextEncoder().encode(canon).length);
      // stepId resolves to the tool frame in the log; for an ok call its recorded output IS the digested one
      const frame = events.filter((e) => stepOf(e) === s.stepId);
      expect(frame.length).toBeGreaterThan(0);
      if (s.status === "ok") {
        const out = frame.map((e) => (e.payload as { output?: unknown }).output).find((x) => x);
        expect(sha256Hex(canonicalJson(out))).toBe(s.digest);
      }
    }
  });

  it("is much smaller in the finished state", async () => {
    const fullB = boot();
    const leanB = boot({ config: { toolCallLog: "lean" } });
    const a = JSON.stringify(outputOf(await run(fullB)));
    const b = JSON.stringify(outputOf(await run(leanB)));
    expect(b.length).toBeLessThan(a.length / 2);
  });

  it("applies to the agentInterrupted payload (both modes)", async () => {
    for (const mode of ["full", "lean"] as const) {
      const ctrl = new AbortController();
      const b = boot({
        catchInterrupted: true,
        abortOnTool: ctrl,
        config: { toolCallLog: mode, signal: ctrl.signal },
      });
      const st = await run(b);
      const payload = (st.variables._output as { interrupted: InterruptedAgentRun }).interrupted;
      expect(payload.toolCallLog.length).toBeGreaterThan(0);
      for (const s of payload.toolCallLog) {
        if (mode === "lean") {
          expect(isLeanAgentStep(s)).toBe(true);
          expect("toolOutput" in s).toBe(false);
        } else {
          expect("toolOutput" in s).toBe(true);
          expect("stepId" in s).toBe(false);
        }
      }
    }
  });

  it("digests an output with no canonical form as null (never throws)", async () => {
    const effects = new EffectRuntime([], {});
    let n = 0;
    effects.register(
      "model",
      createAgentModelEffect({
        async complete(): Promise<LlmResponse> {
          return n++ === 0
            ? {
                content: "",
                toolCalls: [{ id: "c", name: "big", input: {} }],
                stopReason: "tool_use",
              }
            : { content: "ok", stopReason: "end_turn" };
        },
      })
    );
    effects.register("big", new ToolEffect(async () => undefined as unknown));
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
    });
    runtime.registerFlow(flowDef, (async (ctx) =>
      agentLoop$(
        ctx,
        {
          definition: agent$({ id: "a", name: "A", tools: [mk("big")] }),
          modelToolId: "model",
          toolCallLog: "lean",
        },
        { prompt: "go" }
      )) as FlowRunner<unknown, unknown>);
    const st = await (await runtime.start(flowDef, {}, { executionId: "n1" })).waitForCompletion();
    expect(st.status).toBe("completed");
    const s = outputOf(st).toolCallLog[0] as AgentStep | LeanAgentStep;
    if (!isLeanAgentStep(s)) throw new Error("lean expected");
    expect(s?.digest).toBeNull();
    expect(s?.bytes).toBe(0);
    expect(s?.status).toBe("ok");
  });

  it("refuses an unknown mode at boot", async () => {
    const b = boot({ config: { toolCallLog: "slim" as never } });
    await expect(run(b)).rejects.toThrow(/toolCallLog must be/);
  });
});

describe("toolCallLog: the mode is pinned per loop (determinism)", () => {
  it("a lean run resumed lean serves the recorded mode and finishes", async () => {
    const first = boot({ config: { toolCallLog: "lean" } });
    const done = await run(first);
    const resumed = await resumeWith(first.store, 2, { toolCallLog: "lean" });
    expect(resumed.status).toBe("completed");
    expect(JSON.stringify(outputOf(resumed))).toBe(JSON.stringify(outputOf(done)));
  });

  it("lean -> full on resume is REFUSED (divergence), not mixed", async () => {
    const first = boot({ config: { toolCallLog: "lean" } });
    await run(first);
    await expect(resumeWith(first.store, 2, { toolCallLog: "full" })).rejects.toThrow(
      /recorded toolCallLog "lean" but is configured "full"/
    );
  });

  it('"full" -> lean on resume is REFUSED the same way', async () => {
    const first = boot({ config: { toolCallLog: "full" } });
    await run(first);
    await expect(resumeWith(first.store, 2, { toolCallLog: "lean" })).rejects.toThrow(
      /recorded toolCallLog "full" but is configured "lean"/
    );
  });

  it("the refusal is a typed AgentLoopConfigError and nothing is appended after the pin", async () => {
    const first = boot({ config: { toolCallLog: "lean" } });
    await run(first);
    const full = await first.store.read("e1");
    const cutoff = full.findIndex((e) => stepOf(e).startsWith("a#turn:2"));
    const crashed = new InMemoryAsyncEventStore();
    for (const e of full.slice(0, cutoff)) await crashed.append(e);
    const b = boot({ store: crashed, config: { toolCallLog: "full" } });
    const folded = new ReplayVM(full.slice(0, cutoff), {
      executionId: "e1",
      workflowId: "lean",
      workflowVersion: "1.0.0",
    }).getState();
    await expect((await b.runtime.restoreFromState(folded)).waitForCompletion()).rejects.toThrow(
      /fixed for the life of a run/
    );
    const after = (await crashed.read("e1")).slice(cutoff);
    expect(after.some((e) => e.eventType === "STEP_STARTED")).toBe(false);
  });
});

/** A store like every real one: it keeps a JSON copy, never the live object the writer holds. */
class CloningEventStore extends InMemoryAsyncEventStore {
  private static clone(e: EventEnvelope): EventEnvelope {
    return JSON.parse(JSON.stringify(e)) as EventEnvelope;
  }
  override async append(e: EventEnvelope): Promise<void> {
    return super.append(CloningEventStore.clone(e));
  }
  override async appendBatch(es: readonly EventEnvelope[]): Promise<void> {
    return super.appendBatch(es.map(CloningEventStore.clone));
  }
  override async appendIfUnchanged(...a: Parameters<InMemoryAsyncEventStore["appendIfUnchanged"]>) {
    const [id, ev, expect] = a;
    return super.appendIfUnchanged(id, ev === null ? null : CloningEventStore.clone(ev), expect);
  }
}

class Boxed {
  constructor(private readonly v: number) {}
  toJSON() {
    return { boxed: this.v };
  }
}

const recordedOutput = (events: EventEnvelope[], stepId: string): unknown =>
  events
    .filter((e) => e.eventType === "STEP_COMPLETED" && stepOf(e) === stepId)
    .map((e) => (e.payload as { output?: unknown }).output)[0];

describe("toolCallLog: lean digest equals the canonical form of what the log RECORDS (ADR 0142 D2)", () => {
  const shapes: Record<string, (i: { n: number }) => unknown> = {
    Date: ({ n }) => ({ n, d: new Date(0) }),
    "toJSON class": ({ n }) => ({ n, c: new Boxed(n) }),
    Map: ({ n }) => ({ n, m: new Map([["k", 1]]) }),
  };
  for (const [name, bigOutput] of Object.entries(shapes)) {
    it(`${name}: live and resumed digests match the recorded STEP_COMPLETED output`, async () => {
      const first = boot({
        store: new CloningEventStore(),
        bigOutput,
        config: { toolCallLog: "lean" },
      });
      const done = await run(first);
      const events = await first.store.read("e1");
      const log = outputOf(done).toolCallLog;
      const oks = log.filter((s) => isLeanAgentStep(s) && s.status === "ok");
      expect(oks.length).toBeGreaterThan(0);
      for (const s of oks) {
        if (!isLeanAgentStep(s)) throw new Error("lean expected");
        const recorded = recordedOutput(events, s.stepId);
        expect(recorded).toBeDefined();
        expect(s.digest).toBe(sha256Hex(canonicalJson(recorded)));
        expect(s.bytes).toBe(new TextEncoder().encode(canonicalJson(recorded)).length);
      }
      // a resumed run (earlier frames come back JSON-parsed from the fold) digests identically
      const resumed = await resumeWith(
        first.store,
        2,
        { toolCallLog: "lean" },
        { bigOutput, fresh: () => new CloningEventStore() }
      );
      expect(resumed.status).toBe("completed");
      expect(JSON.stringify(outputOf(resumed).toolCallLog)).toBe(JSON.stringify(log));
    });
  }
});

describe("toolCallLog: lean errors and unframed calls (ADR 0142 D1)", () => {
  it("an error entry's digest matches the `failed` value of its <stepId>:outcome decision", async () => {
    const b = boot({ store: new CloningEventStore(), config: { toolCallLog: "lean" } });
    const log = outputOf(await run(b)).toolCallLog;
    const events = await b.store.read("e1");
    const errs = log.filter((s) => isLeanAgentStep(s) && s.status === "error");
    expect(errs.length).toBe(1);
    const e = errs[0];
    if (e === undefined || !isLeanAgentStep(e)) throw new Error("lean expected");
    // the failed tool's frame carries NO output ...
    expect(recordedOutput(events, e.stepId)).toBeUndefined();
    // ... the fed-back failure is in the decision
    const dec = events.find(
      (x) =>
        x.eventType === "DECISION_RECORDED" &&
        (x.payload as { decisionId?: string }).decisionId === `${e.stepId}:outcome`
    );
    expect(dec).toBeDefined();
    const failed = (dec?.payload as { choice?: { failed?: unknown } }).choice?.failed;
    expect(failed).toBeDefined();
    expect(e.digest).toBe(sha256Hex(canonicalJson(failed)));
  });
});

describe("toolCallLog: pin written late (ADR 0142 D3)", () => {
  it("an old run with no pin, resumed with an explicit mode, journals the pin late and rebuilds the whole log in the new shape", async () => {
    const first = boot(); // unset: no pin journaled
    await run(first);
    expect((await first.store.read("e1")).some((e) => stepOf(e).includes("toolCallLog"))).toBe(
      false
    );
    const resumed = await resumeWith(first.store, 2, { toolCallLog: "lean" });
    expect(resumed.status).toBe("completed");
    const log = outputOf(resumed).toolCallLog;
    expect(log).toHaveLength(TURNS);
    // not mixed: EVERY entry is lean, including the turns that were already journaled before the resume
    expect(log.every((s) => isLeanAgentStep(s))).toBe(true);
  });

  it("lean then resumed with the option UNSET is not detected: the log is rebuilt full (documented limit)", async () => {
    const first = boot({ config: { toolCallLog: "lean" } });
    await run(first);
    const resumed = await resumeWith(first.store, 2, undefined);
    expect(resumed.status).toBe("completed");
    expect(outputOf(resumed).toolCallLog.every((s) => !isLeanAgentStep(s))).toBe(true);
  });
});

describe("toolCallLog: lean entries resolve after ADR 0138 compaction", () => {
  it("the stepId is found in the archive and its recorded output verifies the digest", async () => {
    const archive = new InMemoryArchiveStore();
    const b = boot({ suspendAfter: true, config: { toolCallLog: "lean" } });
    const h = await b.runtime.start(flowDef, {}, { executionId: "c1" });
    await h.waitForSuspend();
    const life = new LogLifecycle(b.store, new InMemoryAsyncSnapshotStore(), {
      compactionArchive: archive,
    });
    expect(await life.compact("c1")).not.toBeNull();
    const live = await b.store.read("c1");
    const archived = await life.readArchived("c1");
    const st = await b.runtime.loadState("c1");
    expect(st?.status).toBe("suspended");
    const toolFrames = archived.filter(
      (e) => e.eventType === "STEP_COMPLETED" && /^a#turn:\d+:tool:0$/.test(stepOf(e))
    );
    // the frames were MOVED out of the live log into the archive ...
    expect(live.some((e) => /^a#turn:\d+:tool:0$/.test(stepOf(e)))).toBe(false);
    expect(toolFrames.length).toBeGreaterThan(0);
    // ... and a lean entry (taken from the run's output) resolves there and verifies
    const resumedState = await (
      await b.runtime.resume("c1", { eventType: "go", payload: {} })
    ).waitForCompletion();
    const lean = outputOf(resumedState).toolCallLog;
    const ok = lean.filter((s) => isLeanAgentStep(s) && s.status === "ok");
    expect(ok.length).toBeGreaterThan(0);
    for (const s of ok) {
      if (!isLeanAgentStep(s)) throw new Error("lean expected");
      const rec = recordedOutput(archived, s.stepId);
      expect(sha256Hex(canonicalJson(rec))).toBe(s.digest);
    }
  });
});
