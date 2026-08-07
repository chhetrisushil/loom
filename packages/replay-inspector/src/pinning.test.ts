import type { ExecutionState } from "@loom/core";
import { describe, expect, it } from "vitest";
import { canServePin, describePin, pinOf } from "./pinning";

function state(variables: Record<string, unknown>, version = "1.0.0"): ExecutionState {
  return {
    executionId: "e",
    workflowId: "wf",
    workflowVersion: version,
    status: "running",
    frames: {},
    variables,
    sequence: 0,
    startedAt: 0,
    updatedAt: 0,
  };
}

describe("pinOf — the three cases", () => {
  it("reports a recorded flowHash as pinned", () => {
    expect(pinOf(state({ _flowHash: "abc123" }))).toEqual({
      status: "pinned",
      workflowId: "wf",
      workflowVersion: "1.0.0",
      flowHash: "abc123",
    });
  });

  it("reports a pre-1.4.0 log with no flowHash as unpinned-legacy, not as an error", () => {
    const pin = pinOf(state({ _input: { n: 1 } }));
    expect(pin.status).toBe("unpinned-legacy");
    expect(pin).not.toHaveProperty("flowHash");
  });

  it("reports an unrecorded workflowVersion as empty, never as current", () => {
    expect(pinOf(state({ _flowHash: "h" }, "")).workflowVersion).toBe("");
  });

  it("ignores a wrongly-typed or empty _flowHash rather than trusting it", () => {
    expect(pinOf(state({ _flowHash: 42 })).status).toBe("unpinned-legacy");
    expect(pinOf(state({ _flowHash: "" })).status).toBe("unpinned-legacy");
    expect(pinOf(state({ _flowHash: null })).status).toBe("unpinned-legacy");
  });

  it("does not read _flowHash through the prototype chain", () => {
    const poisoned = Object.create({ _flowHash: "inherited-hash" }) as Record<string, unknown>;
    poisoned._input = 1;
    expect(pinOf(state(poisoned)).status).toBe("unpinned-legacy");
  });
});

describe("describePin", () => {
  it("never renders an unrecorded version as if it were real", () => {
    expect(describePin(pinOf(state({ _flowHash: "h" }, "")))).toContain("version unrecorded");
  });

  it("marks a legacy execution explicitly", () => {
    expect(describePin(pinOf(state({})))).toContain("unpinned (legacy)");
  });

  it("shows the flow hash for a pinned execution", () => {
    expect(describePin(pinOf(state({ _flowHash: "abc" })))).toBe("wf@1.0.0 [flowHash abc]");
  });
});

describe("canServePin", () => {
  it("refuses a pinned execution whose artifact is absent", () => {
    expect(canServePin(pinOf(state({ _flowHash: "v1" })), new Set(["v2"]))).toBe(false);
  });

  it("serves a pinned execution whose artifact is present", () => {
    expect(canServePin(pinOf(state({ _flowHash: "v1" })), new Set(["v1", "v2"]))).toBe(true);
  });

  it("serves a legacy execution — there is no pin to violate", () => {
    expect(canServePin(pinOf(state({})), new Set())).toBe(true);
  });
});
