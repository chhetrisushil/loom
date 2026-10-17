import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Symlink-safe writes under a project root.
 *
 * `path.resolve`/`path.relative` are LEXICAL: they cannot see that `app/flows/x/flow.ts` is a link
 * to `/etc/whatever`, so a lexical "is it inside the root" check passes and `writeFileSync` then
 * follows the link and overwrites a file outside the project. Policy (deliberately simple):
 *
 *  - links ABOVE the root are fine (`/tmp` -> `/private/tmp`), but the root's own FINAL component is
 *    never a link (the CLI refuses a `--dir` that is one; pass its real path). A project
 *    directory inside the cwd (`app`, `./app`, `app/nested`, typed or defaulted) is never trusted:
 *    callers use the cwd as the root, so a cloned repo's own `app -> /outside` link is a component below
 *    the root and is refused (the CLI and the library defaults derive it with `containmentRootFor`);
 *  - NOTHING BELOW the root may be a symlink on the path to a write: not the target, not any parent
 *    directory. That refuses links that point outside AND links that point back inside - an in-project
 *    link is refused too, because "inside" is a fact about the moment of the check, and the cost of
 *    refusing is one clear error naming the link.
 */
export function assertNoSymlinkPath(dir: string, dest: string): void {
  const root = path.resolve(dir);
  assertRootNotLink(root);
  const rel = path.relative(root, path.resolve(dest));
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(
      `refusing to touch "${dest}" - it resolves outside the target directory (${root})`
    );
  }
  let cur = root;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return; // nothing deeper exists
      throw e;
    }
    if (st.isSymbolicLink()) {
      let target = "?";
      try {
        target = fs.readlinkSync(cur);
      } catch {
        /* unreadable link: still refused */
      }
      throw new Error(
        `refusing to write through the symbolic link "${path.relative(root, cur)}" -> ${target} (${root}); replace it with a real file or directory`
      );
    }
  }
}

/**
 * An explicit root whose FINAL component is a symbolic link is refused (one lstat): a clone's `app -> /outside`
 * passed as a library root would otherwise anchor the walk OUTSIDE the project. The cwd itself (identity-equal
 * to `process.cwd()`) is exempt: a repository cannot make you `cd`.
 */
function assertRootNotLink(root: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(root);
  } catch {
    return; // does not exist yet: nothing to be a link
  }
  if (!st.isSymbolicLink()) return;
  try {
    const cwd = fs.statSync(process.cwd());
    const tgt = fs.statSync(root);
    if (cwd.dev === tgt.dev && cwd.ino === tgt.ino) return;
  } catch {
    /* fall through to refusal */
  }
  throw new Error(
    `refusing root "${root}": it is a symbolic link (${fs.readlinkSync(root)}); pass the real path of the directory`
  );
}

