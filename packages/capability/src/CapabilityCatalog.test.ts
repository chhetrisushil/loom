import { flow$, handler$, step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CapabilityCatalog } from "./CapabilityCatalog";
import { capability$ } from "./capability$";

class MemEventStore implements EventStore {
  private m = new Map<string, EventEnvelope[]>();
  async append(e: EventEnvelope) {
    const l = this.m.get(e.executionId) ?? [];
    l.push(e);
    this.m.set(e.executionId, l);
  }
  async read(id: string) {
    return this.m.get(id) ?? [];
  }
  async readFrom(id: string, f: number) {
    return (await this.read(id)).filter((e) => e.sequence >= f);
  }
  async subscribe() {
    return () => {};
  }
  async close() {}
}
class MemSnapshotStore implements SnapshotStore {
  private m = new Map<string, Snapshot[]>();
  async save(s: Snapshot) {
    const l = this.m.get(s.executionId) ?? [];
    l.push(s);
    this.m.set(s.executionId, l);
  }
  async loadLatest(id: string) {
    const l = this.m.get(id);
    return l?.length ? (l[l.length - 1] ?? null) : null;
  }
  async loadAt(id: string, seq: number) {
    const l = this.m.get(id);
    if (!l) return null;
    const c = l.filter((s) => s.sequence <= seq);
    return c[c.length - 1] ?? null;
  }
  async loadLatestBefore(id: string, seq: number) {
    return this.loadAt(id, seq);
  }
  async close() {}
}

const echoStep = step$({
  id: "echo",
  name: "Echo",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ reply: z.string() }),
  handler: handler$(async (input: { text: string }) => ({ reply: `got: ${input.text}` })),
});
const echoRunner: FlowRunner<{ text: string }, { reply: string }> = (ctx, input) =>
  ctx.run(echoStep, { text: input.text });
const echoFlow: RegisteredFlow<{ text: string }, { reply: string }> = {
  definition: flow$({
    id: "echo-flow",
    name: "Echo Flow",
    version: "1.0.0",
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ reply: z.string() }),
    steps: [echoStep],
  }),
  runner: echoRunner,
};

const investigate = capability$({
  id: "investigate-incident",
  intent: "Investigate a production incident and recommend a remediation",
  tags: ["ops", "incident", "sre"],
  inputSchema: z.object({ text: z.string() }),
  flow: echoFlow,
});
const scaleCluster = capability$({
  id: "scale-cluster",
  intent: "Scale a database cluster up or down",
  tags: ["ops", "database", "scaling"],
  inputSchema: z.object({ text: z.string() }),
  flow: echoFlow,
});

describe("capability$ + CapabilityCatalog", () => {
  it("registers and lists capabilities", () => {
    const cat = new CapabilityCatalog().register(investigate).register(scaleCluster);
    expect(cat.ids().sort()).toEqual(["investigate-incident", "scale-cluster"]);
    expect(cat.get("scale-cluster")?.intent).toContain("Scale");
  });

  it("find() keyword-scores capabilities by intent/tags", () => {
    const cat = new CapabilityCatalog().register(investigate).register(scaleCluster);
    const matches = cat.find("please investigate the incident on prod");
    expect(matches[0]?.capability.id).toBe("investigate-incident");
    expect(matches[0]?.score).toBeGreaterThan(0);
  });

  it("invoke() runs the capability's flow via a WorkflowRuntime", async () => {
    const cat = new CapabilityCatalog().register(investigate);
    const runtime = new WorkflowRuntime({
      eventStore: new MemEventStore(),
      snapshotStore: new MemSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });
    cat.registerInto(runtime);

    const handle = await cat.invoke(runtime, "investigate-incident", { text: "cpu-001" });
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
  });

  it("invoke() throws for an unknown capability", async () => {
    const cat = new CapabilityCatalog();
    const runtime = new WorkflowRuntime({
      eventStore: new MemEventStore(),
      snapshotStore: new MemSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });
    await expect(cat.invoke(runtime, "nope", {})).rejects.toThrow(/nope/);
  });
});
