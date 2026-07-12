import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanApp } from "./appModel";
import { applyChanges } from "./applyChanges";
import { planChangesDeterministic } from "./changeSpec";
import { wireGrantsIntoConfig } from "./configEditor";
import { generateProject } from "./generate";
import { parseIntent } from "./parseIntent";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "appgen-bf-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeProject(intent: string): void {
  for (const f of generateProject(parseIntent(intent))) {
    const dest = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.contents);
  }
}

/** Assert a TypeScript source string has no syntax diagnostics (integration guard). */
function assertParses(source: string): void {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  // biome-ignore lint/suspicious/noExplicitAny: parseDiagnostics is internal but stable.
  const diags = (sf as any).parseDiagnostics ?? [];
  expect(diags.length, JSON.stringify(diags.map((d: ts.Diagnostic) => d.messageText))).toBe(0);
}

describe("new step is wired into the runner", () => {
  it("adds a ctx.run call for the new step and still parses", () => {
    writeProject("Create a planner.");
    const model = scanApp(dir);
    const spec = planChangesDeterministic("Create a planner. Step summarize.", model);
    const edit = applyChanges(spec, model).edits.find((e) => e.path.endsWith("flow.ts"));
    expect(edit?.after).toContain("await ctx.run(summarizeStep, { prompt: input.prompt });");
    assertParses(edit?.after ?? "");
  });
});

describe("delete op", () => {
  it("plans a delete for a generated flow and marks it for regeneration", () => {
    writeProject("Create a planner. Create a reporter.");
    const model = scanApp(dir);
    const plan = applyChanges(planChangesDeterministic("Delete the reporter.", model), model);
    expect(plan.deletes.map((d) => d.path)).toContain(
      path.join("app", "flows", "reporter", "flow.ts")
    );
    expect(plan.regenRegistration).toBe(true);
  });

  it("refuses to delete a flow with a hand-edited handler", () => {
    writeProject("Create a planner.");
    const flowPath = path.join(dir, "app", "flows", "planner", "flow.ts");
    const edited = fs
      .readFileSync(flowPath, "utf8")
      .replace("TODO: implement run for ${input.prompt}", "hand-written result");
    fs.writeFileSync(flowPath, edited);
    const model = scanApp(dir);
    const plan = applyChanges(planChangesDeterministic("Delete the planner.", model), model);
    expect(plan.deletes).toEqual([]);
    expect(plan.skips.some((s) => /hand-written/.test(s.reason))).toBe(true);
  });

  it("removes a step (const + array entry + runner call) and still parses", () => {
    // Two steps; the runner calls only the first (run), so summarize is safe to delete.
    writeProject("Create a planner. Step run. Step summarize.");
    const model = scanApp(dir);
    const plan = applyChanges(
      planChangesDeterministic("Delete step summarize from planner.", model),
      model
    );
    const edit = plan.edits.find((e) => e.path.endsWith("flow.ts"));
    expect(edit).toBeDefined();
    expect(edit?.after).not.toContain("summarizeStep");
    expect(edit?.after).toContain("runStep"); // the other step is untouched
    expect(edit?.after).toContain("steps: [runStep]");
    assertParses(edit?.after ?? "");
  });
});

describe("modify op", () => {
  it("records an honest note and makes no edit for an existing step", () => {
    writeProject("Create a planner.");
    const model = scanApp(dir);
    // "Step run" on an app that already has a run step → step op modify.
    const plan = applyChanges(
      planChangesDeterministic("Create a planner. Step run.", model),
      model
    );
    expect(plan.edits).toEqual([]);
    expect(plan.skips.some((s) => /doesn't rewrite handler bodies/.test(s.reason))).toBe(true);
  });
});

describe("wireGrants → config.ts", () => {
  it("plans a config edit adding a GrantTable authorizer and import", () => {
    writeProject("Create a planner.");
    const model = scanApp(dir);
    const plan = applyChanges(
      planChangesDeterministic("Grant metrics-tool to planner.", model),
      model
    );
    const edit = plan.edits.find((e) => e.path.endsWith("config.ts"));
    expect(edit?.after).toContain('import { GrantTable } from "@loom/effect-runtime";');
    expect(edit?.after).toContain("authorizer: new GrantTable({");
    expect(edit?.after).toContain('"planner": ["metrics-tool"]');
  });

  it("does not double-wire when an authorizer already exists", () => {
    const src = [
      'import { defineConfig } from "@loom/app";',
      "export const app = defineConfig({",
      '  storage: { kind: "memory" },',
      "  authorizer: existing,",
      "});",
    ].join("\n");
    const res = wireGrantsIntoConfig(src, { planner: ["metrics-tool"] });
    expect(res.changed).toBe(false);
    expect(res.notes.join()).toMatch(/already declares an `authorizer`/);
  });
});
