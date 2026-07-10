import { describe, expect, it, vi } from "vitest";
import { RULE_ORDER } from "./rules";
import type { FlowSpec, VerifyInput } from "./types";
import { VerificationError, formatReport, runVerification, verify } from "./verify";

/** A fully-clean flow: hash present, no non-determinism, correlated suspend, granted effect. */
function cleanFlow(overrides: Partial<FlowSpec> = {}): FlowSpec {
  return {
    id: "checkout",
    flowHash: "sha256:abc",
    nonDeterministicCalls: [{ callee: "Math.random", insideDecide: true }],
    suspends: [{ id: "approve", correlationKey: "orderId", timed: false }],
    effects: [{ toolId: "charge", capability: "payments.charge" }],
    ...overrides,
  };
}

/** A fully-clean input around one flow. */
function cleanInput(flow: FlowSpec = cleanFlow()): VerifyInput {
  return {
    flows: [flow],
    grants: { grants: { checkout: ["payments.charge"] } },
    meteredDimensions: ["tokens", "costUsd", "ms"],
    resumeAuthenticatorWired: true,
    eventSchemaVersion: "1.7.0",
  };
}

describe("verify — clean baseline", () => {
  it("passes every rule with no findings", () => {
    const report = verify(cleanInput());
    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(0);
    expect(report.checked).toEqual(RULE_ORDER);
  });
});

describe("determinism rule", () => {
  it("flags a non-deterministic call outside ctx.decide", () => {
    const report = verify(
      cleanInput(
        cleanFlow({ nonDeterministicCalls: [{ callee: "Date.now", insideDecide: false }] })
      )
    );
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "determinism", severity: "error" })
    );
  });

  it("allows a non-deterministic call inside ctx.decide", () => {
    const report = verify(
      cleanInput(cleanFlow({ nonDeterministicCalls: [{ callee: "Date.now", insideDecide: true }] }))
    );
    expect(report.findings.filter((f) => f.rule === "determinism")).toHaveLength(0);
  });
});

describe("replay-safety rule", () => {
  it("flags a flow with no content hash", () => {
    const flow = cleanFlow();
    const report = verify(cleanInput({ ...flow, flowHash: undefined }));
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "replay-safety", severity: "error" })
    );
  });

  it("flags a major schema mismatch against a prior log", () => {
    const report = verify({
      ...cleanInput(),
      eventSchemaVersion: "2.0.0",
      resumeLogSchemaVersion: "1.7.0",
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "replay-safety", severity: "error" })
    );
  });

  it("accepts a compatible (same-major) schema", () => {
    const report = verify({
      ...cleanInput(),
      eventSchemaVersion: "1.8.0",
      resumeLogSchemaVersion: "1.7.0",
    });
    expect(report.findings.filter((f) => f.rule === "replay-safety")).toHaveLength(0);
  });
});

describe("suspension-safety rule", () => {
  it("flags a suspend with no correlationKey", () => {
    const report = verify(cleanInput(cleanFlow({ suspends: [{ id: "wait" }] })));
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "suspension-safety", location: "checkout:wait" })
    );
  });

  it("flags a timed suspend with no wakeAt", () => {
    const report = verify(
      cleanInput(cleanFlow({ suspends: [{ correlationKey: "k", timed: true, wakeAt: false }] }))
    );
    expect(report.findings.some((f) => f.rule === "suspension-safety")).toBe(true);
  });

  it("flags approval flows with no ResumeAuthenticator", () => {
    const report = verify({
      ...cleanInput(cleanFlow({ usesApproval: true })),
      resumeAuthenticatorWired: false,
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "suspension-safety", severity: "error" })
    );
  });
});

