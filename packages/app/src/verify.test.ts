import { analyzeRunnerReach } from "@loom/compiler";
import { step$ } from "@loom/core";
import { GrantTable } from "@loom/effect-runtime";
import { verify } from "@loom/verify";
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
        security: { authorizer: partialGrants },
        checks: { verify: "error" },
      })
    ).toThrow(/remediation-tool/);
  });

  it("reports via onWarn in warn mode and still returns the app", () => {
    const warnings: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow()],
      security: { authorizer: partialGrants },
      observability: { onWarn: (m) => warnings.push(m) },
      checks: { verify: "warn" },
    });
    expect(warnings.join("\n")).toContain("capability-compat");
    expect(app.verify().ok).toBe(false);
  });

  it("passes clean in error mode when all effects are granted", () => {
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        flows: [flow()],
        security: { authorizer: fullGrants },
        checks: { verify: "error" },
      })
    ).not.toThrow();
  });

  it("off/unset is a no-op but app.verify() still works on demand", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow()],
      security: { authorizer: fullGrants },
    });
    const report = app.verify();
    expect(report.ok).toBe(true);
    expect(report.checked).toContain("capability-compat");
  });

  it("skips capability-compat entirely when no authorizer is wired", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow()],
      checks: { verify: "error" },
    });
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
      security: { resumeAuthenticator: authenticator },
    });
    expect(app.runtime.hasResumeAuthenticator()).toBe(true);
    expect(app.verify().findings.filter((f) => f.rule === "suspension-safety")).toHaveLength(0);
  });

  it('boots or refuses to boot accordingly under verify:"error"', () => {
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        flows: [gatedFlow()],
        checks: { verify: "error" },
      })
    ).toThrow(/ResumeAuthenticator/);
    expect(() =>
      defineConfig({
        storage: { kind: "memory" },
        flows: [gatedFlow()],
        security: { resumeAuthenticator: authenticator },
        checks: { verify: "error" },
      })
    ).not.toThrow();
  });
});

// ── EF — the rule must FIRE for a real defineConfig app ───────────────────────
//
// A verify rule whose inputs no producer populates evaluates `undefined && …` and
// can never produce a finding, while still counting as coverage in `report.checked`.
// That has happened here before (FlowSpec.suspends is still dead for this reason).
// These tests exist so `effect-class` cannot join it: they go through the real
// builders and the real adapter, not a hand-built VerifyInput.
describe("effect-class reaches the rule through defineConfig", () => {
  const io = { inputSchema: incident, outputSchema: z.object({ ok: z.boolean() }) };
  const readStep = step$({ id: "read", toolId: "read-tool", effectClass: "read-only", ...io });
  const postStep = step$({ id: "post", toolId: "post-tool", effectClass: "external-write", ...io });
  const unclassified = step$({ id: "mystery", toolId: "mystery-tool", ...io });

  const efFlow = (
    id: string,
    effectClass: string,
    steps: ReturnType<typeof step$>[]
  ): RegisteredFlow =>
    ({
      definition: {
        _tag: "FlowDefinition",
        id,
        name: id,
        version: "1.0.0",
        inputSchema: incident,
        outputSchema: resolved,
        steps,
        effectClass,
      },
      runner: (async () => ({ resolved: true })) as unknown as FlowRunner<unknown, unknown>,
    }) as RegisteredFlow;

  const CLASSES = ["read-only", "local-write", "external-write", "irreversible"];

  it("carries the step's and the flow's class into VerifyInput", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [efFlow("audit", "read-only", [readStep, postStep])],
      checks: { verify: { mode: "off", effectClasses: CLASSES } },
    });
    const input = resolveVerifyInput(app.runtime, { effectClasses: CLASSES });
    const spec = input.flows.find((f) => f.id === "audit");
    expect(spec?.effectClass).toBe("read-only");
    expect(spec?.effects?.map((e) => e.effectClass)).toEqual(["read-only", "external-write"]);
    expect(input.effectClasses).toEqual(CLASSES);
  });

  it("a read-only flow that reaches an external write fails app.verify()", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [efFlow("audit", "read-only", [readStep, postStep])],
      checks: { verify: { mode: "warn", effectClasses: CLASSES } },
    });
    const report = app.verify();
    const ef = report.findings.filter((f) => f.rule === "effect-class");
    expect(ef).toHaveLength(1);
    expect(ef[0]?.severity).toBe("error");
    expect(ef[0]?.location).toBe("audit:post-tool");
    expect(report.ok).toBe(false);
  });

  it("names the K2 interaction using the app's real GrantTable", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [efFlow("audit", "read-only", [postStep])],
      security: { authorizer: new GrantTable({ audit: ["post-tool"] }) },
      checks: { verify: { mode: "warn", effectClasses: CLASSES } },
    });
    const ef = app.verify().findings.filter((f) => f.rule === "effect-class");
    expect(ef[0]?.message).toMatch(/IS granted, so K2 will not stop it at runtime/);
  });

  it("an unclassified step makes the flow only partially verified, never silently clean", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [efFlow("audit", "read-only", [unclassified])],
      checks: { verify: { mode: "warn", effectClasses: CLASSES } },
    });
    const ef = app.verify().findings.filter((f) => f.rule === "effect-class");
    expect(ef).toHaveLength(1);
    expect(ef[0]?.severity).toBe("warn");
    expect(ef[0]?.message).toMatch(/only partially verified/);
  });

  it("is byte-identical when the app declares no vocabulary (G2)", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [efFlow("audit", "read-only", [postStep])],
      checks: { verify: { mode: "warn" } },
    });
    expect(app.verify().findings.filter((f) => f.rule === "effect-class")).toEqual([]);
  });
});

