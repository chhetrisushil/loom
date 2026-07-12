import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanApp } from "./appModel";
import { applyChanges } from "./applyChanges";
import { FlowEditor } from "./astEdit";
import { planChangesDeterministic } from "./changeSpec";
import { generateProject } from "./generate";
import { parseIntent } from "./parseIntent";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "appgen-change-"));
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

describe("planChangesDeterministic", () => {
  it("tags everything create for a net-new directory", () => {
    const spec = planChangesDeterministic("Create a planner. Step summarize.", scanApp(dir));
    expect(spec.planner).toBe("deterministic");
    const cap = spec.capabilities[0];
    expect(cap?.op).toBe("create");
    expect(cap?.steps).toEqual([{ id: "summarize", op: "create" }]);
  });

  it("tags an existing flow extend, new steps create, and skips a present gate", () => {
    writeProject("Create a planner. Pause for approval.");
    const model = scanApp(dir);
    const spec = planChangesDeterministic(
      "Create a planner. Step summarize. Pause for approval.",
      model
    );
    const cap = spec.capabilities[0];
    expect(cap?.op).toBe("extend");
    expect(cap?.steps).toEqual([{ id: "summarize", op: "create" }]);
    // The flow already has an approval gate, so we don't re-add it.
    expect(cap?.addApproval).toBe(false);
  });
});

describe("applyChanges", () => {
  it("plans a full project for a net-new directory", () => {
    const model = scanApp(dir);
    const spec = planChangesDeterministic("Create a greeter.", model);
    const plan = applyChanges(spec, model);
    expect(plan.isNewProject).toBe(true);
    expect(plan.creates.map((c) => c.path)).toContain("package.json");
    expect(plan.creates.map((c) => c.path)).toContain("app/flows/greeter/flow.ts");
    expect(plan.edits).toEqual([]);
  });

  it("extends an existing flow: adds a step const, registers it, adds an approval gate", () => {
    writeProject("Create a planner.");
    const model = scanApp(dir);
    const spec = planChangesDeterministic(
      "Create a planner. Step summarize. Pause for approval.",
      model
    );
    const plan = applyChanges(spec, model);

    expect(plan.isNewProject).toBe(false);
    expect(plan.creates).toEqual([]);
    const edit = plan.edits.find((e) => e.path.endsWith(path.join("planner", "flow.ts")));
    expect(edit).toBeDefined();
    const after = edit?.after ?? "";
    // New step const + registration in the flow's steps array.
    expect(after).toContain("const summarizeStep = step$(");
    expect(after).toContain("steps: [runStep, summarizeStep]");
    // Approval gate inserted into the runner.
    expect(after).toContain('await ctx.suspend({ on: "Approved" })');
    // The original run step and its stub handler are untouched.
    expect(after).toContain("const runStep = step$(");
    expect(after).toContain("TODO: implement run for");
  });

  it("adds a brand-new capability as a created flow file and re-wires registration", () => {
    writeProject("Create a planner.");
    const model = scanApp(dir);
    const spec = planChangesDeterministic("Create a reporter.", model);
    const plan = applyChanges(spec, model);
    expect(plan.creates.map((c) => c.path)).toContain("app/flows/reporter/flow.ts");
    expect(plan.regenRegistration).toBe(true);
  });
});

describe("FlowEditor safety gate", () => {
  it("refuses to overwrite a hand-edited handler (insert-only)", () => {
    writeProject("Create a greeter.");
    const flowPath = path.join(dir, "app", "flows", "greeter", "flow.ts");
    const edited = fs
      .readFileSync(flowPath, "utf8")
      .replace(/TODO: implement run for \$\{input\.prompt\}/, "Hello, ${input.prompt}!");
    fs.writeFileSync(flowPath, edited);

    const editor = new FlowEditor(edited, "flow.ts");
    const replaced = editor.replaceStubBody("run", "async () => ({ result: 'x' })");
    expect(replaced).toBe(false);
    expect(editor.changed()).toBe(false);
    expect(editor.notes.join()).toMatch(/hand-edited/);
  });

  it("replaces a still-stub handler body", () => {
    writeProject("Create a greeter.");
    const src = fs.readFileSync(path.join(dir, "app", "flows", "greeter", "flow.ts"), "utf8");
    const editor = new FlowEditor(src, "flow.ts");
    const replaced = editor.replaceStubBody("run", "async () => ({ result: 'done' })");
    expect(replaced).toBe(true);
    expect(editor.toString()).toContain("async () => ({ result: 'done' })");
  });
});
