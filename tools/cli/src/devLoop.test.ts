import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "./args";
import { resolveRunCommand, runDev } from "./dev";
import { genWatch } from "./gen";
import { watchTree } from "./watch";

// ── W5: gen --watch, the tree watcher, and the dev loop ───────────────────────
//
// Every wait is on a CONDITION (a file appears, a line is printed, a pid is gone) with a generous
// ceiling; nothing asserts on elapsed time. Each test works in its own temp dir. Both watcher
// modes are exercised: real `fs.watch` where the platform has it, and forced polling.

const CEILING = 30_000;
const until = (cond: () => boolean | Promise<boolean>) =>
  vi.waitFor(
    async () => {
      if (!(await cond())) throw new Error("condition not met yet");
    },
    { timeout: CEILING, interval: 25 }
  );

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-w5-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const touch = (file: string, body = "export {};\n") => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("watchTree", () => {
  for (const forcePoll of [false, true]) {
    it(`reports added, changed and removed files (${forcePoll ? "polling" : "fs.watch"})`, async () => {
      touch(join(root, "keep.ts"));
      const seen: string[] = [];
      const w = watchTree(root, {
        forcePoll,
        debounceMs: 20,
        pollMs: 50,
        onChange: (cs) => void seen.push(...cs.map((c) => `${c.kind}:${c.file}`)),
        onError: (e) => {
          throw e;
        },
      });
      try {
        touch(join(root, "sub/new.ts"));
        await until(() => seen.includes("added:sub/new.ts"));
        writeFileSync(join(root, "sub/new.ts"), "export const changed = true;\n");
        await until(() => seen.includes("changed:sub/new.ts"));
        unlinkSync(join(root, "sub/new.ts"));
        await until(() => seen.includes("removed:sub/new.ts"));
        expect(seen).not.toContain("added:keep.ts"); // present at start: not a change
      } finally {
        w.close();
      }
    });
  }

  it("never descends into node_modules or .git, and honours `include`", async () => {
    const seen: string[] = [];
    const w = watchTree(root, {
      forcePoll: true,
      debounceMs: 10,
      pollMs: 30,
      include: (f) => f.endsWith(".ts"),
      onChange: (cs) => void seen.push(...cs.map((c) => c.file)),
      onError: () => undefined,
    });
    try {
      touch(join(root, "node_modules/dep/index.ts"));
      touch(join(root, "notes.md"), "x");
      touch(join(root, "real.ts"));
      await until(() => seen.includes("real.ts"));
      expect(seen).toEqual(["real.ts"]);
    } finally {
      w.close();
    }
  });

  it("retries a failed callback with the same diff and keeps watching", async () => {
    let calls = 0;
    const seen: string[] = [];
    const errors: unknown[] = [];
    const w = watchTree(root, {
      forcePoll: true,
      debounceMs: 10,
      pollMs: 30,
      onChange: (cs) => {
        calls++;
        if (calls === 1) throw new Error("transient");
        seen.push(...cs.map((c) => c.file));
      },
      onError: (e) => void errors.push(e),
    });
    try {
      touch(join(root, "a.ts"));
      await until(() => seen.includes("a.ts"));
      expect(errors).toHaveLength(1); // reported once, not once per retry
    } finally {
      w.close();
    }
  });
});

