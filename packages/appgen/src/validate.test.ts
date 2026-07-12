import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeLock, readLockfile, writeLockfile } from "./lockfile";
import { typecheck } from "./validate";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "appgen-validate-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A self-contained tsconfig + source (no external imports) so typecheck runs without
// node_modules — keeps the test hermetic and CI-safe.
function writeTsProject(source: string): void {
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ["*.ts"],
    })
  );
  fs.writeFileSync(path.join(dir, "index.ts"), source);
}

describe("typecheck", () => {
  it("skips cleanly when there is no tsconfig", () => {
    const r = typecheck(dir);
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("passes clean source", () => {
    writeTsProject("export const n: number = 1;\n");
    const r = typecheck(dir);
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toEqual([]);
  });

  it("reports a structured diagnostic for a type error", () => {
    writeTsProject("export const n: number = 'not a number';\n");
    const r = typecheck(dir);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0]?.message).toMatch(/not assignable/i);
    expect(r.diagnostics[0]?.line).toBe(1);
  });
});

describe("lockfile", () => {
  it("round-trips a ChangeSpec through write/read", () => {
    const changeSpec = {
      name: "planner",
      capabilities: [
        {
          id: "planner",
          name: "Planner",
          intent: "Create a planner.",
          op: "create" as const,
          steps: [],
        },
      ],
      planner: "deterministic" as const,
    };
    const lock = makeLock("Create a planner.", changeSpec, "2026-07-12T00:00:00.000Z");
    const file = writeLockfile(dir, lock, "123.spec.json");
    expect(file).toBe(path.join(dir, ".loom", "appgen", "123.spec.json"));

    const read = readLockfile(file);
    expect(read).toEqual(lock);
    expect(read.changeSpec.name).toBe("planner");
  });

  it("rejects a file that is not a lockfile", () => {
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ hello: "world" }));
    expect(() => readLockfile(bad)).toThrow(/not a valid appgen lockfile/);
  });
});
