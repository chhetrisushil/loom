import { agentStep$ } from "@loom/agent";
import { agent$, flow$, step$, tool$ } from "@loom/core";
import type { StepDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { verify } from "@loom/verify";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveVerifyInput } from "./verifyAdapter";

// ── R3 — an agent's declared tool menu IS its reachable effect set ────────────
//
// `resolveVerifyInput` builds `FlowSpec.effects` from declared steps plus
// runner-body reach. An agent step declares no `toolId` of its own and its
// `AgentDefinition.tools` were read by nothing, so a flow hosting an agent
// contributed an EMPTY effect set: `capability-compat` checked nothing,
// `effect-class` passed vacuously, and ADR 0084's "N reachable effects carry no
// class" warn — written precisely to stop a clean pass over unclassified
// effects — could not fire either.
//
// K2's runtime floor was never in question: `EffectRuntime.execute` authorizes
// every agent-chosen tool by `toolId`, so an ungranted tool is still denied at
// run time. What was missing is the STATIC ceiling — the half that answers
// "what is this allowed to do" BEFORE approval.

const deleteTable = tool$({
  id: "delete-table",
  name: "Delete Table",
  description: "Drops a table",
  kind: "tool",
  inputSchema: z.object({ table: z.string() }),
  outputSchema: z.object({}),
});

const readRows = tool$({
  id: "read-rows",
  name: "Read Rows",
  description: "Reads rows",
  kind: "tool",
  inputSchema: z.object({ table: z.string() }),
  outputSchema: z.object({}),
});

const dbaAgent = agent$({
  id: "dba",
  name: "DBA",
  tools: [readRows, deleteTable],
});

/** A flow whose only step is `agentStep`, declaring `effectClass` at the flow level. */
function runtimeWith<I, O>(
  agentStep: StepDefinition<I, O>,
  flowEffectClass?: string
): WorkflowRuntime {
  const effects = new EffectRuntime();
  effects.register("read-rows", new ToolEffect(async () => ({})));
  effects.register("delete-table", new ToolEffect(async () => ({})));
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const definition = flow$({
    id: "dba-flow",
    name: "dba-flow",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    steps: [agentStep],
    ...(flowEffectClass !== undefined && { effectClass: flowEffectClass }),
  });
  runtime.registerFlow(definition, (async () => ({})) as FlowRunner<unknown, unknown>);
  return runtime;
}

/**
 * The REAL producer. Driving `agentStep$` rather than a hand-built look-alike is
 * what makes this end-to-end: a test that mimicked the shape would keep passing if
 * `agentStep$` stopped declaring its menu, which is the failure being guarded.
 */
function agentStepFor() {
  return agentStep$({
    id: "ask-dba",
    agent: dbaAgent,
    provider: { complete: async () => ({ content: "", stopReason: "end_turn" as const }) },
    effectRuntime: new EffectRuntime(),
  });
}

describe("agent tool menu as a reachable effect set (R3)", () => {
  it("contributes every declared agent tool to the flow's effect set", () => {
    const spec = resolveVerifyInput(runtimeWith(agentStepFor())).flows?.[0];
    expect(spec?.effects?.map((e) => e.toolId).sort()).toEqual(["delete-table", "read-rows"]);
  });

  it("requires a grant for each tool the agent can reach", () => {
    // capability-compat previously checked ONE capability — the step's own — for a
    // flow whose agent holds a menu. A grant table covering only the harmless tool
    // must now be a finding.
    const findings = verify(
      {
        ...resolveVerifyInput(runtimeWith(agentStepFor())),
        grants: { grants: { "dba-flow": ["read-rows"] } },
      },
      { rules: ["capability-compat"] }
    );
    expect(findings.findings.map((f) => f.message).join(" ")).toContain("delete-table");
  });

  it("stops a read-only flow from passing while hosting a destructive tool", () => {
    // The headline case: a flow declaring `read-only` while its agent holds
    // `delete-table`. Unclassified effects cannot prove the ceiling, so the flow
    // must no longer read as verified.
    const report = verify(
      {
        ...resolveVerifyInput(runtimeWith(agentStepFor(), "read-only")),
        effectClasses: ["read-only", "external-write"],
      },
      { rules: ["effect-class"] }
    );
    // Both menu tools are unclassified — a class lives on a step declaration and an
    // agent's tools have none — so the report says "partially verified" instead of
    // passing clean. That is ADR 0084's warn finally reaching an agent flow.
    expect(report.findings).not.toEqual([]);
    expect(report.findings.map((f) => f.message).join(" ")).toContain(
      "2 reachable effect(s) carry no class"
    );
  });

  it("reports nothing for a step that declares no menu (G2)", () => {
    // Every flow that does not host an agent is unchanged, byte for byte.
    const plain = step$({
      id: "plain",
      name: "plain",
      toolId: "read-rows",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    });
    const spec = resolveVerifyInput(runtimeWith(plain)).flows?.[0];
    expect(spec?.effects?.map((e) => e.toolId)).toEqual(["read-rows"]);
  });

  it("does not double-count a tool that is also a declared step", () => {
    const both = step$({
      id: "ask-dba",
      name: "ask-dba",
      toolId: "read-rows",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      reachableTools: [{ id: "read-rows" }, { id: "delete-table" }],
    });
    const spec = resolveVerifyInput(runtimeWith(both)).flows?.[0];
    expect(spec?.effects?.map((e) => e.toolId).sort()).toEqual(["delete-table", "read-rows"]);
  });
});
