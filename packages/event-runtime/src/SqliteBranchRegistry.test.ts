import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BranchRef } from "./BranchRegistry";
import { SqliteBranchRegistry } from "./SqliteBranchRegistry";

let registry: SqliteBranchRegistry;
let dbDir: string;

function ref(
  overrides: Partial<BranchRef> & Pick<BranchRef, "name" | "executionId" | "tip">
): BranchRef {
  return {
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "loom-branch-test-"));
  registry = new SqliteBranchRegistry(join(dbDir, "loom.db"));
});

afterEach(() => {
  registry.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe("SqliteBranchRegistry — refs", () => {
  it("putRef creates and getRef returns a ref", () => {
    registry.putRef(ref({ name: "main", executionId: "exec-1", tip: 3 }));
    const got = registry.getRef("main");
    expect(got).not.toBeNull();
    expect(got!.executionId).toBe("exec-1");
    expect(got!.tip).toBe(3);
  });

  it("getRef returns null for unknown name", () => {
    expect(registry.getRef("nope")).toBeNull();
  });

  it("putRef upserts by name (move a ref)", () => {
    registry.putRef(ref({ name: "main", executionId: "exec-1", tip: 3 }));
    registry.putRef(ref({ name: "main", executionId: "exec-2", tip: 8, updatedAt: 2 }));
    const got = registry.getRef("main");
    expect(got!.executionId).toBe("exec-2");
    expect(got!.tip).toBe(8);
    expect(registry.listRefs()).toHaveLength(1);
  });

  it("listRefs returns all refs ordered by name", () => {
    registry.putRef(ref({ name: "spec/b", executionId: "e2", tip: 1 }));
    registry.putRef(ref({ name: "main", executionId: "e1", tip: 0 }));
    expect(registry.listRefs().map((r) => r.name)).toEqual(["main", "spec/b"]);
  });

  it("moveTip advances a ref's tip", () => {
    registry.putRef(ref({ name: "main", executionId: "exec-1", tip: 3 }));
    registry.moveTip("main", 12);
    expect(registry.getRef("main")!.tip).toBe(12);
  });

  it("deleteRef removes a ref", () => {
    registry.putRef(ref({ name: "main", executionId: "exec-1", tip: 3 }));
    registry.deleteRef("main");
    expect(registry.getRef("main")).toBeNull();
  });

  it("preserves fork provenance (parentExecutionId + forkSequence)", () => {
    registry.putRef(
      ref({
        name: "spec/x",
        executionId: "child",
        tip: 4,
        parentExecutionId: "parent",
        forkSequence: 4,
      })
    );
    const got = registry.getRef("spec/x")!;
    expect(got.parentExecutionId).toBe("parent");
    expect(got.forkSequence).toBe(4);
  });
});

describe("SqliteBranchRegistry — promote (pick-a-winner)", () => {
  it("promote repoints the target ref onto the winner without touching the source", () => {
    registry.putRef(ref({ name: "main", executionId: "orig", tip: 5 }));
    registry.putRef(
      ref({
        name: "spec/win",
        executionId: "child",
        tip: 9,
        parentExecutionId: "orig",
        forkSequence: 5,
      })
    );

    registry.promote("spec/win", "main");

    // main now names the winning execution...
    const main = registry.getRef("main")!;
    expect(main.executionId).toBe("child");
    expect(main.tip).toBe(9);
    // ...and the source ref is untouched.
    const spec = registry.getRef("spec/win")!;
    expect(spec.executionId).toBe("child");
    expect(spec.tip).toBe(9);
  });

  it("promote can create the target ref if it does not exist", () => {
    registry.putRef(ref({ name: "spec/win", executionId: "child", tip: 9 }));
    registry.promote("spec/win", "release");
    expect(registry.getRef("release")!.executionId).toBe("child");
  });

  it("promote throws when the source ref is missing", () => {
    expect(() => registry.promote("ghost", "main")).toThrow(/does not exist/);
  });
});

describe("SqliteBranchRegistry — lineage", () => {
  it("records and reads a lineage edge", () => {
    registry.recordLineage({ executionId: "child", parentExecutionId: "parent", forkSequence: 4 });
    const lin = registry.getLineage("child")!;
    expect(lin.parentExecutionId).toBe("parent");
    expect(lin.forkSequence).toBe(4);
  });

  it("getLineage returns null for a non-forked execution", () => {
    expect(registry.getLineage("root")).toBeNull();
  });

  it("children lists direct forks of a parent", () => {
    registry.recordLineage({ executionId: "c1", parentExecutionId: "root", forkSequence: 2 });
    registry.recordLineage({ executionId: "c2", parentExecutionId: "root", forkSequence: 5 });
    registry.recordLineage({ executionId: "g1", parentExecutionId: "c1", forkSequence: 3 });
    expect(
      registry
        .children("root")
        .map((l) => l.executionId)
        .sort()
    ).toEqual(["c1", "c2"]);
    expect(registry.children("c1").map((l) => l.executionId)).toEqual(["g1"]);
    expect(registry.children("leaf")).toEqual([]);
  });
});
