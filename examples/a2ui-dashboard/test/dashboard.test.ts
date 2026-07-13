import type { A2UISurfaceState } from "@loom/a2ui";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { PANELS } from "../src/flows";

const flowFor = (agentId: string) => PANELS.find((p) => p.agentId === agentId)!.flow;

describe("a2ui-dashboard", () => {
  it("a2ui:true registers one surface per agent, driven by its own flow", async () => {
    const app = buildApp();
    // The surface exists ONLY because `a2ui: true` registered it for the agent$ —
    // getState throws for an unregistered surface, so this also proves the wiring.
    const handle = await app.runtime.start(flowFor("cpu-agent"), { host: "web-2" });
    await handle.waitForCompletion();

    const cpu = app.projectionRuntime.getState<A2UISurfaceState>("cpu-agent", handle.executionId);
    expect(cpu.title).toBe("CPU");
    expect(cpu.host).toBe("web-2");
    expect(cpu.value).toBe(88);
    expect(cpu.status).toBe("alert"); // 88 >= 80
    expect(cpu.log).toEqual(["probing cpu on web-2…", "CPU = 88% → ALERT"]);
    await app.close();
  });

  it("a healthy host renders an OK panel (deterministic)", async () => {
    const app = buildApp();
    const handle = await app.runtime.start(flowFor("disk-agent"), { host: "web-1" });
    await handle.waitForCompletion();
    const disk = app.projectionRuntime.getState<A2UISurfaceState>("disk-agent", handle.executionId);
    expect(disk.value).toBe(30);
    expect(disk.status).toBe("ok");
    await app.close();
  });

  it("each agent's patches stay on ITS OWN surface — no cross-talk", async () => {
    const app = buildApp();
    const cpu = await app.runtime.start(flowFor("cpu-agent"), { host: "web-2" });
    const mem = await app.runtime.start(flowFor("memory-agent"), { host: "web-2" });
    await cpu.waitForCompletion();
    await mem.waitForCompletion();

    // The memory surface (its own execution) never sees the CPU agent's title/value.
    const memSurface = app.projectionRuntime.getState<A2UISurfaceState>(
      "memory-agent",
      mem.executionId
    );
    expect(memSurface.title).toBe("Memory");
    expect(memSurface.value).toBe(73);
    // And the CPU surface is independently intact.
    const cpuSurface = app.projectionRuntime.getState<A2UISurfaceState>(
      "cpu-agent",
      cpu.executionId
    );
    expect(cpuSurface.title).toBe("CPU");
    await app.close();
  });
});
