import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordOutcome } from "@loom/analytics";
import { step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { cmdLearnEval, cmdLearnReport } from "./learn";

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const noop = step$({ id: "n", name: "N", toolId: "n-tool", ...io });

/** Records a learnable decision: context + policy stamp + alternatives + a scored outcome. */
const learnable: FlowRunner<unknown, unknown> = async (ctx: WorkflowContext) => {
  const route = await ctx.decide("route", () => "opus", {
    context: { tokens: 100 },
    policy: { id: "logger", version: "1", propensity: 0.5 },
    alternatives: ["gemma", "opus"],
  });
  recordOutcome(ctx, { key: route as string, score: 0.9, decisionId: "route" });
  return { route };
};

/** The old, unlearnable shape: a bare decide with no context and an unlinked outcome. */
const blind: FlowRunner<unknown, unknown> = async (ctx: WorkflowContext) => {
  const route = await ctx.decide("route", () => "opus");
  recordOutcome(ctx, { key: route as string, score: 0.9 });
  return { route };
};

function makeFlow(runner: FlowRunner<unknown, unknown>): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "f",
      name: "F",
      version: "1.0.0",
      ...io,
      steps: [noop],
    },
    runner,
  } as RegisteredFlow;
}

describe("loom learn", () => {
  let dir: string;
  let dbPath: string;

  async function record(runner: FlowRunner<unknown, unknown>): Promise<string> {
    const eventStore = new SqliteEventStore(dbPath);
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new SqliteSnapshotStore(join(dir, "snap.db")),
      effectRuntime: new EffectRuntime(),
    });
    const flow = makeFlow(runner);
    runtime.registerFlow(flow.definition, flow.runner);
    const handle = await runtime.start(flow, {});
    await handle.waitForCompletion();
    eventStore.close();
    return handle.executionId;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-learn-"));
    dbPath = join(dir, "events.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("report summarizes coverage and per-arm rewards", async () => {
    const id = await record(learnable);
    const text = await cmdLearnReport({ db: dbPath }, id);
    expect(text).toMatch(/1 execution\(s\), 1 decision\(s\)/);
    expect(text).toMatch(/with context\s+1 \(100%\)/);
    expect(text).toMatch(/with propensity\s+1 \(100%\)/);
    expect(text).toMatch(/opus\s+0\.9000\s+n=1/);
    expect(text).not.toMatch(/Blocking gaps/);
  });

  it("report names the gaps that make a log unlearnable", async () => {
    const id = await record(blind);
    const text = await cmdLearnReport({ db: dbPath }, id);
    expect(text).toMatch(/Blocking gaps/);
    expect(text).toMatch(/no decision recorded a context/);
    expect(text).toMatch(/no decision recorded a propensity/);
    expect(text).toMatch(/no outcome names a decisionId/);
  });

  it("report says so when there is nothing to learn from", async () => {
    const eventStore = new SqliteEventStore(dbPath);
    eventStore.close();
    expect(await cmdLearnReport({ db: dbPath })).toMatch(/no events|no decisions/);
  });

  it("eval shadow-evaluates a policy module and refuses promotion on thin evidence", async () => {
    const id = await record(learnable);
    const mod = join(dir, "policy.js");
    writeFileSync(
      mod,
      "module.exports.policy = { id: 'always-opus', version: '1', select: () => ({ action: 'opus' }) };"
    );
    const { text, ok } = await cmdLearnEval({ db: dbPath }, mod, { executionId: id });
    expect(text).toMatch(/always-opus@1/);
    expect(text).toMatch(/GATE: refused/);
    expect(ok).toBe(false); // one step is not evidence, and the gate says so
  });

  it("eval passes the gate once the thresholds match the evidence", async () => {
    const id = await record(learnable);
    const mod = join(dir, "policy.js");
    writeFileSync(
      mod,
      "module.exports.policy = { id: 'always-opus', version: '1', select: () => ({ action: 'opus' }) };"
    );
    const { text, ok } = await cmdLearnEval({ db: dbPath }, mod, { executionId: id, minSteps: 1 });
    expect(text).toMatch(/GATE: pass/);
    expect(ok).toBe(true);
  });

  it("eval rejects a module that does not export a Policy", async () => {
    const id = await record(learnable);
    const mod = join(dir, "bad.js");
    writeFileSync(mod, "module.exports.somethingElse = 1;");
    const { text, ok } = await cmdLearnEval({ db: dbPath }, mod, { executionId: id });
    expect(ok).toBe(false);
    expect(text).toMatch(/does not export a Policy/);
  });
});
