import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";
import { cmdNew } from "./gen";

// W5: `loom new` runs `gen` afterwards (--no-gen skips it) and `--template` picks a non-agentic
// flow starter. The templates' own tests are run for real by the day-one e2e.

let root = "";
let out: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-w5-new-"));
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("loom new + gen", () => {
  it("runs gen after writing and reports the result line", async () => {
    const app = join(root, "app");
    expect(await run(["new", "flow", "order-check", "--dir", app])).toBe(0);
    expect(out.some((l) => /^wrote .*loom\.gen\.ts \(1 flow,/.test(l))).toBe(true);
    expect(readFileSync(join(app, "loom.gen.ts"), "utf8")).toContain("./flows/order-check/flow");
  });

  it("--no-gen leaves loom.gen.ts alone", async () => {
    const app = join(root, "app");
    expect(await run(["new", "flow", "order-check", "--no-gen", "--dir", app])).toBe(0);
    expect(existsSync(join(app, "loom.gen.ts"))).toBe(false);
    expect(out.some((l) => l.startsWith("wrote "))).toBe(false);
  });
});

describe("loom new flow --template", () => {
  for (const [template, marker, dep] of [
    ["approval", "resumeSchemas", undefined],
    ["timer", "ctx.sleep(", undefined],
    ["saga", "withSaga(", "@loom/saga"],
  ] as const) {
    it(`${template}: writes the flow and a sibling test`, async () => {
      const app = join(root, "app");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { "@loom/core": "workspace:*", zod: "^3.23.8" } })
      );
      expect(await run(["new", "flow", "t1", "--template", template, "--dir", app])).toBe(0);
      expect(readFileSync(join(app, "flows/t1/flow.ts"), "utf8")).toContain(marker);
      const test = readFileSync(join(app, "flows/t1/flow.test.ts"), "utf8");
      expect(test).toContain('from "@loom/testing"');
      if (template !== "saga") expect(test).toContain("advanceTime");
      // The W1 missing-dependency hint covers what the template imports.
      const hint = out.join("\n");
      if (dep !== undefined) expect(hint).toContain(`"${dep}": "workspace:*"`);
      else expect(hint).not.toContain("@loom/saga");
      expect(hint).toContain('"@loom/testing"');
      expect(hint).toContain(`note - ${template}:`); // the wiring the template cannot do for you
    });
  }

  it("the default template is still the echo flow", () => {
    const r = cmdNew("flow", "plain", join(root, "app"));
    expect(readFileSync(r.path, "utf8")).toContain("handler$(async (i: { input: string })");
  });

  it("refuses an unknown template, and --template on a non-flow", async () => {
    const app = join(root, "app");
    expect(await run(["new", "flow", "x", "--template", "nope", "--dir", app])).toBe(2);
    expect(await run(["new", "tool", "x", "--template", "saga", "--dir", app])).toBe(2);
    expect(existsSync(join(app, "flows"))).toBe(false);
  });
});