// ── The reach bound, end to end ──────────────────────────────────────────────
//
// The rules were only ever as good as `FlowDefinition.steps`, and a step invoked
// through `ctx.run` without being declared there was invisible to
// capability-compat and effect-class. These drive the adapter — the level a real
// app traverses — rather than a hand-built VerifyInput, which is the discipline
// that keeps a rule from going quietly dead.

/** The same flow, but declaring NO steps — everything is reached from the body. */
function undeclaredFlow(): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "gated",
      name: "gated",
      version: "1.0.0",
      inputSchema: incident,
      outputSchema: resolved,
      steps: [],
    },
    runner,
  } as RegisteredFlow;
}

const RUNNER_SOURCE = `
  const metricsStep = step$({ id: "fetch-metrics", toolId: "metrics-tool" });
  const remediationStep = step$({ id: "apply-remediation", toolId: "remediation-tool" });
  const runner = async (ctx, input) => {
    await ctx.run(metricsStep, input);
    await ctx.run(remediationStep, input);
  };
`;

describe("runner-body reach reaches the rules", () => {
  it("an ungranted step invoked via ctx.run but NOT declared is invisible without reach analysis", () => {
    // The bound, demonstrated. This is the control for everything below.
    const { runtime } = defineConfig({
      storage: { kind: "memory" },
      flows: [undeclaredFlow()],
      security: { authorizer: partialGrants },
    });
    const report = verify(resolveVerifyInput(runtime, { authorizer: partialGrants }));
    expect(report.findings.filter((f) => f.rule === "capability-compat")).toHaveLength(0);
    expect(report.ok).toBe(true); // clean, and wrong
  });

  it("with reach analysis the same ungranted step is caught", () => {
    const { runtime } = defineConfig({
      storage: { kind: "memory" },
      flows: [undeclaredFlow()],
      security: { authorizer: partialGrants },
    });
    const report = verify(
      resolveVerifyInput(runtime, {
        authorizer: partialGrants,
        runnerReachByFlow: { gated: analyzeRunnerReach(RUNNER_SOURCE, "gated") },
      })
    );
    const errs = report.findings.filter(
      (f) => f.rule === "capability-compat" && f.severity === "error"
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toContain("remediation-tool");
    expect(report.ok).toBe(false);
  });

  it("does not double-count a step that is both declared and reached", () => {
    const { runtime } = defineConfig({
      storage: { kind: "memory" },
      flows: [flow()],
      security: { authorizer: partialGrants },
    });
    const report = verify(
      resolveVerifyInput(runtime, {
        authorizer: partialGrants,
        runnerReachByFlow: { gated: analyzeRunnerReach(RUNNER_SOURCE, "gated") },
      })
    );
    expect(
      report.findings.filter((f) => f.rule === "capability-compat" && f.severity === "error")
    ).toHaveLength(1);
  });

  it("populates suspends, which had no producer at all", () => {
    const { runtime } = defineConfig({ storage: { kind: "memory" }, flows: [undeclaredFlow()] });
    const input = resolveVerifyInput(runtime, {
      runnerReachByFlow: {
        gated: analyzeRunnerReach(`
          const r = async (ctx) => { await ctx.suspend({ on: "Late", timeout: 5000 }); };
        `),
      },
    });
    expect(input.flows[0]?.suspends).toEqual([{ id: "Late", timed: true }]);
    // …and with no TimerStore wired, that is a real T1 defect.
    const report = verify(input);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "suspension-safety", severity: "error" })
    );
  });

  it("carries the unresolved targets so the rules can bound their claim", () => {
    const { runtime } = defineConfig({
      storage: { kind: "memory" },
      flows: [undeclaredFlow()],
      security: { authorizer: fullGrants },
    });
    const input = resolveVerifyInput(runtime, {
      authorizer: fullGrants,
      runnerReachByFlow: {
        gated: analyzeRunnerReach(`
          const r = async (ctx) => { await ctx.run(mcpInvoke$("hydrate#0"), {}); };
        `),
      },
    });
    expect(input.flows[0]?.reachAnalyzed).toBe(true);
    expect(input.flows[0]?.unresolvedReach).toHaveLength(1);
    const report = verify(input);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "capability-compat", severity: "warn" })
    );
  });

  it("reachAnalyzed is absent when no analysis was supplied — not the same as 'nothing unresolved'", () => {
    const { runtime } = defineConfig({ storage: { kind: "memory" }, flows: [flow()] });
    expect(resolveVerifyInput(runtime).flows[0]?.reachAnalyzed).toBeUndefined();
  });

  it("timerStoreWired is read from the runtime, never accepted from a caller", () => {
    const { runtime } = defineConfig({ storage: { kind: "memory" }, flows: [flow()] });
    expect(resolveVerifyInput(runtime).timerStoreWired).toBe(false);
  });
});

