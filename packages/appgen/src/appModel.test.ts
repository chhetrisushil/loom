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
