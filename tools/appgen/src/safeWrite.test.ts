import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { containmentRootFor, safeWriteFile, safeWriteFileWithHooks } from "./safeWrite";

// Race and failure seams of the symlink-safe writer (the hooks are internal, hence tested here).
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("safeWriteFile races and failures", () => {
  /** `<base>/root/sub/` (real) beside `<base>/outside/`; returns a swapper that makes `sub` a link. */
  function raceSandbox() {
    const base = mkdtempSync(join(tmpdir(), "loom-symlink-"));
    made.push(base);
    const root = join(base, "root");
    const outside = join(base, "outside");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside);
    const swap = () => {
      renameSync(join(root, "sub"), join(base, "sub.moved"));
      symlinkSync(outside, join(root, "sub"));
    };
    return { root, outside, swap, dest: join(root, "sub", "f.ts") };
  }

  it("a parent directory swapped for a link between the check and the open is refused", () => {
    const { root, outside, swap, dest } = raceSandbox();
    expect(() => safeWriteFileWithHooks(root, dest, "pwn", { beforeOpen: swap })).toThrow(
      /swapped for a link|resolves to/
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it("a parent directory swapped for a link between the write and the rename is refused", () => {
    const { root, outside, swap, dest } = raceSandbox();
    expect(() => safeWriteFileWithHooks(root, dest, "pwn", { beforeRename: swap })).toThrow(
      /swapped for a link|resolves to/
    );
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(join(root, "..", "sub.moved")).filter((f) => f === "f.ts")).toEqual([]); // never renamed into place
  });

  it("a failing write (ENOSPC) leaves no temp file behind and does not create the target", () => {
    const { root, dest } = raceSandbox();
    expect(() =>
      safeWriteFileWithHooks(root, dest, "x", {
        writeContents: () => {
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        },
      })
    ).toThrow(/ENOSPC/);
    expect(readdirSync(join(root, "sub"))).toEqual([]);
  });
});

describe("safeWriteFile permissions and containment root", () => {
  it("does not carry a planted target's group/other write bits (or setuid) over", () => {
    const base = mkdtempSync(join(tmpdir(), "loom-symlink-"));
    made.push(base);
    const f = join(base, "f.ts");
    writeFileSync(f, "old");
    chmodSync(f, 0o777);
    safeWriteFile(base, f, "new");
    expect(statSync(f).mode & 0o7777).toBe(0o755);
    chmodSync(f, 0o664);
    safeWriteFile(base, f, "newer");
    expect(statSync(f).mode & 0o022).toBe(0);
  });

  it("containmentRootFor decides by identity: the nearest ancestor that IS the cwd is the root", () => {
    const base = mkdtempSync(join(tmpdir(), "loom-symlink-"));
    made.push(base);
    const cwd = join(base, "proj");
    mkdirSync(join(cwd, "app"), { recursive: true });
    symlinkSync(base, join(base, "alias"));
    expect(containmentRootFor("app/x", cwd)).toBe(cwd);
    expect(containmentRootFor(join(base, "alias", "proj", "app"), cwd)).toBe(
      join(base, "alias", "proj")
    );
    // genuinely outside: the dir itself
    const other = join(base, "other");
    mkdirSync(other);
    expect(containmentRootFor(other, cwd)).toBe(other);
    // the final component never a link
    symlinkSync(other, join(cwd, "ln"));
    expect(() => containmentRootFor("ln", cwd)).toThrow(/symbolic link/);
  });
});
