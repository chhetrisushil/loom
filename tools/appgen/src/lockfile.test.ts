import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLockfile } from "./lockfile";

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
