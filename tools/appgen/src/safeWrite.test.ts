import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeWriteFileWithHooks } from "./safeWrite";

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