describe("the wiring an app actually uses", () => {
  // Finding #1 of the DX pass: `runnerReachByFlow` reached `resolveVerifyInput`
  // and nothing routed it there from `defineConfig`, so ADR 0086's analysis was
  // unreachable from the only path an app takes. Same defect as a capability
  // with no producer, one tier up.
  it("verify.lint.runnerReachByFlow reaches the rules through defineConfig", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [undeclaredFlow()],
      security: { authorizer: partialGrants },
      checks: {
        verify: {
          mode: "off",
          lint: { runnerReachByFlow: { gated: analyzeRunnerReach(RUNNER_SOURCE, "gated") } },
        },
      },
    });
    const errs = app
      .verify()
      .findings.filter((f) => f.rule === "capability-compat" && f.severity === "error");
    expect(errs.map((e) => e.message).join()).toContain("remediation-tool");
  });

  it("app.verify({ lint }) merges over the configured lint, same as the other two analyses", () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [undeclaredFlow()],
      security: { authorizer: partialGrants },
      checks: { verify: { mode: "off" } },
    });
    // Nothing configured ⇒ the bound applies and the report is clean-but-blind…
    expect(app.verify().findings.filter((f) => f.rule === "capability-compat")).toHaveLength(0);
    // …injected at call time (which is how `loom verify` supplies the manifest) ⇒ caught.
    const injected = app.verify({
      lint: { runnerReachByFlow: { gated: analyzeRunnerReach(RUNNER_SOURCE, "gated") } },
    });
    expect(
      injected.findings.filter((f) => f.rule === "capability-compat" && f.severity === "error")
    ).toHaveLength(1);
  });
});
