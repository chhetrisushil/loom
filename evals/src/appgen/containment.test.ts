import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { applyChanges, generateFlows, scanApp } from "@loom/appgen";
import type { ChangeSpec, FilePlan } from "@loom/appgen";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInsideRoot, writePlan } from "./subject";

// ESCALATION RULE (S3): "if `applyChanges` can write OUTSIDE the fixture directory under test, stop, write a failing
// test demonstrating it, and report it as a security finding".
//
// RESULT. `applyChanges` itself writes NOTHING: it is a planner that returns a `FilePlan` of relative paths (and
// reads the existing flow files it edits). Three facts, each pinned below:
//   1. it writes nothing, in any of the shapes tried (relative, `..`, absolute, symlinked flow file);
//   2. a ChangeSpec id of `../../../x` or `/abs/x` yields a plan PATH that escapes the root lexically. That is why the
//      CLI applier (`tools/cli/src/appgen.ts` `resolveInside`, a `path.relative` check) refuses such a path at write time;
//   3. FINDING: a `flow.ts` that is a SYMLINK to a file outside the project is scanned as a flow, planned as an
//      in-place edit, and a write to that path follows the link. The lexical `resolveInside` check cannot see it, and
//      the real `cmdAppgen` overwrote the outside file when this was tried by hand (2026-10-17). The demonstration
//      was the exact pin below (`outsideChanged` was true, with a positive control). It is now FIXED (#627): the
//      scanner skips a symlinked flow, so the pin asserts `outsideChanged` is false.
// Nothing here works around the finding in the code under test; only the eval harness's OWN writer refuses
// symlinks and escapes (writePlan in ./subject.ts), because it must never write outside its fixture either.

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A sandbox: `<base>/fixture` (the project) beside `<base>/outside` (a sentinel the project must never touch). */
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "loom-evals-contain-"));
  made.push(base);
  const root = join(base, "fixture");
  mkdirSync(join(root, "app", "flows"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n");
  const sentinelDir = join(base, "outside");
  mkdirSync(sentinelDir);
  writeFileSync(join(sentinelDir, "sentinel.txt"), "untouched\n");
  return { base, root, sentinelDir };
}

/** Every path under `dir`, sorted, relative: a snapshot to compare before and after. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: false } as never)
    .map(String)
    .sort();
}

const spec = (cap: Partial<ChangeSpec["capabilities"][number]> & { id: string }): ChangeSpec => ({
  name: "t",
  planner: "model",
  capabilities: [
    {
      name: "T",
      intent: "i",
      op: "create",
      steps: [{ id: "run", op: "create" }],
      ...cap,
    },
  ],
});

describe("applyChanges containment (ESCALATION RULE, S3)", () => {
  it("applyChanges writes NOTHING, whatever the ids: the sandbox is byte-for-byte the same afterwards", () => {
    const { base, root } = sandbox();
    const before = tree(base);
    applyChanges(spec({ id: "ok-flow" }), scanApp(root)); // brownfield (package.json marks an existing app)
    // The generator now refuses a non-kebab id outright (codegen-injection fix), before any path exists.
    for (const id of ["../../../escape", "/abs/escape", "a/../../../../escape"]) {
      expect(() => applyChanges(spec({ id }), scanApp(root)), id).toThrow(/kebab-case/);
    }
    // a net-new project too (no marker)
    const fresh = join(base, "fresh");
    mkdirSync(fresh);
    expect(() => applyChanges(spec({ id: "../../../escape" }), scanApp(fresh))).toThrow(
      /kebab-case/
    );
    expect(tree(base)).toEqual([...before, "fresh"].sort());
    expect(readFileSync(join(base, "outside", "sentinel.txt"), "utf8")).toBe("untouched\n");
  });

  it("a traversal or absolute id is refused by the generator; the harness writer still refuses an escaping path", () => {
    const { base, root, sentinelDir } = sandbox();
    // (before the fix this id yielded the plan path below; the generator now throws first)
    expect(() => applyChanges(spec({ id: "../../../outside/x" }), scanApp(root))).toThrow(
      /kebab-case/
    );
    expect(() => applyChanges(spec({ id: "/abs/x" }), scanApp(join(base, "nothing-here")))).toThrow(
      /kebab-case/
    );
    // belt and braces: a hand-built plan with such a path (any future planner bug) is still refused
    const escaping = {
      root,
      isNewProject: false,
      creates: [{ path: "app/flows/../../../outside/x/flow.ts", contents: "x" }],
      edits: [],
      deletes: [],
      skips: [],
      regenRegistration: false,
    } as FilePlan;
    expect(() => resolveInsideRoot(root, escaping.creates[0]?.path as string)).toThrow(
      /outside the fixture/
    );
    expect(() => writePlan(root, escaping)).toThrow(/outside the fixture/);
    expect(readdirSync(sentinelDir)).toEqual(["sentinel.txt"]);
  });

  it("a symlinked flow file is NOT offered as editable (the scanner skips it), and applyChanges writes nothing", () => {
    const { base, root } = sandbox();
    const outside = join(base, "outside", "evil.ts");
    const [f] = generateFlows({
      name: "x",
      capabilities: [{ id: "evil", name: "Evil", intent: "i", steps: ["run"] }],
    });
    writeFileSync(outside, (f as { contents: string }).contents);
    mkdirSync(join(root, "app", "flows", "evil"), { recursive: true });
    symlinkSync(outside, join(root, "app", "flows", "evil", "flow.ts"));
    const before = readFileSync(outside, "utf8");

    const plan = applyChanges(
      spec({ id: "evil", op: "extend", steps: [{ id: "extra", op: "create" }] }),
      scanApp(root)
    );
    // fixed (#627): the link is skipped, so no in-place edit of the outside file is ever planned
    expect(plan.edits).toEqual([]);
    expect(readFileSync(outside, "utf8")).toBe(before); // ... and wrote nothing
    // belt and braces: the harness's own writer refuses a link at the planned path regardless
    expect(() =>
      writePlan(root, {
        ...plan,
        edits: [{ path: join("app", "flows", "evil", "flow.ts"), before, after: "X" }],
      } as typeof plan)
    ).toThrow(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe(before);
  });

  // The FINDING, pinned EXACTLY. We run what the CLI does (scanApp -> applyChanges -> lexical containment check ->
  // plain writeFileSync) over a symlinked flow.ts and record whether the OUTSIDE file changed (content or mtime). Any
  // exception from scanApp / applyChanges / the writer is CAUGHT and recorded separately, so a fix that makes scanApp
  // skip the link or applyChanges throw turns `outsideChanged` false and flips this pin, whatever the mechanism.
  // SCOPE: this is the APPGEN-LEVEL path only (evals does not depend on @loom/cli). It goes red when @loom/appgen stops
  // offering a symlinked flow as editable; the CLI write path (resolveInside + writer in tools/cli/src/appgen.ts) is
  // pinned by tools/cli's own tests. The assertion marked FLIP below was flipped to false when the fix landed.
  function symlinkEscape(): { outsideChanged: boolean; threw: string | undefined } {
    const { base, root } = sandbox();
    const outside = join(base, "outside", "evil.ts");
    const [f] = generateFlows({
      name: "x",
      capabilities: [{ id: "evil", name: "Evil", intent: "i", steps: ["run"] }],
    });
    writeFileSync(outside, (f as { contents: string }).contents);
    utimesSync(outside, 1_000, 1_000); // a fixed, old mtime so a rewrite is always visible
    mkdirSync(join(root, "app", "flows", "evil"), { recursive: true });
    symlinkSync(outside, join(root, "app", "flows", "evil", "flow.ts"));
    const snap = () => `${readFileSync(outside, "utf8")}@${statSync(outside).mtimeMs}`;
    const before = snap();
    let threw: string | undefined;
    try {
      const plan = applyChanges(
        spec({ id: "evil", op: "extend", steps: [{ id: "extra", op: "create" }] }),
        scanApp(root)
      );
      // the CLI's check (tools/cli/src/appgen.ts `resolveInside`): lexical containment, then a plain write
      for (const e of plan.edits) {
        const dest = join(root, e.path);
        if (relative(root, dest).startsWith(`..${sep}`)) continue; // refused lexically
        writeFileSync(dest, e.after); // follows the link
      }
    } catch (e) {
      threw = String((e as Error)?.message ?? e);
    }
    return { outsideChanged: snap() !== before, threw };
  }

  it("POSITIVE CONTROL: the escape detector sees a change to the outside file (so the pin below is not vacuous)", () => {
    const { base } = sandbox();
    const outside = join(base, "outside", "ctl.ts");
    writeFileSync(outside, "a");
    utimesSync(outside, 1_000, 1_000);
    const snap = () => `${readFileSync(outside, "utf8")}@${statSync(outside).mtimeMs}`;
    const before = snap();
    expect(snap()).toBe(before); // no change, no detection
    writeFileSync(outside, "a"); // same content, new mtime: still detected
    expect(snap()).not.toBe(before);
    writeFileSync(outside, "b");
    expect(snap()).not.toBe(before);
  });

  it("SECURITY FIX PINNED: appgen no longer writes through a symlinked flow file (the escape is CLOSED)", () => {
    const { outsideChanged, threw } = symlinkEscape();
    expect(threw, "scanApp/applyChanges/writer threw; the escape did not run").toBeUndefined();
    // FLIP (done): the scanner skips the symlinked flow, so the outside file is untouched
    expect(
      outsideChanged,
      "SECURITY REGRESSION: appgen wrote through a symlinked flow file (the escape reopened)"
    ).toBe(false);
  });
});