describe("loom gen --watch", () => {
  const flowFile = (dir: string, name: string) => join(dir, "flows", name, "flow.ts");

  for (const forcePoll of [false, true]) {
    it(`regenerates on add / rename / remove and exits 0 on abort (${forcePoll ? "polling" : "fs.watch"})`, async () => {
      const dir = join(root, "app");
      touch(flowFile(dir, "alpha"));
      const lines: string[] = [];
      const ac = new AbortController();
      const done = genWatch(dir, {
        log: (l) => void lines.push(l),
        signal: ac.signal,
        forcePoll,
        debounceMs: 20,
        pollMs: 50,
      });
      const gen = () => readFileSync(join(dir, "loom.gen.ts"), "utf8");

      await until(() => lines.some((l) => l.startsWith("watching ")));
      expect(gen()).toContain("./flows/alpha/flow");

      touch(flowFile(dir, "beta"));
      await until(() => gen().includes("./flows/beta/flow"));
      await until(() => lines.some((l) => l.includes("+./flows/beta/flow")));

      // A rename is a remove + an add.
      mkdirSync(join(dir, "flows", "gamma"), { recursive: true });
      writeFileSync(flowFile(dir, "gamma"), readFileSync(flowFile(dir, "beta")));
      unlinkSync(flowFile(dir, "beta"));
      rmSync(join(dir, "flows", "beta"), { recursive: true });
      await until(() => gen().includes("./flows/gamma/flow") && !gen().includes("flows/beta/flow"));

      // A transient failure (the folder vanishing) is reported; the watcher survives and recovers.
      rmSync(join(dir, "flows"), { recursive: true });
      await until(() => !gen().includes("./flows/alpha/flow"));
      touch(flowFile(dir, "delta"));
      await until(() => gen().includes("./flows/delta/flow"));

      ac.abort();
      await expect(done).resolves.toBe(0);
    }, 120_000);
  }

  it("does not regenerate for an edit that cannot change loom.gen.ts", async () => {
    const dir = join(root, "app");
    touch(flowFile(dir, "alpha"));
    const lines: string[] = [];
    const ac = new AbortController();
    const done = genWatch(dir, {
      log: (l) => void lines.push(l),
      signal: ac.signal,
      forcePoll: true,
      debounceMs: 10,
      pollMs: 30,
    });
    await until(() => lines.some((l) => l.startsWith("watching ")));
    writeFileSync(flowFile(dir, "alpha"), "export const edited = 1;\n"); // content edit
    touch(join(dir, "flows", "alpha", "flow.test.ts")); // a test file is not a module
    touch(flowFile(dir, "omega")); // a real add: the barrier
    await until(() => lines.some((l) => l.includes("+./flows/omega/flow")));
    expect(lines.filter((l) => l.startsWith("wrote "))).toHaveLength(2); // initial + omega
    ac.abort();
    await done;
  }, 60_000);

  it("a missing --dir is a usage error, not a watch", async () => {
    await expect(genWatch(join(root, "nope"), { log: () => undefined })).rejects.toBeInstanceOf(
      UsageError
    );
  });
});

describe("resolveRunCommand", () => {
  it("--run wins; else dev, else start; never a `loom dev` script", () => {
    const pkg = (scripts: Record<string, string>) =>
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
    expect(resolveRunCommand(root, "node x.js")).toBe("node x.js");
    pkg({ start: "tsx app/main.ts", dev: "tsx watch app/main.ts" });
    expect(resolveRunCommand(root, undefined)).toBe("tsx watch app/main.ts");
    pkg({ start: "tsx app/main.ts", dev: "loom dev --config ./loom.config.ts" });
    expect(resolveRunCommand(root, undefined)).toBe("tsx app/main.ts");
    pkg({ dev: "loom dev --config x" });
    expect(() => resolveRunCommand(root, undefined)).toThrow(UsageError);
    expect(() => resolveRunCommand(join(root, "none"), undefined)).toThrow(/nothing to run/);
  });
});

