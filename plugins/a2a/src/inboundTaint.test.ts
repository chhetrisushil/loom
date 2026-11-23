import type { FlowDefinition } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { InMemoryGrantBroker, lineageOrigin } from "@loomwork/task-authority";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LoomAgentExecutor } from "./AgentExecutor";
import type { A2ATask } from "./types";

// ADR 0150 D7 / S-R7: A2A ingress taints what the peer sends, plus the peer's VERIFIED lineage.
const SECRET = "a2a-secret";
const probeTask = { _tag: "TaskDefinition", kind: "tool", id: "p", toolId: "probe" } as never;
const world = (opts: ConstructorParameters<typeof LoomAgentExecutor>[2], typed = false) => {
  const seen: (readonly string[] | undefined)[] = [];
  const effects = new EffectRuntime();
  effects.register(
    "probe",
    new ToolEffect(async (_i: unknown, ctx) => {
      seen.push(ctx.seenOrigins?.());
      return 1;
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    seenOriginsEnabled: true,
    onWarn: () => {},
  });
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    await ctx.suspend({ on: "InputProvided", correlationKey: "k" });
    await ctx.run(probeTask, {});
    return "done";
  };
  const definition = {
    _tag: "FlowDefinition",
    id: "a",
    name: "a",
    version: "1.0.0",
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    steps: [],
    ...(typed && { resumeSchemas: { InputProvided: z.object({ ok: z.boolean() }) } }),
  } as unknown as FlowDefinition;
  runtime.registerFlow(definition, runner);
  const flow = { definition, runner } as RegisteredFlow;
  return { seen, exec: new LoomAgentExecutor(runtime, flow, opts) };
};
const task: A2ATask = {
  id: "t1",
  message: { role: "user", parts: [{ type: "text", text: "hi" }] },
};
const grantFor = (secret: string, taskId: string) =>
  new InMemoryGrantBroker({ secret, now: () => 1 }).mint({
    taskId,
    issuedTo: "peer-a",
    effects: ["x"],
    leases: {},
    ttlMs: 1000,
  });
const run = async (w: ReturnType<typeof world>, principal: Record<string, unknown> | undefined) => {
  const call = principal === undefined ? {} : { principal };
  await w.exec.submit(task, call);
  await new Promise((r) => setTimeout(r, 30));
  await w.exec.provideInput("t1", { eventType: "InputProvided", payload: { ok: true } }, call);
  for (let i = 0; i < 200 && w.seen.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  return w.seen[0];
};

describe("A2A inbound taint", () => {
  it("a peer is labelled a2a-inbound:<actor>, with no lineage when it has no grant", async () => {
    const w = world({ taintInbound: { lineageOf: lineageOrigin(SECRET) } });
    expect(await run(w, { actor: "peer-a" })).toEqual(["a2a-inbound:peer-a"]);
  });

  // kills: reading the rootId from a caller-supplied value (an unsigned or foreign-key grant) instead of a verified grant
  it("a verified grant adds lineage:<rootId>; a forged or foreign-key grant adds nothing", async () => {
    const g = await grantFor(SECRET, "A");
    const ok = await run(world({ taintInbound: { lineageOf: lineageOrigin(SECRET) } }), {
      actor: "peer-a",
      taskGrant: g,
    });
    expect(ok).toEqual(expect.arrayContaining(["lineage:A", "a2a-inbound:peer-a"]));
    const forged = await run(world({ taintInbound: { lineageOf: lineageOrigin(SECRET) } }), {
      actor: "peer-a",
      taskGrant: { ...g, rootId: "VICTIM" },
    });
    expect(forged).toEqual(["a2a-inbound:peer-a"]);
    const foreignKey = await grantFor("someone-elses-secret", "B");
    const other = await run(world({ taintInbound: { lineageOf: lineageOrigin(SECRET) } }), {
      actor: "peer-a",
      taskGrant: foreignKey,
    });
    expect(other).toEqual(["a2a-inbound:peer-a"]);
  });

  // kills: tainting when it was not asked for (the flow input shape must not change by default)
  it("is off by default: nothing is tainted", async () => {
    expect(await run(world({}), { actor: "peer-a" })).toEqual([]);
  });

  it("an anonymous or hostile peer name is labelled safely", async () => {
    const w = world({ taintInbound: true });
    expect(await run(w, undefined)).toEqual(["a2a-inbound:anonymous"]);
    const x = world({ taintInbound: true });
    expect(await run(x, { actor: `evil\nname${"z".repeat(200)}` })).toEqual([
      `a2a-inbound:evil?name${"z".repeat(128 - 9)}`,
    ]);
  });

  // kills (M-8): wrapping the payload of a gate with a resumeSchema (the typed shape would refuse the wrapper)
  it("a resume payload for a gate with a resumeSchema is passed through untouched", async () => {
    const w = world({ taintInbound: true }, true);
    expect(await run(w, { actor: "peer-a" })).toEqual(["a2a-inbound:peer-a"]);
  });
});
