import { canonicalJson, fnv1a64 } from "@loom/core";
import { describe, expect, it } from "vitest";
import { BLUEPRINT_IR_SHAPE, BLUEPRINT_IR_VERSION } from "./irVersion";

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

const PINNED: ReadonlyArray<readonly [version: string, digest: string]> = [
  ["1.0.0", "59ee5cb1c37efe75"],
  ["2.0.0", "90e690ca0de812fd"],
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
});
