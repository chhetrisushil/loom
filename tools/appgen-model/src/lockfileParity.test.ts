import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppModel, type ChangeSpec, readLockfile } from "@loom/appgen";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateChangeSpec } from "./validateSpec";

// `readLockfile` (a `--from-spec` replay) and `validateChangeSpec` (a model plan) share ONE
// structural implementation. Each duplicate / collision case below is refused by both, with
// the same message.

const NET_NEW: AppModel = { root: "/x", isExisting: false, flows: [] };

const cap = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "deploy-app",
  name: "Deploy",
  intent: "ship it",
  op: "create",
  steps: [{ id: "build", op: "create" }],
  ...over,
});

const spec = (caps: Record<string, unknown>[]): ChangeSpec =>
  ({ name: "plan", planner: "deterministic", capabilities: caps }) as unknown as ChangeSpec;

describe("lockfile and model validator agree on structure", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-lock-parity-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lockIssues = (changeSpec: ChangeSpec, intent = ""): string[] => {
    const f = join(dir, "x.spec.json");
    writeFileSync(f, JSON.stringify({ version: 1, createdAt: "t", intent, changeSpec }));
    try {
      readLockfile(f);
      return [];
    } catch (e) {
      return (e as Error).message
        .split("\n")
        .filter((l) => l.startsWith("  - "))
        .map((l) => l.slice(4));
    }
  };

  const CASES: Record<string, ChangeSpec> = {
    "duplicate step id in one flow": spec([
      cap({
        steps: [
          { id: "build", op: "create" },
          { id: "build", op: "create" },
        ],
      }),
    ]),
    "step ids that generate one name": spec([
      cap({
        steps: [
          { id: "a-b2", op: "create" },
          { id: "a-b-2", op: "create" },
        ],
      }),
    ]),
    "a flow created twice": spec([cap({}), cap({ steps: [{ id: "other", op: "create" }] })]),
    "modify in a flow being created": spec([cap({ steps: [{ id: "build", op: "modify" }] })]),
    "delete in a flow being created": spec([cap({ steps: [{ id: "build", op: "delete" }] })]),
    "step id repeated across two ops on one flow": spec([
      cap({ op: "extend", steps: [{ id: "build", op: "modify" }] }),
      cap({ op: "extend", steps: [{ id: "build", op: "delete" }] }),
    ]),
  };

  for (const [label, changeSpec] of Object.entries(CASES)) {
    it(`refuses ${label} with the validator's message`, () => {
      const fromValidator = validateChangeSpec(changeSpec, NET_NEW).filter(
        // The validator also compares against the scanned app; a lockfile has no app.
        (i) => !i.includes("no such flow exists")
      );
      expect(fromValidator.length).toBeGreaterThan(0);
      expect(lockIssues(changeSpec)).toEqual(fromValidator);
    });
  }

  it("accepts a well-formed spec", () => {
    const ok = spec([cap({})]);
    expect(lockIssues(ok)).toEqual([]);
    expect(validateChangeSpec(ok, NET_NEW)).toEqual([]);
  });

  it("holds the top-level intent to the text rule", () => {
    const ok = spec([cap({})]);
    expect(lockIssues(ok, "ship it\nglobalThis.pwned = 1")).toEqual([
      "intent contains a control, line-break or invisible/bidi character - write it as one plain line of text",
    ]);
    expect(lockIssues(ok, "a\u202eb")).toHaveLength(1);
    expect(lockIssues(ok, "x".repeat(501))).toEqual(["intent is too long (501 > 500 characters)"]);
    expect(lockIssues(ok, 'an ordinary `sentence` with ${punctuation} and "quotes"')).toEqual([]);
  });
});
