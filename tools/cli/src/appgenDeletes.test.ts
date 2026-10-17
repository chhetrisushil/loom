import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdAppgen } from "./appgen";
import { run } from "./cli";

// A deletion (a whole flow, or a step cut out of one) is never applied unattended, whichever
// planner produced it: with no TTY to ask and no --yes, `loom appgen` refuses and exits 1.
// (vitest's stdin is not a TTY, so these runs are the non-interactive path.)
describe("loom appgen: deletions need a confirmation", () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-appgen-del-"));
    stdout = [];
    stderr = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      stdout.push(a.join(" "));
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = async (): Promise<string> => {
    const app = join(dir, "app-dir");
    const code = await run([
      "appgen",
      "Create a planner. Step summarize. Create a reporter.",
      "--dir",
      app,
      "--yes",
      "--offline",
    ]);
    expect(code).toBe(0);
    return app;
  };
  const reporter = (app: string) => join(app, "app/flows/reporter/flow.ts");

  it("refuses a flow delete without --yes, naming what it would delete", async () => {
    const app = await seed();
    const code = await run(["appgen", "Delete the reporter.", "--dir", app, "--offline"]);
    expect(code).toBe(1);
    expect(existsSync(reporter(app))).toBe(true);
    expect(stderr.join("")).toMatch(/DELETES 1 item\(s\).*reporter.*--yes/);
  });

  it("refuses a step delete without --yes and leaves the file untouched", async () => {
    const app = await seed();
    const flow = join(app, "app/flows/planner/flow.ts");
    const before = readFileSync(flow, "utf8");
    const code = await run([
      "appgen",
      "Delete step summarize from planner.",
      "--dir",
      app,
      "--offline",
    ]);
    expect(code).toBe(1);
    expect(readFileSync(flow, "utf8")).toBe(before);
    expect(stderr.join("")).toContain('step "summarize"');
  });

  it("applies the same deletes with --yes", async () => {
    const app = await seed();
    expect(await run(["appgen", "Delete the reporter.", "--dir", app, "--offline", "--yes"])).toBe(
      0
    );
    expect(existsSync(reporter(app))).toBe(false);
  });

  it("a dry run lists every deletion explicitly and writes nothing", async () => {
    const app = await seed();
    const code = await run([
      "appgen",
      "Delete the reporter. Delete step summarize from planner.",
      "--dir",
      app,
      "--offline",
      "--dry-run",
    ]);
    expect(code).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain("DESTRUCTIVE: this plan DELETES 2 item(s)");
    expect(text).toContain("flow file");
    expect(text).toContain('step "summarize"');
    expect(existsSync(reporter(app))).toBe(true);
  });

  it("a plan without deletions still applies unattended", async () => {
    const app = await seed();
    const code = await run(["appgen", "Create a planner. Step route.", "--dir", app, "--offline"]);
    expect(code).toBe(0);
    expect(readFileSync(join(app, "app/flows/planner/flow.ts"), "utf8")).toContain("routeStep");
  });

  describe("the library API (cmdAppgen) needs consent for deletes too", () => {
    const del = (app: string, extra: object = {}) =>
      cmdAppgen({ intent: "Delete the reporter.", dir: app, offline: true, ...extra });

    it("refuses with neither confirm nor allowDeletes: nothing written, deletions named", async () => {
      const app = await seed();
      const r = await del(app);
      expect(r.aborted).toBe(true);
      expect(r.refusedDeletes?.join(";")).toContain("reporter");
      expect(r.deleted).toEqual([]);
      expect(existsSync(reporter(app))).toBe(true);
    });

    it("applies with allowDeletes: true", async () => {
      const app = await seed();
      const r = await del(app, { allowDeletes: true });
      expect(r.aborted).toBeUndefined();
      expect(existsSync(reporter(app))).toBe(false);
    });

    it("a confirm callback decides: false writes nothing, true applies", async () => {
      const app = await seed();
      const no = await del(app, { confirm: async () => false });
      expect(no.aborted).toBe(true);
      expect(no.refusedDeletes).toBeUndefined();
      expect(existsSync(reporter(app))).toBe(true);
      await del(app, { confirm: async () => true });
      expect(existsSync(reporter(app))).toBe(false);
    });

    it("a plan without deletions is unaffected", async () => {
      const app = await seed();
      const r = await cmdAppgen({
        intent: "Create a planner. Step route.",
        dir: app,
        offline: true,
      });
      expect(r.aborted).toBeUndefined();
      expect(readFileSync(join(app, "app/flows/planner/flow.ts"), "utf8")).toContain("routeStep");
    });
  });
});
