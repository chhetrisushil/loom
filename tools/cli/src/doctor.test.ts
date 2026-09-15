import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

    // Every check that needs an input it does not have must SAY so — asserting the property
    // rather than a count, so adding a check cannot quietly turn a skip into silence.
    const skipped = result.checks.filter((c) => c.status === "skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(3);
    for (const check of skipped)
      expect(check.detail).toMatch(/--manifest|--config|nothing declared/);
    expect(text).toContain("no loom-manifest.json found");
    expect(text).toContain("no built config module found");
    // Each skip names the flag that would have enabled it.
    expect(text).toContain("--manifest");
    expect(text).toContain("--config");
  });

  // ── durable timers + wake ownership ────────────────────────────────────────

  const timerConfig = (body: string) => {
    const ws = workspace();
    const config = join(ws, "config.js");
    writeFileSync(config, `module.exports = ${body};`);
    return { ws, config };
  };

  const find = (
    result: { checks: { name: string; status: string; detail: string }[] },
    p: string
  ) => result.checks.find((c) => c.name.startsWith(p));

  it("fails when schedules are declared and no TimerStore can fire them", async () => {
    const { ws, config } = timerConfig(
      '{ stores: {}, schedules: [{ id: "nightly" }, { id: "weekly" }] }'
    );
    const { result, text } = await cmdDoctor({ dir: ws, config });
    const check = find(result, "durable timers");
    expect(check?.status).toBe("failed");
    expect(result.ok).toBe(false);
    expect(text).toContain("can never fire");
  });

  it("advises — does not fail — when gates exist but no TimerStore does", async () => {
    // A timeout lives in the runner body, so this is inference. It must not fail a build on
    // a guess, and it must not stay silent either.
    const { ws, config } = timerConfig(
      `{ stores: {}, schedules: [],
         runtime: { getFlowIds: () => ["approve"],
                    getFlow: () => ({ definition: { resumeSchemas: { Approved: {} } } }) } }`
    );
    const { result, text } = await cmdDoctor({ dir: ws, config });
    expect(find(result, "durable timers")?.status).toBe("advisory");
    expect(text).toContain("advisory (depends on how you deploy)"); // not silence
    // It says what verification does NOT cover, so a clean report is not read as coverage.
    expect(text).toContain("FlowSpec.suspends has no producer");
  });

  it("an advisory does not fail the run, and does not vanish from the summary", () => {
    // Asserted on the formatter, because `result.ok` in a full run also carries every other
    // check — and the property under test is what an advisory ALONE does.
    const text = formatDoctor({
      ok: true,
      checks: [
        { name: "durable timers (can this deployment wake?)", status: "advisory", detail: "…" },
        { name: "something else", status: "ok", detail: "fine" },
      ],
    });
    expect(text).toContain("passed, but");
    expect(text).toContain("1 advisory (depends on how you deploy)");
    expect(text).not.toContain("all checks passed");
  });

  it("advises when a TimerStore has no lease behind it", async () => {
    const { ws, config } = timerConfig("{ stores: { timerStore: {} }, schedules: [] }");
    const { result, text } = await cmdDoctor({ dir: ws, config });
    expect(find(result, "timer wake ownership")?.status).toBe("advisory");
    expect(text).toContain("every node resumes the same due execution");
    expect(text).toContain("Harmless on a single node");
  });

  it("passes when the timer store has a lease store, and says nothing further", async () => {
    const { ws, config } = timerConfig(
      '{ stores: { timerStore: {}, leaseStore: {} }, schedules: [{ id: "nightly" }] }'
    );
    const { result } = await cmdDoctor({ dir: ws, config });
    expect(find(result, "durable timers")?.status).toBe("ok");
    expect(find(result, "timer wake ownership")?.status).toBe("ok");
  });

  it("skips ownership when there are no timers — there are no wakes to own", async () => {
    const { ws, config } = timerConfig("{ stores: {}, schedules: [] }");
    const { result } = await cmdDoctor({ dir: ws, config });
    expect(find(result, "timer wake ownership")?.status).toBe("skipped");
    // ...and the timer check skips too: nothing observable needs one.
    expect(find(result, "durable timers")?.status).toBe("skipped");
  });

  it("loads the config for inspection, not for running", async () => {
    // doctor used a bare `require`, so pointing it at a deployment's config STARTED that
    // deployment's timer service — a diagnostic firing due timers as a side effect of being
    // asked a question. The module records what it saw at import time.
    const ws = workspace();
    const config = join(ws, "config.js");
    const witness = join(ws, "witness.txt");
    writeFileSync(
      config,
      `require("node:fs").writeFileSync(${JSON.stringify(witness)}, String(process.env.LOOM_NO_AUTOSTART));
       module.exports = { stores: {}, schedules: [] };`
    );
    await cmdDoctor({ dir: ws, config });
    expect(readFileSync(witness, "utf8")).toBe("1");
  });

  it("fails when a CONFIGURED memory store cannot do relevance retrieval", async () => {
    // Not a default anybody fell into: somebody wired this backend. `recallRelevant` and
    // `KnowledgeBase.retrieve` refuse such a store rather than degrading to the newest N,
    // so the app is one relevance query away from throwing.
    const ws = workspace();
    const config = join(ws, "config.js");
    writeFileSync(
      config,
      "module.exports = { stores: { memoryStore: { append(){}, read(){}, clear(){} } } };"
    );
    const { result, text } = await cmdDoctor({ dir: ws, config });
    const check = result.checks.find((c) => c.name.startsWith("memory store"));
    expect(check?.status).toBe("failed");
    expect(text).toContain("does not implement the optional `search`");
  });

  it("passes a configured store that implements search", async () => {
    const ws = workspace();
    const config = join(ws, "config.js");
    writeFileSync(
      config,
      "module.exports = { stores: { memoryStore: { append(){}, read(){}, clear(){}, search(){} } } };"
    );
    const { result } = await cmdDoctor({ dir: ws, config });
    expect(result.checks.find((c) => c.name.startsWith("memory store"))?.status).toBe("ok");
  });

  it("skips — and names the durability cost — when no memory store is configured", async () => {
    // The shape ADR 0090 opened with: an agent that restarted remembered nothing, and
    // nothing said so. A skip, not a failure: a test suite or a browser app wants exactly
    // this — but the skip is what turns a clean bill of health into partial coverage.
    const ws = workspace();
    const config = join(ws, "config.js");
    writeFileSync(config, "module.exports = { stores: {} };");
    const { result, text } = await cmdDoctor({ dir: ws, config });
    expect(result.checks.find((c) => c.name.startsWith("memory store"))?.status).toBe("skipped");
    // The skip carries the cost, rather than the check simply being absent.
    expect(text).toContain("LOST ON RESTART");
    expect(text).toContain("memoryStore: new SqliteMemoryStore");
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
