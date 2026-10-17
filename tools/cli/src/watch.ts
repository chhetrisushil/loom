import * as fs from "node:fs";
import * as path from "node:path";

// ── A small, dependency-free directory watcher ────────────────────────────────
//
// `fs.watch` is a HINT, not a source of truth: its events are coalesced, duplicated and (on some
// platforms) lost, and `recursive: true` is not available everywhere. So the watcher keeps a
// SNAPSHOT of the tree (path -> mtime:size) and treats every event - or, when recursive watching
// is unavailable, a poll tick - as "rescan and diff". What it reports is the diff, so a burst of
// editor events collapses into one callback, and a lost event is repaired by the next one.

export interface TreeChange {
  kind: "added" | "removed" | "changed";
  /** Path relative to the watched directory, with `/` separators. */
  file: string;
}

export interface TreeWatchOptions {
  /** Which files to track (relative `/` path). Default: every file. */
  include?: (file: string) => boolean;
  /** Directory names never descended into. Default: {@link DEFAULT_IGNORED_DIRS}. */
  ignoredDirs?: ReadonlySet<string>;
  /** Quiet period after the last event before the tree is rescanned. Default 100 ms. */
  debounceMs?: number;
  /**
   * The longest a burst of events may keep postponing the rescan. A steady stream (a log being
   * appended, a sync tool) would otherwise reset the debounce forever and starve a real edit.
   * Default 1000 ms.
   */
  maxWaitMs?: number;
  /** Rescan interval when recursive watching is unavailable. Default 1000 ms. */
  pollMs?: number;
  /**
   * In `fs.watch` mode: how often to rescan anyway and re-arm the watcher when it died or the
   * root was replaced (deleted and recreated: the old watcher is attached to the dead inode and
   * says nothing). Default 5000 ms.
   */
  safetyMs?: number;
  /**
   * Event filenames to drop BEFORE a rescan is scheduled (where `fs.watch` provides them). By
   * default: names under an ignored directory, and anything `include` rejects that looks like a
   * file (has an extension) - a directory event always passes, since files inside it follow.
   */
  ignoreEvent?: (file: string) => boolean;
  /** Skip `fs.watch` and poll (tests; filesystems without events). */
  forcePoll?: boolean;
  /** The diff since the last report. Never called with an empty list. May be async. */
  onChange(changes: TreeChange[]): void | Promise<void>;
  /** A scan or callback failed. The watcher keeps running. */
  onError(err: unknown): void;
}

export interface TreeWatcher {
  /** `watch` = recursive `fs.watch` events; `poll` = interval rescans. */
  readonly mode: "watch" | "poll";
  close(): void;
}

export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  ".data",
  ".loom",
  ".turbo",
]);

type Snapshot = Map<string, string>;

function scan(root: string, include: (f: string) => boolean, ignored: ReadonlySet<string>) {
  const out: Snapshot = new Map();
  const walk = (abs: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // vanished or unreadable mid-scan: the next scan sees the truth
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) walk(path.join(abs, entry.name), childRel);
      } else if (entry.isFile() && include(childRel)) {
        try {
          const st = fs.statSync(path.join(abs, entry.name));
          out.set(childRel, `${st.mtimeMs}:${st.size}`);
        } catch {
          // deleted between readdir and stat
        }
      }
    }
  };
  walk(root, "");
  return out;
}

