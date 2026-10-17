import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanApp } from "./appModel";
import { generateProject } from "./generate";
import { parseIntent } from "./parseIntent";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "appgen-scan-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a generated project into `dir` so we scan real generator output. */
function writeProject(intent: string): void {
  for (const f of generateProject(parseIntent(intent))) {
    const dest = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.contents);
  }
}

describe("scanApp (dir → AppModel)", () => {
  it("reports a net-new directory as empty and non-existing", () => {
    const model = scanApp(dir);
    expect(model.isExisting).toBe(false);
    expect(model.flows).toEqual([]);
  });

  it("scans a generated project: flow id, steps, gates, and generated marker", () => {
    writeProject("Create a planner. Pause for approval. Generate UI.");
    const model = scanApp(dir);

    expect(model.isExisting).toBe(true);
    const flow = model.flows.find((f) => f.id === "planner");
    expect(flow).toBeDefined();
    expect(flow?.file).toBe(path.join("app", "flows", "planner", "flow.ts"));
    expect(flow?.isGenerated).toBe(true);
    expect(flow?.hasApproval).toBe(true);
    expect(flow?.hasUi).toBe(true);
    expect(flow?.steps.map((s) => s.id)).toEqual(["run"]);
    // A freshly generated handler is an untouched stub.
    expect(flow?.steps[0]?.handlerState).toBe("stub");
  });

  it("classifies a hand-edited handler body as 'edited' (the safety gate signal)", () => {
    writeProject("Create a greeter.");
    const flowPath = path.join(dir, "app", "flows", "greeter", "flow.ts");
    const edited = fs
      .readFileSync(flowPath, "utf8")
      .replace(/TODO: implement run for \$\{input\.prompt\}/, "Hello, ${input.prompt}!");
    fs.writeFileSync(flowPath, edited);

    const flow = scanApp(dir).flows.find((f) => f.id === "greeter");
    expect(flow?.steps[0]?.handlerState).toBe("edited");
  });
});

describe("scanApp never offers a symlinked flow as an editable flow", () => {
  const outsideDir = (): string => path.join(dir, "..", `${path.basename(dir)}-outside`);
  const outsideOf = (): string => {
    fs.mkdirSync(outsideDir());
    return outsideDir();
  };
  afterEach(() => {
    fs.rmSync(outsideDir(), { recursive: true, force: true });
  });

  it("skips a symlinked flow.ts and records it", () => {
    writeProject("Create a planner. Step fetch.");
    const o = outsideOf();
    const flow = path.join(dir, "app", "flows", "planner", "flow.ts");
    fs.renameSync(flow, path.join(o, "flow.ts"));
    fs.symlinkSync(path.join(o, "flow.ts"), flow);
    const m = scanApp(dir);
    expect(m.flows.map((f) => f.id)).not.toContain("planner");
    expect(m.skippedLinks).toEqual([path.join("app", "flows", "planner", "flow.ts")]);
  });

  it("skips a symlinked flow folder and a symlinked app/flows", () => {
    writeProject("Create a planner. Step fetch.");
    const o = outsideOf();
    const folder = path.join(dir, "app", "flows", "planner");
    fs.renameSync(folder, path.join(o, "planner"));
    fs.symlinkSync(path.join(o, "planner"), folder);
    expect(scanApp(dir).flows).toEqual([]);
    expect(scanApp(dir).skippedLinks).toEqual([path.join("app", "flows", "planner")]);
    fs.rmSync(folder);
    fs.renameSync(path.join(dir, "app", "flows"), path.join(o, "flows"));
    fs.symlinkSync(path.join(o, "flows"), path.join(dir, "app", "flows"));
    expect(scanApp(dir).flows).toEqual([]);
    expect(scanApp(dir).skippedLinks).toEqual([path.join("app", "flows")]);
  });
});
