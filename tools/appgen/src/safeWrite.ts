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

/** @internal Test-only seams; not part of the public surface (not re-exported from the package index). */
export interface SafeWriteHooks {
  /** Test-only seam: runs immediately BEFORE the pre-open realpath re-check (models the race window). */
  beforeOpen?: () => void;
  /** Test-only seam: runs after the temp file is written, immediately BEFORE the pre-rename re-check. */
  beforeRename?: () => void;
  /** Test-only seam: replaces the write of the temp file's contents (to inject a failing write). */
  writeContents?: (fd: number, contents: string) => void;
}

/** Refuse when the parent's real path is not `realpath(root)` + the lexical relative parent. */
function assertParentRealpath(dir: string, parent: string): void {
  const root = path.resolve(dir);
  const expected = path.join(
    fs.realpathSync.native(root),
    path.relative(root, path.resolve(parent))
  );
  const actual = fs.realpathSync.native(parent);
  if (actual !== expected) {
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
    mode = fs.lstatSync(dest).mode & 0o777;
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
