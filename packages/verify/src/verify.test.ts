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

describe("the reach bound is stated, not implied", () => {
  // capability-compat, effect-class and suspension-safety all answer "does
  // everything this flow reaches satisfy X". Each is only as good as the
  // reachable set, and silence about a hole in that set turns a green report
  // into an overclaim.
  it("capability-compat warns when a ctx.run target could not be resolved", () => {
    const report = verify({
      ...cleanInput(
        cleanFlow({
          reachAnalyzed: true,
          unresolvedReach: [{ expr: "mcpInvoke$(…)", kind: "step" }],
        })
      ),
      grants: { grants: { checkout: "*" } },
    });
    const f = report.findings.filter((x) => x.rule === "capability-compat");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("warn");
    expect(f[0]?.message).toContain("mcpInvoke$(…)");
    // A warn, so a report with only this stays ok — an unresolved target is a
    // limit of the analysis, not a defect in the app.
    expect(report.ok).toBe(true);
  });

  it("says nothing when reach analysis resolved everything", () => {
    const report = verify({
      ...cleanInput(cleanFlow({ reachAnalyzed: true })),
      grants: { grants: { checkout: "*" } },
    });
    expect(report.findings.filter((x) => x.rule === "capability-compat")).toHaveLength(0);
  });

  it("truncates a long unresolved list rather than printing all of it", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ expr: `s${i}`, kind: "step" as const }));
    const report = verify({
      ...cleanInput(cleanFlow({ reachAnalyzed: true, unresolvedReach: many })),
      grants: { grants: { checkout: "*" } },
    });
    expect(report.findings[0]?.message).toContain("+4 more");
  });
});

