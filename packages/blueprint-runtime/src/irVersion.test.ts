import { canonicalJson, fnv1a64 } from "@loom/core";
import { describe, expect, it } from "vitest";
import { BLUEPRINT_IR_SHAPE, BLUEPRINT_IR_VERSION } from "./irVersion";
import { IR_VERSIONS_READ_AS_IS } from "./normalize";

// ADR 0096 — the Blueprint is loom's stable rendering IR. An external framework compiles to
// it, so its shape is a contract: a change must be visible as a version bump, never as a quiet
// edit. `irVersion.ts` makes a SHAPE change fail `tsc` until its manifest is updated; this file
// makes a MANIFEST change fail the suite until the version is bumped. Together: no silent change.
//
// To bump: change the shape, update the manifest in irVersion.ts, set BLUEPRINT_IR_VERSION,
// then ADD a row here with the new version and the digest the failing assertion prints.
// Never edit an existing row's digest — with one exception, taken here: a version that has not
// yet been PUBLISHED has no reader to break, so 2.0.0's digest was re-pinned in the same
// unreleased cycle that introduced it when the `bindingFinding`/`degradedFrom` manifests were
// added. 1.0.0 is released and its row is never touched.
//
// 2.1.0 (ADR 0098) is a MINOR bump — optional cell placement and optional layout titles only —
// and 2.0.0 now has an external reader (loom-ui pins it), so its row is frozen like 1.0.0's.

const PINNED: ReadonlyArray<readonly [version: string, digest: string]> = [
  ["1.0.0", "59ee5cb1c37efe75"],
  ["2.0.0", "90e690ca0de812fd"],
  ["2.1.0", "f2b72f769b6a85a1"],
];

const digestOf = (shape: unknown) => fnv1a64(canonicalJson(shape));

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

describe("BLUEPRINT_IR_VERSION", () => {
  it("is semver, so a consumer can pin against it", () => {
    expect(BLUEPRINT_IR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is the newest pinned version, and pinned versions strictly ascend", () => {
    const versions = PINNED.map(([v]) => v);
    expect(versions[versions.length - 1]).toBe(BLUEPRINT_IR_VERSION);
    for (let i = 1; i < versions.length; i++) {
      expect(
        compareSemver(versions[i - 1] as string, versions[i] as string),
        `${versions[i - 1]} must precede ${versions[i]}`
      ).toBeLessThan(0);
    }
  });
});

describe("BLUEPRINT_IR_SHAPE", () => {
  it("every manifest is sorted and non-empty (the guard can't silently cover nothing)", () => {
    for (const [name, keys] of Object.entries(BLUEPRINT_IR_SHAPE)) {
      expect(keys.length, name).toBeGreaterThan(0);
      expect([...keys].sort(), name).toEqual(keys);
    }
  });

  it("matches the digest pinned for the current version", () => {
    const pinned = PINNED.find(([v]) => v === BLUEPRINT_IR_VERSION)?.[1];
    const actual = digestOf(BLUEPRINT_IR_SHAPE);
    expect(
      actual,
      `Blueprint IR shape changed. If intended: bump BLUEPRINT_IR_VERSION and pin ${actual} under it.`
    ).toBe(pinned);
  });

  it("a shape change without a bump would fail (negative self-check)", () => {
    const mutated = { ...BLUEPRINT_IR_SHAPE, widget: [...BLUEPRINT_IR_SHAPE.widget, "zzz"] };
    const pinned = PINNED.find(([v]) => v === BLUEPRINT_IR_VERSION)?.[1];
    expect(digestOf(mutated)).not.toBe(pinned);
  });

  it("2.1.0 carries cell placement and layout titles, every one optional (ADR 0098)", () => {
    expect(BLUEPRINT_IR_SHAPE.gridCell).toEqual([
      "column:optional",
      "node:required",
      "row:optional",
      "rowSpan:optional",
      "span:optional",
    ]);
    for (const manifest of [
      BLUEPRINT_IR_SHAPE.gridLayout,
      BLUEPRINT_IR_SHAPE.flexLayout,
      BLUEPRINT_IR_SHAPE.stackLayout,
    ]) {
      expect(manifest).toContain("title:optional");
    }
  });
});

// `IR_VERSIONS_READ_AS_IS` (normalize.ts) is otherwise only a comment-enforced rule — nothing
// fails if a future minor bump forgets to add its outgoing version. This turns that rule into a
// live guard: every PINNED version sharing BLUEPRINT_IR_VERSION's major (i.e. every minor released
// under the current major, per ADR 0096 D2) must be readable as-is, and the current version
// itself always must be.
const majorOf = (version: string): number => Number(version.split(".")[0]);

describe("IR_VERSIONS_READ_AS_IS", () => {
  it("contains BLUEPRINT_IR_VERSION itself", () => {
    expect(IR_VERSIONS_READ_AS_IS.has(BLUEPRINT_IR_VERSION)).toBe(true);
  });

  it("contains every PINNED version that shares BLUEPRINT_IR_VERSION's major", () => {
    const currentMajor = majorOf(BLUEPRINT_IR_VERSION);
    const sameMajor = PINNED.map(([version]) => version).filter(
      (version) => majorOf(version) === currentMajor
    );
    expect(sameMajor.length).toBeGreaterThan(0); // the check can't silently cover nothing
    for (const version of sameMajor) {
      expect(IR_VERSIONS_READ_AS_IS.has(version), version).toBe(true);
    }
  });
});
