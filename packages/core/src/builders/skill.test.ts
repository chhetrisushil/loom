import { describe, expect, it } from "vitest";
import { z } from "zod";
import { instructions$, loadInstructions, skill$, tool$ } from "../index";

describe("skill$ / instructions$", () => {
  it("builds a SkillDefinition with inline instructions and optional fields", () => {
    const t = tool$({
      id: "restart-pool",
      name: "Restart Pool",
      description: "Recycle the connection pool",
      inputSchema: z.object({ target: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
    });
    const s = skill$({
      id: "diagnose-cpu",
      name: "Diagnose CPU",
      description: "Root-cause CPU saturation",
      tags: ["cpu", "sre"],
      instructions: instructions$("Query metrics, then reason about pool usage."),
      tools: [t],
    });
    expect(s._tag).toBe("SkillDefinition");
    expect(s.id).toBe("diagnose-cpu");
    expect(s.description).toBe("Root-cause CPU saturation");
    expect(s.tags).toEqual(["cpu", "sre"]);
    expect(s.tools).toEqual([t]);
  });

  it("omits optional fields when not provided", () => {
    const s = skill$({ id: "x", name: "X", description: "d", instructions: instructions$("body") });
    expect("tags" in s).toBe(false);
    expect("tools" in s).toBe(false);
  });

  it("loadInstructions resolves an inline ref", async () => {
    expect(await loadInstructions(instructions$("hello"))).toBe("hello");
  });

  it("loadInstructions resolves a compiler-style loader", async () => {
    const loader = async () => ({ default: "loaded body" });
    expect(await loadInstructions(loader)).toBe("loaded body");
  });
});