// A tiny "app": appends its pid to starts.log, records a grandchild's pid, then idles.
const APP_JS = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const dir = process.env.DEV_TEST_DIR;
fs.appendFileSync(dir + "/starts.log", process.pid + "\\n");
const mode = fs.existsSync(dir + "/crash") ? "crash" : "idle";
if (mode === "crash") { fs.appendFileSync(dir + "/crashes.log", "x\\n"); process.exit(3); }
const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
fs.writeFileSync(dir + "/grandchild.pid", String(gc.pid));
setInterval(() => {}, 1000);
`;

describe("loom dev (runDev)", () => {
  function setup() {
    const app = join(root, "app");
    touch(join(app, "flows", "alpha", "flow.ts"));
    writeFileSync(join(root, "app.js"), APP_JS);
    const lines: string[] = [];
    const ac = new AbortController();
    const starts = () =>
      existsSync(join(root, "starts.log"))
        ? readFileSync(join(root, "starts.log"), "utf8").split("\n").filter(Boolean).map(Number)
        : [];
    const start = (extra: Partial<Parameters<typeof runDev>[0]> = {}) =>
      runDev({
        dir: app,
        command: `"${process.execPath}" ${join(root, "app.js")}`,
        cwd: root,
        env: { DEV_TEST_DIR: root },
        log: (l) => void lines.push(l),
        signal: ac.signal,
        forcePoll: true,
        debounceMs: 20,
        pollMs: 40,
        killGraceMs: 5000,
        ...extra,
      });
    return { app, lines, ac, starts, start };
  }

  it("regenerates and restarts on a new module, kills the whole process group, exits 0 on abort", async () => {
    const { app, lines, ac, starts, start } = setup();
    const done = start();
    await until(() => starts().length === 1 && existsSync(join(root, "grandchild.pid")));
    expect(readFileSync(join(app, "loom.gen.ts"), "utf8")).toContain("./flows/alpha/flow");
    const firstChild = starts()[0] as number;
    const firstGrand = Number(readFileSync(join(root, "grandchild.pid"), "utf8"));
    expect(alive(firstGrand)).toBe(true);

    unlinkSync(join(root, "grandchild.pid"));
    touch(join(app, "flows", "beta", "flow.ts"));
    await until(() => starts().length === 2 && existsSync(join(root, "grandchild.pid")));
    expect(readFileSync(join(app, "loom.gen.ts"), "utf8")).toContain("./flows/beta/flow");
    // The previous run's whole tree is gone - not just the pid the loop spawned.
    await until(() => !alive(firstChild) && !alive(firstGrand));
    expect(lines.some((l) => l.includes("restarting"))).toBe(true);

    const secondGrand = Number(readFileSync(join(root, "grandchild.pid"), "utf8"));
    ac.abort();
    await expect(done).resolves.toBe(0);
    // No orphan, no zombie: by the time runDev resolves the tree is down.
    await until(() => !alive(starts()[1] as number) && !alive(secondGrand));
  }, 120_000);

  it("a content edit restarts the app without regenerating", async () => {
    const { app, lines, ac, starts, start } = setup();
    const done = start();
    await until(() => starts().length === 1);
    const genBefore = lines.filter((l) => l.startsWith("wrote ")).length;
    writeFileSync(join(app, "flows", "alpha", "flow.ts"), "export const edited = 1;\n");
    await until(() => starts().length === 2);
    expect(lines.filter((l) => l.startsWith("wrote "))).toHaveLength(genBefore);
    ac.abort();
    await done;
  }, 60_000);

  it("backs off while the app crash-loops, and a change restarts it at once", async () => {
    const { app, lines, ac, starts, start } = setup();
    writeFileSync(join(root, "crash"), "");
    const done = start({ backoff: { baseMs: 50, maxMs: 200, stableMs: 600_000 } });
    // It keeps coming back (auto-restart) ...
    await until(() => starts().length >= 3);
    // ... and the announced delays grow, capped at maxMs.
    const delays = lines
      .map((l) => /restarting in (\d+)ms/.exec(l)?.[1])
      .filter((d): d is string => d !== undefined)
      .map(Number);
    expect(delays.slice(0, 3)).toEqual([50, 100, 200]);

    // Fix the app: the next start (by backoff or by a change) idles.
    unlinkSync(join(root, "crash"));
    touch(join(app, "flows", "alpha", "other.ts"));
    await until(() => existsSync(join(root, "grandchild.pid")));
    ac.abort();
    await done;
  }, 60_000);

  it("an app that exits 0 waits for a change instead of looping", async () => {
    const { app, lines, ac, starts, start } = setup();
    writeFileSync(
      join(root, "once.js"),
      `require("node:fs").appendFileSync("${join(root, "starts.log")}", "1\\n");`
    );
    const done = start({ command: `"${process.execPath}" ${join(root, "once.js")}` });
    await until(() => lines.some((l) => l.includes("exited (0)")));
    expect(starts()).toHaveLength(1);
    touch(join(app, "flows", "beta", "flow.ts"));
    await until(() => starts().length === 2);
    ac.abort();
    await done;
  }, 60_000);
});

describe("loom dev (cli)", () => {
  it("refuses without --config, pointing at `loom inspect`", async () => {
    const { run } = await import("./cli");
    const errs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.join(" "));
    });
    try {
      expect(await run(["dev", "--db", "x.db"])).toBe(2); // --db is not a dev flag any more
      expect(await run(["dev"])).toBe(2);
      expect(errs.join("\n")).toContain("loom inspect");
    } finally {
      spy.mockRestore();
    }
  });
});
