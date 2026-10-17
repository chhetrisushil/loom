import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findWorkspace, linkPackageJson, loomPackages, scaffoldFiles } from "./index";

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

// ── The day-one path: where the app lives decides how @loom/* is wired ───────
//
// `create-loom-app demo && cd demo && pnpm install` used to fail with
// ERR_PNPM_WORKSPACE_PKG_NOT_FOUND for everyone outside the monorepo, while printing a "Next:" line
// that could not work. Every refusal below asserts BOTH the exit code and that nothing was written
// (a guard that "refuses" after writing is not a guard).

const BIN = resolve(__dirname, "..", "dist", "index.js");
const cli = (args: string[], cwd: string) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [BIN, ...args], {
        encoding: "utf8",
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

/** A stand-in loom checkout: the workspace file, the packages the validator looks at, built dists. */
function fakeLoom(root: string, opts: { built?: boolean } = {}): string {
  const built = opts.built ?? true;
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - 'plugins/*'\n  - 'tools/*'\n"
  );
  const pkgs: [string, string][] = [
    ["packages/core", "@loom/core"],
    ["packages/app", "@loom/app"],
    ["packages/middleware", "@loom/middleware"],
    ["plugins/sentinel", "@loom/plugin-sentinel"],
    ["tools/cli", "@loom/cli"],
    ["tools/testing", "@loom/testing"],
  ];
  for (const [dir, name] of pkgs) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name }));
    if (built) mkdirSync(join(root, dir, "dist"));
  }
  return root;
}

