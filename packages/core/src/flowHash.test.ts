import { describe, expect, it } from "vitest";
import { z } from "zod";
import { flow$ } from "./builders/flow";
import { step$ } from "./builders/step";
import { flowContentHash } from "./flowHash";

const io = {
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
};

function makeFlow(overrides: Partial<Parameters<typeof flow$>[0]> = {}) {
  return flow$({
    id: "audit",
    name: "Audit",
    version: "1.0.0",
    ...io,
    steps: [
      step$({ id: "collect", name: "Collect", toolId: "collect-tool", ...io }),
      step$({ id: "report", name: "Report", toolId: "report-tool", timeoutMs: 5000, ...io }),
    ],
    ...overrides,
  });
}

// K11.1 — the hash is the fold-compatibility fingerprint: stable under rebuilds
// and cosmetic edits, different for any change to the step graph / bindings /
// durable policies.
describe("flowContentHash (K11.1)", () => {
  it("is deterministic across structurally identical definitions", () => {
    expect(flowContentHash(makeFlow())).toBe(flowContentHash(makeFlow()));
  });

  it("ignores cosmetic metadata (name, description)", () => {
    const base = flowContentHash(makeFlow());
    expect(flowContentHash(makeFlow({ name: "Renamed Audit" }))).toBe(base);
    expect(flowContentHash(makeFlow({ description: "now documented" }))).toBe(base);
  });

  it("changes when the step graph changes", () => {
    const base = flowContentHash(makeFlow());
    const extraStep = makeFlow({
      steps: [
        step$({ id: "collect", name: "Collect", toolId: "collect-tool", ...io }),
        step$({ id: "verify", name: "Verify", toolId: "verify-tool", ...io }),
        step$({ id: "report", name: "Report", toolId: "report-tool", timeoutMs: 5000, ...io }),
      ],
    });
    expect(flowContentHash(extraStep)).not.toBe(base);
  });

  it("changes when a step's effect binding or durable policy changes", () => {
    const base = flowContentHash(makeFlow());
    const rebound = makeFlow({
      steps: [
        step$({ id: "collect", name: "Collect", toolId: "collect-tool-v2", ...io }),
        step$({ id: "report", name: "Report", toolId: "report-tool", timeoutMs: 5000, ...io }),
      ],
    });
    const retimed = makeFlow({
      steps: [
        step$({ id: "collect", name: "Collect", toolId: "collect-tool", ...io }),
        step$({ id: "report", name: "Report", toolId: "report-tool", timeoutMs: 9000, ...io }),
      ],
    });
    expect(flowContentHash(rebound)).not.toBe(base);
    expect(flowContentHash(retimed)).not.toBe(base);
  });

  it("changes with version and deadline", () => {
    const base = flowContentHash(makeFlow());
    expect(flowContentHash(makeFlow({ version: "1.1.0" }))).not.toBe(base);
    expect(flowContentHash(makeFlow({ deadlineMs: 60_000 }))).not.toBe(base);
  });
});

// ADR 0113 D1/D2 — SHA-256, the legacy generation, and the opt-in body fingerprint.
describe("flowContentHash (ADR 0113)", () => {
  it("is SHA-256, prefixed `sha256:`, over the same canonical structure", async () => {
    const { flowContentHash: hash, legacyFlowContentHash } = await import("./flowHash");
    expect(hash(makeFlow())).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(legacyFlowContentHash(makeFlow())).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    // structurally different flows differ in BOTH generations
    const other = makeFlow({ version: "2.0.0" });
    expect(hash(other)).not.toBe(hash(makeFlow()));
    expect(legacyFlowContentHash(other)).not.toBe(legacyFlowContentHash(makeFlow()));
  });

  it("flowHashMatches: a legacy recording is compared with the legacy hash, a new one with the new", async () => {
    const {
      flowContentHash: hash,
      flowHashMatches,
      legacyFlowContentHash,
    } = await import("./flowHash");
    const f = makeFlow();
    expect(flowHashMatches(hash(f), f)).toBe(true);
    expect(flowHashMatches(legacyFlowContentHash(f), f)).toBe(true);
    const changed = makeFlow({ version: "9.9.9" });
    expect(flowHashMatches(hash(f), changed)).toBe(false);
    expect(flowHashMatches(legacyFlowContentHash(f), changed)).toBe(false);
    expect(flowHashMatches(`sha256:${"0".repeat(64)}`, f)).toBe(false);
  });

  it("codeFingerprint, compatibleWith and stepFamilies are NOT hash inputs (and flow$ carries them)", () => {
    const base = flowContentHash(makeFlow());
    const f = makeFlow({
      codeFingerprint: "fp1",
      compatibleWith: ["fp0"],
      stepFamilies: ["x", /^y/],
    });
    expect(flowContentHash(f)).toBe(base);
    expect(f.codeFingerprint).toBe("fp1");
    expect(f.compatibleWith).toEqual(["fp0"]);
    expect(f.stepFamilies).toHaveLength(2);
    expect("codeFingerprint" in makeFlow()).toBe(false); // absent stays absent
  });
});