function diff(prev: Snapshot, next: Snapshot): TreeChange[] {
  const changes: TreeChange[] = [];
  for (const [file, sig] of next) {
    const before = prev.get(file);
    if (before === undefined) changes.push({ kind: "added", file });
    else if (before !== sig) changes.push({ kind: "changed", file });
  }
  for (const file of prev.keys()) if (!next.has(file)) changes.push({ kind: "removed", file });
  return changes.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Watch `root` and report added / removed / changed files. The initial snapshot is taken before
 * this returns, so anything created after the call is reported (no start-up race).
 */
export function watchTree(root: string, options: TreeWatchOptions): TreeWatcher {
  const include = options.include ?? (() => true);
  const ignored = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  const debounceMs = options.debounceMs ?? 100;
  const pollMs = options.pollMs ?? 1000;
  const maxWaitMs = options.maxWaitMs ?? 1000;
  const safetyMs = options.safetyMs ?? 5000;

  let previous = scan(root, include, ignored);
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let dirty = false;
  let failing = false;
  let retry: NodeJS.Timeout | undefined;
  let poller: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  let safety: NodeJS.Timeout | undefined;
  let armedIno: number | undefined;
  let unsupported = false;
  let firstEventAt: number | undefined;
  let mode: "watch" | "poll" = "poll";

  const check = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      dirty = true; // an async callback is in flight: rescan once it settles
      return;
    }
    running = true;
    try {
      do {
        dirty = false;
        const next = scan(root, include, ignored);
        const changes = diff(previous, next);
        if (changes.length > 0 && !closed) {
          try {
            await options.onChange(changes);
          } catch (err) {
            // Keep the old snapshot so the SAME diff is delivered again, and retry on a timer
            // (an event-only watcher would otherwise wait for an edit that may never come).
            if (!failing) options.onError(err);
            failing = true;
            if (closed) return;
            retry = setTimeout(() => {
              retry = undefined;
              void check();
            }, pollMs);
            return;
          }
        }
        previous = next;
        failing = false;
      } while (dirty && !closed);
    } catch (err) {
      options.onError(err);
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    if (closed) return;
    const now = Date.now();
    firstEventAt ??= now;
    // Trailing debounce, capped: the rescan runs at most maxWaitMs after the first event of a burst.
    const delay = Math.max(0, Math.min(debounceMs, firstEventAt + maxWaitMs - now));
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      firstEventAt = undefined;
      void check();
    }, delay);
  };

  const startPolling = (): void => {
    mode = "poll";
    if (poller === undefined) poller = setInterval(schedule, pollMs);
  };

  const inoOf = (): number | undefined => {
    try {
      return fs.statSync(root).ino;
    } catch {
      return undefined;
    }
  };

  const shouldSchedule = (filename: string | Buffer | null): boolean => {
    if (filename === null || filename === undefined) return true; // platform gave no name: assume relevant
    const file = filename.toString().split(path.sep).join("/");
    if (file.split("/").some((seg) => ignored.has(seg))) return false;
    if (options.ignoreEvent?.(file) === true) return false;
    // Something with an extension that `include` rejects is not a tracked file; one without may be a directory.
    return include(file) || !path.basename(file).includes(".");
  };

  const dropWatcher = (w: fs.FSWatcher): void => {
    if (watcher !== w) return;
    watcher = undefined;
    mode = "poll"; // the safety rescan re-arms it
    try {
      w.close();
    } catch {
      // already closed
    }
  };

  /** Try to attach a recursive watcher to the CURRENT root. False when this platform cannot. */
  const arm = (): boolean => {
    try {
      // Recursive watching: macOS and Windows natively, Linux from Node 20 (the repo's floor).
      // Anything else throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM and we poll instead.
      const w = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (shouldSchedule(filename)) schedule();
      });
      armedIno = inoOf();
      watcher = w;
      mode = "watch";
      w.on("error", (err) => {
        options.onError(err);
        dropWatcher(w);
      });
      w.on("close", () => dropWatcher(w));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
        unsupported = true;
      }
      return false;
    }
  };

  if (options.forcePoll === true) {
    startPolling();
  } else if (!arm()) {
    startPolling();
  }
  if (options.forcePoll !== true && !unsupported) {
    safety = setInterval(() => {
      const ino = inoOf();
      if (watcher !== undefined && ino !== armedIno) dropWatcher(watcher); // root replaced
      if (watcher === undefined && ino !== undefined && !arm() && unsupported) startPolling();
      if (poller !== undefined && watcher !== undefined) {
        clearInterval(poller); // the watcher is back: polling is redundant
        poller = undefined;
      }
      schedule(); // a lost event is repaired by a rescan
    }, safetyMs);
  }

  return {
    get mode() {
      return mode;
    },
    close(): void {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (poller !== undefined) clearInterval(poller);
      if (retry !== undefined) clearTimeout(retry);
      if (safety !== undefined) clearInterval(safety);
      watcher?.close();
    },
  };
}
