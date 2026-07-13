import { describe, expect, it } from "vitest";
import { generateRegistration, pascal } from "./codegen";
import { agentFile, appFiles, flowFile, newFile, skillFile, toolFile } from "./templates";

describe("codegen", () => {
  it("pascal-cases kebab/snake/space names", () => {
    expect(pascal("greet-customer")).toBe("GreetCustomer");
    expect(pascal("issue_refund")).toBe("IssueRefund");
    expect(pascal("greet")).toBe("Greet");
  });

  it("generateRegistration emits static imports + a flowModules array", () => {
    const out = generateRegistration(["./flows/a/flow", "./flows/b/flow"]);
    expect(out).toContain('import * as _f0 from "./flows/a/flow";');
    expect(out).toContain('import * as _f1 from "./flows/b/flow";');
    expect(out).toContain("export const flowModules = [_f0, _f1];");
  });

  it("generateRegistration with no flows yields an empty array", () => {
    const out = generateRegistration([]);
    expect(out).toContain("export const flowModules = [];");
    // agent/tool/skill arrays are always emitted (empty when none discovered).
    expect(out).toContain("export const agentModules = [];");
    expect(out).toContain("export const toolModules = [];");
    expect(out).toContain("export const skillModules = [];");
  });

  it("generateRegistration emits agent/tool/skill modules alongside flows", () => {
    const out = generateRegistration(
      ["./flows/a/flow"],
      ["./agents/triage"],
      ["./tools/lookup"],
      ["./skills/refunds"]
    );
    expect(out).toContain('import * as _a0 from "./agents/triage";');
    expect(out).toContain("export const agentModules = [_a0];");
    expect(out).toContain('import * as _t0 from "./tools/lookup";');
    expect(out).toContain("export const toolModules = [_t0];");
    expect(out).toContain('import * as _s0 from "./skills/refunds";');
    expect(out).toContain("export const skillModules = [_s0];");
  });
});

describe("per-file templates", () => {
  it("flowFile exports a PascalCase flow with no unresolved placeholders", () => {
    const f = flowFile("greet");
    expect(f).toContain("export const GreetFlow");
    expect(f).toContain('id: "greet"');
    expect(f).not.toContain("${");
  });

  it("toolFile, agentFile and skillFile export their PascalCase constructs", () => {
    expect(toolFile("lookup")).toContain("export const LookupTool");
    expect(agentFile("support")).toContain("export const SupportAgent");
    const skill = skillFile("refunds");
    expect(skill).toContain("export const RefundsSkill");
    expect(skill).toContain("instructions$(");
    expect(skill).not.toContain("${");
  });

  it("newFile routes each kind to its convention path", () => {
    expect(newFile("flow", "greet").path).toBe("app/flows/greet/flow.ts");
    expect(newFile("agent", "support").path).toBe("app/agents/support.ts");
    expect(newFile("tool", "lookup").path).toBe("app/tools/lookup.ts");
    expect(newFile("skill", "refunds").path).toBe("app/skills/refunds.ts");
  });
});

describe("appFiles", () => {
  it("emits the convention layout with a pre-generated loom.gen", () => {
    const files = appFiles("acme");
    expect(files["app/flows/greet/flow.ts"]).toContain("GreetFlow");
    expect(files["app/loom.gen.ts"]).toContain("./flows/greet/flow");
    expect(files["app/config.ts"]).toContain("flowModules");
    expect(files["app/config.ts"]).toContain("skillModules");
    for (const content of Object.values(files)) expect(content).not.toContain("${");
  });
});
