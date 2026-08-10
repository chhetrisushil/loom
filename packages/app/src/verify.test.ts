import { step$ } from "@loom/core";
import { GrantTable } from "@loom/effect-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";
import { resolveVerifyInput } from "./verifyAdapter";

const incident = z.object({ incidentId: z.string() });
const resolved = z.object({ resolved: z.boolean() });
const metricsStep = step$({
  id: "fetch-metrics",
  name: "Metrics",
  toolId: "metrics-tool",
  inputSchema: incident,
  outputSchema: z.object({ cpu: z.number() }),
});
const remediationStep = step$({
  id: "apply-remediation",
  name: "Remediate",
  toolId: "remediation-tool",
  inputSchema: incident,
  outputSchema: z.object({ fixed: z.boolean() }),
});

const runner: FlowRunner<{ incidentId: string }, { resolved: boolean }> = async (
  ctx: WorkflowContext,
  input
) => {
  await ctx.run(metricsStep, { incidentId: input.incidentId });
  await ctx.run(remediationStep, { incidentId: input.incidentId });
  return { resolved: true };
};

function flow(): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "gated",
      name: "gated",
      version: "1.0.0",
      inputSchema: incident,
      outputSchema: resolved,
      steps: [metricsStep, remediationStep],
    },
    runner,
  } as RegisteredFlow;
}

/** Grants both tools — a clean app. */
const fullGrants = new GrantTable({ gated: ["metrics-tool", "remediation-tool"] });
/** Grants only one tool — remediation-tool is ungranted. */
const partialGrants = new GrantTable({ gated: ["metrics-tool"] });

describe("resolveVerifyInput adapter", () => {
  it("projects flows with a content hash and effect capabilities", () => {
    const app = defineConfig({ storage: { kind: "memory" }, flows: [flow()] });
    const input = resolveVerifyInput(app.runtime, { authorizer: fullGrants });
    expect(input.flows).toHaveLength(1);
    const f = input.flows[0]!;
    expect(f.id).toBe("gated");
    expect(f.flowHash).toMatch(/^fnv1a:/);
    expect(f.effects?.map((e) => e.capability).sort()).toEqual([
      "metrics-tool",
      "remediation-tool",
    ]);
    expect(input.grants?.grants).toEqual({ gated: ["metrics-tool", "remediation-tool"] });
    expect(input.eventSchemaVersion).toBeDefined();
  });

  it("skips grants when the authorizer is not a GrantTable", () => {
    const app = defineConfig({ storage: { kind: "memory" }, flows: [flow()] });
    const input = resolveVerifyInput(app.runtime, {
      authorizer: { authorize: () => ({ allowed: true }) },
    });
    expect(input.grants).toBeUndefined();
  });

  it("feeds nonDeterministicByFlow into the flow's determinism input (#82)", () => {
    const app = defineConfig({ storage: { kind: "memory" }, flows: [flow()] });
    const input = resolveVerifyInput(app.runtime, {
      nonDeterministicByFlow: { gated: [{ callee: "Date.now", insideDecide: false }] },
    });
    expect(input.flows[0]?.nonDeterministicCalls).toEqual([
      { callee: "Date.now", insideDecide: false },
    ]);
  });
});

describe("defineConfig({ verify }) boot gate", () => {
  it("throws at boot in error mode when a step's effect is ungranted (capability-compat)", () => {
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        flows: [flow()],
        authorizer: partialGrants,
        verify: "error",
      })
    ).toThrow(/remediation-tool/);
  });

  it("reports via onWarn in warn mode and still returns the app", () => {
    const warnings: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow()],
      authorizer: partialGrants,
      verify: "warn",
      onWarn: (m) => warnings.push(m),
    });
    expect(warnings.join("\n")).toContain("capability-compat");
    expect(app.verify().ok).toBe(false);
  });

  it("passes clean in error mode when all effects are granted", () => {
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        flows: [flow()],
        authorizer: fullGrants,
        verify: "error",
      })
    ).not.toThrow();
  });

  it("off/unset is a no-op but app.verify() still works on demand", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow()],
      authorizer: fullGrants,
    });
    const report = app.verify();
    expect(report.ok).toBe(true);
    expect(report.checked).toContain("capability-compat");
  });

  it("skips capability-compat entirely when no authorizer is wired", () => {
    const app = defineConfig({ storage: { kind: "memory" }, flows: [flow()], verify: "error" });
    expect(app.verify().findings.filter((f) => f.rule === "capability-compat")).toHaveLength(0);
  });
});

// ── K12 — the approval check, which used to be unreachable ───────────────────
//
// `suspension-safety` has always carried a rule for this: a flow that can be resumed by
// an externally-supplied event, with no ResumeAuthenticator behind it, accepts
// unauthenticated resumes. It read two FlowSpec fields NOTHING populated, so it could
// not fire for any app — a green report meant only that the question was never asked.

/** A flow declaring a resume gate contract (ADR 0077) — externally resumable. */
function gatedFlow(): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "gated",
      name: "gated",
      version: "1.0.0",
      inputSchema: incident,
      outputSchema: resolved,
      steps: [metricsStep, remediationStep],
      resumeSchemas: { ApprovalGranted: z.object({ approved: z.boolean() }) },
    },
    runner,
  } as RegisteredFlow;
}

const authenticator = { verify: () => ({ status: "not-applicable" }) as const };

describe("verify — K12 resume authentication", () => {
  it("derives usesApproval from declared resume gates", () => {
    const app = defineConfig({ storage: { kind: "memory" }, flows: [gatedFlow()] });
    expect(resolveVerifyInput(app.runtime).flows[0]?.usesApproval).toBe(true);
  });

  it("leaves a flow with no resume gates alone", () => {
    const app = defineConfig({ storage: { kind: "memory" }, flows: [flow()] });
    expect(resolveVerifyInput(app.runtime).flows[0]?.usesApproval).toBeUndefined();
  });

  it("ERRORS when a resumable flow has no authenticator wired", () => {
    // The finding that could not previously be produced.
    const app = defineConfig({ storage: { kind: "memory" }, flows: [gatedFlow()] });
    const report = app.verify();
    const finding = report.findings.find((f) => f.rule === "suspension-safety");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("no ResumeAuthenticator is wired");
    expect(report.ok).toBe(false);
  });

  it("reports the wiring from the RUNTIME, not from a caller's claim", () => {
    // The reason this is read off the runtime: a rule you satisfy by asserting you wired
    // something is a rule that passes for the app that forgot.
    const app = defineConfig({ storage: { kind: "memory" }, flows: [gatedFlow()] });
    expect(app.runtime.hasResumeAuthenticator()).toBe(false);
    expect(resolveVerifyInput(app.runtime).resumeAuthenticatorWired).toBe(false);
  });

  it("clears once an authenticator is wired", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [gatedFlow()],
      resumeAuthenticator: authenticator,
    });
    expect(app.runtime.hasResumeAuthenticator()).toBe(true);
    expect(app.verify().findings.filter((f) => f.rule === "suspension-safety")).toHaveLength(0);
  });

  it('boots or refuses to boot accordingly under verify:"error"', () => {
    expect(() =>
      defineConfig({ storage: { kind: "memory" }, flows: [gatedFlow()], verify: "error" })
    ).toThrow(/ResumeAuthenticator/);
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        flows: [gatedFlow()],
        resumeAuthenticator: authenticator,
        verify: "error",
      })
    ).not.toThrow();
  });
});
