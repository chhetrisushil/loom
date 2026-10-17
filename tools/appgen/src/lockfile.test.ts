import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeLock, readLockfile, writeLockfile } from "./lockfile";

describe("readLockfile validation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (obj: unknown): string => {
    const f = join(dir, "x.spec.json");
    writeFileSync(f, JSON.stringify(obj));
    return f;
  };

  it("accepts a well-formed spec with kebab ids", () => {
    const f = write({
      version: 1,
      createdAt: "t",
      intent: "",
      changeSpec: {
        name: "a",
        planner: "deterministic",
        capabilities: [{ id: "deploy-app", steps: [{ id: "build" }] }],
      },
    });
    expect(readLockfile(f).changeSpec.capabilities[0]!.id).toBe("deploy-app");
  });

  it("rejects a path-traversal capability id", () => {
    const f = write({
      version: 1,
      createdAt: "t",
      intent: "",
      changeSpec: {
        name: "a",
        planner: "deterministic",
        capabilities: [{ id: "../../../etc", steps: [] }],
      },
    });
    expect(() => readLockfile(f)).toThrow(/unsafe capability id/);
  });

  it("rejects an unsafe step id", () => {
    const f = write({
      version: 1,
      createdAt: "t",
      intent: "",
      changeSpec: {
        name: "a",
        planner: "deterministic",
        capabilities: [{ id: "ok", steps: [{ id: "a`);evil" }] }],
      },
    });
    expect(() => readLockfile(f)).toThrow(/unsafe step id/);
  });
});

describe("writeLockfile never writes through a symlink", () => {
  const lock = makeLock("i", { ops: [] } as never, "2026-01-01T00:00:00Z");
  it("refuses a planted .loom directory link and a planted lockfile link", () => {
    const base = mkdtempSync(join(tmpdir(), "loom-lock-"));
    try {
      const root = join(base, "root");
      const outside = join(base, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      symlinkSync(outside, join(root, ".loom"));
      expect(() => writeLockfile(root, lock, "a.spec.json")).toThrow(/symbolic link/);
      expect(readdirSync(outside)).toEqual([]);

      rmSync(join(root, ".loom"));
      mkdirSync(join(root, ".loom", "appgen"), { recursive: true });
      const victim = join(outside, "victim.json");
      writeFileSync(victim, "keep");
      symlinkSync(victim, join(root, ".loom", "appgen", "b.spec.json"));
      expect(() => writeLockfile(root, lock, "b.spec.json")).toThrow(/symbolic link/);
      expect(readFileSync(victim, "utf8")).toBe("keep");
      // a normal write still works
      const dest = writeLockfile(root, lock, "c.spec.json");
      expect(JSON.parse(readFileSync(dest, "utf8")).intent).toBe("i");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