describe("capability-compat rule", () => {
  it("flags an ungranted capability", () => {
    const report = verify({
      ...cleanInput(),
      grants: { grants: { checkout: ["orders.read"] } },
    });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "capability-compat", location: "checkout:charge" })
    );
  });

  it("accepts a wildcard grant", () => {
    const report = verify({ ...cleanInput(), grants: { grants: { checkout: "*" } } });
    expect(report.findings.filter((f) => f.rule === "capability-compat")).toHaveLength(0);
  });

  it("is skipped when no GrantTable is wired (G2)", () => {
    const { grants, ...noGrants } = cleanInput();
    void grants;
    const report = verify(noGrants);
    expect(report.findings.filter((f) => f.rule === "capability-compat")).toHaveLength(0);
  });
});

describe("placement-compat rule", () => {
  it("flags a computeTarget with no registered targets", () => {
    const report = verify(cleanInput(cleanFlow({ computeTarget: "gpu" })));
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "placement-compat", severity: "error" })
    );
  });

  it("flags a computeTarget that is not registered", () => {
    const report = verify({
      ...cleanInput(cleanFlow({ computeTarget: "gpu" })),
      placement: { targets: ["local", "cloud-run"] },
    });
    expect(
      report.findings.some((f) => f.rule === "placement-compat" && f.severity === "error")
    ).toBe(true);
  });

  it("accepts a registered target and warns on unsupported kind", () => {
    const report = verify({
      ...cleanInput(
        cleanFlow({
          computeTarget: "cloud-run",
          effects: [{ toolId: "t", capability: "c", kind: "gpu" }],
        })
      ),
      grants: { grants: { checkout: "*" } },
      placement: { targets: ["cloud-run"], supportedKinds: { "cloud-run": ["step", "llm"] } },
    });
    expect(
      report.findings.filter((f) => f.rule === "placement-compat" && f.severity === "error")
    ).toHaveLength(0);
    expect(
      report.findings.some((f) => f.rule === "placement-compat" && f.severity === "warn")
    ).toBe(true);
  });
});

describe("resource-compat rule", () => {
  it("errors on an unmetered budget dimension", () => {
    const report = verify(
      cleanInput(cleanFlow({ budget: { dimensions: ["memBytes"], ceilings: { memBytes: 1 } } }))
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "resource-compat", severity: "error" })
    );
  });

  it("warns on a metered budget dimension with no ceiling", () => {
    const report = verify(cleanInput(cleanFlow({ budget: { dimensions: ["tokens"] } })));
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "resource-compat", severity: "warn" })
    );
  });
});

describe("runVerification — mode gate", () => {
  it("off: returns null and never builds the input (G2 zero-overhead)", () => {
    const build = vi.fn(() => cleanInput());
    const result = runVerification("off", build);
    expect(result).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it("warn: logs when there are findings and returns the report", () => {
    const log = vi.fn();
    const report = runVerification(
      "warn",
      () => cleanInput(cleanFlow({ flowHash: undefined })),
      undefined,
      log
    );
    expect(report?.ok).toBe(false);
    expect(log).toHaveBeenCalledOnce();
  });

  it("warn: does not log a fully-clean input", () => {
    const log = vi.fn();
    runVerification("warn", () => cleanInput(), undefined, log);
    expect(log).not.toHaveBeenCalled();
  });

  it("error: throws VerificationError before start when not ok", () => {
    expect(() =>
      runVerification("error", () => cleanInput(cleanFlow({ flowHash: undefined })))
    ).toThrow(VerificationError);
  });

  it("error: passes through a clean input", () => {
    expect(runVerification("error", () => cleanInput())?.ok).toBe(true);
  });
});

describe("formatReport", () => {
  it("renders a pass line", () => {
    expect(formatReport(verify(cleanInput()))).toContain("no findings");
  });

  it("renders error and warning counts", () => {
    const report = verify(
      cleanInput(cleanFlow({ flowHash: undefined, budget: { dimensions: ["tokens"] } }))
    );
    const text = formatReport(report);
    expect(text).toContain("error(s)");
    expect(text).toContain("warning(s)");
  });
});
