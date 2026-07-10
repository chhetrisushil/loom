import { describe, expect, it } from "vitest";
import { z } from "zod";
import { flow$ } from "./builders/flow";
import { step$ } from "./builders/step";
import { flowContentHash } from "./flowHash";

const io = { inputSchema: z.object({ n: z.number() }), outputSchema: z.object({ ok: z.boolean() }) };

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