/** True when two paths name the same filesystem object (st_dev + st_ino; `stat` follows links). */
function sameObject(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function statOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

/**
 * The symlink-containment root for a project directory, decided by FILESYSTEM IDENTITY (st_dev +
 * st_ino), never by comparing path spellings (case, Unicode form, `/tmp` vs `/private/tmp`, macOS
 * firmlinks `/System/Volumes/Data/...`, logical `$PWD` all spell one directory many ways).
 *
 * Rule: (1) the FINAL component of `dir` is never a link (the cwd itself, reached by identity, is exempt:
 * it is trusted even when reached through a link - a repository cannot make you `cd`); (2) the nearest
 * ancestor of `dir`, in the spelling used, whose identity IS the cwd's becomes the root, so every
 * component below it is lstat-walked by the writer; (3) if no spelled ancestor matches but the target's
 * PHYSICAL parent chain (`p/..`, `p/../..`, ...) reaches the cwd, the target is inside the project by a
 * spelling the walk cannot cover and this THROWS; (4) only when the physical chain never meets the cwd
 * is the target genuinely outside, and `dir` itself is the root (links above it are fine).
 */
export function containmentRootFor(dir: string, cwd: string = process.cwd()): string {
  const target = path.resolve(cwd, dir);
  const cwdId = statOrUndefined(cwd);
  if (cwdId === undefined) {
    // A cwd that does not exist has no identity: only a lexical answer is possible.
    const rel = path.relative(path.resolve(cwd), target);
    const inside =
      rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
    return inside ? path.resolve(cwd) : target;
  }
  const targetId = statOrUndefined(target);
  if (targetId !== undefined && sameObject(targetId, cwdId)) return target; // the cwd itself
  let isLink = false;
  try {
    isLink = fs.lstatSync(target).isSymbolicLink();
  } catch {
    /* does not exist yet */
  }
  if (isLink) {
    throw new Error(
      `refusing --dir "${dir}": it is a symbolic link (${target}); pass the real path of the directory`
    );
  }
  for (let a = path.dirname(target); ; a = path.dirname(a)) {
    const st = statOrUndefined(a);
    if (st !== undefined && sameObject(st, cwdId)) return a;
    if (path.dirname(a) === a) break;
  }
  // No spelled ancestor is the cwd: walk the physical parent chain of the deepest existing ancestor.
  let p = target;
  while (statOrUndefined(p) === undefined && path.dirname(p) !== p) p = path.dirname(p);
  let cur = p;
  for (;;) {
    const st = statOrUndefined(cur);
    if (st === undefined) break;
    if (sameObject(st, cwdId)) {
      throw new Error(
        `refusing --dir "${dir}": it resolves inside the project through a spelling the containment check cannot walk; pass a path relative to the project`
      );
    }
    const up = statOrUndefined(path.join(cur, ".."));
    if (up === undefined || sameObject(up, st)) break; // reached "/"
    cur = path.join(cur, "..");
  }
  return target;
}

/** @internal Test-only seams; not part of the public surface (not re-exported from the package index). */
export interface SafeWriteHooks {
  /** Test-only seam: runs immediately BEFORE the pre-open realpath re-check (models the race window). */
  beforeOpen?: () => void;
  /** Test-only seam: runs after the temp file is written, immediately BEFORE the pre-rename re-check. */
  beforeRename?: () => void;
  /** Test-only seam: replaces the write of the temp file's contents (to inject a failing write). */
  writeContents?: (fd: number, contents: string) => void;
}

/**
 * Refuse when the parent directory is not the object `realpath(root)` + the relative parent names.
 * Compared by FILESYSTEM IDENTITY (dev + ino), not by path string: a parent swapped for a link names
 * a different object, while a different spelling of the same directory (firmlink, case) does not trip it.
 */
function assertParentRealpath(dir: string, parent: string): void {
  const root = path.resolve(dir);
  const expected = path.join(
    fs.realpathSync.native(root),
    path.relative(root, path.resolve(parent))
  );
  const actual = fs.realpathSync.native(parent);
  let same = false;
  try {
    const a = fs.statSync(actual);
    const e = fs.statSync(expected);
    same = a.dev === e.dev && a.ino === e.ino;
    // `stat` follows links, so a swapped-in link would name the same object as itself: also require
    // that no component of the relative parent is a link right now.
    let cur = root;
    for (const seg of path.relative(root, path.resolve(parent)).split(path.sep)) {
      if (seg === "") continue;
      cur = path.join(cur, seg);
      if (fs.lstatSync(cur).isSymbolicLink()) same = false;
    }
  } catch {
    same = false;
  }
  if (!same) {
    throw new Error(
      `refusing to write: "${path.relative(root, path.resolve(parent)) || "."}" resolves to ${actual}, not ${expected} (a parent directory was swapped for a link)`
    );
  }
}

/**
 * Write `contents` to `dest` (inside `dir`) without ever following a symlink: verify the chain, create
 * parents, verify again, write a temp file in the same directory (`O_EXCL`, `O_NOFOLLOW`) and `rename`
 * it over the target. `rename` replaces a directory entry rather than following it, so a link raced in
 * at the final component is replaced as a link, never written through. Immediately before the open and
 * again before the rename the parent's `realpath` is compared with `realpath(root)` + the relative
 * parent, so a parent directory swapped for a link after the first check is refused.
 *
 * RESIDUAL (precise): a swap that lands between the final realpath check and the `rename` syscall. It
 * needs a concurrent writer, with an identity able to modify a directory on the path, who swaps a
 * parent directory in that window; Node has no `openat`/`renameat`, so it cannot be closed from here.
 * The temp file is removed on every failure path.
 */
export function safeWriteFile(dir: string, dest: string, contents: string): void {
  safeWriteFileWithHooks(dir, dest, contents, {});
}

/** @internal `safeWriteFile` with test-only race seams. Not exported from the package index. */
export function safeWriteFileWithHooks(
  dir: string,
  dest: string,
  contents: string,
  hooks: SafeWriteHooks
): void {
  assertNoSymlinkPath(dir, dest);
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });
  assertNoSymlinkPath(dir, dest);
  let mode = 0o644;
  try {
    // a planted target's group/other write bits are never carried over
    mode = fs.lstatSync(dest).mode & 0o755 & ~0o022;
  } catch {
    /* new file */
  }
  const tmpName = `.${path.basename(dest)}.${process.pid}.${Date.now()}.tmp`;
  hooks.beforeOpen?.();
  assertParentRealpath(dir, parent);
  // From here on use the RESOLVED parent: a link swapped in later cannot redirect the open, the rename
  // or the cleanup (the cleanup would otherwise delete in the wrong directory).
  const realParent = fs.realpathSync.native(parent);
  const tmp = path.join(realParent, tmpName);
  const final = path.join(realParent, path.basename(dest));
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    mode
  );
  try {
    try {
      (hooks.writeContents ?? ((f, c) => fs.writeFileSync(f, c)))(fd, contents);
    } finally {
      fs.closeSync(fd);
    }
    hooks.beforeRename?.();
    assertParentRealpath(dir, parent);
    fs.renameSync(tmp, final);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
