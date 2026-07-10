import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { SqliteEventStore } from "@loom/event-runtime";
import { SqliteSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { checkManifest } from "./check";
import { cmdDebug, cmdEval, cmdLogs } from "./commands";
import { idempotencyAdvisory, loadLogs, runDeployCheck } from "./deploy";
import { cmdGen, cmdNew, discoverFlows } from "./gen";
import { describeState, evaluateGoldens, foldAt, formatLog, parseArgs } from "./index";
import { serveInspector } from "./inspector";
import { buildTrace } from "./trace";
import { cmdVerify } from "./verify";

// ── record a real run into a temp SQLite store ────────────────────────────────
const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const aStep = step$({ id: "a", name: "A", toolId: "a-tool", ...io });
const bStep = step$({ id: "b", name: "B", toolId: "b-tool", ...io });
const gated: FlowRunner<unknown, unknown> = async (ctx: WorkflowContext) => {
  await ctx.run(aStep, {});
  await ctx.suspend({ on: "Approved" });
  await ctx.run(bStep, {});
  return { done: true };
};
const flow = {
  definition: {
    _tag: "FlowDefinition",
    id: "f",
    name: "F",
    version: "1.0.0",
    ...io,
    steps: [aStep, bStep],
  },
  runner: gated,
} as RegisteredFlow;

describe("loom CLI", () => {
  let dir: string;
  let dbPath: string;
  let log: EventEnvelope[];
  let executionId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-cli-"));
    dbPath = join(dir, "events.db");
    const effects = new EffectRuntime();
    effects.register("a-tool", new ToolEffect(async () => ({ ok: 1 })));
    effects.register("b-tool", new ToolEffect(async () => ({ ok: 2 })));
    const eventStore = new SqliteEventStore(dbPath);
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new SqliteSnapshotStore(join(dir, "snap.db")),
      effectRuntime: effects,
    });
    runtime.registerFlow(flow.definition, flow.runner);
    const handle = await runtime.start(flow, {});
    await handle.waitForSuspend(); // stop at the gate
    executionId = handle.executionId;
    log = await eventStore.read(executionId);
    eventStore.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe("parseArgs", () => {
    it("splits command, flags, positionals", () => {
      expect(parseArgs(["debug", "--db", "x.db", "exec-1", "--at", "3"])).toEqual({
        command: "debug",
        positionals: ["exec-1"],
        flags: { db: "x.db", at: "3" },
      });
    });
  });

  describe("foldAt / formatLog / describeState", () => {
    it("foldAt reconstructs state at a past sequence (time-travel)", () => {
      // At sequence 0 (EXECUTION_STARTED) the flow hasn't reached the suspend yet.
      const early = foldAt(log, 0);
      expect(early.status).toBe("running");
      const full = foldAt(log);
      expect(full.status).toBe("suspended");
    });
    it("formatLog marks the suspend point", () => {
      const text = formatLog(log);
      expect(text).toContain("⏸");
      expect(text).toContain("EXECUTION_SUSPENDED");
    });
    it("describeState summarizes frames + status", () => {
      const text = describeState(foldAt(log));
      expect(text).toContain("status: suspended");
      expect(text).toContain("a: completed");
    });
  });

  describe("commands over SQLite", () => {
    it("loom logs prints the timeline", async () => {
      const text = await cmdLogs(dbPath, executionId);
      expect(text).toContain("EXECUTION_STARTED");
      expect(text).toContain("STEP_COMPLETED");
    });
    it("loom debug --at N prints state at that sequence", async () => {
      const text = await cmdDebug(dbPath, executionId, 0);
      expect(text).toContain("status: running");
    });
    it("loom debug (no --at) prints timeline + final state", async () => {
      const text = await cmdDebug(dbPath, executionId);
      expect(text).toContain("EXECUTION_SUSPENDED");
      expect(text).toContain("status: suspended");
    });
    it("loom debug on an unknown execution is graceful", async () => {
      expect(await cmdDebug(dbPath, "nope")).toContain("no execution");
    });
  });

  describe("loom eval", () => {
    it("passes a golden matching expectations, fails a mismatch, exits accordingly", () => {
      writeFileSync(
        join(dir, "ok.json"),
        JSON.stringify({
          name: "gate",
          log,
          expect: { status: "suspended", stepsCompleted: ["a"] },
        })
      );
      writeFileSync(
        join(dir, "bad.json"),
        JSON.stringify({ name: "wrong", log, expect: { status: "completed" } })
      );
      const { text, report } = cmdEval(dir);
      expect(report.ok).toBe(false);
      expect(report.passed).toBe(1);
      expect(report.failed).toBe(1);
      expect(text).toContain("✓ gate");
      expect(text).toContain("✗ wrong");
    });

    it("evaluateGoldens is pure and reports step-completion failures", () => {
      const report = evaluateGoldens([
        { name: "x", log, expect: { stepsCompleted: ["a", "b"] } }, // b hasn't run (suspended)
      ]);
      expect(report.ok).toBe(false);
      expect(report.results[0]?.failures.some((f) => f.includes('"b"'))).toBe(true);
    });
  });

  describe("loom new + gen (folder convention)", () => {
    it("scaffolds a flow file, discovers it, and generates loom.gen.ts", () => {
      const appDir = join(dir, "app");
      // loom new flow greet
      const created = cmdNew("flow", "greet", appDir);
      expect(created.created).toBe(true);
      expect(created.path).toBe(join(appDir, "flows/greet/flow.ts"));
      expect(readFileSync(created.path, "utf-8")).toContain("export const GreetFlow");

      // loom new flow report
      cmdNew("flow", "report", appDir);

      // discovery finds both, sorted
      expect(discoverFlows(appDir)).toEqual(["./flows/greet/flow", "./flows/report/flow"]);

      // loom gen writes a static registration module
      const { out, count } = cmdGen(appDir);
      expect(count).toBe(2);
      const gen = readFileSync(out, "utf-8");
      expect(gen).toContain('import * as _f0 from "./flows/greet/flow";');
      expect(gen).toContain("export const flowModules = [_f0, _f1];");
    });

    it("does not overwrite an existing file", () => {
      const appDir = join(dir, "app");
      expect(cmdNew("tool", "lookup", appDir).created).toBe(true);
      expect(cmdNew("tool", "lookup", appDir).created).toBe(false);
    });

    it("rejects an unknown kind", () => {
      expect(() => cmdNew("widget", "x", join(dir, "app"))).toThrow(/unknown kind/);
    });

    it("gen on an empty app yields an empty flowModules array", () => {
      const { count, out } = cmdGen(join(dir, "empty-app"));
      expect(count).toBe(0);
      expect(readFileSync(out, "utf-8")).toContain("export const flowModules = [];");
    });
  });

  describe("loom check (manifest)", () => {
    it("collects per-flow compiler warnings and reports ok/not-ok", () => {
      const clean = checkManifest({ flows: { a: { warnings: [] } } });
      expect(clean.ok).toBe(true);
      expect(clean.issues).toEqual([]);

      const dirty = checkManifest({
        flows: { a: { warnings: ["step 'x' has neither handler nor toolId"] } },
      });
      expect(dirty.ok).toBe(false);
      expect(dirty.issues[0]).toContain('flow "a"');
    });
  });

  describe("buildTrace (inspector render model)", () => {
    it("produces a timeline + folded status per sequence", () => {
      const trace = buildTrace(log);
      expect(trace.executionId).toBe(executionId);
      expect(trace.finalStatus).toBe("suspended");
      expect(trace.timeline.some((e) => e.suspend)).toBe(true);
      // status at sequence 0 is running; final frame is suspended.
      expect(trace.frames[0]?.status).toBe("running");
      expect(trace.frames.at(-1)?.status).toBe("suspended");
    });
  });

  describe("loom deploy check", () => {
    it("loadLogs reads stored EventEnvelope[] json files", () => {
      writeFileSync(join(dir, "run1.json"), JSON.stringify(log));
      expect(loadLogs(dir)).toHaveLength(1);
      expect(loadLogs(dir)[0]).toHaveLength(log.length);
    });

    it("runDeployCheck passes an identical deploy and flags a removed flow", () => {
      const resolver = {
        getFlow: () => ({ definition: { version: "1.0.0", steps: [{ id: "a" }, { id: "b" }] } }),
      };
      expect(runDeployCheck([log], resolver).ok).toBe(true);
      const removed = { getFlow: () => undefined };
      const report = runDeployCheck([log], removed);
      expect(report.ok).toBe(false);
      expect(report.issues[0]?.kind).toBe("flow-missing");
    });

    it("idempotencyAdvisory lists tool effects with no idempotent declaration (K9)", () => {
      const resolver = {
        getFlowIds: () => ["f"],
        getFlow: () => ({
          definition: {
            version: "1.0.0",
            steps: [
              { id: "pay", toolId: "pay-tool" }, // tool, undeclared → advisory
              { id: "wire", toolId: "wire-tool" }, // tool, declared → fine
              { id: "ask", toolId: "ask-llm" }, // not a tool → skipped
            ],
          },
        }),
      };
      const effects = {
        kindOf: (toolId: string) => (toolId === "ask-llm" ? "llm" : "tool"),
        declaredIdempotence: (toolId: string) => (toolId === "wire-tool" ? false : undefined),
      };
      expect(idempotencyAdvisory(resolver, effects)).toEqual(["pay-tool"]);
      // No enumeration capability → no advisory (never a hard failure).
      expect(idempotencyAdvisory({ getFlow: () => undefined }, effects)).toEqual([]);
    });
  });

  describe("loom verify", () => {
    /** A fixture config module exporting a LoomApp-shaped object with verify(). */
    function writeConfig(name: string, body: string): string {
      const p = join(dir, name);
      writeFileSync(p, body);
      return p;
    }

    it("prints the report and returns ok when a config passes", async () => {
      const p = writeConfig(
        "pass.js",
        `module.exports = { default: {
           verify: () => ({ ok: true, findings: [], checked: ["capability-compat"] }),
           close: async () => {},
         } };`
      );
      const { text, result } = await cmdVerify(p);
      expect(result.ok).toBe(true);
      expect(text).toContain("no findings");
    });

    it("surfaces error findings (exit non-zero) when a config fails", async () => {
      const p = writeConfig(
        "fail.js",
        `module.exports = { default: {
           verify: () => ({
             ok: false,
             findings: [{ rule: "capability-compat", severity: "error", message: "effect x not granted" }],
             checked: ["capability-compat"],
           }),
           close: async () => {},
         } };`
      );
      const { text, result } = await cmdVerify(p);
      expect(result.ok).toBe(false);
      expect(text).toContain("capability-compat");
    });

    it("throws when the module does not export a LoomApp", async () => {
      const p = writeConfig("bad.js", "module.exports = { default: {} };");
      await expect(cmdVerify(p)).rejects.toThrow(/LoomApp/);
    });
  });

  describe("serveInspector", () => {
    it("serves the page, the trace, and the folded state at a sequence", async () => {
      const store = new SqliteEventStore(dbPath);
      const server = serveInspector(store);
      await server.start();
      try {
        const page = await fetch(`${server.url}/`);
        expect(await page.text()).toContain("loom inspector");

        const trace = await (await fetch(`${server.url}/api/trace/${executionId}`)).json();
        expect(trace.finalStatus).toBe("suspended");

        const state = await (await fetch(`${server.url}/api/state/${executionId}/0`)).text();
        expect(state).toContain("status: running");

        expect((await fetch(`${server.url}/api/trace/nope`)).status).toBe(404);
      } finally {
        await server.stop();
        await store.close();
      }
    });
  });
});
