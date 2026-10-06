import { describe, expect, it } from "vitest";
import { generateFlows, generateProject } from "./generate";
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

describe("generateFlows (AppSpec → folder-convention flow files)", () => {
  it("emits an inspectable flow at app/flows/<id>/flow.ts", () => {
    const files = generateFlows(parseIntent(EXAMPLE));
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.contents]));

    const flow = byPath["app/flows/planner/flow.ts"] ?? "";
    // Ordinary, statically-wired Loom code — no runtime NL, no capability catalog.
    expect(flow).toContain("step$(");
    expect(flow).toContain("flow$(");
    expect(flow).toContain("input: { prompt: string }"); // handler input typed — type-checks under strict tsc
    expect(flow).toContain("export const PlannerFlow"); // RegisteredFlow, folder-convention shape
    expect(flow).not.toContain("capability$("); // dropped the capability-catalog model
    expect(flow).toContain('await ctx.suspend({ on: "Approved" })'); // approval gate
    expect(flow).toContain("surface(ctx).set"); // UI surface (ADR 0114 spelling)
    expect(flow).toContain('from "@loom/agent-surface"'); // typed by agent-surface, so imported
    expect(flow).not.toContain("ctx.ui.");
    expect(flow).toContain("@loom/reasoning"); // reasoning hint (commented import)
    expect(flow).toContain("ctx.decide"); // route logged via the decision seam
    expect(flow).toContain("gemma"); // ladder documented
  });

  it("omits reasoning / approval / UI wiring when the intent doesn't ask for it", () => {
    const flow =
      generateFlows(parseIntent("Create a greeter.")).find(
        (f) => f.path === "app/flows/greeter/flow.ts"
      )?.contents ?? "";
    expect(flow).toContain("export const GreeterFlow");
    expect(flow).not.toContain("ctx.suspend");
    expect(flow).not.toContain("surface(ctx)");
    expect(flow).not.toContain("@loom/agent-surface");
    expect(flow).not.toContain("@loom/reasoning");
  });
});

describe("generateProject (AppSpec → full runnable project)", () => {
  it("emits a complete folder-convention project seeded from the intent", () => {
    const files = generateProject(parseIntent(EXAMPLE));
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.contents]));

    // Project scaffolding so `pnpm install && pnpm start` works out of the box.
    expect(byPath["package.json"]).toBeDefined();
    expect(byPath["tsconfig.json"]).toBeDefined();
    expect(byPath["app/config.ts"]).toContain("defineConfig(");
    expect(byPath["app/config.ts"]).toContain("flowModules");

    // The NL-derived flow, statically wired via loom.gen.
    expect(byPath["app/flows/planner/flow.ts"]).toContain("export const PlannerFlow");
    expect(byPath["app/loom.gen.ts"]).toContain('import * as _f0 from "./flows/planner/flow"');

    // The sample greet flow from the scaffold baseline is replaced, not left behind.
    expect(byPath["app/flows/greet/flow.ts"]).toBeUndefined();

    // Entry point drives the approval suspend → resume round-trip; compute noted in README.
    expect(byPath["app/main.ts"]).toContain("PlannerFlow");
    expect(byPath["app/main.ts"]).toContain("waitForSuspend");
    expect(byPath["README.md"]).toContain("fargate");
  });

  it("emits a non-approval entry that just waits for completion", () => {
    const byPath = Object.fromEntries(
      generateProject(parseIntent("Create a greeter.")).map((f) => [f.path, f.contents])
    );
    expect(byPath["app/main.ts"]).toContain("waitForCompletion");
    expect(byPath["app/main.ts"]).not.toContain("waitForSuspend");
  });
});
