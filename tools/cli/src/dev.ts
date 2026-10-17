import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { UsageError } from "./args";
import { CONVENTION_FOLDERS, cmdGen, genSummary } from "./gen";
import { type TreeChange, watchTree } from "./watch";

// ── `loom dev` - the development loop ─────────────────────────────────────────
//
// gen --watch + run the app's entry, restarting it when the source changes, + the inspector.
//
// The app runs as a CHILD PROCESS in its own process group, so a restart can kill the whole tree
// (the app, whatever it forked, a `pnpm`/`sh` wrapper) and never leave an orphan holding a port or
// a database. The loop never needs the app's cooperation: it watches files and signals processes.

/** The script `loom dev` runs when `--run` is not given: `dev`, else `start` (never `loom dev` itself). */
export function resolveRunCommand(cwd: string, explicit: string | undefined): string {
  if (explicit !== undefined) {
    if (explicit.trim() === "") throw new UsageError("loom dev: --run needs a command");
    return explicit;
  }
  const manifest = path.join(cwd, "package.json");
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { scripts?: unknown };
    if (parsed.scripts && typeof parsed.scripts === "object") {
      scripts = parsed.scripts as Record<string, unknown>;
    }
  } catch {
    // no readable package.json: fall through to the usage error below
  }
  for (const name of ["dev", "start"]) {
    const script = scripts[name];
    // A `dev` script that is itself `loom dev ...` would fork-bomb the loop.
    if (typeof script === "string" && !/\bloom\s+dev\b/.test(script)) return script;
  }
  throw new UsageError(
    `loom dev: nothing to run - pass --run "<command>" (for example --run "tsx app/main.ts"), or add a "dev" or "start" script to ${manifest}`
  );
}

export interface DevOptions {
  /** The folder holding flows/, agents/, ... (default "app"). */
  dir: string;
  /** Symlink-containment root for the generated registration (default: `dir`; see `cmdGen`). */
  root?: string;
  /** Shell command that starts the app. */
  command: string;
  /** Working directory of the child (default: process.cwd()). */
  cwd?: string;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Extra environment for the child. */
  env?: Record<string, string>;
  /** Quiet period before a burst of file events becomes one restart (default 150 ms). */
  debounceMs?: number;
  pollMs?: number;
  forcePoll?: boolean;
  /** Crash-loop backoff: first delay, cap, and how long a run must last to count as stable. */
  backoff?: { baseMs?: number; maxMs?: number; stableMs?: number };
  /** How long a stopping child gets after SIGTERM before SIGKILL (default 3000 ms). */
  killGraceMs?: number;
  /** A second interrupt: SIGKILL the child's group at once and resolve (skips the grace). */
  forceSignal?: AbortSignal;
  /**
   * The environment the child inherits (default: `process.env`). `loom dev` passes the one it
   * started with, so switches the dev process sets for ITSELF while loading the config for the
   * inspector (`LOOM_NO_AUTOSTART`, `LOOM_QUIET`) never reach the app.
   */
  inheritEnv?: NodeJS.ProcessEnv;
  /** Interval of the watcher's safety rescan / re-arm (default 5000 ms). */
  safetyMs?: number;
}

/** What the dev loop watches: source files only, never editor / database scratch. */
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json)$/;
const NOISE_NAME = /(?:~|\.swp|\.swx|\.tmp|\.log|-wal|-shm|-journal|\.db|\.sqlite3?)$/;

/** Whether a changed path (relative, `/` separators) should restart the app. */
export function isDevSource(file: string): boolean {
  if (isDevNoise(file)) return false;
  const segments = file.split("/");
  return SOURCE_FILE.test(segments[segments.length - 1] as string);
}

/**
 * Names that are never worth a rescan, whatever their extension (or lack of one): our own output,
 * dotfiles / hidden dirs, vim's extensionless probe file, editor and database scratch. The watcher's
 * `ignoreEvent`, so these events do not even schedule a rescan.
 */
