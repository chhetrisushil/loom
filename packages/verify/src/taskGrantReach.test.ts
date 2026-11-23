import { describe, expect, it } from "vitest";
import { RULE_ORDER } from "./rules";
import type { FlowSpec } from "./types";
import { verify } from "./verify";

const flow = (id: string, tools: string[], extra: Partial<FlowSpec> = {}): FlowSpec => ({
  id,
  effects: tools.map((t) => ({ toolId: t, capability: t })),
  reachAnalyzed: true,
  ...extra,
});
const run = (input: Parameters<typeof verify>[0]) =>
  verify(input, { rules: ["task-grant-reach"] }).findings;

describe("task-grant-reach (ADR 0150 D9)", () => {
  it("is in the registry", () => {
    expect(RULE_ORDER).toContain("task-grant-reach");
  });

  it("passes a template that equals the reach, and one that is narrower", () => {
    // kills: flagging a template that is a subset of the reach
    const flows = [flow("f", ["a", "b"])];
    expect(run({ flows, taskGrants: [{ flowId: "f", effects: ["a", "b"] }] })).toEqual([]);
    expect(run({ flows, taskGrants: [{ flowId: "f", effects: ["a"] }] })).toEqual([]);
  });

  it("warns on an effect outside the reach, naming it (over-broad)", () => {
    // kills: a rule that never compares, or reports an error / nothing
    const f = run({
      flows: [flow("f", ["a"])],
      taskGrants: [{ flowId: "f", effects: ["a", "z", "y"] }],
    });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "task-grant-reach", severity: "warn", location: "f" });
    expect(f[0]?.message).toContain('"y", "z"');
    expect(f[0]?.message).not.toContain('"a"');
  });

  it("uses the template's resolved reach (children, agent loops) over the flow's own effects", () => {
    // kills: always reading flow.effects, which would flag a legitimate child-flow effect
    const flows = [flow("f", ["a"])];
    expect(
      run({ flows, taskGrants: [{ flowId: "f", effects: ["a", "c"], reach: ["a", "c"] }] })
    ).toEqual([]);
  });

  it("warns on a template for an unregistered flow", () => {
    // kills: silently skipping an unknown flow (a typo would read as coverage)
    const f = run({ flows: [flow("f", [])], taskGrants: [{ flowId: "nope", effects: ["a"] }] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "warn", location: "nope" });
  });

  it("is a no-op when unconfigured, and says so when configured but empty", () => {
    // kills: erroring on absent input, and the vacuous pass on []
    expect(run({ flows: [flow("f", ["a"])] })).toEqual([]);
    const f = run({ flows: [flow("f", ["a"])], taskGrants: [] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "info" });
  });

  it("states the reach bound when the flow has unresolved targets", () => {
    // kills: a clean result over a flow whose reach is only partly known
    const f = run({
      flows: [flow("f", ["a"], { unresolvedReach: [{ expr: "x()", kind: "step" }] })],
      taskGrants: [{ flowId: "f", effects: ["a"] }],
    });
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("warn");
  });
});
