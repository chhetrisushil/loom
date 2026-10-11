import { legacyFlowContentHash, step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type FlowResolver, simulateDeploy } from "./deploySim";

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const aStep = step$({ id: "a", name: "A", toolId: "a-tool", ...io });
const bStep = step$({ id: "b", name: "B", toolId: "b-tool", ...io });

const straightRunner: FlowRunner<unknown, unknown> = async (ctx) => {
  await ctx.run(aStep, {});
  await ctx.run(bStep, {});
  return { done: true };
};
const gatedRunner: FlowRunner<unknown, unknown> = async (ctx: WorkflowContext) => {
  await ctx.run(aStep, {});
  await ctx.suspend({ on: "Approved" });
  await ctx.run(bStep, {});
  return { done: true };
};

function def(version = "1.0.0") {
  return {
    _tag: "FlowDefinition" as const,
    id: "flow",
    name: "Flow",
    version,
    ...io,
    steps: [aStep, bStep],
  };
}

async function record(runner: FlowRunner<unknown, unknown>): Promise<EventEnvelope[]> {
  const effects = new EffectRuntime();
  effects.register("a-tool", new ToolEffect(async () => ({ ok: 1 })));
  effects.register("b-tool", new ToolEffect(async () => ({ ok: 2 })));
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const flow = { definition: def(), runner } as RegisteredFlow;
  runtime.registerFlow(flow.definition, flow.runner);
  const handle = await runtime.start(flow, {});
  await Promise.race([handle.waitForCompletion(), handle.waitForSuspend()]);
  return eventStore.read(handle.executionId);
}

/** A resolver exposing a chosen new definition (or nothing, to simulate removal). */
function resolver(newDef?: ReturnType<typeof def>): FlowResolver {
  return { getFlow: (id) => (newDef && id === "flow" ? { definition: newDef } : undefined) };
}

describe("simulateDeploy", () => {
  it("passes when the new deployment is identical", async () => {
    const log = await record(straightRunner);
    const report = simulateDeploy([log], resolver(def()));
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
    expect(report.issues.filter((i) => i.severity === "breaking")).toEqual([]);
  });

  it("flags a breaking flow removal (in-flight run stranded)", async () => {
    const log = await record(straightRunner);
    const report = simulateDeploy([log], resolver(undefined));
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.kind).toBe("flow-missing");
  });

  it("flags a breaking step rename that orphans a recorded output", async () => {
    const log = await record(straightRunner);
    const renamed = {
      ...def(),
      steps: [step$({ id: "a-renamed", name: "A", toolId: "a-tool", ...io }), bStep],
    };
    const report = simulateDeploy([log], resolver(renamed));
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === "step-removed" && i.detail.includes('"a"'))).toBe(
      true
    );
  });

  it("warns about an in-flight suspended execution carried across the deploy", async () => {
    const log = await record(gatedRunner);
    const report = simulateDeploy([log], resolver(def()));
    expect(report.ok).toBe(true); // suspended-carryover is a warning, not breaking
    const carry = report.issues.find((i) => i.kind === "suspended-carryover");
    expect(carry?.detail).toContain("Approved");
  });

  // K11.4 — the census: live executions whose recorded flow-code hash would
  // change under the new deployment make the gate CI-enforceable ("drain or
  // pin before deploy").
  describe("flow-code drift (K11.4)", () => {
    it("flags a LIVE execution whose recorded hash differs from the new deployment", async () => {
      const log = await record(gatedRunner); // suspended = live
      const report = simulateDeploy([log], resolver(def("2.0.0"))); // structural change
      expect(report.ok).toBe(false);
      const drift = report.issues.find((i) => i.kind === "flow-code-drift");
      expect(drift?.severity).toBe("breaking");
      expect(drift?.detail).toMatch(/drain|pin|resumeAs/);
    });

    it("ADR 0113 D1 — a live execution that recorded a legacy fnv1a: hash is judged by the legacy hash of the new code", async () => {
      const log = await record(gatedRunner);
      const legacyOf = (d: ReturnType<typeof def>): string => legacyFlowContentHash(d);
      const withLegacy = (hash: string) =>
        log.map((e) =>
          e.eventType === "EXECUTION_STARTED"
            ? { ...e, payload: { ...(e.payload as object), flowHash: hash } }
            : e
        );
      // same structure: no drift (and no false alarm from comparing fnv1a: with sha256:)
      const same = simulateDeploy([withLegacy(legacyOf(def()))], resolver(def()));
      expect(same.issues.filter((i) => i.kind === "flow-code-drift")).toEqual([]);
      // changed structure: still flagged
      const changed = simulateDeploy([withLegacy(legacyOf(def()))], resolver(def("2.0.0")));
      expect(changed.issues.some((i) => i.kind === "flow-code-drift")).toBe(true);
    });

    it("ignores drift on terminal executions (they never resume)", async () => {
      const log = await record(straightRunner); // completed
      const report = simulateDeploy([log], resolver(def("2.0.0")));
      expect(report.issues.filter((i) => i.kind === "flow-code-drift")).toEqual([]);
    });

    it("skips legacy logs that recorded no hash (G2)", async () => {
      const log = await record(gatedRunner);
      const legacy = log.map((e) =>
        e.eventType === "EXECUTION_STARTED"
          ? { ...e, payload: { input: (e.payload as { input?: unknown }).input } }
          : e
      );
      const report = simulateDeploy([legacy], resolver(def("2.0.0")));
      expect(report.issues.filter((i) => i.kind === "flow-code-drift")).toEqual([]);
    });

    it("skips resolvers that supply only a minimal structural view (no _tag)", async () => {
      const log = await record(gatedRunner);
      const minimal: FlowResolver = {
        getFlow: () => ({ definition: { version: "9.9.9", steps: [{ id: "a" }, { id: "b" }] } }),
      };
      const report = simulateDeploy([log], minimal);
      expect(report.issues.filter((i) => i.kind === "flow-code-drift")).toEqual([]);
    });
  });
});
