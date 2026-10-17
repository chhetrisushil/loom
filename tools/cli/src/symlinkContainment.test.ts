import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppgenIO, cmdAppgen, resolveInside } from "./appgen";
import { run } from "./cli";
import { cmdGen, cmdNew, containmentRootFor, genWatch } from "./gen";
import { cmdPluginNew } from "./plugin";

// SECURITY: `resolveInside` was LEXICAL, so a symlinked `app/flows/<id>/flow.ts` (or a symlinked directory
// on the path) passed the containment check and the write followed the link and overwrote a file OUTSIDE
// the project. Every test runs inside a mkdtemp tree; the "outside" target is a sibling directory of the
// project, inside that same temp tree, and is checked for content AND mtime afterwards.

const made: string[] = [];
function caseInsensitiveFs(): boolean {
  const d = mkdtempSync(join(tmpdir(), "loom-case-"));
  try {
    mkdirSync(join(d, "abc"));
    return existsSync(join(d, "ABC"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
function normInsensitiveFs(): boolean {
  const d = mkdtempSync(join(tmpdir(), "loom-nf-"));
  try {
    mkdirSync(join(d, "caf\u00e9"));
    return existsSync(join(d, "cafe\u0301"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const INTENT = "Create a planner. Step fetch.";
const EXTEND = "Create a planner. Step fetch. Step publish.";

/** `<base>/project` (a real appgen-generated app) beside `<base>/outside` (a sentinel it must never touch). */
async function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "loom-symlink-"));
  made.push(base);
  const root = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(outside);
  await cmdAppgen({ intent: INTENT, dir: root, now: 1 }, noPromptIO());
  return { base, root, outside };
}

/** Real filesystem IO that NEVER prompts: a conflict is a test failure, not a hang on stdin. */
function noPromptIO(): AppgenIO {
  return {
    exists: (p) => existsSync(p) || isLink(p),
    write: (p, c) => {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, c); // deliberately NAIVE: the guard under test must not depend on a careful IO
    },
    resolveConflict: async () => ({ action: "overwrite" }),
  };
}
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function sentinel(outside: string, name = "victim.ts") {
  const file = join(outside, name);
  writeFileSync(file, "// untouched\n");
  const mtime = statSync(file).mtimeMs;
  return {
    file,
    unchanged: () => {
      expect(readFileSync(file, "utf8")).toBe("// untouched\n");
      expect(statSync(file).mtimeMs).toBe(mtime);
    },
  };
}

function flowPath(root: string) {
  return join(root, "app", "flows", "planner", "flow.ts");
}

describe("appgen never writes through a symlink (real-path containment)", () => {
  it("a symlinked flow.ts is not planned as an edit, and nothing outside is written", async () => {
    const { root, outside } = await sandbox();
    const s = sentinel(outside);
    rmSync(flowPath(root));
    symlinkSync(s.file, flowPath(root));

    // The scan skips the link, so the plan never proposes an in-place edit of it ...
    await expect(cmdAppgen({ intent: EXTEND, dir: root, dryRun: true })).resolves.toMatchObject({
      warnings: [expect.stringContaining("app/flows/planner/flow.ts")],
    });
    // ... and if a create lands on the link anyway, the applier refuses it by name.
    await expect(cmdAppgen({ intent: EXTEND, dir: root }, noPromptIO())).rejects.toThrow(
      /symbolic link .*flow\.ts/
    );
    s.unchanged();
    expect(lstatSync(flowPath(root)).isSymbolicLink()).toBe(true); // the link itself was not replaced
  });

  it("an edit planned from a lockfile against a symlinked flow.ts is refused at write time", async () => {
    const { root, outside } = await sandbox();
    const lockDir = join(root, ".loom", "appgen");
    const lock = readdirSync(lockDir).find((f) => f.endsWith(".spec.json")) as string;
    const s = sentinel(outside);
    rmSync(flowPath(root));
    symlinkSync(s.file, flowPath(root));
    await expect(
      cmdAppgen({ intent: "ignored", dir: root, fromSpec: join(lockDir, lock) }, noPromptIO())
    ).rejects.toThrow(/symbolic link/);
    s.unchanged();
  });

  it("a symlinked flows/<id>/ DIRECTORY is refused (no write lands in the outside directory)", async () => {
    const { root, outside } = await sandbox();
    const real = join(root, "app", "flows", "planner");
    const moved = join(outside, "planner");
    renameSync(real, moved);
    symlinkSync(moved, real);
    const before = readdirSync(moved).sort();
    const mtime = statSync(join(moved, "flow.ts")).mtimeMs;
    const content = readFileSync(join(moved, "flow.ts"), "utf8");

    await expect(cmdAppgen({ intent: EXTEND, dir: root }, noPromptIO())).rejects.toThrow(
      /symbolic link .*planner/
    );
    expect(readdirSync(moved).sort()).toEqual(before);
    expect(readFileSync(join(moved, "flow.ts"), "utf8")).toBe(content);
    expect(statSync(join(moved, "flow.ts")).mtimeMs).toBe(mtime);
  });

  it("a symlinked app/ directory or app/flows is refused and never scanned", async () => {
    const { root, outside } = await sandbox();
    const moved = join(outside, "app");
    renameSync(join(root, "app"), moved);
    symlinkSync(moved, join(root, "app"));
    const snapshot = readdirSync(moved, { recursive: true }).map(String).sort();
    await expect(cmdAppgen({ intent: EXTEND, dir: root }, noPromptIO())).rejects.toThrow(
      /symbolic link/
    );
    expect(readdirSync(moved, { recursive: true }).map(String).sort()).toEqual(snapshot);
  });

  it("a symlink INSIDE the project pointing INSIDE is refused too (policy: no symlink on a write path)", async () => {
    const { root } = await sandbox();
    const twin = join(root, "app", "flows", "planner", "flow.real.ts");
    writeFileSync(twin, readFileSync(flowPath(root)));
    rmSync(flowPath(root));
    symlinkSync("flow.real.ts", flowPath(root)); // relative link, stays inside
    const content = readFileSync(twin, "utf8");
    await expect(cmdAppgen({ intent: EXTEND, dir: root }, noPromptIO())).rejects.toThrow(
      /symbolic link/
    );
    expect(readFileSync(twin, "utf8")).toBe(content);
  });

  it("a symlinked app/loom.gen.ts (registration) is not written through", async () => {
    const { root, outside } = await sandbox();
    const s = sentinel(outside, "gen.ts");
    rmSync(join(root, "app", "loom.gen.ts"), { force: true });
    symlinkSync(s.file, join(root, "app", "loom.gen.ts"));
    await expect(
      cmdAppgen({ intent: "Create a reporter. Step a.", dir: root }, noPromptIO())
    ).rejects.toThrow(/symbolic link .*loom\.gen\.ts/);
    s.unchanged();
  });

  it("a symlinked .loom/appgen lockfile directory is not written through", async () => {
    const { root, outside } = await sandbox();
    rmSync(join(root, ".loom"), { recursive: true, force: true });
    symlinkSync(outside, join(root, ".loom"));
    await expect(
      cmdAppgen({ intent: "Create a reporter. Step a.", dir: root }, noPromptIO())
    ).rejects.toThrow(/symbolic link .*\.loom/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("traversal and absolute ids are still refused lexically", () => {
    const base = mkdtempSync(join(tmpdir(), "loom-symlink-"));
    made.push(base);
    for (const bad of ["../x.ts", "a/../../x.ts", "/etc/passwd"]) {
      expect(() => resolveInside(base, bad)).toThrow(/outside the target directory/);
    }
  });

  it("a normal project still works: create, then extend in place, no stray temp files", async () => {
    const { root } = await sandbox();
    expect(existsSync(flowPath(root))).toBe(true);
    const r = await cmdAppgen({ intent: EXTEND, dir: root, now: 2 }, noPromptIO());
    expect(r.overwritten.length + r.written.length).toBeGreaterThan(0);
    expect(readFileSync(flowPath(root), "utf8")).toContain("publish");
    expect(
      readdirSync(join(root, "app", "flows", "planner")).filter((f) => f.endsWith(".tmp"))
    ).toEqual([]);
  });

  it("the default IO writes atomically through safeWriteFile and keeps a normal project working", async () => {
    const base = mkdtempSync(join(tmpdir(), "loom-symlink-"));
    made.push(base);
    const root = join(base, "p");
    await cmdAppgen({ intent: INTENT, dir: root, now: 1 }); // default IO
    const r = await cmdAppgen({ intent: EXTEND, dir: root, now: 2 }); // default IO, in-place edit
    expect(r.overwritten.length).toBeGreaterThan(0);
    expect(readFileSync(flowPath(root), "utf8")).toContain("publish");
  });

  it("safeWriteFile (called directly) refuses a destination that is already a link", async () => {
    const { root, outside } = await sandbox();
    const s = sentinel(outside, "planted.ts");
    const { safeWriteFile } = await import("./safeWrite");
    const dest = join(root, "app", "planted.ts");
    symlinkSync(s.file, dest);
    expect(() => safeWriteFile(root, dest, "pwn")).toThrow(/symbolic link/);
    s.unchanged();
  });
});

describe("a --dir inside the cwd is never trusted as a containment root", () => {
  /** A cloned repo: `<base>/repo/app -> <base>/outside` (a cwd-relative default `app`). */
  function clonedRepo() {
    const base = mkdtempSync(join(tmpdir(), "loom-symlink-"));
    made.push(base);
    const repo = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(join(outside, "flows"), { recursive: true });
    mkdirSync(repo);
    symlinkSync(outside, join(repo, "app"));
    const s = sentinel(outside, "loom.gen.ts");
    return { base, repo, outside, s };
  }
  async function inCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.cwd();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.chdir(cwd);
    try {
      return await fn();
    } finally {
      process.chdir(prev);
      spy.mockRestore();
      err.mockRestore();
    }
  }

  it("loom gen with no --dir refuses `app -> outside` and leaves outside untouched", async () => {
    const { repo, outside, s } = clonedRepo();
    await inCwd(repo, async () => {
      await expect(run(["gen"])).resolves.not.toBe(0);
    });
    s.unchanged();
    expect(readdirSync(outside).sort()).toEqual(["flows", "loom.gen.ts"]);
  });

  it("loom new with no --dir refuses `app -> outside` and creates nothing outside", async () => {
    const { repo, outside, s } = clonedRepo();
    await inCwd(repo, async () => {
      await expect(run(["new", "flow", "pwn"])).resolves.not.toBe(0);
    });
    s.unchanged();
    expect(readdirSync(join(outside, "flows"))).toEqual([]);
  });

  async function devRefuses(extra: string[]): Promise<void> {
    const { repo, outside, s } = clonedRepo();
    const logs: string[] = [];
    const evRuntime = createRequire(join(__dirname, "symlinkContainment.test.ts")).resolve(
      "@loom/event-runtime"
    );
    writeFileSync(
      join(repo, "loom.config.js"),
      `const { InMemoryAsyncEventStore } = require(${JSON.stringify(evRuntime)});
       module.exports = { stores: { eventStore: new InMemoryAsyncEventStore() }, close: async () => {} };`
    );
    await inCwd(repo, async () => {
      const spy = vi.mocked(console.log);
      spy.mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
      vi.mocked(console.error).mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
      const done = run([
        "dev",
        "--config",
        join(repo, "loom.config.js"),
        "--run",
        `"${process.execPath}" -e "setTimeout(()=>{},60000)"`,
        ...extra,
        "--port",
        "0",
      ]);
      const until = async () => {
        for (let i = 0; i < 400 && !logs.some((l) => l.includes("gen failed")); i++)
          await new Promise((r) => setTimeout(r, 25));
      };
      await until();
      process.emit("SIGHUP");
      const code = await done;
      logs.push(`exit=${code}`);
    });
    expect(logs.join("\n")).toMatch(/gen failed.*symbolic link/);
    s.unchanged();
    expect(readdirSync(outside).sort()).toEqual(["flows", "loom.gen.ts"]);
  }

  it("loom dev's gen path (no --dir) refuses `app -> outside`", async () => {
    await devRefuses([]);
  }, 60_000);

  it("`loom gen --dir app` (the scaffolded project's own script) refuses `app -> outside`", async () => {
    const { repo, outside, s } = clonedRepo();
    await inCwd(repo, async () => {
      await expect(run(["gen", "--dir", "app"])).resolves.not.toBe(0);
      await expect(run(["gen", "--dir", "./app"])).resolves.not.toBe(0);
    });
    s.unchanged();
    expect(readdirSync(outside).sort()).toEqual(["flows", "loom.gen.ts"]);
  });

  it("`loom new flow x --dir app` refuses `app -> outside` and creates nothing outside", async () => {
    const { repo, outside, s } = clonedRepo();
    await inCwd(repo, async () => {
      await expect(run(["new", "flow", "x", "--dir", "app"])).resolves.not.toBe(0);
    });
    s.unchanged();
    expect(readdirSync(join(outside, "flows"))).toEqual([]);
  });

  it("the library defaults (no root) refuse `app -> outside`: cmdGen, cmdNew, genWatch", async () => {
    const { repo, outside, s } = clonedRepo();
    await inCwd(repo, async () => {
      expect(() => cmdGen("app")).toThrow(/symbolic link/);
      expect(() => cmdNew("flow", "x", "app")).toThrow(/symbolic link/);
      await expect(genWatch("app", { log: () => undefined })).rejects.toThrow(/symbolic link/);
    });
    s.unchanged();
    expect(readdirSync(join(outside, "flows"))).toEqual([]);
  });

  it("`--dir app/nested` where `app` is a link is refused", async () => {
    const { repo, outside, s } = clonedRepo();
    mkdirSync(join(outside, "nested"));
    await inCwd(repo, async () => {
      await expect(run(["gen", "--dir", "app/nested"])).resolves.not.toBe(0);
      await expect(run(["new", "flow", "x", "--dir", "app/nested"])).resolves.not.toBe(0);
    });
    s.unchanged();
    expect(readdirSync(join(outside, "nested"))).toEqual([]);
  });

  it("an absolute --dir under the cwd is contained to the cwd too", async () => {
    const { repo, outside, s } = clonedRepo();
    await inCwd(repo, async () => {
      await expect(run(["gen", "--dir", join(realpathSync(repo), "app")])).resolves.not.toBe(0);
    });
    s.unchanged();
    expect(readdirSync(outside).sort()).toEqual(["flows", "loom.gen.ts"]);
  });

  it("an absolute --dir OUTSIDE the cwd that is itself a link is now REFUSED (policy: final component never a link)", async () => {
    const { repo, outside, base } = clonedRepo();
    rmSync(join(outside, "loom.gen.ts"));
    const named = join(base, "named-link");
    symlinkSync(outside, named);
    const code = await inCwd(repo, () => run(["gen", "--dir", named]));
    expect(code).not.toBe(0);
    expect(existsSync(join(outside, "loom.gen.ts"))).toBe(false);
  });

  it("a real directory inside the cwd works, with and without a cwd that is itself a link", async () => {
    const base = mkdtempSync(join(tmpdir(), "loom-symlink-"));
    made.push(base);
    const real = join(base, "real");
    mkdirSync(join(real, "app", "flows"), { recursive: true });
    const viaLink = join(base, "cwd-link");
    symlinkSync(real, viaLink);
    await inCwd(real, async () => {
      expect(await run(["gen", "--dir", "app"])).toBe(0);
    });
    rmSync(join(real, "app", "loom.gen.ts"));
    await inCwd(viaLink, async () => {
      expect(await run(["gen", "--dir", "app"])).toBe(0);
    });
    expect(existsSync(join(real, "app", "loom.gen.ts"))).toBe(true);
  });

  it("containmentRootFor: cwd for anything inside it, the dir itself only when it leaves the cwd", () => {
    const cwd = resolve(tmpdir(), "p");
    expect(containmentRootFor("app", cwd)).toBe(cwd);
    expect(containmentRootFor("./app/x", cwd)).toBe(cwd);
    expect(containmentRootFor(".", cwd)).toBe(cwd);
    expect(containmentRootFor(join(cwd, "app"), cwd)).toBe(cwd);
    expect(containmentRootFor("../other", cwd)).toBe(resolve(cwd, "../other"));
    expect(containmentRootFor("/somewhere/else", cwd)).toBe("/somewhere/else");
  });

  it("loom dev's gen path with `--dir app` refuses `app -> outside`", async () => {
    await devRefuses(["--dir", "app"]);
  }, 60_000);
});

describe("--dir is classified by REAL path, never by spelling", () => {
  /**
   * `<base>/proj` (the cwd, real) with `app -> <base>/outside`, plus `<base>/alias -> <base>` (a second
   * spelling of the whole tree, like macOS /tmp -> /private/tmp) and `<base>/logical -> proj` (a shell's
   * logical `$PWD`). Built inside the temp tree so it behaves the same on Linux.
   */
  function fixture(linkName = "app") {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "loom-symlink-")));
    made.push(base);
    const proj = join(base, "proj");
    const outside = join(base, "outside");
    mkdirSync(proj);
    mkdirSync(join(outside, "flows"), { recursive: true });
    symlinkSync(outside, join(proj, linkName));
    symlinkSync(base, join(base, "alias"));
    symlinkSync(proj, join(base, "logical"));
    return { base, proj, outside, s: sentinel(outside, "loom.gen.ts") };
  }
  async function inCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.chdir(cwd);
    try {
      return await fn();
    } finally {
      process.chdir(prev);
      log.mockRestore();
      err.mockRestore();
    }
  }
  const untouched = (outside: string) =>
    expect(readdirSync(outside).sort()).toEqual(["flows", "loom.gen.ts"]);

  it("loom gen --dir <alias-of-the-tree>/proj/app (cwd physical) refuses `app -> outside`", async () => {
    const { base, proj, outside, s } = fixture();
    await inCwd(proj, async () => {
      await expect(run(["gen", "--dir", join(base, "alias", "proj", "app")])).resolves.not.toBe(0);
    });
    s.unchanged();
    untouched(outside);
  });

  it('loom gen --dir "$PWD/app" with a LOGICAL $PWD (process cwd physical) refuses `app -> outside`', async () => {
    const { base, proj, outside, s } = fixture();
    await inCwd(proj, async () => {
      await expect(run(["gen", "--dir", join(base, "logical", "app")])).resolves.not.toBe(0);
    });
    s.unchanged();
    untouched(outside);
  });

  it("loom new flow --dir <logical>/app refuses `app -> outside`", async () => {
    const { base, proj, outside, s } = fixture();
    await inCwd(proj, async () => {
      await expect(
        run(["new", "flow", "pwn", "--dir", join(base, "logical", "app")])
      ).resolves.not.toBe(0);
    });
    s.unchanged();
    untouched(outside);
  });

  it("loom appgen --dir <logical>/app refuses `app -> outside` (files and lockfile)", async () => {
    const { base, proj, outside, s } = fixture();
    await inCwd(proj, async () => {
      await expect(
        run(["appgen", INTENT, "--dir", join(base, "logical", "app"), "--yes", "--offline"])
      ).resolves.not.toBe(0);
    });
    s.unchanged();
    untouched(outside);
  });

  it("loom plugin new --dir <logical>/app refuses `app -> outside`", async () => {
    const { base, proj, outside, s } = fixture();
    await inCwd(proj, async () => {
      await expect(
        run(["plugin", "new", "store", "my-store", "--dir", join(base, "logical", "app")])
      ).resolves.not.toBe(0);
    });
    s.unchanged();
    untouched(outside);
  });

  it("a real dir inside the cwd works through an aliased spelling (no false refusal)", async () => {
    const { base, proj } = fixture();
    mkdirSync(join(proj, "real", "flows"), { recursive: true });
    await inCwd(proj, async () => {
      expect(await run(["gen", "--dir", join(base, "logical", "real")])).toBe(0);
      expect(await run(["gen", "--dir", join(base, "alias", "proj", "real")])).toBe(0);
    });
    expect(existsSync(join(proj, "real", "loom.gen.ts"))).toBe(true);
  });

  it("a --dir truly outside the cwd (a sibling) that is itself a link is REFUSED; its real path works", async () => {
    const { base, proj, outside } = fixture();
    rmSync(join(outside, "loom.gen.ts"), { force: true });
    symlinkSync(outside, join(base, "named"));
    await inCwd(proj, async () => {
      expect(await run(["gen", "--dir", join(base, "named")])).not.toBe(0);
      expect(await run(["gen", "--dir", "../named"])).not.toBe(0);
      expect(existsSync(join(outside, "loom.gen.ts"))).toBe(false);
      expect(await run(["gen", "--dir", "../outside"])).toBe(0);
    });
    expect(existsSync(join(outside, "loom.gen.ts"))).toBe(true);
  });

  it("containmentRootFor: by real path, in the spelling dir used; a link as final component throws", () => {
    const { base, proj } = fixture();
    mkdirSync(join(proj, "real"));
    expect(containmentRootFor(join(base, "logical", "real"), proj)).toBe(join(base, "logical"));
    expect(containmentRootFor(join(base, "alias", "proj", "real"), proj)).toBe(
      join(base, "alias", "proj")
    );
    expect(containmentRootFor("real", proj)).toBe(proj);
    expect(containmentRootFor(join(base, "outside"), proj)).toBe(join(base, "outside"));
    expect(containmentRootFor("not/yet/created", proj)).toBe(proj);
    expect(() => containmentRootFor("app", proj)).toThrow(/symbolic link/);
    expect(() => containmentRootFor(join(base, "logical", "app"), proj)).toThrow(/symbolic link/);
    expect(() => containmentRootFor(join(base, "named"), proj)).not.toThrow(); // absent here
  });
});

describe("the same exposure in the other project-root writers", () => {
  it("loom gen will not write app/loom.gen.ts through a link", () => {
    const base = mkdtempSync(join(tmpdir(), "loom-symlink-"));
    made.push(base);
    const dir = join(base, "app");
    mkdirSync(join(dir, "flows"), { recursive: true });
    const outside = join(base, "outside");
    mkdirSync(outside);
    const s = sentinel(outside, "gen.ts");
    symlinkSync(s.file, join(dir, "loom.gen.ts"));
    expect(() => cmdGen(dir)).toThrow(/symbolic link/);
    s.unchanged();
  });

  it("loom new will not create a file through a dangling or live link", () => {
    const base = mkdtempSync(join(tmpdir(), "loom-symlink-"));
    made.push(base);
    const dir = join(base, "app");
    const outside = join(base, "outside");
    mkdirSync(join(dir, "flows"), { recursive: true });
    mkdirSync(outside);
    // `flows/demo` is a link to an outside directory: the scaffold must not populate it
    symlinkSync(outside, join(dir, "flows", "demo"));
    expect(() => cmdNew("flow", "demo", dir)).toThrow(/symbolic link/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("loom plugin new will not write through a linked plugin directory", () => {
    const base = mkdtempSync(join(tmpdir(), "loom-symlink-"));
    made.push(base);
    const dir = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(join(dir, "plugins"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "plugins", "my-store"));
    expect(() => cmdPluginNew("store", "my-store", { firstParty: true, dir })).toThrow(
      /symbolic link/
    );
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("case and Unicode-normalisation spellings of the cwd are the cwd (native real path)", () => {
  function build(name: string) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "loom-symlink-")));
    made.push(base);
    const proj = join(base, name);
    const outside = join(base, "victim");
    mkdirSync(proj);
    mkdirSync(join(outside, "flows"), { recursive: true });
    symlinkSync(outside, join(proj, "app"));
    return { base, proj, outside, s: sentinel(outside, "loom.gen.ts") };
  }
  async function inCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.chdir(cwd);
    try {
      return await fn();
    } finally {
      process.chdir(prev);
      log.mockRestore();
      err.mockRestore();
    }
  }
  const caseInsensitive = caseInsensitiveFs();
  const CASE_REASON = "temp FS is case-sensitive: case-variant spellings cannot be exercised";
  const NFC = "caf\u00e9";
  const NFD = "cafe\u0301";
  const normInsensitive = normInsensitiveFs();

  it.runIf(caseInsensitive)(
    "`../PROJ/app`, `../Proj/app`, `<abs>/PROJ/app` refuse `app -> victim` (CLI + library)",
    async () => {
      const { base, proj, outside, s } = build("proj");
      const other = join(base, "other");
      mkdirSync(other);
      await inCwd(proj, async () => {
        for (const d of ["../PROJ/app", "../Proj/app", join(base, "PROJ", "app")]) {
          expect(await run(["gen", "--dir", d])).not.toBe(0);
          expect(await run(["new", "flow", "pwn", "--dir", d])).not.toBe(0);
          expect(() => cmdGen(d)).toThrow(/symbolic link/);
          expect(() => cmdNew("flow", "pwn", d)).toThrow(/symbolic link/);
        }
      });
      s.unchanged();
      expect(readdirSync(outside).sort()).toEqual(["flows", "loom.gen.ts"]);
    }
  );

  it.runIf(caseInsensitive)("a real dir through a miscased spelling still works", async () => {
    const { base, proj } = build("proj");
    mkdirSync(join(proj, "real", "flows"), { recursive: true });
    await inCwd(proj, async () => {
      expect(await run(["gen", "--dir", join(base, "PROJ", "real")])).toBe(0);
    });
    expect(existsSync(join(proj, "real", "loom.gen.ts"))).toBe(true);
  });

  it.runIf(normInsensitive)(
    "an NFD-spelled ancestor of an NFC-named cwd refuses `app -> victim`",
    async () => {
      const { base, proj, outside, s } = build(NFC);
      await inCwd(proj, async () => {
        const d = join(base, NFD, "app");
        expect(await run(["gen", "--dir", d])).not.toBe(0);
        expect(() => cmdGen(d)).toThrow(/symbolic link/);
        expect(() => cmdNew("flow", "pwn", d)).toThrow(/symbolic link/);
      });
      s.unchanged();
      expect(readdirSync(outside).sort()).toEqual(["flows", "loom.gen.ts"]);
    }
  );
  // Spellings the temp FS cannot distinguish are `it.runIf` tests above: vitest reports them as SKIPPED
  // (with their title), never as a vacuous pass.
});

describe("an INTERMEDIATE link above --dir is refused in every spelling of the cwd (identity, not strings)", () => {
  // `x -> victim` is a component ABOVE the --dir's final component, so the final-component rule alone
  // cannot catch it: only classifying the --dir as INSIDE the project (by st_dev/st_ino) lets the lstat
  // walk see `x`. These fail if classification falls back to comparing spellings.
  function build(name = "proj") {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "loom-symlink-")));
    made.push(base);
    const proj = join(base, name);
    const victim = join(base, "victim");
    mkdirSync(proj);
    mkdirSync(join(victim, "app", "flows"), { recursive: true });
    symlinkSync(victim, join(proj, "x"));
    symlinkSync(base, join(base, "alias"));
    symlinkSync(proj, join(base, "logical"));
    const s = sentinel(join(victim, "app"), "loom.gen.ts");
    return { base, proj, victim, s };
  }
  async function inCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.chdir(cwd);
    try {
      return await fn();
    } finally {
      process.chdir(prev);
      log.mockRestore();
      err.mockRestore();
    }
  }
  const untouched = (victim: string) =>
    expect(readdirSync(join(victim, "app")).sort()).toEqual(["flows", "loom.gen.ts"]);

  async function expectRefused(
    proj: string,
    victim: string,
    s: { unchanged: () => void },
    d: string
  ) {
    await inCwd(proj, async () => {
      expect(await run(["gen", "--dir", d])).not.toBe(0);
      expect(await run(["new", "flow", "pwn", "--dir", d])).not.toBe(0);
      expect(await run(["appgen", INTENT, "--dir", d, "--yes"])).not.toBe(0);
    });
    s.unchanged();
    untouched(victim);
  }

  async function lib(proj: string, d: string) {
    await inCwd(proj, async () => {
      expect(() => cmdGen(d)).toThrow(/symbolic link/);
      expect(() => cmdNew("flow", "pwn", d)).toThrow(/symbolic link/);
      await expect(cmdAppgen({ intent: INTENT, dir: d, now: 1 }, noPromptIO())).rejects.toThrow(
        /symbolic link|outside|resolves/
      );
    });
  }

  it("plain relative `x/app`", async () => {
    const { proj, victim, s } = build();
    await expectRefused(proj, victim, s, "x/app");
    await lib(proj, "x/app");
    s.unchanged();
    untouched(victim);
  });

  it("alias-dir spelling `<alias>/proj/x/app`", async () => {
    const { base, proj, victim, s } = build();
    const d = join(base, "alias", "proj", "x", "app");
    await expectRefused(proj, victim, s, d);
    await lib(proj, d);
    s.unchanged();
    untouched(victim);
  });

  it("logical $PWD spelling `<logical>/x/app` (cwd reached through a link)", async () => {
    const { base, proj, victim, s } = build();
    const d = join(base, "logical", "x", "app");
    await expectRefused(proj, victim, s, d);
    await lib(proj, d);
    s.unchanged();
    untouched(victim);
  });

  it.runIf(existsSync("/System/Volumes/Data"))(
    "macOS firmlink `/System/Volumes/Data<cwd>/x/app`",
    async () => {
      const { proj, victim, s } = build();
      const fl = `/System/Volumes/Data${proj}`;
      const a = statSync(proj);
      let same = false;
      try {
        const b = statSync(fl);
        same = a.dev === b.dev && a.ino === b.ino;
      } catch {}
      if (!same) return; // this path is not a firmlink spelling of the temp dir on this machine
      const d = join(fl, "x", "app");
      await expectRefused(proj, victim, s, d);
      await lib(proj, d);
      s.unchanged();
      untouched(victim);
    }
  );

  it.runIf(caseInsensitiveFs())("case variant `../PROJ/x/app` and `<abs>/PROJ/x/app`", async () => {
    const { base, proj, victim, s } = build("proj");
    for (const d of ["../PROJ/x/app", join(base, "PROJ", "x", "app")]) {
      await expectRefused(proj, victim, s, d);
      await lib(proj, d);
    }
    s.unchanged();
    untouched(victim);
  });

  it.runIf(normInsensitiveFs())("NFD spelling of an NFC-named cwd `<NFD>/x/app`", async () => {
    const { base, proj, victim, s } = build("caf\u00e9");
    const d = join(base, "cafe\u0301", "x", "app");
    await expectRefused(proj, victim, s, d);
    await lib(proj, d);
    s.unchanged();
    untouched(victim);
  });

  it("a real nested dir still works (no false refusal) through the alias spelling", async () => {
    const { base, proj } = build();
    mkdirSync(join(proj, "real", "flows"), { recursive: true });
    await inCwd(proj, async () => {
      expect(await run(["gen", "--dir", join(base, "alias", "proj", "real")])).toBe(0);
    });
    expect(existsSync(join(proj, "real", "loom.gen.ts"))).toBe(true);
  });
});
