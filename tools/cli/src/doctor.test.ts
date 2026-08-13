import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cmdDoctor, formatDoctor } from "./doctor";
import { lintFromManifest } from "./verify";

let dir: string;
function workspace(): string {
  dir = mkdtempSync(join(tmpdir(), "loom-doctor-"));
  return dir;
}
afterEach(() => {
  dir = "";
});

const CLEAN_MANIFEST = JSON.stringify({
  flows: {
    checkout: {
      version: "1.0.0",
      steps: ["a"],
      chunkMap: {},
      suspendPoints: [],
      warnings: [],
      module: "app.ts",
    },
  },
  steps: {},
});

describe("loom doctor", () => {
  it("reports what it SKIPPED, not just what passed", async () => {
    // The whole point. A doctor that runs one of three checks and prints
    // "healthy" is worse than no doctor, because the green is cited as evidence.
    const ws = workspace();
    const { text, result } = await cmdDoctor({ dir: ws });

    expect(result.checks.filter((c) => c.status === "skipped")).toHaveLength(2);
    expect(text).toContain("no loom-manifest.json found");
    expect(text).toContain("no built config module found");
    // Each skip names the flag that would have enabled it.
    expect(text).toContain("--manifest");
    expect(text).toContain("--config");
  });

  it("a run with skips does not read the same as a clean run", async () => {
    const ws = workspace();
    const { text, result } = await cmdDoctor({ dir: ws });
    expect(result.ok).toBe(true); // a skip is not a failure…
    expect(text).toContain("coverage is partial"); // …but it is never silent
    expect(text).not.toContain("all checks passed");
  });

  it("runs the flow-graph check when a manifest is discoverable", async () => {
    const ws = workspace();
    writeFileSync(join(ws, "loom-manifest.json"), CLEAN_MANIFEST);
    const { result } = await cmdDoctor({ dir: ws });
    const check = result.checks.find((c) => c.name.startsWith("flow-graph"));
    expect(check?.status).toBe("ok");
  });

  it("finds a manifest under dist/ too", async () => {
    const ws = workspace();
    mkdirSync(join(ws, "dist"));
    writeFileSync(join(ws, "dist", "loom-manifest.json"), CLEAN_MANIFEST);
    const { result } = await cmdDoctor({ dir: ws });
    expect(result.checks.find((c) => c.name.startsWith("flow-graph"))?.status).toBe("ok");
  });

  it("a failing check fails the run; a skipped one does not", () => {
    expect(
      formatDoctor({
        ok: false,
        checks: [{ name: "x", status: "failed", detail: "boom" }],
      })
    ).toContain("FAILED");
    expect(formatDoctor({ ok: true, checks: [{ name: "x", status: "ok", detail: "" }] })).toContain(
      "all checks passed"
    );
  });
});

describe("manifest → lint extraction", () => {
  it("pulls all three analyses, so none of them needs hand-plumbed source", () => {
    const lint = lintFromManifest({
      flows: {
        a: {
          loopIdentity: [{ callee: "run", loopKind: "for", reason: "static id" }],
          nonDeterministic: [{ callee: "Date.now", insideDecide: false }],
          runnerReach: {
            steps: [{ toolId: "t.a", stepId: "a" }],
            unresolved: [{ expr: "imported", kind: "step" }],
            suspends: [{ id: "Gate" }],
          },
        },
      },
    });
    expect(lint.loopIdentityByFlow.a).toHaveLength(1);
    expect(lint.nonDeterministicByFlow.a).toHaveLength(1);
    expect(lint.runnerReachByFlow.a?.steps).toHaveLength(1);
  });

  it("omits empty analyses rather than emitting empty maps", () => {
    const lint = lintFromManifest({ flows: { a: { loopIdentity: [], nonDeterministic: [] } } });
    expect(lint.loopIdentityByFlow).toEqual({});
    expect(lint.nonDeterministicByFlow).toEqual({});
    expect(lint.runnerReachByFlow).toEqual({});
  });

  it("keeps a runnerReach whose lists are empty — 'analyzed, nothing found' is a claim", () => {
    // Distinct from "never analyzed", which is what FlowSpec.reachAnalyzed exists
    // to separate. Dropping it here would collapse the two.
    const lint = lintFromManifest({
      flows: { a: { runnerReach: { steps: [], unresolved: [], suspends: [] } } },
    });
    expect(lint.runnerReachByFlow.a).toBeDefined();
  });

  it("tolerates a manifest with no flows", () => {
    expect(lintFromManifest({})).toEqual({
      loopIdentityByFlow: {},
      nonDeterministicByFlow: {},
      runnerReachByFlow: {},
    });
  });
});