export function isDevNoise(file: string): boolean {
  if (file === "loom.gen.ts") return true; // OUR output: restarting on it would double every restart
  const segments = file.split("/");
  const base = segments[segments.length - 1] as string;
  if (segments.some((seg) => seg.startsWith("."))) return true; // dotfiles, .#lock, hidden dirs
  return base === "4913" || NOISE_NAME.test(base); // vim's probe file, sqlite sidecars
}

/** Signal a child's whole process group (POSIX), or the child itself where groups do not exist. */
function signalTree(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(sig);
    else process.kill(-child.pid, sig);
  } catch {
    // already gone
  }
}

/** Whether anything is still alive in the child's process group (the child itself where groups do not exist). */
function groupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Run until `signal` aborts; resolves 0 after the child (and its group) is gone. */
export async function runDev(options: DevOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const cwd = options.cwd ?? process.cwd();
  const baseMs = options.backoff?.baseMs ?? 1000;
  const maxMs = options.backoff?.maxMs ?? 30_000;
  const stableMs = options.backoff?.stableMs ?? 10_000;
  const killGraceMs = options.killGraceMs ?? 3000;

  // Same PATH an npm script gets, so `--run "tsx app/main.ts"` finds the project's local bins.
  const binDirs: string[] = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    binDirs.push(path.join(d, "node_modules", ".bin"));
    if (path.dirname(d) === d) break;
  }
  const inherited = options.inheritEnv ?? process.env;
  const childEnv: NodeJS.ProcessEnv = {
    ...inherited,
    ...options.env,
    PATH: [...binDirs, inherited.PATH ?? ""].join(path.delimiter),
    LOOM_DEV: "1",
  };

  let child: ChildProcess | undefined;
  let stopped = false;
  let backoffMs = baseMs;
  let restartTimer: NodeJS.Timeout | undefined;
  let startedAt = 0;
  let exited: Promise<void> = Promise.resolve();
  let forced = false;
  /** Children being stopped on purpose (their group gets the full grace, then SIGKILL). */
  const stopping = new WeakSet<ChildProcess>();
  /** Pending "SIGKILL the leftovers of a self-exited child" timers. */
  const reapers = new Map<NodeJS.Timeout, ChildProcess>();
  let force!: () => void;
  const forcedP = new Promise<void>((resolve) => {
    force = resolve;
  });
  /** Wait `ms`, or until a second interrupt forces everything down. */
  const waiter = (ms: number): { done: Promise<void>; cancel: () => void } => {
    let t: NodeJS.Timeout | undefined;
    const timed = new Promise<void>((resolve) => {
      t = setTimeout(resolve, ms);
    });
    return { done: Promise.race([timed, forcedP]), cancel: () => clearTimeout(t) };
  };
  const pause = async (ms: number): Promise<void> => {
    const w = waiter(ms);
    await w.done;
    w.cancel();
  };
  const killAllNow = (): void => {
    if (child !== undefined) signalTree(child, "SIGKILL");
    for (const proc of reapers.values()) signalTree(proc, "SIGKILL"); // leftovers awaiting their reaper
  };
  const onProcessExit = (): void => killAllNow(); // best effort if loom itself is going down
  const onForce = (): void => {
    forced = true;
    killAllNow();
    force();
  };

  const start = (): void => {
    startedAt = Date.now();
    // detached => its own process group (POSIX), which is what lets us kill the whole tree.
    const proc = spawn(options.command, {
      cwd,
      env: childEnv,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "inherit", "inherit"],
    });
    child = proc;
    log(`loom dev: started (pid ${proc.pid}): ${options.command}`);
    exited = new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      proc.once("exit", (code, sig) => {
        if (child === proc) child = undefined;
        // Members the app left in its group: a stop in progress gives them the grace period
        // (stopChild escalates); on a self-exit ask them to stop now and force it after the grace.
        if (!stopping.has(proc) && groupAlive(proc)) {
          signalTree(proc, "SIGTERM");
          const t = setTimeout(() => {
            reapers.delete(t);
            if (groupAlive(proc)) signalTree(proc, "SIGKILL");
          }, killGraceMs);
          reapers.set(t, proc);
        }
        if (!stopped && !restarting) {
          if (code === 0) {
            log("loom dev: the app exited (0) - waiting for a change to run it again");
          } else {
            const ranFor = Date.now() - startedAt;
            if (ranFor >= stableMs) backoffMs = baseMs;
            log(
              `loom dev: the app ${sig ? `was killed by ${sig}` : `exited with code ${code}`} - restarting in ${backoffMs}ms (or on the next change)`
            );
            scheduleRestart();
          }
        }
        finish();
      });
      proc.once("error", (err) => {
        // spawn failed (or the child could not be signalled): there is no child any more.
        log(`loom dev: could not start the app: ${err.message}`);
        if (child === proc) child = undefined;
        if (!stopped && !restarting) scheduleRestart();
        finish();
      });
    });
  };

  const scheduleRestart = (): void => {
    if (restartTimer !== undefined) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (!stopped && child === undefined) start();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, maxMs);
  };

  let restarting = false;
  const stopChild = async (): Promise<void> => {
    if (restartTimer !== undefined) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    const proc = child;
    if (proc === undefined) return;
    stopping.add(proc);
    signalTree(proc, "SIGTERM");
    // The shell may exit at once while its children are still flushing: wait for the WHOLE group
    // (up to the grace period), and only then SIGKILL what is left - of this generation only.
    const deadline = Date.now() + killGraceMs;
    const grace = waiter(killGraceMs);
    await Promise.race([exited, grace.done]);
    grace.cancel(); // a prompt exit must not leave the grace timer holding the event loop
    while (groupAlive(proc) && Date.now() < deadline && !forced) await pause(25);
    if (groupAlive(proc)) signalTree(proc, "SIGKILL");
    await exited;
    if (child === proc) child = undefined;
  };

  const restart = async (why: string): Promise<void> => {
    if (stopped) return;
    restarting = true;
    try {
      log(`loom dev: ${why} - restarting`);
      await stopChild();
      backoffMs = baseMs; // a change is a fresh attempt, not part of a crash loop
      if (!stopped) start();
    } finally {
      restarting = false;
    }
  };

  // Generate once up front, like `loom gen`, so the first run sees a current loom.gen.ts.
  try {
    log(genSummary(cmdGen(options.dir, options.root ?? options.dir)));
  } catch (err) {
    if (err instanceof UsageError) throw err;
    log(`loom dev: gen failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const watcher = watchTree(options.dir, {
    include: isDevSource,
    ignoreEvent: isDevNoise,
    ...(options.debounceMs !== undefined
      ? { debounceMs: options.debounceMs }
      : { debounceMs: 150 }),
    ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
    ...(options.forcePoll !== undefined && { forcePoll: options.forcePoll }),
    ...(options.safetyMs !== undefined && { safetyMs: options.safetyMs }),
    async onChange(changes: TreeChange[]) {
      const structural = changes.some(
        (c) => c.kind !== "changed" && CONVENTION_FOLDERS.includes(c.file.split("/")[0] as string)
      );
      if (structural) {
        try {
          log(genSummary(cmdGen(options.dir, options.root ?? options.dir)));
        } catch (err) {
          log(`loom dev: gen failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const shown = changes
        .slice(0, 3)
        .map((c) => `${c.kind} ${c.file}`)
        .join(", ");
      await restart(changes.length > 3 ? `${shown} (+${changes.length - 3} more)` : shown);
    },
    onError(err) {
      log(
        `loom dev: watch error: ${err instanceof Error ? err.message : String(err)} (still watching)`
      );
    },
  });

  // Registered only now: everything above can throw (bad --dir, watcher), and nothing may leak then.
  process.on("exit", onProcessExit);
  if (options.forceSignal?.aborted) onForce();
  else options.forceSignal?.addEventListener("abort", onForce, { once: true });
  try {
    start();

    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) return resolve();
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    stopped = true;
    watcher.close();
    await stopChild();
    // Leftovers of a self-exited generation already had SIGTERM: finish them now.
    for (const [t, proc] of reapers) {
      clearTimeout(t);
      signalTree(proc, "SIGKILL");
    }
    reapers.clear();
    return 0;
  } finally {
    stopped = true;
    watcher.close();
    process.removeListener("exit", onProcessExit);
    options.forceSignal?.removeEventListener("abort", onForce);
  }
}
