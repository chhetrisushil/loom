import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findWorkspace,
  globToRegExp,
  linkPackageJson,
  loomPackages,
  scaffoldFiles,
  workspaceGlobs,
} from "./index";

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

  it("a missing <directory> is bad usage (exit 2) and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cla-nodir-"));
    try {
      const { code, out } = run([], dir);
      expect(code).toBe(2);
      expect(out).toContain("usage: create-loom-app");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a flag missing its value is bad usage (exit 2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cla-noval-"));
    try {
      expect(run(["app", "--name"], dir).code).toBe(2);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses any flag-shaped target, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cla-flag-"));
    try {
      const { code, out } = run(["--oops"], dir);
      expect(code).toBe(2);
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

  it("--force refuses to write through a planted symlink and touches nothing outside", () => {
    const base = scratch();
    const loom = fakeLoom(join(base, "loom"));
    const cwd = join(base, "work");
    mkdirSync(join(cwd, "demo"), { recursive: true });
    const victim = join(base, "victim.txt");
    writeFileSync(victim, "do not touch");
    symlinkSync(victim, join(cwd, "demo/package.json"));
    const r = cli(["demo", "--loom-path", loom, "--force"], cwd);
    expect(r.code).toBe(2);
    expect(r.out).toContain("symbolic link");
    expect(readFileSync(victim, "utf8")).toBe("do not touch");
    expect(readdirSync(join(cwd, "demo"))).toEqual(["package.json"]); // refused up front: nothing written
  });

  it("--force refuses a symlinked sub-directory too", () => {
    const base = scratch();
    const loom = fakeLoom(join(base, "loom"));
    const cwd = join(base, "work");
    mkdirSync(join(cwd, "demo"), { recursive: true });
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(cwd, "demo/app"));
    const r = cli(["demo", "--loom-path", loom, "--force"], cwd);
    expect(r.code).toBe(2);
    expect(readdirSync(outside)).toEqual([]);
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

  it("accepts a scoped --name, and names a symlinked target after the link, not its realpath", () => {
    const base = scratch();
    const loom = fakeLoom(join(base, "loom"));
    const cwd = join(base, "work");
    mkdirSync(join(base, "real-dir-name"), { recursive: true });
    mkdirSync(cwd);
    const scoped = cli(["scoped", "--loom-path", loom, "--name", "@acme/scoped-app"], cwd);
    expect(scoped.code).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, "scoped/package.json"), "utf8")).name).toBe(
      "@acme/scoped-app"
    );

    symlinkSync(join(base, "real-dir-name"), join(cwd, "linked-app"));
    const linked = cli(["linked-app", "--loom-path", loom], cwd);
    expect(linked.code).toBe(0);
    expect(JSON.parse(readFileSync(join(base, "real-dir-name/package.json"), "utf8")).name).toBe(
      "linked-app"
    );
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

describe("workspace detection forms", () => {
  const match = (glob: string, rel: string) => globToRegExp(glob).test(rel);

  it("globs: ** matches zero or more segments", () => {
    expect(match("**/foo", "foo")).toBe(true);
    expect(match("**/foo", "a/b/foo")).toBe(true);
    expect(match("**/foo", "a/bar")).toBe(false);
    expect(match("packages/**", "packages")).toBe(true);
    expect(match("packages/**", "packages/a/b")).toBe(true);
    expect(match("packages/**", "other")).toBe(false);
    expect(match("a/**/b", "a/b")).toBe(true);
    expect(match("a/**/b", "a/x/y/b")).toBe(true);
    expect(match("packages/*", "packages/a")).toBe(true);
    expect(match("packages/*", "packages/a/b")).toBe(false);
    expect(match("./apps/*", "apps/x")).toBe(true);
  });

  it("parses block, quoted, comment-laden and inline-array forms", () => {
    expect(
      workspaceGlobs("packages:\n  - 'a/*'\n  - \"b\"\n  - c/* # note\n  - '!c/skip'\n")
    ).toEqual(["a/*", "b", "c/*", "!c/skip"]);
    expect(workspaceGlobs("packages: ['a/*', \"b\"]\n")).toEqual(["a/*", "b"]);
    expect(workspaceGlobs("packages: [\n  'a/*',\n  b\n]\n")).toEqual(["a/*", "b"]);
    expect(workspaceGlobs("catalog:\n  x: 1\n")).toBeUndefined();
  });

  it("refuses a packages: it cannot parse instead of guessing", () => {
    expect(() => workspaceGlobs("packages: *anchor\n")).toThrow(/cannot confidently parse/);
    expect(() => workspaceGlobs("packages:\n")).toThrow(/cannot confidently parse/);
    expect(() => workspaceGlobs("packages:\n  foo: bar\n")).toThrow(/cannot confidently parse/);
  });

  const withWorkspace = (yaml: string, target: string) => {
    const root = mkdtempSync(join(tmpdir(), "cla-ws-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), yaml);
      return findWorkspace(join(root, target)).root !== undefined;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("findWorkspace: inline array, no packages key, **, and negation", () => {
    expect(withWorkspace("packages: ['apps/*']\n", "apps/x")).toBe(true);
    expect(withWorkspace("packages: ['apps/*']\n", "other/x")).toBe(false);
    expect(withWorkspace("onlyBuiltDependencies: [a]\n", "anything/x")).toBe(true);
    expect(withWorkspace("packages:\n  - '**/foo'\n", "foo")).toBe(true);
    expect(withWorkspace("packages:\n  - 'packages/**'\n", "packages")).toBe(true);
    expect(withWorkspace("packages:\n  - 'apps/*'\n  - '!apps/skip'\n", "apps/skip")).toBe(false);
    expect(withWorkspace("packages:\n  - 'apps/*'\n  - '!apps/skip'\n", "apps/ok")).toBe(true);
    expect(() => withWorkspace("packages: *x\n", "apps/x")).toThrow(/cannot confidently parse/);
  });

  it("run() refuses (exit 2, writes nothing) when the enclosing workspace file is unparseable", () => {
    const root = mkdtempSync(join(tmpdir(), "cla-ws-bad-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: *x\n");
      const { code, out } = cli(["app"], root);
      expect(code).toBe(2);
      expect(out).toContain("cannot confidently parse");
      expect(readdirSync(root)).toEqual(["pnpm-workspace.yaml"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
