import { step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { manifestWarnings, registerFlowsFrom } from "./registerFlows";

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const runner: FlowRunner<unknown, unknown> = async () => ({});

function flow(id: string): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id,
      name: id,
      version: "1.0.0",
      ...io,
      steps: [step$({ id: `${id}-s`, name: id, toolId: `${id}-t`, ...io })],
    },
    runner,
  } as RegisteredFlow;
}

function newRuntime(): WorkflowRuntime {
  return new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
}

describe("registerFlowsFrom", () => {
  it("registers every RegisteredFlow-shaped export, ignoring non-flows", () => {
    const runtime = newRuntime();
    // A module namespace: two flows + noise the scan must skip.
    const mod = {
      AlphaFlow: flow("alpha"),
      BetaFlow: flow("beta"),
      helper: () => 1,
      CONFIG: { nope: true },
      notAFlow: { definition: { id: 123 }, runner },
    };
    const ids = registerFlowsFrom(runtime, mod);
    expect(ids.sort()).toEqual(["alpha", "beta"]);
    expect(runtime.getFlow("alpha")).toBeDefined();
    expect(runtime.getFlow("beta")).toBeDefined();
  });

  it("is idempotent — already-registered ids are skipped", () => {
    const runtime = newRuntime();
    const mod = { A: flow("alpha") };
    expect(registerFlowsFrom(runtime, mod)).toEqual(["alpha"]);
    expect(registerFlowsFrom(runtime, mod)).toEqual([]); // second pass registers nothing new
  });

  it("captures helper-constructed flows (discovery is by shape, not compiler id)", () => {
    const runtime = newRuntime();
    const make = (id: string) => flow(id); // id is a runtime value, invisible to static analysis
    const mod = { X: make("gamma") };
    expect(registerFlowsFrom(runtime, mod)).toEqual(["gamma"]);
  });
});

describe("manifestWarnings", () => {
  it("flags manifest flows that were not registered and surfaces compiler warnings", () => {
    const manifest = {
      flows: {
        alpha: { warnings: [] },
        beta: { warnings: ["step 'beta-x' has neither handler nor toolId"] },
        ghost: { warnings: [] },
      },
    };
    const registered = new Set(["alpha", "beta"]);
    const out = manifestWarnings(manifest, (id) => registered.has(id));
    expect(out).toContain('flow "ghost" is in the manifest but was not registered at boot');
    expect(out.some((m) => m.includes("beta") && m.includes("neither handler"))).toBe(true);
    expect(out.some((m) => m.startsWith('flow "alpha"'))).toBe(false); // clean flow, no noise
  });
});