describe("create-loom-app day-one wiring", () => {
  const dirs: string[] = [];
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), "cla-day1-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("inside the loom workspace keeps workspace:* and needs no flag", () => {
    const base = scratch();
    const loom = fakeLoom(join(base, "loom"));
    const r = cli(["apps/my-app"], loom);
    expect(r.code).toBe(0);
    const pkg = JSON.parse(readFileSync(join(loom, "apps/my-app/package.json"), "utf8"));
    expect(pkg.dependencies["@loom/app"]).toBe("workspace:*");
    expect(pkg.pnpm).toBeUndefined();
    expect(r.out).toContain("Next: cd apps/my-app && pnpm install && pnpm test && pnpm start");
  });

  it("outside the workspace WITHOUT --loom-path refuses up front (exit 2) and writes nothing", () => {
    const cwd = scratch();
    const r = cli(["demo"], cwd);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--loom-path");
    expect(r.out).toContain("not published");
    expect(r.out).not.toContain("Next:");
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("outside the workspace WITH --loom-path emits link: + overrides for every loom package", () => {
    const base = scratch();
    const loom = fakeLoom(join(base, "loom"));
    const cwd = join(base, "work");
    mkdirSync(cwd);
    const r = cli(["demo", "--loom-path", loom], cwd);
    expect(r.code).toBe(0);
    const pkg = JSON.parse(readFileSync(join(cwd, "demo/package.json"), "utf8"));
    expect(pkg.dependencies["@loom/app"]).toBe("*");
    expect(pkg.devDependencies["@loom/cli"]).toBe("*");
    expect(pkg.pnpm.overrides["@loom/core"]).toBe("link:../../loom/packages/core");
    expect(pkg.pnpm.overrides["@loom/plugin-sentinel"]).toBe("link:../../loom/plugins/sentinel");
    expect(Object.keys(pkg.pnpm.overrides).sort()).toEqual([...loomPackages(loom).keys()].sort());
    expect(JSON.stringify(pkg)).not.toContain("workspace:");
    expect(r.out).toContain("Next: cd demo && pnpm install && pnpm test && pnpm start");
  });

  it("--loom-path that is not a loom checkout, or is not built, refuses and writes nothing", () => {
    const base = scratch();
    const cwd = join(base, "work");
    mkdirSync(cwd);
    const notLoom = join(base, "elsewhere");
    mkdirSync(notLoom);
    const unbuilt = fakeLoom(join(base, "unbuilt"), { built: false });
    for (const [path, msg] of [
      [join(base, "missing"), "is not a directory"],
      [notLoom, "not a loom checkout"],
      [unbuilt, "not built"],
    ] as const) {
      const r = cli(["demo", "--loom-path", path], cwd);
      expect(r.code, path).toBe(2);
      expect(r.out, path).toContain(msg);
      expect(readdirSync(cwd), path).toEqual([]);
    }
  });

  it("refuses a non-empty target without --force, and `.` in a non-empty cwd (nothing touched)", () => {
    const base = scratch();
    const loom = fakeLoom(join(base, "loom"));
    const cwd = join(base, "work");
    mkdirSync(join(cwd, "demo"), { recursive: true });
    writeFileSync(join(cwd, "demo/config.ts"), "// my edit");
    const r = cli(["demo", "--loom-path", loom], cwd);
    expect(r.code).toBe(2);
    expect(r.out).toContain("not empty");
    expect(readdirSync(join(cwd, "demo"))).toEqual(["config.ts"]);

    const dot = join(cwd, "demo");
    const r2 = cli([".", "--loom-path", loom, "--name", "demo"], dot);
    expect(r2.code).toBe(2);
    expect(readdirSync(dot)).toEqual(["config.ts"]);
  });

  it("--force overwrites only what it generates, deletes nothing, and says so", () => {
    const base = scratch();
    const loom = fakeLoom(join(base, "loom"));
    const cwd = join(base, "work");
    mkdirSync(join(cwd, "demo/app"), { recursive: true });
    writeFileSync(join(cwd, "demo/app/config.ts"), "// my edit");
    writeFileSync(join(cwd, "demo/notes.txt"), "keep me");
    const r = cli(["demo", "--loom-path", loom, "--force"], cwd);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--force: overwrote 1 existing generated file(s)");
    expect(readFileSync(join(cwd, "demo/app/config.ts"), "utf8")).toContain("defineConfig");
    expect(readFileSync(join(cwd, "demo/notes.txt"), "utf8")).toBe("keep me");
  });

  it("refuses an invalid npm name with a suggestion, and quotes the cd hint when it must", () => {
    const base = scratch();
    const loom = fakeLoom(join(base, "loom"));
    const cwd = join(base, "work");
    mkdirSync(cwd);
    const bad = cli(["Bad Name!", "--loom-path", loom], cwd);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("not a valid npm package name");
    expect(bad.out).toContain("--name bad-name");
    expect(readdirSync(cwd)).toEqual([]);

    const ok = cli(["Bad Name!", "--loom-path", loom, "--name", "bad-name"], cwd);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("cd 'Bad Name!' &&");
    const pkg = JSON.parse(readFileSync(join(cwd, "Bad Name!/package.json"), "utf8"));
    expect(pkg.name).toBe("bad-name");
  });

  it("refuses to link from inside someone else's pnpm workspace (overrides would be ignored)", () => {
    const base = scratch();
    const loom = fakeLoom(join(base, "loom"));
    const mono = join(base, "mono");
    mkdirSync(join(mono, "apps"), { recursive: true });
    writeFileSync(join(mono, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    const r = cli(["apps/x", "--loom-path", loom], mono);
    expect(r.code).toBe(2);
    expect(r.out).toContain("not a loom checkout");
    expect(readdirSync(join(mono, "apps"))).toEqual([]);
  });

  it("findWorkspace honours the globs and negations; linkPackageJson relinks relative to the app", () => {
    const base = scratch();
    const loom = fakeLoom(join(base, "loom"));
    expect(findWorkspace(join(loom, "apps/a"))).toEqual({ root: loom, isLoom: true });
    expect(findWorkspace(join(loom, "apps/a/deeper")).root).toBeUndefined();
    expect(findWorkspace(join(base, "elsewhere"))).toEqual({ root: undefined, isLoom: false });
    writeFileSync(
      join(loom, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n  - '!apps/skip'\n  - 'tools/*'\n"
    );
    expect(findWorkspace(join(loom, "apps/skip")).root).toBeUndefined();
    const out = JSON.parse(
      linkPackageJson(scaffoldFiles("a")["package.json"] as string, join(base, "x/y"), loom)
    );
    expect(out.pnpm.overrides["@loom/cli"]).toBe("link:../../loom/tools/cli");
  });
});
