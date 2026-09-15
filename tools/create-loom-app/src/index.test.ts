import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffoldFiles } from "./index";

describe("scaffoldFiles", () => {
  it("emits a convention-following, defineConfig-wired skeleton", () => {
    const files = scaffoldFiles("acme-support");

    // The folder convention.
    for (const f of [
      "package.json",
      "loom.config.ts",
      "app/config.ts",
      "app/middleware.ts",
      "app/loom.gen.ts",
      "app/flows/greet/flow.ts",
      "app/main.ts",
      "app/greet.test.ts",
    ]) {
      expect(files[f], f).toBeTruthy();
    }

    expect(files["package.json"]).toContain('"name": "acme-support"');
    expect(files["package.json"]).toContain("@loom/app");
    expect(files["app/config.ts"]).toContain("defineConfig");
    expect(files["app/config.ts"]).toContain("flowModules");
    expect(files["app/middleware.ts"]).toContain("retryMiddleware");
    expect(files["app/flows/greet/flow.ts"]).toContain("flow$");
    // loom.gen.ts imports the starter flow so the app runs out of the box.
    expect(files["app/loom.gen.ts"]).toContain("./flows/greet/flow");
    // Generated code must not contain unresolved template placeholders.
    for (const content of Object.values(files)) {
      expect(content).not.toContain("${");
    }
  });
});

// ── Argument validation ──────────────────────────────────────────────────────
//
// `create-loom-app --help` used to scaffold eleven files into a directory literally named
// `--help` and report success: the only check was that an argument EXISTED. Newly reachable
// too — before the entry guard was fixed, a global install ran nothing at all.

describe("create-loom-app argument handling", () => {
  const BIN = resolve(__dirname, "..", "dist", "index.js");
  const run = (args: string[], cwd: string) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd }),
      };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  it("prints usage for --help instead of scaffolding into a folder called that", () => {
    const dir = mkdtempSync(join(tmpdir(), "cla-help-"));
    try {
      const { code, out } = run(["--help"], dir);
      expect(code).toBe(0);
      expect(out).toContain("usage: create-loom-app");
      expect(existsSync(join(dir, "--help"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses any flag-shaped target, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cla-flag-"));
    try {
      const { code, out } = run(["--oops"], dir);
      expect(code).toBe(1);
      expect(out).toContain("is not a directory name");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
