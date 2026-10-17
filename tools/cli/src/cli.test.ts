import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { SqliteBranchRegistry, SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { failure } from "./refusalTestUtil";

import { AnthropicProvider, GeminiProvider, OpenAiProvider } from "@loom/llm";
import { appFiles } from "@loom/scaffold";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow, WorkflowContext } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AppgenIO,
  type Conflict,
  cmdAppgen,
  plannerTag,
  renderPlan,
  routeFromSpec,
} from "./appgen";
import { COMMANDS } from "./args";
import { checkManifest } from "./check";
import { USAGE, resolveIntent } from "./cli";
import { parseRedact } from "./cli";
import { cmdDebug, cmdEval, cmdLogs } from "./commands";
import { cmdComplianceReport } from "./compliance";
import { idempotencyAdvisory, loadLogs, runDeployCheck } from "./deploy";
import { unifiedDiff } from "./diff";
import {
  cmdGen,
  cmdNew,
  discoverAgents,
  discoverFlows,
  discoverMemories,
  discoverProjections,
  discoverSchedules,
  discoverSkills,
  discoverTools,
} from "./gen";
import { describeState, evaluateGoldens, foldAt, formatLog, parseArgs } from "./index";
import { serveInspector } from "./inspector";
import { cmdIntrospect } from "./introspect";
import { cmdCompat, cmdKernelManifest } from "./kernel";
import { cmdOptimize } from "./optimize";
import { cmdProfile } from "./profile";
import { cmdRetentionRun } from "./retention";
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

    it("holds only what was typed — an unset flag is undefined, not an inherited member", () => {
      // Every option is read out of this bag by name. With a prototype,
      // `flags["valueOf"] ?? fallback` answers with a FUNCTION for a flag nobody passed.
      const { flags } = parseArgs(["debug", "--db", "x.db"]);
      // Read the way the CLI reads: by a name computed at runtime, which is the case an
      // inherited member answers for.
      for (const option of ["valueOf", "constructor", "toString", "hasOwnProperty"]) {
        expect(flags[option], option).toBeUndefined();
      }
    });

    it("rejects `--__proto__` as an unknown flag rather than recording or polluting", () => {
      expect(() => parseArgs(["debug", "--__proto__", "x"])).toThrow(/unknown flag --__proto__/);
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
    it("formatLog renders a continue-as-new hand-off with its successor (EVENT_SCHEMA 1.23.0)", () => {
      const text = formatLog([
        {
          id: "c-1",
          workflowId: "wf",
          executionId: "c",
          eventType: "EXECUTION_CONTINUED",
          sequence: 1,
          timestamp: 1,
          payload: { successorId: "c~1" },
          metadata: { kernel: true },
        },
      ]);
      expect(text).toContain("EXECUTION_CONTINUED");
      expect(text).toContain("c~1");
    });
    it("describeState summarizes frames + status", () => {
      const text = describeState(foldAt(log));
      expect(text).toContain("status: suspended");
      expect(text).toContain("a: completed");
    });
  });

  describe("commands over SQLite", () => {
    it("loom logs prints the timeline", async () => {
      const text = await cmdLogs({ db: dbPath }, executionId);
      expect(text).toContain("EXECUTION_STARTED");
      expect(text).toContain("STEP_COMPLETED");
    });
    it("loom debug --at N prints state at that sequence", async () => {
      const text = await cmdDebug({ db: dbPath }, executionId, 0);
      expect(text).toContain("status: running");
    });
    it("loom debug (no --at) prints timeline + final state", async () => {
      const text = await cmdDebug({ db: dbPath }, executionId);
      expect(text).toContain("EXECUTION_SUSPENDED");
      expect(text).toContain("status: suspended");
    });
    it("loom debug on an unknown execution is an error, not an empty answer", async () => {
      expect(await failure(cmdDebug({ db: dbPath }, "nope"))).toContain("no such execution nope");
    });
    it("loom profile prints a flame graph + latency breakdown", async () => {
      const text = await cmdProfile({ db: dbPath }, executionId);
      expect(text).toContain(`profile ${executionId}`);
      expect(text).toContain("flame graph:");
      expect(text).toContain("latency:");
      expect(text).toContain("a —"); // the completed step appears in the flame tree
    });
    it("loom profile on an unknown execution is an error, not an empty answer", async () => {
      expect(await failure(cmdProfile({ db: dbPath }, "nope"))).toContain("no such execution nope");
    });
    it("loom introspect prints the execution/task/decision/resource graphs", async () => {
      const text = await cmdIntrospect({ db: dbPath }, executionId);
      expect(text).toContain("executions:");
      expect(text).toContain("tasks:");
      expect(text).toContain("a — completed");
    });
    it("loom introspect --graph selects one graph", async () => {
      const text = await cmdIntrospect({ db: dbPath }, executionId, "tasks");
      expect(text).toContain("tasks:");
      expect(text).not.toContain("resources:");
    });
    it("loom introspect on an unknown execution is an error, not an empty answer", async () => {
      expect(await failure(cmdIntrospect({ db: dbPath }, "nope"))).toContain(
        "no such execution nope"
      );
    });
    it("loom optimize prints the advisory report", async () => {
      const text = await cmdOptimize({ db: dbPath }, executionId);
      expect(text).toContain("advisory optimization report");
      expect(text).toContain("recommendations:");
    });
    it("loom optimize on an unknown execution is an error, not an empty answer", async () => {
      expect(await failure(cmdOptimize({ db: dbPath }, "nope"))).toContain(
        "no such execution nope"
      );
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

    it("discovers every construct (flat-file) and emits all six module arrays", () => {
      const appDir = join(dir, "app-at");
      cmdNew("flow", "greet", appDir);
      const agent = cmdNew("agent", "triage", appDir);
      const tool = cmdNew("tool", "lookup", appDir);
      const skill = cmdNew("skill", "refunds", appDir);
      const schedule = cmdNew("schedule", "nightly", appDir);
      const mem = cmdNew("memory", "chat", appDir);
      const projection = cmdNew("projection", "counter", appDir);
      expect(agent.path).toBe(join(appDir, "agents/triage.ts")); // flat file, not a folder
      expect(tool.path).toBe(join(appDir, "tools/lookup.ts"));
      expect(skill.path).toBe(join(appDir, "skills/refunds.ts"));
      expect(schedule.path).toBe(join(appDir, "schedules/nightly.ts"));
      expect(mem.path).toBe(join(appDir, "memories/chat.ts"));
      expect(projection.path).toBe(join(appDir, "projections/counter.ts"));

      expect(discoverAgents(appDir)).toEqual(["./agents/triage"]);
      expect(discoverTools(appDir)).toEqual(["./tools/lookup"]);
      expect(discoverSkills(appDir)).toEqual(["./skills/refunds"]);
      expect(discoverSchedules(appDir)).toEqual(["./schedules/nightly"]);
      expect(discoverMemories(appDir)).toEqual(["./memories/chat"]);
      expect(discoverProjections(appDir)).toEqual(["./projections/counter"]);

      const { flows, agents, tools, skills, schedules, memories, projections, out } =
        cmdGen(appDir);
      expect([flows, agents, tools, skills, schedules, memories, projections]).toEqual([
        1, 1, 1, 1, 1, 1, 1,
      ]);
      const gen = readFileSync(out, "utf-8");
      expect(gen).toContain('import * as _a0 from "./agents/triage";');
      expect(gen).toContain("export const agentModules = [_a0];");
      expect(gen).toContain('import * as _t0 from "./tools/lookup";');
      expect(gen).toContain("export const toolModules = [_t0];");
      expect(gen).toContain('import * as _s0 from "./skills/refunds";');
      expect(gen).toContain("export const skillModules = [_s0];");
      expect(gen).toContain('import * as _sc0 from "./schedules/nightly";');
      expect(gen).toContain("export const scheduleModules = [_sc0];");
      expect(gen).toContain('import * as _m0 from "./memories/chat";');
      expect(gen).toContain("export const memoryModules = [_m0];");
      expect(gen).toContain('import * as _p0 from "./projections/counter";');
      expect(gen).toContain("export const projectionModules = [_p0];");
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
      mkdirSync(join(dir, "empty-app"));
      const { count, out } = cmdGen(join(dir, "empty-app"));
      expect(count).toBe(0);
      expect(readFileSync(out, "utf-8")).toContain("export const flowModules = [];");
    });
  });

  describe("loom appgen (NL → app)", () => {
    // Canonical @loom/appgen example → spec.name "planner", flow at app/flows/planner/flow.ts.
    const EXAMPLE =
      "Create a planner. Use Gemma first. Elevate to Gemini. Pause for approval. Deploy on Fargate. Generate UI.";

    // Real fs for exists/write, but scripted (non-interactive) conflict resolution.
    function scriptedIO(actions: Conflict[]): AppgenIO & { conflicts: string[] } {
      const conflicts: string[] = [];
      let i = 0;
      return {
        conflicts,
        exists: (p) => existsSync(p),
        write: (p, contents) => {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, contents);
        },
        resolveConflict: async (existingPath) => {
          conflicts.push(existingPath);
          const a = actions[i++];
          if (a === undefined) throw new Error(`unexpected conflict for ${existingPath}`);
          return a;
        },
      };
    }

    const relWritten = (r: { written: string[]; overwritten: string[] }, base: string) =>
      [...r.written, ...r.overwritten].map((p) => relative(base, p));

    it("scaffolds a full runnable project when the target dir is new", async () => {
      const appDir = join(dir, "gen");
      const io = scriptedIO([]);
      const r = await cmdAppgen({ intent: EXAMPLE, dir: appDir }, io);

      expect(r.specName).toBe("planner");
      expect(io.conflicts).toEqual([]); // no collisions → never prompted

      // A complete folder-convention project seeded from the intent.
      const rel = relWritten(r, appDir);
      expect(rel).toContain("package.json");
      expect(rel).toContain("tsconfig.json");
      expect(rel).toContain(join("app", "config.ts"));
      expect(rel).toContain(join("app", "loom.gen.ts"));
      expect(rel).toContain(join("app", "flows", "planner", "flow.ts"));
      expect(readFileSync(join(appDir, "app/flows/planner/flow.ts"), "utf-8")).toContain(
        "export const PlannerFlow"
      );
      expect(readFileSync(join(appDir, "app/config.ts"), "utf-8")).toContain("defineConfig(");
    });

    it("adds flows + regenerates loom.gen.ts in an existing app", async () => {
      const appDir = join(dir, "existing");
      // A pre-existing folder-convention app with one flow already wired.
      mkdirSync(join(appDir, "app/flows/existing-flow"), { recursive: true });
      writeFileSync(join(appDir, "package.json"), "{}");
      writeFileSync(join(appDir, "app/flows/existing-flow/flow.ts"), "export const X = 1;");
      writeFileSync(join(appDir, "app/loom.gen.ts"), "export const flowModules = [];");
      const io = scriptedIO([]);

      const r = await cmdAppgen({ intent: "Create a summarizer.", dir: appDir }, io);

      // Only the new flow is written; no project files (package.json etc.) are re-scaffolded.
      const rel = relWritten(r, appDir);
      expect(rel).toContain(join("app", "flows", "summarizer", "flow.ts"));
      expect(rel).not.toContain("package.json");
      expect(rel).not.toContain("tsconfig.json");
      // loom.gen.ts is regenerated to wire BOTH the pre-existing and the new flow.
      expect(r.overwritten).toContain(join(appDir, "app/loom.gen.ts"));
      const gen = readFileSync(join(appDir, "app/loom.gen.ts"), "utf-8");
      expect(gen).toContain("./flows/existing-flow/flow");
      expect(gen).toContain("./flows/summarizer/flow");
    });

    it("resolves the intent from a positional string or --from <file> identically", () => {
      const fromFile = join(dir, "intent.txt");
      writeFileSync(fromFile, EXAMPLE);
      expect(resolveIntent({ from: fromFile }, [])).toBe(EXAMPLE);
      expect(resolveIntent({}, ["Create", "a", "planner."])).toBe("Create a planner.");
    });

    it("errors when no intent is supplied", () => {
      expect(() => resolveIntent({}, [])).toThrow(/provide an intent/);
    });

    it("renames on conflict, leaving the existing file untouched", async () => {
      const appDir = join(dir, "rename");
      // A lone flow file (no project markers) → still new-app mode; it collides.
      mkdirSync(join(appDir, "app/flows/planner"), { recursive: true });
      writeFileSync(join(appDir, "app/flows/planner/flow.ts"), "ORIGINAL");
      const io = scriptedIO([{ action: "rename", newPath: "app/flows/planner/flow_v2.ts" }]);

      const r = await cmdAppgen({ intent: EXAMPLE, dir: appDir }, io);

      expect(io.conflicts).toEqual([join(appDir, "app/flows/planner/flow.ts")]);
      expect(readFileSync(join(appDir, "app/flows/planner/flow.ts"), "utf-8")).toBe("ORIGINAL");
      expect(r.written).toContain(join(appDir, "app/flows/planner/flow_v2.ts"));
      expect(readFileSync(join(appDir, "app/flows/planner/flow_v2.ts"), "utf-8")).toContain(
        "export const PlannerFlow"
      );
    });

    it("skips a conflicting file but still scaffolds the rest of the project", async () => {
      const appDir = join(dir, "skip");
      mkdirSync(join(appDir, "app/flows/planner"), { recursive: true });
      writeFileSync(join(appDir, "app/flows/planner/flow.ts"), "ORIGINAL");
      const io = scriptedIO([{ action: "skip" }]);

      const r = await cmdAppgen({ intent: EXAMPLE, dir: appDir }, io);

      expect(r.skipped).toEqual([join(appDir, "app/flows/planner/flow.ts")]);
      expect(readFileSync(join(appDir, "app/flows/planner/flow.ts"), "utf-8")).toBe("ORIGINAL");
      expect(existsSync(join(appDir, "package.json"))).toBe(true); // rest still written
    });

    it("overwrites a conflicting file in place", async () => {
      const appDir = join(dir, "overwrite");
      mkdirSync(join(appDir, "app/flows/planner"), { recursive: true });
      writeFileSync(join(appDir, "app/flows/planner/flow.ts"), "ORIGINAL");
      const io = scriptedIO([{ action: "overwrite" }]);

      const r = await cmdAppgen({ intent: EXAMPLE, dir: appDir }, io);

      expect(r.overwritten).toContain(join(appDir, "app/flows/planner/flow.ts"));
      expect(readFileSync(join(appDir, "app/flows/planner/flow.ts"), "utf-8")).toContain(
        "export const PlannerFlow"
      );
    });

    it("--dry-run computes a plan but writes nothing", async () => {
      const appDir = join(dir, "dry");
      const io = scriptedIO([]);
      const r = await cmdAppgen({ intent: EXAMPLE, dir: appDir, dryRun: true }, io);

      expect(r.dryRun).toBe(true);
      expect(r.plan.isNewProject).toBe(true);
      expect(r.plan.creates.length).toBeGreaterThan(0);
      expect(r.written).toEqual([]);
      expect(r.overwritten).toEqual([]);
      expect(existsSync(join(appDir, "package.json"))).toBe(false); // nothing written
    });

    it("aborts without writing when the confirm callback returns false", async () => {
      const appDir = join(dir, "confirm");
      const r = await cmdAppgen(
        { intent: "Create a greeter.", dir: appDir, confirm: async () => false },
        scriptedIO([])
      );
      expect(r.aborted).toBe(true);
      expect(r.written).toEqual([]);
      expect(existsSync(join(appDir, "package.json"))).toBe(false);
    });

    it("deletes a generated flow on a delete intent and re-wires registration", async () => {
      const appDir = join(dir, "del");
      await cmdAppgen(
        { intent: "Create a planner. Create a reporter.", dir: appDir },
        scriptedIO([])
      );
      expect(existsSync(join(appDir, "app/flows/reporter/flow.ts"))).toBe(true);

      const r = await cmdAppgen({ intent: "Delete the reporter.", dir: appDir }, scriptedIO([]));
      expect(r.deleted.some((p) => p.includes(join("reporter", "flow.ts")))).toBe(true);
      expect(existsSync(join(appDir, "app/flows/reporter/flow.ts"))).toBe(false);
      expect(readFileSync(join(appDir, "app/loom.gen.ts"), "utf-8")).not.toContain("reporter");
    });

    it("writes a replayable lockfile and --from-spec reproduces byte-identical output", async () => {
      const srcDir = join(dir, "spec-src");
      const first = await cmdAppgen({ intent: EXAMPLE, dir: srcDir, now: 123 }, scriptedIO([]));
      expect(first.lockfile).toBe(join(srcDir, ".loom/appgen/123.spec.json"));

      // Replay the spec (no intent, no model) into a fresh directory.
      const replayDir = join(dir, "spec-replay");
      const replay = await cmdAppgen(
        { intent: "", dir: replayDir, fromSpec: first.lockfile! },
        scriptedIO([])
      );
      expect(replay.specName).toBe("planner");

      const a = readFileSync(join(srcDir, "app/flows/planner/flow.ts"), "utf-8");
      const b = readFileSync(join(replayDir, "app/flows/planner/flow.ts"), "utf-8");
      expect(b).toBe(a); // byte-identical, reproduced without re-parsing the intent
    });
  });

  describe("planner surface", () => {
    it("--dry-run surfaces which planner produced the plan", () => {
      const plan = {
        root: "/x",
        isNewProject: true,
        creates: [{ path: "package.json", contents: "{}" }],
        edits: [],
        deletes: [],
        skips: [],
        regenRegistration: false,
      };
      expect(renderPlan(plan, ".", { planner: "deterministic" })).toContain("[deterministic]");
      expect(
        renderPlan(plan, ".", {
          planner: "model",
          elevations: [{ from: "gemma-e4b", to: "gemma-12b", reason: "x" }],
        })
      ).toContain("[model, elevated gemma-e4b→gemma-12b]");
    });

    it("plannerTag renders deterministic vs model (with elevations)", () => {
      expect(plannerTag("deterministic")).toBe("[deterministic]");
      expect(plannerTag("model")).toBe("[model]");
      expect(plannerTag("model", [{ from: "a", to: "b", reason: "x" }])).toBe(
        "[model, elevated a→b]"
      );
    });
  });

  describe("unifiedDiff (dry-run rendering)", () => {
    it("marks inserted and unchanged lines", () => {
      const d = unifiedDiff("a\nb\nc", "a\nb\nX\nc");
      expect(d.some((l) => l === "+X")).toBe(true);
      expect(d.some((l) => l === " b")).toBe(true);
      expect(d.some((l) => l.startsWith("-"))).toBe(false);
    });
    it("returns nothing when the sides are identical", () => {
      expect(unifiedDiff("a\nb", "a\nb")).toEqual([]);
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

    // A fixture whose verify() echoes injected loop-identity findings as warnings,
    // so the tests observe exactly what cmdVerify passed through.
    const ECHOING_APP = `module.exports = { default: {
       verify: (opts) => {
         const flows = Object.keys((opts && opts.lint && opts.lint.loopIdentityByFlow) || {});
         return {
           ok: true,
           findings: flows.map((f) => ({ rule: "determinism", severity: "warn", message: "loop-identity: " + f })),
           checked: ["determinism"],
         };
       },
       close: async () => {},
     } };`;

    const MANIFEST = JSON.stringify({
      flows: {
        interp: {
          loopIdentity: [
            { callee: "run", loopKind: "ForOfStatement", reason: "static-step-in-loop" },
          ],
        },
        clean: { loopIdentity: [] },
      },
    });

    it("injects the manifest's loopIdentity findings via --manifest (ADR 0061)", async () => {
      const sub = join(dir, "verify-explicit");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "app.js"), ECHOING_APP);
      writeFileSync(join(sub, "m.json"), MANIFEST);
      const { text, result } = await cmdVerify(join(sub, "app.js"), join(sub, "m.json"));
      expect(text).toContain("[manifest]");
      expect(text).toContain("loop-identity: interp");
      expect(result.findings).toHaveLength(1); // `clean` (empty findings) is not injected
    });

    it("auto-detects loom-manifest.json next to the config when --manifest is omitted", async () => {
      const sub = join(dir, "verify-auto");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "app.js"), ECHOING_APP);
      writeFileSync(join(sub, "loom-manifest.json"), MANIFEST);
      const { text, result } = await cmdVerify(join(sub, "app.js"));
      expect(text).toContain("loop-identity for 1 flow(s) (ADR 0061)");
      expect(result.findings.map((f) => f.message)).toEqual(["loop-identity: interp"]);
    });

    it("says when runner bodies were NOT analysed — the silence used to read as clean", async () => {
      // This test used to assert the opposite: that a run with no manifest stayed
      // byte-identical to one with it. That WAS the defect — three rules see past a flow's
      // declared steps only with reach data, and reported exactly as they do with it.
      const sub = join(dir, "verify-none");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "app.js"), ECHOING_APP);
      const bare = await cmdVerify(join(sub, "app.js"));
      expect(bare.text).toContain("none found");
      expect(bare.text).toContain("not analysed");
      expect(bare.text).toContain("--manifest"); // names the fix, like every other refusal
      expect(bare.result.findings).toHaveLength(0); // ...and still does not FAIL the run

      // A manifest that carries no runner-body analysis leaves the rules just as blind, so
      // the presence of a file is not the question.
      writeFileSync(join(sub, "loom-manifest.json"), JSON.stringify({ flows: { clean: {} } }));
      const empty = await cmdVerify(join(sub, "app.js"));
      expect(empty.text).toContain("carries no runner-body analysis");
      expect(empty.result.findings).toHaveLength(0);
    });
  });

  describe("loom kernel-manifest / compat", () => {
    it("prints the manifest text and valid JSON", () => {
      expect(cmdKernelManifest({})).toContain("kernel ABI");
      const json = JSON.parse(cmdKernelManifest({ json: true }));
      expect(json.kernelAbi.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(json.eventSchema.eventTypes.length).toBeGreaterThan(0);
    });
    it("emits the compatibility-matrix + maturity docs", () => {
      const out = join(dir, "spec");
      const msg = cmdKernelManifest({ emitDocs: out });
      expect(msg).toContain("compatibility-matrix.md");
      expect(existsSync(join(out, "compatibility-matrix.md"))).toBe(true);
      expect(existsSync(join(out, "maturity.md"))).toBe(true);
    });
    it("compat passes same-major and fails major mismatch (exit code)", () => {
      expect(cmdCompat({ abi: "1.9.0" }).ok).toBe(true);
      const bad = cmdCompat({ abi: "2.0.0" });
      expect(bad.ok).toBe(false);
      expect(bad.text).toContain("kernelAbi");
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

        const trace = (await (await fetch(`${server.url}/api/trace/${executionId}`)).json()) as {
          finalStatus: string;
        };
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

describe("K10-R6 — CLI egress redaction (--redact)", () => {
  it("parseRedact splits a comma list, tolerating spaces / the bare flag", () => {
    expect(parseRedact("ssn, user.token ,")).toEqual(["ssn", "user.token"]);
    expect(parseRedact(undefined)).toEqual([]);
    expect(parseRedact("true")).toEqual([]); // `--redact` with no value
  });

  it("formatLog masks redacted output paths on EXECUTION_COMPLETED", () => {
    const events: EventEnvelope[] = [
      {
        id: "e0",
        workflowId: "wf",
        executionId: "x1",
        eventType: "EXECUTION_COMPLETED",
        sequence: 0,
        timestamp: 1,
        payload: { output: { ssn: "123-45-6789", ok: true } },
      },
    ];
    const text = formatLog(events, ["ssn"]);
    expect(text).not.toContain("123-45-6789");
    expect(text).toContain("[redacted]");
    expect(text).toContain('"ok":true');
  });

  it("describeState masks redacted paths in the folded output", () => {
    const state = {
      executionId: "x1",
      workflowId: "wf",
      workflowVersion: "1.0.0",
      status: "completed",
      frames: {},
      variables: { _output: { token: "sk_live_SECRET", label: "ok" } },
      sequence: 1,
      startedAt: 0,
      updatedAt: 0,
    } as unknown as import("@loom/core").ExecutionState;
    const text = describeState(state, ["token"]);
    expect(text).not.toContain("sk_live_SECRET");
    expect(text).toContain("[redacted]");
    expect(text).toContain('"label":"ok"');
  });
});

describe("loom retention run + compliance report (listExecutions SPI)", () => {
  let cdir: string;
  let cdb: string;
  let csnap: string;

  async function seed(
    store: SqliteEventStore,
    id: string,
    steps: [string, unknown][]
  ): Promise<void> {
    await Promise.all(
      steps.map(([eventType, payload], seq) =>
        store.append({
          id: `${id}-${seq}`,
          workflowId: "wf",
          executionId: id,
          eventType,
          sequence: seq,
          timestamp: 1000 + seq,
          payload,
        })
      )
    );
  }

  beforeEach(async () => {
    cdir = mkdtempSync(join(tmpdir(), "loom-ret-"));
    cdb = join(cdir, "events.db");
    csnap = join(cdir, "snap.db");
    // `--snap` must name an EXISTING file (a mistyped path is refused, never created).
    await new SqliteSnapshotStore(csnap).close();
    const store = new SqliteEventStore(cdb);
    // Two completed executions for "ann", one still-running for "bob".
    await seed(store, "x1", [
      ["EXECUTION_STARTED", { input: { userId: "ann" } }],
      ["EXECUTION_COMPLETED", { output: {} }],
    ]);
    await seed(store, "x2", [
      ["EXECUTION_STARTED", { input: { userId: "ann" } }],
      ["EXECUTION_COMPLETED", { output: {} }],
    ]);
    await seed(store, "x3", [["EXECUTION_STARTED", { input: { userId: "bob" } }]]);
    store.close();
  });
  afterEach(() => rmSync(cdir, { recursive: true, force: true }));

  it("compliance report inventories subjects → executions", async () => {
    const text = await cmdComplianceReport({ db: cdb }, "input.userId");
    expect(text).toContain("2 subject(s)");
    expect(text).toMatch(/ann\s+2 executions/);
    expect(text).toMatch(/bob\s+1 execution\b/);
  });

  it("does not delete a parent a live branch still depends on, and says so when it cannot tell", async () => {
    // The bug this replaced: the command built `LogLifecycle` with no branch registry, so
    // R5.3's live-descendant guard was a no-op and `--apply` deleted parents whose forks alias
    // their prefix. The dry run re-implemented eligibility locally, so it did not mention
    // branches either — a preview that disagrees with its apply.
    const branchesDb = join(cdir, "branches.db");
    const registry = new SqliteBranchRegistry(branchesDb);
    // x1 is terminal and aged; a live branch was forked from it.
    await registry.recordLineage({
      executionId: "branch-of-x1",
      parentExecutionId: "x1",
      forkSequence: 1,
    });
    const store = new SqliteEventStore(cdb);
    await seed(store, "branch-of-x1", [["EXECUTION_STARTED", { input: {} }]]);
    store.close();

    const guarded = await cmdRetentionRun({
      db: cdb,
      snap: csnap,
      ttlMs: 0,
      apply: false,
      branches: branchesDb,
    });
    expect(guarded).toContain("blocked-by-branch");
    expect(guarded).not.toContain("⚠"); // the guard is on, so no warning

    await cmdRetentionRun({ db: cdb, snap: csnap, ttlMs: 0, apply: true, branches: branchesDb });
    const after = new SqliteEventStore(cdb);
    const remaining = (await after.listExecutions()).filter((id) => !id.startsWith("__loom_"));
    expect(remaining).toContain("x1"); // survived, because something still depends on it
    after.close();
    await registry.close();
  });

  it("warns when it cannot apply the branch guard at all", async () => {
    // Silence here would be the worst outcome: the sweep looks complete while the one guard
    // that prevents data loss is switched off.
    const unguarded = await cmdRetentionRun({ db: cdb, snap: csnap, ttlMs: 0, apply: false });
    expect(unguarded).toContain("R5.3");
    expect(unguarded).toContain("OFF");
  });

  it("retention run dry-runs by default, reclaims aged terminal executions with --apply", async () => {
    const dry = await cmdRetentionRun({ db: cdb, snap: csnap, ttlMs: 0, apply: false });
    expect(dry).toContain("DRY RUN");
    expect(dry).toContain("would-reclaim"); // x1, x2 terminal + aged
    expect(dry).toContain("not-terminal"); // x3 still running

    const applied = await cmdRetentionRun({ db: cdb, snap: csnap, ttlMs: 0, apply: true });
    expect(applied).toContain("reclaimed");

    // x1/x2 are gone; x3 (running) survives.
    const store = new SqliteEventStore(cdb);
    const remaining = (await store.listExecutions()).filter((id) => !id.startsWith("__loom_"));
    expect(remaining).toEqual(["x3"]);
    store.close();
  });
});

describe("appgen --model provider resolution (any model of your choice)", () => {
  // A fake @loom/appgen-model — only its gemmaRoute/DEFAULT_TIER are used (the local case).
  const fakeM = {
    DEFAULT_TIER: "e4b",
    gemmaRoute: (modelPath: string, tierKey: string) => ({
      id: `gemma:${modelPath}#${tierKey}`,
      tier: 0,
      tags: ["planning"],
      provider: { local: modelPath },
    }),
  };
  const withEnv = (vars: Record<string, string>, fn: () => void): void => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("resolves anthropic / openai / gemini specs to the matching @loom/llm provider", () => {
    withEnv({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" }, () => {
      expect(
        routeFromSpec("anthropic:claude-opus-4-8", 0, undefined, fakeM).provider
      ).toBeInstanceOf(AnthropicProvider);
      expect(routeFromSpec("openai:gpt-4o", 0, undefined, fakeM).provider).toBeInstanceOf(
        OpenAiProvider
      );
      const g = routeFromSpec("gemini:gemini-2.0-flash", 1, undefined, fakeM);
      expect(g.provider).toBeInstanceOf(GeminiProvider);
      expect(g.id).toBe("gemini:gemini-2.0-flash");
      expect(g.tier).toBe(1);
    });
  });

  it("routes a .gguf path / gemma: / local: to the local Gemma provider", () => {
    expect(routeFromSpec("./e4b.gguf", 0, undefined, fakeM).id).toContain("gemma:");
    expect(routeFromSpec("gemma:/m/e4b.gguf", 0, "12b", fakeM).id).toContain("#12b");
    expect(routeFromSpec("local:/m/e4b.gguf", 0, undefined, fakeM).id).toContain("gemma:");
  });

  it("errors clearly on a missing key or an unknown provider", () => {
    withEnv({ ANTHROPIC_API_KEY: "" }, () => {
      expect(() => routeFromSpec("anthropic:x", 0, undefined, fakeM)).toThrow(/ANTHROPIC_API_KEY/);
    });
    expect(() => routeFromSpec("cohere:x", 0, undefined, fakeM)).toThrow(/unrecognized provider/);
  });
});

// ── The reference doc is a fitness function, not prose ────────────────────────
//
// `docs/usage-cli.md` reproduces USAGE verbatim in its first fenced block. Left
// unguarded it drifts silently — a new command lands, the doc doesn't move, and
// nothing is red. Assert the two are byte-identical so adding a command forces
// the doc edit in the same change.
describe("docs/usage-cli.md", () => {
  const doc = join(__dirname, "..", "..", "..", "docs", "usage-cli.md");

  it("reproduces the CLI usage summary verbatim", () => {
    const md = readFileSync(doc, "utf8");
    const block = /```text\n([\s\S]*?)```/.exec(md);
    expect(block, "no ```text block in usage-cli.md").not.toBeNull();
    expect(block![1]).toBe(USAGE);
  });

  it("documents every command the dispatcher accepts", () => {
    const md = readFileSync(doc, "utf8");
    const commands = readFileSync(join(__dirname, "cli.ts"), "utf8")
      .split("\n")
      .flatMap((line) => /^\s{4}case "([a-z][a-z-]*)":/.exec(line)?.[1] ?? [])
      .filter((c) => c !== "help");
    // Guard against a vacuous pass: if the dispatcher is ever restructured so the
    // regex matches nothing, this loop would silently assert nothing at all.
    expect(commands.length).toBeGreaterThan(15);
    for (const command of commands) {
      expect(md, `\`loom ${command}\` undocumented`).toContain(`loom ${command}`);
    }
  });
});

// Every command in the table needs a HEADING of its own in the reference. The check above only
// proves the words "loom <cmd>" occur somewhere (a cheat-sheet row or a passing mention satisfies
// it), which is how `census`, `recover` and `branches` shipped with no section at all.
describe("docs/usage-cli.md headings", () => {
  const doc = join(__dirname, "..", "..", "..", "docs", "usage-cli.md");

  /** The `##`..`####` heading lines of a markdown source, outside fenced blocks. */
  function headings(md: string): string[] {
    const out: string[] = [];
    let fenced = false;
    for (const line of md.split("\n")) {
      if (line.trimStart().startsWith("```")) fenced = !fenced;
      else if (!fenced && /^#{2,4} /.test(line)) out.push(line);
    }
    return out;
  }

  /** The commands lacking a heading that names them as `loom <cmd>…` or a backticked `<cmd>`. */
  function undocumented(md: string): string[] {
    const hs = headings(md);
    return Object.keys(COMMANDS).filter(
      (cmd) => !hs.some((h) => new RegExp(`\`(?:loom )?${cmd}[\` ]`).test(h))
    );
  }

  it("gives every command in the command table its own ##/### section", () => {
    const md = readFileSync(doc, "utf8");
    expect(Object.keys(COMMANDS).length).toBeGreaterThan(25); // not vacuous
    expect(undocumented(md)).toEqual([]);
  });

  it("fails when a command's section is removed (the guard fires)", () => {
    const md = readFileSync(doc, "utf8");
    const without = md
      .split("\n")
      .filter((l) => !/^#{2,4} .*`(?:loom )?census[` ]/.test(l))
      .join("\n");
    expect(without).not.toBe(md);
    expect(undocumented(without)).toEqual(["census"]);
  });

  it("a bare mention in prose is not a section", () => {
    expect(undocumented("Use loom census to look.\n\n## Nothing here\n")).toContain("census");
  });
});

// ── `loom new` / `loom gen` refusals (F8) ─────────────────────────────────────
//
// A name became a path (`../evil` wrote outside app/flows), a typo'd --dir was created and
// "succeeded" with 0 flows, and a template imported a package the app never declared. Each guard
// below asserts the refusal AND that the tree is unchanged — a refusal that writes is not one.

describe("loom new / gen guards", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loom-new-guard-"));
    writeFileSync(join(root, "package.json"), appFiles("guard-app")["package.json"] as string);
    mkdirSync(join(root, "app"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const tree = (): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        out.push(relative(root, p));
        if (e.isDirectory()) walk(p);
      }
    };
    walk(root);
    return out.sort();
  };

  it("refuses names that are not kebab-case (suggesting the fix) or that escape the folder", () => {
    const before = tree();
    expect(() => cmdNew("flow", "Bad Name", join(root, "app"))).toThrow(/did you mean "bad-name"/);
    expect(() => cmdNew("flow", "PascalCase", join(root, "app"))).toThrow(/pascal-case/);
    for (const evil of ["../evil", "a/b", "..", "/etc/x", "a\\b"]) {
      expect(() => cmdNew("tool", evil, join(root, "app")), evil).toThrow(/path, not a name/);
    }
    expect(tree()).toEqual(before);
  });

  it("gen refuses a --dir that does not exist instead of creating it", () => {
    const before = tree();
    expect(() => cmdGen(join(root, "nonexist"))).toThrow(/not an existing directory/);
    expect(tree()).toEqual(before);
  });

  it("emits a sibling test for a flow, and it is not mistaken for a flow module", () => {
    const r = cmdNew("flow", "order-check", join(root, "app"));
    expect(r.extras.map((e) => e.path)).toEqual([join(root, "app/flows/order-check/flow.test.ts")]);
    const test = readFileSync(r.extras[0]!.path, "utf-8");
    expect(test).toContain('from "@loom/testing"');
    expect(test).toContain("OrderCheckFlow");
    expect(discoverFlows(join(root, "app"))).toEqual(["./flows/order-check/flow"]);
    // Re-running skips both files; nothing is overwritten.
    const again = cmdNew("flow", "order-check", join(root, "app"));
    expect([again.created, ...again.extras.map((e) => e.created)]).toEqual([false, false]);
  });

  it("audits every template's imports against the scaffolded package.json", () => {
    const kinds = [
      "flow",
      "agent",
      "tool",
      "skill",
      "schedule",
      "memory",
      "projection",
      "sentinel",
    ];
    const missing: Record<string, string[]> = {};
    for (const kind of kinds)
      missing[kind] = cmdNew(kind, `x-${kind}`, join(root, "app")).missingDeps;
    // Only the sentinel imports something a fresh app does not declare; the hint is the exact line.
    expect(missing).toEqual({
      flow: [],
      agent: [],
      tool: [],
      skill: [],
      schedule: [],
      memory: [],
      projection: [],
      sentinel: ['"@loom/plugin-sentinel": "workspace:*"'],
    });
    // It never edits package.json.
    expect(readFileSync(join(root, "package.json"), "utf-8")).toBe(
      appFiles("guard-app")["package.json"]
    );
  });

  it("uses the app's own @loom spec (a linked app gets `*`)", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { "@loom/core": "*", "@loom/workflow-runtime": "*", zod: "^3" },
      })
    );
    expect(cmdNew("sentinel", "watch", join(root, "app")).missingDeps).toEqual([
      '"@loom/middleware": "*"',
      '"@loom/plugin-sentinel": "*"',
    ]);
  });
});
