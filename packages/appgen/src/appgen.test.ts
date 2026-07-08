import { describe, expect, it } from "vitest";
import { generateApp } from "./generate";
import { parseIntent } from "./parseIntent";

const EXAMPLE =
  "Create a planner. Use Gemma first. Elevate to Gemini. Pause for approval. Deploy on Fargate. Generate UI.";

describe("parseIntent (NL → AppSpec)", () => {
  it("parses the canonical example into a structured spec", () => {
    const spec = parseIntent(EXAMPLE);
    expect(spec.name).toBe("planner");
    const cap = spec.capabilities[0];
    expect(cap?.id).toBe("planner");
    expect(cap?.reasoning).toEqual({ baseModel: "gemma", elevateTo: ["gemini"] });
    expect(cap?.approval).toBe(true);
    expect(cap?.ui).toBe(true);
    expect(cap?.steps).toEqual(["run"]); // default step
    expect(spec.compute).toEqual({ target: "fargate" });
  });

  it("supports explicit steps and multiple capabilities", () => {
    const spec = parseIntent("Create a triage. Step classify. Step route. Create a resolver.");
    expect(spec.capabilities.map((c) => c.id)).toEqual(["triage", "resolver"]);
    expect(spec.capabilities[0]?.steps).toEqual(["classify", "route"]);
    expect(spec.capabilities[1]?.steps).toEqual(["run"]);
  });

  it("defaults to a single 'app' capability when nothing is created", () => {
    const spec = parseIntent("Generate UI.");
    expect(spec.capabilities).toHaveLength(1);
    expect(spec.capabilities[0]?.id).toBe("app");
    expect(spec.capabilities[0]?.ui).toBe(true);
  });
});

describe("generateApp (AppSpec → plain static TypeScript)", () => {
  it("emits an inspectable capability file + composition root", () => {
    const files = generateApp(parseIntent(EXAMPLE));
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.contents]));

    const flow = byPath["src/planner.ts"] ?? "";
    // Ordinary, statically-wired Loom code — no runtime NL.
    expect(flow).toContain("step$(");
    expect(flow).toContain("flow$(");
    expect(flow).toContain("capability$(");
    expect(flow).toContain('await ctx.suspend({ on: "Approved" })'); // approval gate
    expect(flow).toContain("ctx.ui.set"); // UI surface
    expect(flow).toContain("@loom/reasoning"); // reasoning hint (commented import)
    expect(flow).toContain("ctx.decide"); // route logged via the decision seam
    expect(flow).toContain("gemma"); // ladder documented

    const app = byPath["src/app.ts"] ?? "";
    expect(app).toContain("defineConfig(");
    expect(app).toContain("CapabilityCatalog");
    expect(app).toContain("plannerCapability");
    expect(app).toContain("fargate"); // compute note
  });

  it("omits reasoning / approval / UI wiring when the intent doesn't ask for it", () => {
    const flow =
      generateApp(parseIntent("Create a greeter.")).find((f) => f.path === "src/greeter.ts")
        ?.contents ?? "";
    expect(flow).toContain("greeterCapability");
    expect(flow).not.toContain("ctx.suspend");
    expect(flow).not.toContain("ctx.ui.set");
    expect(flow).not.toContain("@loom/reasoning");
  });
});
