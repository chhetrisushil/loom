import { agent$, flow$, step$, tool$ } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import { verify } from "@loomwork/verify";
import { WorkflowRuntime } from "@loomwork/workflow-runtime";
import type { FlowRunner } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveVerifyInput } from "./verifyAdapter";

function runtimeOf(flows: Record<string, string[]>): WorkflowRuntime {
  const effects = new EffectRuntime();
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  for (const [id, tools] of Object.entries(flows)) {
    for (const t of tools) effects.register(t, new ToolEffect(async () => ({})));
    runtime.registerFlow(
      flow$({
        id,
        name: id,
        version: "1.0.0",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        steps: tools.map((t) =>
          step$({
            id: `s-${t}`,
            name: t,
            toolId: t,
            inputSchema: z.object({}),
            outputSchema: z.object({}),
          })
        ),
      }),
      (async () => ({})) as FlowRunner<unknown, unknown>
    );
  }
  return runtime;
}

const check = (rt: WorkflowRuntime, taskGrants: Parameters<typeof resolveVerifyInput>[1]) =>
  verify(resolveVerifyInput(rt, taskGrants), { rules: ["task-grant-reach"] }).findings;

describe("task-grant-reach end to end (ADR 0150 D9)", () => {
  const rt = runtimeOf({ parent: ["a"], child: ["c"] });
  const tool = tool$({
    id: "loop-tool",
    name: "l",
    description: "l",
    kind: "tool",
    inputSchema: z.object({}),
    outputSchema: z.object({}),
  });

  it("counts a declared child flow's effects as reachable, and flags what nothing reaches", () => {
    // kills: ignoring child edges (false over-broad) or ignoring the comparison
    const ok = check(rt, {
      taskGrants: [
        { flowId: "parent", effects: ["a", "c"], reach: { children: { parent: ["child"] } } },
      ],
    });
    expect(ok).toEqual([]);
    const bad = check(rt, { taskGrants: [{ flowId: "parent", effects: ["a", "c"] }] });
    expect(bad.map((f) => f.severity)).toEqual(["warn"]);
    expect(bad[0]?.message).toContain('"c"');
  });

  it("counts an agent loop's menu as reachable", () => {
    const l = { definition: agent$({ id: "x", name: "x", tools: [tool] } as never) };
    const f = check(rt, {
      taskGrants: [
        { flowId: "parent", effects: ["a", "loop-tool"], reach: { agentLoops: { parent: [l] } } },
      ],
    });
    expect(f).toEqual([]);
  });
});
