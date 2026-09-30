import { describe, expect, it } from "vitest";
import { analyzeLoopIdentity } from "./loopIdentity";
import { buildManifest } from "./manifest";
import { transformFile } from "./transform";

// ── ADR 0061 — the step-identity lint ────────────────────────────────────────
//
// Flags ctx.run/ctx.execute inside loops whose step id cannot vary per
// iteration. Heuristic contract: quiet on anything unresolvable (false
// negatives acceptable; false positives kill lints).

describe("analyzeLoopIdentity (ADR 0061)", () => {
  it("flags a static step reference inside a for-of loop", () => {
    const findings = analyzeLoopIdentity(
      `
      async function runner(ctx, input) {
        for (const item of input.plan) {
          await ctx.run(applyStep, item);
        }
      }
      `,
      "executeBlueprint"
    );
    expect(findings).toEqual([
      {
        callee: "run",
        loopKind: "ForOfStatement",
        reason: "static-step-in-loop",
        location: "executeBlueprint",
      },
    ]);
  });

  it("accepts a template-literal id derived from the loop variable", () => {
    const findings = analyzeLoopIdentity(`
      async function runner(ctx, input) {
        for (const [i, item] of input.plan.entries()) {
          await ctx.run(step$({ id: \`apply#\${i}\`, toolId: "apply" }), item);
        }
      }
    `);
    expect(findings).toEqual([]);
  });

  it("handles .map callbacks: flags a constant-id mint, accepts an index-derived one", () => {
    const flagged = analyzeLoopIdentity(`
      async function runner(ctx, input) {
        await Promise.all(input.items.map((item) =>
          ctx.run(step$({ id: "apply", toolId: "apply" }), item)));
      }
    `);
    expect(flagged).toEqual([
      { callee: "run", loopKind: ".map()", reason: "id-not-derived-from-loop-variable" },
    ]);

    const clean = analyzeLoopIdentity(`
      async function runner(ctx, input) {
        await Promise.all(input.items.map((item, i) =>
          ctx.run(step$({ id: \`apply#\${i}\`, toolId: "apply" }), item)));
      }
    `);
    expect(clean).toEqual([]);
  });

  it("accepts a while-loop counter mutated in the body as an iteration-varying binding", () => {
    const findings = analyzeLoopIdentity(`
      async function runner(ctx, input) {
        let i = 0;
        while (i < input.n) {
          await ctx.execute(step$({ id: "apply#" + i, toolId: "apply" }), input.plan[i]);
          i++;
        }
      }
    `);
    expect(findings).toEqual([]);
  });

  it("flags an object-literal step whose id ignores every enclosing loop variable (nested loops)", () => {
    const findings = analyzeLoopIdentity(`
      async function runner(ctx, input) {
        for (const provider of input.providers) {
          for (const node of provider.graph) {
            await ctx.run(step$({ id: "hydrate", toolId: "mcp.invoke" }), node);
          }
        }
      }
    `);
    expect(findings).toEqual([
      { callee: "run", loopKind: "ForOfStatement", reason: "id-not-derived-from-loop-variable" },
    ]);
  });

  it("stays quiet outside loops and on unresolvable first arguments", () => {
    expect(
      analyzeLoopIdentity(`
        async function runner(ctx, input) {
          await ctx.run(applyStep, input);
          for (const item of input.plan) {
            await ctx.run(stepFor(item), item); // helper call referencing the loop var — resolvable, clean
            await ctx.run(steps[item.kind], item); // element access — unresolvable, quiet
          }
        }
      `)
    ).toEqual([]);
  });
});

describe("loop-identity wiring: transform → manifest (ADR 0061 DX)", () => {
  function emptyState() {
    return {
      chunks: new Map(),
      steps: new Map(),
      stepsByVarName: new Map(),
      flows: new Map(),
      skills: new Map(),
      skillsByVarName: new Map(),
      projections: new Map(),
    };
  }

  it("a flow-bearing module with a bad loop surfaces findings in the manifest (warning + structured field)", () => {
    const src = [
      'import { flow$, step$ } from "@loom/core";',
      'import { z } from "zod";',
      "const io = z.object({});",
      "export const runner = async (ctx, input) => {",
      "  for (const item of input.plan) {",
      "    await ctx.run(applyStep, item);",
      "  }",
      "};",
      "export const flow = flow$({",
      '  id: "interp",',
      '  name: "interp",',
      '  version: "1.0.0",',
      "  inputSchema: io,",
      "  outputSchema: io,",
      "  steps: [],",
      "});",
    ].join("\n");
    const state = emptyState();
    transformFile(src, "/abs/interp.ts", state);
    const manifest = buildManifest(state);
    const flow = manifest.flows.interp;
    expect(flow).toBeDefined();
    expect(flow?.loopIdentity).toEqual([
      { callee: "run", loopKind: "ForOfStatement", reason: "static-step-in-loop" },
    ]);
    expect(flow?.warnings.some((w) => w.includes("ADR 0061"))).toBe(true);
  });

  it("a clean interpreter module carries no loopIdentity field", () => {
    const src = [
      'import { flow$, step$ } from "@loom/core";',
      'import { z } from "zod";',
      "const io = z.object({});",
      "export const runner = async (ctx, input) => {",
      "  for (const [i, item] of input.plan.entries()) {",
      "    await ctx.run(step$({ id: `apply#${i}`, toolId: 'apply' }), item);",
      "  }",
      "};",
      "export const flow = flow$({",
      '  id: "clean",',
      '  name: "clean",',
      '  version: "1.0.0",',
      "  inputSchema: io,",
      "  outputSchema: io,",
      "  steps: [],",
      "});",
    ].join("\n");
    const state = emptyState();
    transformFile(src, "/abs/clean.ts", state);
    const manifest = buildManifest(state);
    expect(manifest.flows.clean?.loopIdentity).toBeUndefined();
    expect(manifest.flows.clean?.warnings.some((w) => w.includes("ADR 0061"))).toBe(false);
  });
});
