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
import { wireGrantsIntoConfig } from "./configEditor";
import { makeLock, readLockfile, writeLockfile } from "./lockfile";

const CAP = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "deploy-app",
  name: "Deploy",
  intent: "ship it",
  op: "create",
  steps: [],
  ...over,
});

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
        capabilities: [CAP({ id: "deploy-app", steps: [{ id: "build", op: "create" }] })],
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
        capabilities: [CAP({ id: "../../../etc", steps: [] })],
      },
    });
    expect(() => readLockfile(f)).toThrow(/capability id/);
  });

  it("rejects an unsafe step id", () => {
    const f = write({
      version: 1,
      createdAt: "t",
      intent: "",
      changeSpec: {
        name: "a",
        planner: "deterministic",
        capabilities: [CAP({ id: "ok", steps: [{ id: "a`);evil", op: "create" }] })],
      },
    });
    expect(() => readLockfile(f)).toThrow(/step id/);
  });

  const spec = (cap: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    write({
      version: 1,
      createdAt: "t",
      intent: "",
      changeSpec: { name: "a", planner: "model", capabilities: [CAP(cap)], ...extra },
    });

  it("refuses bidi / zero-width / tag / line-break characters in a wireGrants entry", () => {
    for (const bad of [
      "db.read\u202e\u2066",
      "db\u200bread",
      "db\u{e0041}read",
      "db\u2028read",
      "db\nread",
    ]) {
      expect(() => readLockfile(spec({ wireGrants: [bad] })), bad).toThrow(/wireGrants/);
    }
  });

  it("refuses unsafe text in every other field a sink reads", () => {
    const bad = "x\u202ey";
    expect(() => readLockfile(spec({ intent: bad }))).toThrow(/intent of/);
    expect(() => readLockfile(spec({ name: bad }))).toThrow(/name of/);
    expect(() => readLockfile(spec({ reasoning: { baseModel: bad } }))).toThrow(/base model/);
    expect(() => readLockfile(spec({ reasoning: { elevateTo: ["ok", bad] } }))).toThrow(
      /elevation/
    );
    expect(() => readLockfile(spec({}, { name: bad }))).toThrow(/plan name/);
    expect(() => readLockfile(spec({}, { compute: { target: bad } }))).toThrow(/compute target/);
    expect(() => readLockfile(spec({ intent: "a".repeat(501) }))).toThrow(/too long/);
  });

  it("refuses an empty plan with the model validator's message (parity)", () => {
    const f = write({
      version: 1,
      createdAt: "t",
      intent: "",
      changeSpec: { name: "a", planner: "model", capabilities: [] },
    });
    expect(() => readLockfile(f)).toThrow(/the plan has no capabilities — it is empty/);
  });

  it("refuses wrongly typed fields", () => {
    expect(() => readLockfile(spec({ wireGrants: "db.read" }))).toThrow(/array/);
    expect(() => readLockfile(spec({ wireGrants: [1] }))).toThrow(/string/);
    expect(() => readLockfile(spec({ name: 7 }))).toThrow(/name of/);
    expect(() => readLockfile(spec({ op: "explode" }))).toThrow(/known op/);
    expect(() => readLockfile(spec({ addUi: "yes" }))).toThrow(/addUi/);
    expect(() => readLockfile(spec({}, { planner: "magic" }))).toThrow(/planner/);
    expect(() => readLockfile(spec({}, { compute: 3 }))).toThrow(/compute/);
  });

  it("applies the new-id rule to a create and the loose rule to an existing id", () => {
    expect(() => readLockfile(spec({ id: "1-run" }))).toThrow(/start with a letter/);
    expect(() => readLockfile(spec({ id: "a--b" }))).toThrow(/kebab-case/);
    // a legacy id on an extend is only looked up, so the loose rule applies
    expect(
      readLockfile(spec({ id: "1-legacy", op: "extend" })).changeSpec.capabilities
    ).toHaveLength(1);
  });

  it("the config sink escapes a grant even if one were to reach it", () => {
    const grant = "db.read\u202e\u2066\u2028\u{e0041}";
    const r = wireGrantsIntoConfig(
      'import { defineConfig } from "@loom/app";\nexport default defineConfig({});\n',
      { "cap\u202e": [grant] }
    );
    expect(r.changed).toBe(true);
    expect(r.after).not.toMatch(/[\u202e\u2066\u2028]|\u{e0041}/u);
    expect(r.after).toContain('"db.read\\u202e\\u2066\\u2028\\udb40\\udc41"');
    expect(r.after).toContain('"cap\\u202e"');
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
