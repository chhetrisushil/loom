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

describe("FlowEditor.ensureUi — import handling (ADR 0114)", () => {
  const body = (head: string) =>
    `${head}\nconst runner = async (ctx: any) => {\n  await ctx.run();\n  return {};\n};\n`;
  const edit = (src: string): string => {
    const ed = new FlowEditor(src);
    ed.ensureUi();
    return ed.toString();
  };
  const importCount = (out: string) => (out.match(/@loom\/agent-surface/g) ?? []).length;

  it("adds the import when absent", () => {
    const out = edit(body('import { x } from "y";'));
    expect(out).toContain('import { surface } from "@loom/agent-surface";');
    expect(out).toContain('surface(ctx).set("status"');
  });

  it("reuses a multi-line import (no duplicate)", () => {
    const out = edit(
      body('import {\n  createSurfaceEmitter,\n  surface,\n} from "@loom/agent-surface";')
    );
    expect(importCount(out)).toBe(1);
    expect(out).toContain('surface(ctx).set("status"');
  });

  it("reuses an aliased import under its local name", () => {
    const out = edit(body('import { surface as s } from "@loom/agent-surface";'));
    expect(importCount(out)).toBe(1);
    expect(out).toContain('s(ctx).set("status"');
    expect(out).not.toContain("surface(ctx)");
  });

  it("reuses a namespace import", () => {
    const out = edit(body('import * as ui from "@loom/agent-surface";'));
    expect(importCount(out)).toBe(1);
    expect(out).toContain('ui.surface(ctx).set("status"');
  });

  it("aliases our import around a colliding local `surface` binding", () => {
    const out = edit(body("const surface = 1;"));
    expect(out).toContain('import { surface as loomSurface } from "@loom/agent-surface";');
    expect(out).toContain('loomSurface(ctx).set("status"');
    expect(out).toContain("const surface = 1;");
  });

  it("picks a fresh alias when `loomSurface` is also bound", () => {
    const out = edit(body("const surface = 1;\nconst loomSurface = 2;"));
    expect(out).toContain('import { surface as loomSurface2 } from "@loom/agent-surface";');
    expect(out).toContain('loomSurface2(ctx).set("status"');
  });

  it("a type-only import does not count (and its name forces an alias)", () => {
    const out = edit(body('import type { surface } from "@loom/agent-surface";'));
    expect(out).toContain('import { surface as loomSurface } from "@loom/agent-surface";');
    expect(out).toContain('loomSurface(ctx).set("status"');
  });

  it("leaves an existing surface write alone, including through an alias", () => {
    const src = body('import { surface as s } from "@loom/agent-surface";').replace(
      "return {};",
      's(ctx).set("a", 1);\n  return {};'
    );
    const ed = new FlowEditor(src);
    ed.ensureUi();
    expect(ed.changed()).toBe(false);
  });
});

describe("planChangesDeterministic: existing digit-led ids resolve legacy-first", () => {
  const flow = (id: string, steps: string[]) => ({
    id,
    file: `app/flows/${id}/flow.ts`,
    steps: steps.map((s) => ({ id: s, handlerState: "edited" as const })),
    hasApproval: false,
    hasUi: false,
    isGenerated: false,
  });
  const model = (...flows: ReturnType<typeof flow>[]) => ({
    root: "/x",
    isExisting: true,
    flows,
  });
  const app = model(flow("2fa-login", ["3d-render"]));

  it("extends the existing flow and modifies the existing step (no item- ids)", () => {
    const spec = planChangesDeterministic("Create a 2fa login. Step 3d render.", app as never);
    expect(spec.capabilities).toHaveLength(1);
    const cap = spec.capabilities[0]!;
    expect(cap.id).toBe("2fa-login");
    expect(cap.op).toBe("extend");
    expect(cap.steps).toEqual([{ id: "3d-render", op: "modify" }]);
    expect(JSON.stringify(spec)).not.toContain("item-");
  });

  it("a net-new digit-led name or step still gets the item- prefix", () => {
    const spec = planChangesDeterministic("Create a 9lives. Step 4k scan.", app as never);
    expect(spec.capabilities[0]).toMatchObject({
      id: "item-9lives",
      op: "create",
      steps: [{ id: "item-4k-scan", op: "create" }],
    });
    // a new step on the existing flow is created with the minted id
    const s2 = planChangesDeterministic("Create a 2fa login. Step 5g relay.", app as never);
    expect(s2.capabilities[0]).toMatchObject({
      id: "2fa-login",
      op: "extend",
      steps: [{ id: "item-5g-relay", op: "create" }],
    });
  });

  it("a grant to the existing digit-led capability merges into the same entry", () => {
    const spec = planChangesDeterministic(
      "Create a 2fa login. Step 3d render. Grant search to 2fa login.",
      app as never
    );
    expect(spec.capabilities).toHaveLength(1);
    expect(spec.capabilities[0]).toMatchObject({ id: "2fa-login", wireGrants: ["search"] });
  });

  it("does not strip item-: a genuine new 'item 2fa' never maps to the existing '2fa'", () => {
    const only = model(flow("2fa", ["run"]));
    const spec = planChangesDeterministic("Create a item 2fa.", only as never);
    expect(spec.capabilities[0]).toMatchObject({ id: "item-2fa", op: "create" });
    // the other direction: a new "2fa" phrase maps onto an existing `item-2fa`
    const other = model(flow("item-2fa", ["run"]));
    expect(planChangesDeterministic("Create a 2fa.", other as never).capabilities[0]).toMatchObject(
      { id: "item-2fa", op: "extend" }
    );
  });

  describe("delete resolves ids like extend (legacy slug, else the minted one, never mint)", () => {
    it("deletes a minted flow `item-2fa` named '2fa'; the legacy slug still wins when both exist", () => {
      const minted = model(flow("item-2fa", ["run"]));
      expect(planChangesDeterministic("Delete 2fa.", minted as never).capabilities).toEqual([
        expect.objectContaining({ id: "item-2fa", op: "delete" }),
      ]);
      const both = model(flow("2fa", ["run"]), flow("item-2fa", ["run"]));
      expect(planChangesDeterministic("Delete 2fa.", both as never).capabilities).toEqual([
        expect.objectContaining({ id: "2fa", op: "delete" }),
      ]);
    });

    it("deletes a minted step from a minted flow", () => {
      const minted = model(flow("item-2fa", ["item-3d", "run"]));
      const spec = planChangesDeterministic("Delete step 3d from 2fa.", minted as never);
      expect(spec.capabilities).toHaveLength(1);
      expect(spec.capabilities[0]).toMatchObject({
        id: "item-2fa",
        op: "extend",
        steps: [{ id: "item-3d", op: "delete" }],
      });
    });

    it("never mints for delete: with neither id present nothing is planned", () => {
      const app = model(flow("planner", ["run"]));
      expect(planChangesDeterministic("Delete 2fa.", app as never).capabilities).toEqual([]);
      expect(
        planChangesDeterministic("Delete step 3d from planner.", app as never).capabilities
      ).toEqual([]);
      expect(
        planChangesDeterministic("Delete step run from 2fa.", app as never).capabilities
      ).toEqual([]);
    });
  });
});