describe("suspension-safety rule", () => {
  // A suspend with no correlationKey used to be an ERROR reading "a resume event
  // cannot be routed to it". `WorkflowRuntime.resume(executionId, event)` routes
  // by executionId and nothing matches on correlationKey at all, so that was
  // simply false — invisible only because `FlowSpec.suspends` had no producer.
  // Populating the input is what made it visible; the check is gone.
  it("does NOT flag a suspend that declares no correlationKey", () => {
    const report = verify(cleanInput(cleanFlow({ suspends: [{ id: "wait" }] })));
    expect(report.findings.filter((f) => f.rule === "suspension-safety")).toHaveLength(0);
  });

  it("flags a timed suspend with no wakeAt when no TimerStore is wired", () => {
    const report = verify(
      cleanInput(cleanFlow({ suspends: [{ id: "late", timed: true, wakeAt: false }] }))
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "suspension-safety", severity: "error" })
    );
  });

  it("does NOT flag it when a TimerStore IS wired — wakeAt is derived from timeout there", () => {
    const report = verify({
      ...cleanInput(cleanFlow({ suspends: [{ id: "late", timed: true, wakeAt: false }] })),
      timerStoreWired: true,
    });
    expect(report.findings.filter((f) => f.rule === "suspension-safety")).toHaveLength(0);
  });

  it("warns when a suspend condition could not be read statically", () => {
    // A flow that suspends must not look like a flow that does not.
    const report = verify(
      cleanInput(
        cleanFlow({
          reachAnalyzed: true,
          unresolvedReach: [{ expr: "gateCondition", kind: "suspend" }],
        })
      )
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "suspension-safety", severity: "warn" })
    );
  });

  it("ignores an unresolved STEP target — it says nothing about suspend safety", () => {
    const report = verify(
      cleanInput(
        cleanFlow({ reachAnalyzed: true, unresolvedReach: [{ expr: "charge", kind: "step" }] })
      )
    );
    expect(report.findings.filter((f) => f.rule === "suspension-safety")).toHaveLength(0);
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

// ── EF — effect classes (static ceiling) + K2 reconciliation ──────────────────
describe("effect-class rule", () => {
  const CLASSES = ["read-only", "local-write", "external-write", "irreversible"] as const;
  const run = (input: Partial<VerifyInput>) =>
    verify({ flows: [], effectClasses: [...CLASSES], ...input } as VerifyInput).findings.filter(
      (f) => f.rule === "effect-class"
    );

  const flow = (
    effectClass: string | undefined,
    effects: { toolId: string; effectClass?: string }[]
  ) => ({
    id: "f",
    ...(effectClass !== undefined && { effectClass }),
    effects: effects.map((e) => ({
      toolId: e.toolId,
      capability: e.toolId,
      kind: "step" as const,
      ...(e.effectClass !== undefined && { effectClass: e.effectClass }),
    })),
  });

  it("passes when every reachable effect is within the declared class", () => {
    expect(
      run({
        flows: [
          flow("local-write", [
            { toolId: "read", effectClass: "read-only" },
            { toolId: "save", effectClass: "local-write" },
          ]),
        ],
      })
    ).toEqual([]);
  });

  it("fails when a reachable effect exceeds the declared class", () => {
    const f = run({
      flows: [flow("read-only", [{ toolId: "post", effectClass: "external-write" }])],
    });
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("error");
    expect(f[0]?.message).toMatch(
      /declares effect class "read-only" but reaches "post", classed "external-write"/
    );
    expect(f[0]?.location).toBe("f:post");
  });

  it("composes conservatively — the worst reachable effect decides", () => {
    const f = run({
      flows: [
        flow("local-write", [
          { toolId: "a", effectClass: "read-only" },
          { toolId: "b", effectClass: "irreversible" },
          { toolId: "c", effectClass: "local-write" },
        ]),
      ],
    });
    expect(f.map((x) => x.location)).toEqual(["f:b"]);
  });

  // ── K2 reconciliation ──────────────────────────────────────────────────────
  it("says when K2 will NOT stop the violation, because the capability is granted", () => {
    const f = run({
      flows: [flow("read-only", [{ toolId: "post", effectClass: "external-write" }])],
      grants: { grants: { f: ["post"] } },
    });
    expect(f[0]?.message).toMatch(/IS granted, so K2 will not stop it at runtime/);
  });

  it("says when K2 would also deny it", () => {
    const f = run({
      flows: [flow("read-only", [{ toolId: "post", effectClass: "external-write" }])],
      grants: { grants: { f: ["other"] } },
    });
    expect(f[0]?.message).toMatch(/K2 would also deny it/);
  });

  it("stays silent about K2 when no GrantTable is wired", () => {
    const f = run({
      flows: [flow("read-only", [{ toolId: "post", effectClass: "external-write" }])],
    });
    expect(f[0]?.message).not.toMatch(/K2/);
  });

  // ── Cannot pass vacuously ──────────────────────────────────────────────────
  it("warns rather than passing when reachable effects carry no class", () => {
    const f = run({ flows: [flow("read-only", [{ toolId: "mystery" }])] });
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("warn");
    expect(f[0]?.message).toMatch(
      /1 reachable effect\(s\) carry no class — the declaration is only partially verified/
    );
  });

  it("rejects a class name outside the configured ordering (catches typos)", () => {
    expect(run({ flows: [flow("read-onyl", [])] })[0]?.message).toMatch(
      /not in the configured ordering/
    );
    expect(
      run({ flows: [flow("read-only", [{ toolId: "x", effectClass: "extrenal-write" }])] })[0]
        ?.message
    ).toMatch(/Effect "x" declares effect class "extrenal-write"/);
  });

  // ── G2: unwired is byte-identical ──────────────────────────────────────────
  it("is a no-op when the app declares no vocabulary", () => {
    const input = {
      flows: [flow("anything", [{ toolId: "x", effectClass: "nonsense" }])],
    } as VerifyInput;
    expect(verify(input).findings.filter((f) => f.rule === "effect-class")).toEqual([]);
  });

  it("is a no-op for a flow that declares no class", () => {
    expect(
      run({ flows: [flow(undefined, [{ toolId: "post", effectClass: "irreversible" }])] })
    ).toEqual([]);
  });
});
