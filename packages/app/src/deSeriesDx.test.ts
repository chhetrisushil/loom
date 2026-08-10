import { step$ } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";

// ── DE-series DX wiring: lint plumbing + the registerEffects seam ────────────

const io = z.object({});
const apply = step$({
  id: "apply",
  name: "apply",
  toolId: "apply",
  inputSchema: io,
  outputSchema: io,
});

const runner: FlowRunner<Record<string, never>, Record<string, never>> = async (
  ctx: WorkflowContext
) => {
  await ctx.run(apply, {});
  return {};
};

function flow(): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "interp",
      name: "interp",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [apply],
    },
    runner,
  } as RegisteredFlow;
}

describe("defineConfig verify.lint plumbing (ADR 0061 / issue #82)", () => {
  it("loopIdentityByFlow findings surface as determinism warnings at boot", () => {
    const warnings: string[] = [];
    defineConfig({
      storage: { kind: "memory" },
      flows: [flow()],
      observability: { onWarn: (m) => warnings.push(m) },
      checks: {
        verify: {
          mode: "warn",
          lint: {
            loopIdentityByFlow: {
              interp: [
                { callee: "run", loopKind: "ForOfStatement", reason: "static-step-in-loop" },
              ],
            },
          },
        },
      },
    });
    expect(warnings.some((w) => w.includes("cannot vary per iteration"))).toBe(true);
  });

  it("nonDeterministicByFlow findings reach the determinism rule (previously a dead path)", () => {
    const warnings: string[] = [];
    let threw = false;
    try {
      defineConfig({
        storage: { kind: "memory" },
        flows: [flow()],
        observability: { onWarn: (m) => warnings.push(m) },
        checks: {
          verify: {
            mode: "error",
            lint: {
              nonDeterministicByFlow: {
                interp: [{ callee: "Date.now", insideDecide: false, location: "interp" }],
              },
            },
          },
        },
      });
    } catch (err) {
      threw = true;
      expect(String(err)).toContain("Date.now");
    }
    expect(threw).toBe(true); // error mode: a determinism ERROR fails boot
  });
});

describe("app.verify({ lint }) override (loom verify manifest injection, ADR 0061)", () => {
  it("merges extra loop-identity findings over the configured lint at call time", () => {
    const app = defineConfig({ storage: { kind: "memory" }, flows: [flow()] });

    const bare = app.verify();
    expect(bare.findings.filter((f) => f.rule === "determinism")).toHaveLength(0);

    const injected = app.verify({
      lint: {
        loopIdentityByFlow: {
          interp: [{ callee: "run", loopKind: "ForOfStatement", reason: "static-step-in-loop" }],
        },
      },
    });
    const warnings = injected.findings.filter((f) => f.rule === "determinism");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("cannot vary per iteration");
    // And the override is per-call — the next bare verify is clean again.
    expect(app.verify().findings.filter((f) => f.rule === "determinism")).toHaveLength(0);
  });
});

describe("defineConfig registerEffects seam (ADR 0063/0064 DX)", () => {
  it("runs the hook at boot with the constructed EffectRuntime", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow()],
      execution: {
        registerEffects: (effects) => {
          effects.register("mcp.invoke", new ToolEffect(async () => ({ ok: true })));
        },
      },
    });
    expect(app.effectRuntime.has("mcp.invoke")).toBe(true);
  });
});
