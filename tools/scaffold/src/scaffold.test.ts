import { describe, expect, it } from "vitest";
import { generateRegistration, pascal } from "./codegen";
import { constructNameProblem, isValidPackageName, kebab, packageNameFrom } from "./names";
import {
  agentFile,
  appFiles,
  flowFile,
  importedPackages,
  memoryFile,
  newFile,
  newFiles,
  projectionFile,
  scheduleFile,
  skillFile,
  toolFile,
} from "./templates";

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

  it("generateRegistration with no flows yields empty arrays for every construct", () => {
    const out = generateRegistration([]);
    expect(out).toContain("export const flowModules = [];");
    // agent/tool/skill/schedule/memory arrays are always emitted (empty when none discovered).
    expect(out).toContain("export const agentModules = [];");
    expect(out).toContain("export const toolModules = [];");
    expect(out).toContain("export const skillModules = [];");
    expect(out).toContain("export const scheduleModules = [];");
    expect(out).toContain("export const memoryModules = [];");
    expect(out).toContain("export const projectionModules = [];");
  });

  it("generateRegistration emits every construct's modules alongside flows", () => {
    const out = generateRegistration(
      ["./flows/a/flow"],
      ["./agents/triage"],
      ["./tools/lookup"],
      ["./skills/refunds"],
      ["./schedules/nightly"],
      ["./memories/chat"],
      ["./projections/counter"]
    );
    expect(out).toContain('import * as _a0 from "./agents/triage";');
    expect(out).toContain("export const agentModules = [_a0];");
    expect(out).toContain('import * as _t0 from "./tools/lookup";');
    expect(out).toContain("export const toolModules = [_t0];");
    expect(out).toContain('import * as _s0 from "./skills/refunds";');
    expect(out).toContain("export const skillModules = [_s0];");
    expect(out).toContain('import * as _sc0 from "./schedules/nightly";');
    expect(out).toContain("export const scheduleModules = [_sc0];");
    expect(out).toContain('import * as _m0 from "./memories/chat";');
    expect(out).toContain("export const memoryModules = [_m0];");
    expect(out).toContain('import * as _p0 from "./projections/counter";');
    expect(out).toContain("export const projectionModules = [_p0];");
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

  it("scheduleFile, memoryFile and projectionFile export their PascalCase constructs", () => {
    expect(scheduleFile("nightly")).toContain("export const NightlySchedule");
    expect(scheduleFile("nightly")).toContain("cron:");
    expect(memoryFile("chat")).toContain("export const ChatMemory");
    expect(memoryFile("chat")).not.toContain("${");
    expect(projectionFile("counter")).toContain("export const CounterProjection");
    expect(projectionFile("counter")).toContain("handlers:");
    expect(projectionFile("counter")).not.toContain("${");
  });

  it("newFile routes each kind to its convention path", () => {
    expect(newFile("flow", "greet").path).toBe("app/flows/greet/flow.ts");
    expect(newFile("agent", "support").path).toBe("app/agents/support.ts");
    expect(newFile("tool", "lookup").path).toBe("app/tools/lookup.ts");
    expect(newFile("skill", "refunds").path).toBe("app/skills/refunds.ts");
    expect(newFile("schedule", "nightly").path).toBe("app/schedules/nightly.ts");
    expect(newFile("memory", "chat").path).toBe("app/memories/chat.ts");
    expect(newFile("projection", "counter").path).toBe("app/projections/counter.ts");
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

describe("names", () => {
  it("accepts kebab-case construct names and refuses the rest with a suggestion", () => {
    for (const ok of ["greet", "pg-lag", "a1", "order-check-2"]) {
      expect(constructNameProblem(ok), ok).toBeUndefined();
    }
    expect(constructNameProblem("Bad Name")).toContain('"bad-name"');
    expect(constructNameProblem("1abc")).toContain("kebab-case");
    expect(constructNameProblem("")).toContain("kebab-case");
    for (const p of ["../x", "a/b", "..", ".", "C:x", "a\\b"]) {
      expect(constructNameProblem(p), p).toContain("path");
    }
    expect(kebab("MyCoolApp!")).toBe("my-cool-app");
  });

  it("validates npm package names and derives one from a folder name", () => {
    expect(isValidPackageName("my-app")).toBe(true);
    for (const bad of ["Bad Name!", "", ".hidden", "_x", "UPPER"]) {
      expect(isValidPackageName(bad), bad).toBe(false);
    }
    expect(packageNameFrom("Bad Name!")).toBe("bad-name");
    expect(packageNameFrom("!!!")).toBeUndefined();
  });
});

describe("newFiles and importedPackages", () => {
  it("a flow ships a sibling test that imports @loom/testing; other kinds ship only themselves", () => {
    expect(newFiles("flow", "greet").map((f) => f.path)).toEqual([
      "app/flows/greet/flow.ts",
      "app/flows/greet/flow.test.ts",
    ]);
    expect(newFiles("tool", "lookup").map((f) => f.path)).toEqual(["app/tools/lookup.ts"]);
    expect(newFiles("flow", "greet")[1]?.content).toContain("createTestApp");
  });

  it("lists bare package imports only (scoped as two segments; node: and relative excluded)", () => {
    expect(
      importedPackages(
        [
          'import { a } from "@loom/core";',
          'import x from "zod/v3";',
          'import "node:fs";',
          'import y from "./y";',
        ].join("\n")
      )
    ).toEqual(["@loom/core", "zod"]);
    expect(importedPackages(newFile("sentinel", "w").content)).toContain("@loom/plugin-sentinel");
  });

  it("the scaffolded package.json declares @loom/testing for the emitted flow test", () => {
    expect(appFiles("a")["package.json"]).toContain('"@loom/testing": "workspace:*"');
  });
});
