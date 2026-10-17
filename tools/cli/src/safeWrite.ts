import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Symlink-safe writes under a project root.
 *
 * `path.resolve`/`path.relative` are LEXICAL: they cannot see that `app/flows/x/flow.ts` is a link
 * to `/etc/whatever`, so a lexical "is it inside the root" check passes and `writeFileSync` then
 * follows the link and overwrites a file outside the project. Policy (deliberately simple):
 *
 *  - the ROOT itself may be reached through a link (`/tmp` -> `/private/tmp`, a symlinked checkout):
 *    it is whatever the user pointed `--dir` at;
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

/**
 * Write `contents` to `dest` (inside `dir`) without ever following a symlink: verify the chain, create
 * parents, verify again, write a temp file in the same directory (`O_EXCL`, `O_NOFOLLOW`) and `rename`
 * it over the target. `rename` replaces a directory entry rather than following it, so a link raced in
 * at the final component is replaced as a link, never written through.
 */
export function safeWriteFile(dir: string, dest: string, contents: string): void {
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
  const tmp = path.join(parent, `.${path.basename(dest)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    mode
  );
  try {
    fs.writeFileSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
