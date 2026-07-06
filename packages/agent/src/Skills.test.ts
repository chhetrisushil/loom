import { agent$, instructions$, skill$, tool$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentRunner } from "./AgentRunner";
import { SkillRegistry } from "./SkillRegistry";
import { deterministicSkillSelector } from "./SkillSelector";

function makeEffectContext(): EffectContext {
  return { executionId: "exec-1", stepId: "s", workflowId: "wf-1", attempt: 1, emit: vi.fn() };
}

const restartTool = tool$({
  id: "restart-pool",
  name: "Restart Pool",
  description: "Recycle the connection pool",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
});

describe("SkillRegistry.find", () => {
  it("scores over id/name/description/tags with stable, id-broken ties", () => {
    const reg = new SkillRegistry();
    reg.register(
      skill$({
        id: "diagnose-cpu",
        name: "CPU",
        description: "diagnose cpu saturation",
        tags: ["cpu"],
        instructions: instructions$("a"),
      })
    );
    reg.register(
      skill$({
        id: "diagnose-disk",
        name: "Disk",
        description: "diagnose disk pressure",
        tags: ["disk"],
        instructions: instructions$("b"),
      })
    );
    const matches = reg.find("cpu is saturated");
    expect(matches[0]?.skill.id).toBe("diagnose-cpu");
    // "cpu" only matches the cpu skill.
    expect(matches.map((m) => m.skill.id)).toEqual(["diagnose-cpu"]);
  });
});

describe("deterministicSkillSelector", () => {
  it("is stable across calls for the same input (replay-safe)", async () => {
    const reg = new SkillRegistry();
    reg.register(
      skill$({
        id: "diagnose-cpu",
        name: "CPU",
        description: "diagnose cpu saturation",
        tags: ["cpu"],
        instructions: instructions$("a"),
      })
    );
    reg.register(
      skill$({
        id: "diagnose-disk",
        name: "Disk",
        description: "diagnose disk pressure",
        tags: ["disk"],
        instructions: instructions$("b"),
      })
    );
    const selector = deterministicSkillSelector();
    const a = await selector.select({ prompt: "cpu is saturated" }, reg);
    const b = await selector.select({ prompt: "cpu is saturated" }, reg);
    expect(a).toEqual(b);
    expect(a).toEqual(["diagnose-cpu"]);
  });
});

describe("AgentRunner + skills", () => {
  it("selects, emits, composes the prompt, adds skill tools, and never loads unselected skills", async () => {
    let cpuLoads = 0;
    let diskLoads = 0;
    const cpuSkill = skill$({
      id: "diagnose-cpu",
      name: "CPU",
      description: "diagnose cpu saturation",
      tags: ["cpu"],
      instructions: async () => {
        cpuLoads++;
        return { default: "CPU RUNBOOK: check pool usage." };
      },
      tools: [restartTool],
    });
    const diskSkill = skill$({
      id: "diagnose-disk",
      name: "Disk",
      description: "diagnose disk pressure",
      tags: ["disk"],
      instructions: async () => {
        diskLoads++;
        return { default: "DISK RUNBOOK." };
      },
    });
    const registry = new SkillRegistry().register(cpuSkill).register(diskSkill);

    let seenSystem: string | undefined;
    let seenTools: string[] = [];
    const provider: LlmProvider = {
      complete: async (req: LlmRequest): Promise<LlmResponse> => {
        seenSystem = req.system;
        seenTools = (req.tools ?? []).map((t) => t.name);
        return { content: "done", stopReason: "end_turn" };
      },
    };

    const definition = agent$({ id: "sre-agent", name: "SRE", tools: [] });
    const ctx = makeEffectContext();
    const runner = new AgentRunner({
      definition,
      provider,
      effectRuntime: new EffectRuntime(),
      systemPrompt: "You are an SRE.",
      skills: registry,
    });

    await runner.run({ prompt: "cpu is saturated on prod-postgres" }, ctx);

    // Composed prompt = base + selected skill instructions.
    expect(seenSystem).toContain("You are an SRE.");
    expect(seenSystem).toContain("CPU RUNBOOK: check pool usage.");
    expect(seenSystem).not.toContain("DISK RUNBOOK.");
    // Skill tool surfaced to the model.
    expect(seenTools).toContain("restart-pool");
    // Selection recorded for replay/audit.
    const emit = ctx.emit as ReturnType<typeof vi.fn>;
    const selected = emit.mock.calls.find((c) => c[0] === "SKILLS_SELECTED");
    expect(selected?.[1]).toEqual({ skillIds: ["diagnose-cpu"] });
    // Only the selected skill's body loaded; the other stayed lazy.
    expect(cpuLoads).toBe(1);
    expect(diskLoads).toBe(0);
  });

  it("leaves behavior unchanged when no registry is supplied", async () => {
    const provider: LlmProvider = {
      complete: async (req) => {
        expect(req.system).toBe("base");
        return { content: "ok", stopReason: "end_turn" };
      },
    };
    const ctx = makeEffectContext();
    const runner = new AgentRunner({
      definition: agent$({ id: "a", name: "A", tools: [] }),
      provider,
      effectRuntime: new EffectRuntime(),
      systemPrompt: "base",
    });
    await runner.run({ prompt: "x" }, ctx);
    const emit = ctx.emit as ReturnType<typeof vi.fn>;
    expect(emit.mock.calls.some((c) => c[0] === "SKILLS_SELECTED")).toBe(false);
  });
});
