import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime, GrantTable } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryDurableStateStore, durableState } from "@loomwork/plugin-durable-state";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { WorkflowRuntime } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TaskGrantAuthorizer } from "./authorizer";
import { installTaskAuthority } from "./install";
import { InMemoryGrantBroker } from "./renew";

// ADR 0150 D8 (slice-2 S6): the durable-state `load` is a READ whose resource is the key.
const SECRET = "ds-secret";
const NOW = 1_000_000;
const def: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "wf",
  name: "wf",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};

async function run(reads: string[] | undefined, key: string) {
  const store = new InMemoryDurableStateStore();
  const handle = durableState({
    id: "carry",
    version: 1,
    schema: z.object({ n: z.number() }),
    store,
  });
  const toolId = handle.toolIds.load;
  const effects = new EffectRuntime([], {
    authorizer: new TaskGrantAuthorizer({
      secret: SECRET,
      base: new GrantTable({ wf: [toolId, handle.toolIds.save] }),
      now: () => NOW,
    }),
  });
  handle.register(effects);
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const broker = new InMemoryGrantBroker({ secret: SECRET, now: () => NOW });
  installTaskAuthority(runtime, { source: broker, secret: SECRET, now: () => NOW });
  runtime.registerFlow(def, async (ctx) => (await handle.load(ctx, key)).found);
  const g = await broker.mint({
    taskId: "t",
    issuedTo: "a",
    effects: [toolId],
    leases: {},
    ttlMs: 60_000,
    ...(reads !== undefined && { reads }),
  });
  const h = await runtime.start(
    def,
    {},
    { executionId: "e", principal: { actor: "a", taskGrant: g } }
  );
  const state = await h.waitForCompletion().catch(() => undefined);
  return { state, toolId, events: await eventStore.read("e") };
}

describe("durable-state load honours a task grant's reads", () => {
  it("declares itself a read with the key as the resource; save is not a read", () => {
    const h = durableState({
      id: "c",
      version: 1,
      schema: z.object({}),
      store: new InMemoryDurableStateStore(),
    });
    expect(h.effects.load.capabilities).toEqual({ read: true });
    expect(h.effects.load.resourceOf?.({ key: "ns/a" })).toBe("ns/a");
    expect(h.effects.save.capabilities).toBeUndefined();
  });

  // kills: a load with no resourceOf (the key is invisible to reads) and a load not marked a read
  it("a key covered by reads loads", async () => {
    const toolId = (await run([], "ns/a")).toolId;
    const r = await run([`${toolId}:ns/*`], "ns/a");
    expect(r.state?.status).toBe("completed");
  });

  // kills: absent reads allowing, a glob that ignores the key, matching the bare tool id
  for (const reads of [undefined, ["x:ns/*"], "other"] as const) {
    it(`a key outside reads (${JSON.stringify(reads)}) is denied with task-grant:read-scope`, async () => {
      const toolId = (await run([], "ns/a")).toolId;
      const list =
        reads === undefined ? undefined : reads === "other" ? [`${toolId}:other/*`] : [...reads];
      const r = await run(list, "ns/a");
      const denied = r.events.filter((e) => e.eventType === "EFFECT_DENIED");
      expect(denied).toHaveLength(1);
      expect(JSON.stringify(denied[0]?.payload)).toContain("task-grant:read-scope");
      expect(r.events.some((e) => e.eventType === "EXECUTION_COMPLETED")).toBe(false);
    });
  }
});
