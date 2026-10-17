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
  /** Rescan interval when recursive watching is unavailable. Default 1000 ms. */
  pollMs?: number;
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

  let previous = scan(root, include, ignored);
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let dirty = false;
  let failing = false;
  let retry: NodeJS.Timeout | undefined;
  let poller: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
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
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void check();
    }, debounceMs);
  };

  const startPolling = (): void => {
    mode = "poll";
    if (poller === undefined) poller = setInterval(schedule, pollMs);
  };

  if (options.forcePoll !== true) {
    try {
      // Recursive watching: macOS and Windows natively, Linux from Node 20 (the repo's floor).
      // Anything else throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM and we poll instead.
      watcher = fs.watch(root, { recursive: true }, schedule);
      watcher.on("error", (err) => {
        options.onError(err);
        watcher?.close();
        watcher = undefined;
        startPolling(); // keep watching, less efficiently
      });
      mode = "watch";
    } catch {
      startPolling();
    }
  } else {
    startPolling();
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
      watcher?.close();
    },
  };
}
