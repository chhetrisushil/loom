import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "./args";
import { isDevNoise, isDevSource, resolveRunCommand, runDev } from "./dev";
import { genWatch } from "./gen";
import { watchTree } from "./watch";

// ── W5: gen --watch, the tree watcher, and the dev loop ───────────────────────
//
// Every wait is on a CONDITION (a file appears, a line is printed, a pid is gone) with a generous
// ceiling; nothing asserts on elapsed time. Each test works in its own temp dir. Both watcher
// modes are exercised: real `fs.watch` where the platform has it, and forced polling.

// Count (and pass through) fs.watch calls, so the re-arm test can prove a fresh watcher was made.
// `fixedIno` makes statSync report one inode number for every path, as Linux often does for a
// directory deleted and recreated in place.
const watchCalls = vi.hoisted(() => ({
  fn: undefined as unknown,
  fixedIno: undefined as number | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  const spy = vi.fn(orig.watch);
  watchCalls.fn = spy;
  const statSync = ((...args: Parameters<typeof orig.statSync>) => {
    const st = orig.statSync(...args);
    if (st !== undefined && watchCalls.fixedIno !== undefined) st.ino = watchCalls.fixedIno;
    return st;
  }) as typeof orig.statSync;
  return { ...orig, default: orig, watch: spy, statSync };
});

const CEILING = 30_000;
const until = (cond: () => boolean | Promise<boolean>) =>
  vi.waitFor(
    async () => {
      if (!(await cond())) throw new Error("condition not met yet");
    },
    { timeout: CEILING, interval: 25 }
  );

let root = "";
const leftoverGroups = new Set<number>();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loom-w5-"));
});
afterEach(() => {
  // A failed assertion must not leave an app (and its grandchild) running: kill every group the
  // test saw start, from the pid files the apps write.
  for (const file of ["starts.log", "grandchild.pid", "gc-ready", "env.json"]) {
    try {
      for (const raw of readFileSync(join(root, file), "utf8").split("\n")) {
        // never pid 0/1 or our own: kill(-1) signals EVERY process this user owns (it took down
        // the whole desktop session twice), kill(0)/kill(-ourGroup) signals the test runner
        const pid = /^\d+$/.test(raw) ? Number(raw) : 0;
        if (pid > 1 && pid !== process.pid && pid !== process.ppid) leftoverGroups.add(pid);
      }
    } catch {
      // not written by this test
    }
  }
  for (const pid of leftoverGroups) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // gone already
      }
    }
  }
  leftoverGroups.clear();
  rmSync(root, { recursive: true, force: true });
});

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

  it("a steady event stream cannot starve the rescan (max wait)", async () => {
    const seen: string[] = [];
    const w = watchTree(root, {
      debounceMs: 300,
      maxWaitMs: 150,
      pollMs: 50,
      onChange: (cs) => void seen.push(...cs.map((c) => c.file)),
      onError: () => undefined,
    });
    let n = 0;
    const stream = setInterval(
      () => writeFileSync(join(root, "busy.ts"), `export const n = ${n++};\n`),
      10
    );
    try {
      // The stream never pauses for the 300 ms debounce, yet the change is still reported.
      await until(() => seen.includes("busy.ts"));
    } finally {
      clearInterval(stream);
      w.close();
    }
  });

  it("re-arms the event watcher (a fresh fs.watch) after the root is deleted and recreated", async () => {
    // The safety rescan alone finds new files, and macOS keeps delivering events across a replaced
    // root, so neither proves the re-arm: the count of fs.watch calls does.
    const watchSpy = watchCalls.fn as ReturnType<typeof vi.fn>;
    watchSpy.mockClear();
    const w = watchTree(root, {
      debounceMs: 20,
      pollMs: 50,
      safetyMs: 100,
      onChange: () => undefined,
      onError: () => undefined,
    });
    try {
      if (w.mode !== "watch") return; // no recursive fs.watch on this platform: nothing to re-arm
      expect(watchSpy).toHaveBeenCalledTimes(1);
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true }); // a new inode
      await until(() => watchSpy.mock.calls.length >= 2);
      expect(w.mode).toBe("watch");
    } finally {
      w.close();
    }
  });

  it("re-arms when the recreated root reuses the old inode number (Linux ext4)", async () => {
    const watchSpy = watchCalls.fn as ReturnType<typeof vi.fn>;
    watchSpy.mockClear();
    watchCalls.fixedIno = 4242;
    const w = watchTree(root, {
      debounceMs: 20,
      pollMs: 50,
      safetyMs: 100,
      onChange: () => undefined,
      onError: () => undefined,
    });
    try {
      if (w.mode !== "watch") return; // no recursive fs.watch on this platform: nothing to re-arm
      expect(watchSpy).toHaveBeenCalledTimes(1);
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true }); // same inode number, new directory
      await until(() => watchSpy.mock.calls.length >= 2);
      expect(w.mode).toBe("watch");
    } finally {
      watchCalls.fixedIno = undefined;
      w.close();
    }
  });

  it("an ignoreEvent-rejected name never schedules a rescan", async () => {
    const dir = join(root, "w");
    mkdirSync(dir);
    let scans = 0;
    const rejected: string[] = [];
    const w = watchTree(dir, {
      debounceMs: 10,
      safetyMs: 600_000,
      include: (f) => {
        scans++;
        return f.endsWith(".ts");
      },
      ignoreEvent: (f) => {
        rejected.push(f);
        return true; // every event name is rejected (the watched dir itself reports as "w" too)
      },
      onChange: () => undefined,
      onError: () => undefined,
    });
    try {
      if (w.mode !== "watch") return;
      const before = scans;
      let n = 0;
      await until(() => {
        writeFileSync(join(dir, "scratch4913"), String(n++)); // extensionless: only ignoreEvent stops it
        return rejected.includes("scratch4913");
      });
      // events were delivered and rejected; give any (wrong) rescan a chance, then none happened
      await new Promise((r) => setTimeout(r, 300));
      expect({ scans, rejected }).toEqual({ scans: before, rejected });
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

  it("survives the watched --dir being deleted and recreated", async () => {
    const dir = join(root, "app");
    touch(flowFile(dir, "alpha"));
    const lines: string[] = [];
    const ac = new AbortController();
    const done = genWatch(dir, {
      log: (l) => void lines.push(l),
      signal: ac.signal,
      debounceMs: 20,
      pollMs: 50,
      safetyMs: 100,
    });
    await until(() => lines.some((l) => l.startsWith("watching ")));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    touch(flowFile(dir, "beta"));
    await until(() => {
      try {
        return readFileSync(join(dir, "loom.gen.ts"), "utf8").includes("./flows/beta/flow");
      } catch {
        return false;
      }
    });
    touch(flowFile(dir, "gamma"));
    await until(() =>
      readFileSync(join(dir, "loom.gen.ts"), "utf8").includes("./flows/gamma/flow")
    );
    ac.abort();
    await expect(done).resolves.toBe(0);
  }, 60_000);

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
    // It keeps coming back (auto-restart), and the announced delays grow, capped at maxMs.
    const announced = (): number[] =>
      lines
        .map((l) => /restarting in (\d+)ms/.exec(l)?.[1])
        .filter((d): d is string => d !== undefined)
        .map(Number);
    await until(() => starts().length >= 3 && announced().length >= 3);
    const delays = announced();
    expect(delays.slice(0, 3)).toEqual([50, 100, 200]);

    // Fix the app: the next start (by backoff or by a change) idles.
    unlinkSync(join(root, "crash"));
    touch(join(app, "flows", "alpha", "other.ts"));
    await until(() => existsSync(join(root, "grandchild.pid")));
    ac.abort();
    await done;
  }, 60_000);

  it("ignores editor / database scratch, and a real edit still restarts during a stream of it", async () => {
    const { app, ac, starts, start } = setup();
    const done = start({ forcePoll: false, debounceMs: 40 });
    await until(() => starts().length === 1);
    let n = 0;
    const stream = setInterval(() => {
      n++;
      writeFileSync(join(app, "flows", "alpha", ".flow.ts.swp"), String(n));
      writeFileSync(join(app, "flows", "alpha", "flow.ts~"), String(n));
      writeFileSync(join(app, "state.db"), String(n));
      writeFileSync(join(app, "state.db-wal"), String(n));
      writeFileSync(join(app, "4913"), String(n));
    }, 5);
    try {
      const seenBefore = n;
      await until(() => n >= seenBefore + 40); // a long burst of ignored events: no restart
      expect(starts()).toHaveLength(1);
      writeFileSync(join(app, "flows", "alpha", "flow.ts"), "export const edited = 2;\n");
      await until(() => starts().length === 2); // the real edit lands in the middle of the stream
    } finally {
      clearInterval(stream);
    }
    ac.abort();
    await done;
    expect(starts()).toHaveLength(2); // ... and only that edit restarted it
  }, 60_000);

  it("the dev filter: scratch is noise (even extensionless), sources are not", () => {
    for (const f of [
      "4913",
      "app/4913",
      ".flow.ts.swp",
      "flow.ts~",
      "state.db",
      "x.db-wal",
      "loom.gen.ts",
      ".git/x.ts",
      "a.log",
    ]) {
      expect(isDevNoise(f), f).toBe(true);
      expect(isDevSource(f), f).toBe(false);
    }
    for (const f of ["flows/a/flow.ts", "config.json", "x.mjs"]) {
      expect(isDevNoise(f), f).toBe(false);
      expect(isDevSource(f), f).toBe(true);
    }
    expect(isDevNoise("flows")).toBe(false); // a directory event must still pass
  });

  it("a failing runDev leaves no process.exit listener behind", async () => {
    const before = process.listenerCount("exit");
    await expect(
      runDev({
        dir: join(root, "no-such-dir"),
        command: "true",
        cwd: root,
        log: () => undefined,
        forcePoll: true,
      })
    ).rejects.toThrow();
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("gives a SIGTERM'd tree its grace: the grandchild finishes flushing before runDev resolves", async () => {
    const { ac, start } = setup();
    // The shell child exits at once on SIGTERM; its grandchild traps it and flushes slowly.
    writeFileSync(
      join(root, "grand.js"),
      `const fs = require("node:fs");
       process.on("SIGTERM", () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(join(root, "flushed"))}, "ok"); process.exit(0); }, 300));
       fs.writeFileSync(${JSON.stringify(join(root, "gc-ready"))}, String(process.pid));
       setInterval(() => {}, 1000);`
    );
    writeFileSync(
      join(root, "parent.js"),
      `const { spawn } = require("node:child_process");
       spawn(process.execPath, [${JSON.stringify(join(root, "grand.js"))}], { stdio: "ignore" });
       process.on("SIGTERM", () => process.exit(0));
       setInterval(() => {}, 1000);`
    );
    const done = start({ command: `"${process.execPath}" ${join(root, "parent.js")}` });
    await until(() => existsSync(join(root, "gc-ready")));
    const grand = Number(readFileSync(join(root, "gc-ready"), "utf8"));
    ac.abort();
    await expect(done).resolves.toBe(0);
    expect(existsSync(join(root, "flushed"))).toBe(true); // not SIGKILLed mid-flush
    expect(alive(grand)).toBe(false); // ... and no orphan remains
  }, 60_000);

  it("a second interrupt kills the group at once instead of waiting out the grace", async () => {
    const { ac, start } = setup();
    const force = new AbortController();
    writeFileSync(
      join(root, "stubborn.js"),
      `const fs = require("node:fs");
       process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(join(root, "got-term"))}, "1"));
       fs.writeFileSync(${JSON.stringify(join(root, "gc-ready"))}, String(process.pid));
       setInterval(() => {}, 1000);`
    );
    const done = start({
      command: `"${process.execPath}" ${join(root, "stubborn.js")}`,
      killGraceMs: 600_000,
      forceSignal: force.signal,
    });
    await until(() => existsSync(join(root, "gc-ready")));
    const pid = Number(readFileSync(join(root, "gc-ready"), "utf8"));
    ac.abort(); // first interrupt: SIGTERM, which this app ignores
    await until(() => existsSync(join(root, "got-term")));
    expect(alive(pid)).toBe(true);
    force.abort(); // second interrupt
    await expect(done).resolves.toBe(0);
    await until(() => !alive(pid));
  }, 60_000);

  it("the child gets the environment loom dev STARTED with, not the inspect-only switches", async () => {
    writeFileSync(
      join(root, "envdump.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(join(root, "env.json"))}, JSON.stringify({ a: process.env.LOOM_NO_AUTOSTART ?? null, q: process.env.LOOM_QUIET ?? null }));
       setInterval(() => {}, 1000);`
    );
    const read = () =>
      JSON.parse(readFileSync(join(root, "env.json"), "utf8")) as {
        a: string | null;
        q: string | null;
      };
    const run = async (inheritEnv: NodeJS.ProcessEnv) => {
      rmSync(join(root, "env.json"), { force: true });
      const { ac, start } = setup();
      const done = start({
        command: `"${process.execPath}" ${join(root, "envdump.js")}`,
        inheritEnv,
      });
      await until(() => existsSync(join(root, "env.json")));
      const seen = read();
      ac.abort();
      await done;
      return seen;
    };
    const dirty = { ...process.env, LOOM_NO_AUTOSTART: "1", LOOM_QUIET: "1" };
    const clean = { ...process.env };
    Reflect.deleteProperty(clean, "LOOM_NO_AUTOSTART");
    Reflect.deleteProperty(clean, "LOOM_QUIET");
    // loom dev's own process set the switches (dirty) but the user never did (clean): child sees none.
    expect(await run(clean)).toEqual({ a: null, q: null });
    // The user set them themselves: they pass through.
    expect(await run(dirty)).toEqual({ a: "1", q: "1" });
  }, 60_000);

  it("a child that cannot be spawned does not wedge the loop: it is retried", async () => {
    const { lines, ac, start } = setup();
    const done = start({
      cwd: join(root, "no-such-cwd"), // spawn fails with ENOENT -> an 'error' event
      backoff: { baseMs: 20, maxMs: 40, stableMs: 600_000 },
    });
    await until(() => lines.filter((l) => l.includes("could not start the app")).length >= 2);
    ac.abort();
    await done;
  }, 60_000);

  it("an app that exits 0 waits for a change instead of looping", async () => {
    const { app, lines, ac, starts, start } = setup();
    writeFileSync(
      join(root, "once.js"),
      `require("node:fs").appendFileSync("${join(root, "starts.log")}", process.pid + "\\n");`
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

describe("loadLoomApp env scoping", () => {
  it("restores LOOM_NO_AUTOSTART after the import (to unset, or to the user's value)", async () => {
    const { loadLoomApp } = await import("./stores");
    const config = join(root, "cfg.js");
    writeFileSync(
      config,
      `require("node:fs").writeFileSync(${JSON.stringify(join(root, "seen"))}, String(process.env.LOOM_NO_AUTOSTART)); module.exports = { stores: {} };`
    );
    const before = process.env.LOOM_NO_AUTOSTART;
    try {
      Reflect.deleteProperty(process.env, "LOOM_NO_AUTOSTART");
      await loadLoomApp(config);
      expect(readFileSync(join(root, "seen"), "utf8")).toBe("1"); // on during the import ...
      expect(process.env.LOOM_NO_AUTOSTART).toBeUndefined(); // ... gone after
      process.env.LOOM_NO_AUTOSTART = "keep-me";
      await loadLoomApp(config);
      expect(process.env.LOOM_NO_AUTOSTART).toBe("keep-me");
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "LOOM_NO_AUTOSTART");
      else process.env.LOOM_NO_AUTOSTART = before;
    }
  });
});

describe("loadLoomApp concurrent loads", () => {
  it("overlapping loads leave LOOM_NO_AUTOSTART / LOOM_QUIET exactly as before", async () => {
    const { loadLoomApp } = await import("./stores");
    const mk = (name: string) => {
      const f = join(root, `${name}.js`);
      writeFileSync(f, "module.exports = { stores: {} };");
      return f;
    };
    const keys = ["LOOM_NO_AUTOSTART", "LOOM_QUIET", "LOOM_DEBUG"] as const;
    const before = keys.map((k) => process.env[k]);
    try {
      for (const k of keys) Reflect.deleteProperty(process.env, k);
      await Promise.all([loadLoomApp(mk("c1")), loadLoomApp(mk("c2")), loadLoomApp(mk("c3"))]);
      for (const k of keys) expect(process.env[k]).toBeUndefined();
      process.env.LOOM_NO_AUTOSTART = "keep-me";
      await Promise.all([loadLoomApp(mk("c1")), loadLoomApp(mk("c2"))]);
      expect(process.env.LOOM_NO_AUTOSTART).toBe("keep-me");
    } finally {
      keys.forEach((k, i) => {
        const v = before[i];
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      });
    }
  });
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

  it("refuses a bad --port, and refuses to nest inside its own child (LOOM_DEV=1)", async () => {
    const { run } = await import("./cli");
    const errs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.join(" "));
    });
    const before = process.env.LOOM_DEV;
    try {
      for (const bad of ["70000", "-1", "abc", "1.5"]) {
        expect(await run(["dev", "--config", "x.js", "--run", "true", "--port", bad])).toBe(2);
      }
      expect(errs.join("\n")).toContain("0..65535");
      errs.length = 0;
      process.env.LOOM_DEV = "1";
      expect(await run(["dev", "--config", "x.js", "--run", "true"])).toBe(2);
      expect(errs.join("\n")).toContain("already running this app");
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "LOOM_DEV");
      else process.env.LOOM_DEV = before;
      spy.mockRestore();
    }
  });

  it("end to end: a config that loaded for the inspector leaves the app's env clean, and SIGHUP stops it", async () => {
    const { run } = await import("./cli");
    const evRuntime = createRequire(join(__dirname, "devLoop.test.ts")).resolve(
      "@loom/event-runtime"
    );
    writeFileSync(
      join(root, "loom.config.js"),
      `const { InMemoryAsyncEventStore } = require(${JSON.stringify(evRuntime)});
       module.exports = { stores: { eventStore: new InMemoryAsyncEventStore() }, close: async () => {} };`
    );
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(
      join(root, "envdump.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(join(root, "env.json"))}, JSON.stringify({ a: process.env.LOOM_NO_AUTOSTART ?? null, q: process.env.LOOM_QUIET ?? null, dev: process.env.LOOM_DEV }));
       require("node:fs").appendFileSync(${JSON.stringify(join(root, "starts.log"))}, process.pid + "\\n");
       process.on("SIGTERM", () => process.exit(0));
       setInterval(() => {}, 1000);`
    );
    const saved = {
      a: process.env.LOOM_NO_AUTOSTART,
      q: process.env.LOOM_QUIET,
      d: process.env.LOOM_DEV,
    };
    for (const k of ["LOOM_NO_AUTOSTART", "LOOM_QUIET", "LOOM_DEV"])
      Reflect.deleteProperty(process.env, k);
    const cwd = process.cwd();
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    process.chdir(root);
    try {
      const done = run([
        "dev",
        "--config",
        join(root, "loom.config.js"),
        "--dir",
        join(root, "app"),
        "--run",
        `"${process.execPath}" ${join(root, "envdump.js")}`,
        "--port",
        "0",
      ]);
      await until(() => existsSync(join(root, "env.json")));
      expect(logs.join("\n")).toContain("loom inspector on"); // the config DID load for the inspector
      expect(JSON.parse(readFileSync(join(root, "env.json"), "utf8"))).toEqual({
        a: null,
        q: null,
        dev: "1",
      });
      process.emit("SIGHUP");
      await expect(done).resolves.toBe(0);
    } finally {
      process.chdir(cwd);
      spy.mockRestore();
      for (const [k, v] of [
        ["LOOM_NO_AUTOSTART", saved.a],
        ["LOOM_QUIET", saved.q],
        ["LOOM_DEV", saved.d],
      ] as const) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
  }, 60_000);
});
