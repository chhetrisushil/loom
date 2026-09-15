#!/usr/bin/env node
import * as fs from "node:fs";
import * as readline from "node:readline";
import type { FilePlan } from "@loom/appgen";
import { SqliteEventStore } from "@loom/plugin-sqlite";

import { type Elevation, type Planner, cmdAppgen, plannerTag, renderPlan } from "./appgen";
import { cmdCensus } from "./census";
import { STORE_FLAG_HELP, hasStoreFlags } from "./stores";
import { cmdCheck } from "./check";
import { cmdDebug, cmdEval, cmdLogs } from "./commands";
import { cmdComplianceReport } from "./compliance";
import { cmdDeployCheck } from "./deploy";
import { cmdDoctor } from "./doctor";
import { cmdGen, cmdNew } from "./gen";
import { serveInspector } from "./inspector";
import { cmdIntrospect } from "./introspect";
import { cmdCompat, cmdKernelManifest } from "./kernel";
import { cmdKnowledgeList, cmdKnowledgeSearch, cmdKnowledgeSync } from "./knowledge";
import { cmdLearnEval, cmdLearnReport } from "./learn";
import { cmdLintClaimCheck } from "./lintClaimCheck";
import { cmdOptimize } from "./optimize";
import { cmdPluginCheck, cmdPluginNew, cmdPluginSeams } from "./plugin";
import { cmdPluginSearch } from "./pluginSearch";
import { cmdPluginTry } from "./pluginTry";
import { cmdProfile } from "./profile";
import { cmdRetentionRun } from "./retention";
import { cmdSweepContent } from "./sweepContent";
import { cmdVerify } from "./verify";

interface Parsed {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  // No prototype: with one, `flags["valueOf"] ?? fallback` answers with a FUNCTION for a
  // flag nobody passed, and `--__proto__ x` sets a prototype instead of recording a flag.
  // Every option is read out of this bag by name, so the bag must hold only what was typed.
  const flags: Record<string, string> = Object.create(null);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

/** Parse `--redact a,b,c` into a list of output dot-paths to mask (K10-R6). */
export function parseRedact(flag: string | undefined): string[] {
  return flag === undefined || flag === "true"
    ? []
    : flag
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
}

/**
 * The usage summary — also the CLI's reference contract. `docs/usage-cli.md` reproduces this
 * block verbatim and a test asserts the two match, so a new command cannot land undocumented.
 */
export const USAGE = `loom — project-local commands for a Loom app

  loom gen   [--dir app]                          regenerate loom.gen.ts from app/flows
  loom new   <flow|agent|tool|skill|schedule|memory|projection|sentinel> <name> [--dir app] scaffold a file
  loom plugin new <seam> <name> [--first-party] [--dir .]  scaffold a plugin package
  loom plugin check [--dir .] [--publish]         validate a plugin (--publish adds npm-readiness)
  loom plugin try --module <path> [--preset <name>] [--options <json>]  run a store plugin end-to-end
  loom plugin search <term>                       find plugins on npm (keyword loom-plugin)
  loom plugin seams                               list the seams a plugin can target
  loom appgen <intent> | --from <file> [--dir .] [--dry-run] [--check]  NL → new project or edits
                                                  (--dry-run previews; --check typechecks after apply)
  loom appgen ... --model <spec> [--model-big <spec>]  plan with a model of your choice
                                                  (anthropic:<m> / openai:<m> / gemini:<m> / a .gguf path)
  loom appgen --from-spec <file> [--dir .]        replay a .loom/appgen/<ts>.spec.json (no model)
  loom doctor [--dir .] [--config <module>] [--manifest <path>]  run every pre-flight check that
                                                  can run, and report which ones could NOT
  loom check --manifest <path>                    static flow-graph checks (compiler manifest)
  loom lint claim-check [--dir .]                 CC-5: flag claim-check reach-through inside flows
  loom verify --config <module> [--manifest <path>]  pre-flight runtime verification (@loom/verify)
                                                  (auto-reads loom-manifest.json loopIdentity findings, ADR 0061)
  loom logs  --db <path> <executionId> [--redact a,b]   print the event timeline
  loom profile --db <path> <executionId>          flame graph + latency breakdown
  loom introspect --db <path> <executionId> [--graph N]  execution/task/decision/resource graphs
  loom optimize --db <path> <executionId>         advisory optimization report (recommendations)
  loom learn report --db <path> [executionId]     trajectories, per-arm rewards, learning coverage
  loom learn eval --db <path> --policy <module> [--min-steps N] [executionId]
                                                  shadow-evaluate a candidate policy on real logs
  loom knowledge sync --config <mod> --scope <s> --dir <path> [--ext md,txt] [--source <s>] [--apply]
                                                  reconcile a directory into a corpus
                                                  (dry run by default; --apply also REMOVES
                                                   documents the directory no longer has —
                                                   but never another writer's, see --source)
  loom knowledge list --config <mod> --scope <s>  what the corpus holds
  loom knowledge search --config <mod> --scope <s> "<query>" [--limit N]
                                                  ask the corpus (operator query — not recorded)
  loom kernel-manifest [--json] [--emit-docs <dir>]  kernel version + maturity manifest
  loom compat --abi <v> --event-schema <v> [...]  validate a deployment's contract versions
  loom debug --db <path> <executionId> [--at N] [--redact a,b]   time-travel: state at sequence N
  loom eval  --dir <path>                         replay golden logs vs expectations
  loom deploy check --logs <dir> --config <mod>   simulate deploy vs new flow defs
  loom census --db <path> [--snap <path>] [--leases <path>] [--buckets 5m,1h,6h,24h]
                                                  what is stuck, and is anything watching it
                                                  (read-only; takes no predicate)
  loom retention run --db <path> --snap <path> [--branches <path>] [--ttl ms] [--apply]
                                                  reclaim aged terminal executions
                                                  (--branches enables the live-descendant
                                                   guard; without it a parent with live
                                                   branches is NOT protected)
  loom sweep content --db <path> --content <path> [--archive-db <path>] [--pin KIND,KIND] [--ttl ms] [--apply]  K10.6 pinned blob sweep
  loom compliance report --db <path> --subject-path <p> [--tenant-path <p>]  data-subject inventory
  loom inspect --db <path> [--port N]             web inspector (timeline + slider)

New project?  →  npm create loom-app
`;

async function main(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);

  switch (command) {
    case "logs": {
      requireFlag(flags, "db");
      const executionId = requirePositional(positionals, "executionId");
      console.log(await cmdLogs(flags.db!, executionId, parseRedact(flags.redact)));
      return 0;
    }
    case "debug": {
      requireFlag(flags, "db");
      const executionId = requirePositional(positionals, "executionId");
      const at = flags.at !== undefined ? Number.parseInt(flags.at, 10) : undefined;
      console.log(await cmdDebug(flags.db!, executionId, at, parseRedact(flags.redact)));
      return 0;
    }
    case "census": {
      if (!hasStoreFlags(flags)) {
        console.error(`loom census: ${STORE_FLAG_HELP}`);
        return 1;
      }
      console.log(
        await cmdCensus({
          ...(flags.config !== undefined && { config: flags.config }),
          ...(flags.db !== undefined && { db: flags.db }),
          ...(flags.snap !== undefined && { snap: flags.snap }),
          ...(flags.leases !== undefined && { leases: flags.leases }),
          ...(flags.buckets !== undefined && { buckets: flags.buckets }),
          ...(flags.sample !== undefined && { sampleSize: Number(flags.sample) }),
        })
      );
      return 0;
    }

    case "retention": {
      requirePositional(positionals, "run"); // `loom retention run`
      if (!hasStoreFlags(flags)) {
        console.error(`loom retention: ${STORE_FLAG_HELP}`);
        return 1;
      }
      const ttl = flags.ttl !== undefined ? Number.parseInt(flags.ttl, 10) : 0;
      console.log(
        await cmdRetentionRun({
          ...(flags.config !== undefined && { config: flags.config }),
          ...(flags.db !== undefined && { db: flags.db }),
          ...(flags.snap !== undefined && { snap: flags.snap }),
          ...(flags.branches !== undefined && { branches: flags.branches }),
          ttlMs: ttl,
          apply: flags.apply === "true",
        })
      );
      return 0;
    }
    case "sweep": {
      requirePositional(positionals, "content"); // `loom sweep content`
      requireFlag(flags, "db");
      requireFlag(flags, "content");
      const ttl = flags.ttl !== undefined ? Number.parseInt(flags.ttl, 10) : 30 * 24 * 3_600_000;
      console.log(
        await cmdSweepContent({
          db: flags.db!,
          content: flags.content!,
          ...(flags["archive-db"] !== undefined && { archiveDb: flags["archive-db"] }),
          ...(flags.pin !== undefined && { pin: flags.pin }),
          ttlMs: ttl,
          apply: flags.apply === "true",
        })
      );
      return 0;
    }
    case "compliance": {
      requirePositional(positionals, "report"); // `loom compliance report`
      requireFlag(flags, "db");
      requireFlag(flags, "subject-path");
      console.log(
        await cmdComplianceReport(flags.db!, flags["subject-path"]!, flags["tenant-path"])
      );
      return 0;
    }
    case "eval": {
      requireFlag(flags, "dir");
      const { text, report } = cmdEval(flags.dir!);
      console.log(text);
      return report.ok ? 0 : 1;
    }
    case "lint": {
      requirePositional(positionals, "claim-check"); // `loom lint claim-check`
      const { text, findings } = cmdLintClaimCheck(flags.dir ?? ".");
      console.log(text);
      return findings.length === 0 ? 0 : 1;
    }
    case "check": {
      requireFlag(flags, "manifest");
      const { text, result } = cmdCheck(flags.manifest!);
      console.log(text);
      return result.ok ? 0 : 1;
    }
    case "doctor": {
      const { text, result } = await cmdDoctor({
        ...(flags.dir !== undefined && { dir: flags.dir }),
        ...(flags.config !== undefined && { config: flags.config }),
        ...(flags.manifest !== undefined && { manifest: flags.manifest }),
      });
      console.log(text);
      return result.ok ? 0 : 1;
    }
    case "verify": {
      requireFlag(flags, "config");
      const { text, result } = await cmdVerify(flags.config!, flags.manifest);
      console.log(text);
      return result.ok ? 0 : 1;
    }
    case "profile": {
      requireFlag(flags, "db");
      const executionId = requirePositional(positionals, "executionId");
      console.log(await cmdProfile(flags.db!, executionId));
      return 0;
    }
    case "introspect": {
      requireFlag(flags, "db");
      const executionId = requirePositional(positionals, "executionId");
      console.log(await cmdIntrospect(flags.db!, executionId, flags.graph));
      return 0;
    }
    case "optimize": {
      requireFlag(flags, "db");
      const executionId = requirePositional(positionals, "executionId");
      console.log(await cmdOptimize(flags.db!, executionId));
      return 0;
    }
    case "learn": {
      const sub = requirePositional(positionals, "report|eval");
      requireFlag(flags, "db");
      if (sub === "report") {
        console.log(await cmdLearnReport(flags.db!, positionals[1]));
        return 0;
      }
      if (sub === "eval") {
        requireFlag(flags, "policy");
        const { text, ok } = await cmdLearnEval(flags.db!, flags.policy!, {
          ...(positionals[1] !== undefined && { executionId: positionals[1] }),
          ...(flags["min-steps"] !== undefined && {
            minSteps: Number.parseInt(flags["min-steps"], 10),
          }),
        });
        console.log(text);
        return ok ? 0 : 1;
      }
      console.error(`unknown subcommand "learn ${sub}" — expected report|eval`);
      return 2;
    }
    case "knowledge": {
      const sub = requirePositional(positionals, "sync | list | search");
      requireFlag(flags, "config");
      requireFlag(flags, "scope");
      if (sub === "sync") {
        requireFlag(flags, "dir");
        const { text } = await cmdKnowledgeSync({
          config: flags.config!,
          scope: flags.scope!,
          dir: flags.dir!,
          ...(flags.ext !== undefined &&
            flags.ext !== "true" && { extensions: flags.ext.split(",").map((e) => e.trim()) }),
          ...(flags["max-bytes"] !== undefined && {
            maxBytes: Number.parseInt(flags["max-bytes"], 10),
          }),
          ...(flags.source !== undefined && flags.source !== "true" && { source: flags.source }),
          apply: flags.apply === "true",
        });
        console.log(text);
        return 0;
      }
      if (sub === "list") {
        console.log((await cmdKnowledgeList({ config: flags.config!, scope: flags.scope! })).text);
        return 0;
      }
      if (sub === "search") {
        const query = positionals[1];
        if (query === undefined || query.length === 0) {
          throw new Error(
            'knowledge search: pass the query as a positional — loom knowledge search --config <mod> --scope <s> "replica lag"'
          );
        }
        const { text } = await cmdKnowledgeSearch({
          config: flags.config!,
          scope: flags.scope!,
          query,
          ...(flags.limit !== undefined && { limit: Number.parseInt(flags.limit, 10) }),
        });
        console.log(text);
        return 0;
      }
      throw new Error(`unknown subcommand "${sub}" — expected sync | list | search`);
    }
    case "kernel-manifest": {
      console.log(
        cmdKernelManifest({
          json: flags.json === "true",
          ...(flags["emit-docs"] !== undefined && { emitDocs: flags["emit-docs"] }),
        })
      );
      return 0;
    }
    case "compat": {
      const { text, ok } = cmdCompat(flags);
      console.log(text);
      return ok ? 0 : 1;
    }
    case "gen": {
      const dir = flags.dir ?? "app";
      const { out, flows, agents, tools, skills, schedules, memories, projections } = cmdGen(dir);
      const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
      const parts = [
        plural(flows, "flow"),
        plural(agents, "agent"),
        plural(tools, "tool"),
        plural(skills, "skill"),
        plural(schedules, "schedule"),
        plural(memories, "memory").replace("memorys", "memories"),
        plural(projections, "projection"),
      ];
      console.log(`wrote ${out} (${parts.join(", ")})`);
      return 0;
    }
    case "new": {
      const kind = requirePositional(positionals, "kind");
      const name = positionals[1];
      if (name === undefined) throw new Error("missing required <name>");
      const dir = flags.dir ?? "app";
      const { path: dest, created } = cmdNew(kind, name, dir);
      console.log(created ? `created ${dest}` : `skipped ${dest} (already exists)`);
      return created ? 0 : 1;
    }
    case "plugin": {
      const sub = positionals[0];
      if (sub === "seams") {
        console.log(cmdPluginSeams());
        return 0;
      }
      if (sub === "try") {
        requireFlag(flags, "module");
        const r = await cmdPluginTry({
          module: flags.module!,
          ...(flags.preset !== undefined && { preset: flags.preset }),
          ...(flags.options !== undefined && { options: flags.options }),
        });
        const mark = (ok: boolean, msg: string) => `  ${ok ? "✓" : "✗"} ${msg}`;
        console.log(mark(r.completed, `smoke flow completed (preset ${r.preset})`));
        console.log(mark(r.eventsPersisted > 0, `persisted ${r.eventsPersisted} events`));
        console.log(mark(r.replayOk, "replays from the durable store"));
        console.log(`\nplugin try: ${r.ok ? "passed" : "FAILED"}`);
        return r.ok ? 0 : 1;
      }
      if (sub === "search") {
        const term = positionals.slice(1).join(" ");
        console.log(await cmdPluginSearch(term));
        return 0;
      }
      if (sub === "check") {
        const dir = flags.dir ?? positionals[1] ?? ".";
        const { findings, ok } = cmdPluginCheck(dir, { publish: flags.publish === "true" });
        const glyph = { ok: "✓", warn: "⚠", error: "✗" } as const;
        for (const f of findings) console.log(`  ${glyph[f.level]} ${f.message}`);
        const errors = findings.filter((f) => f.level === "error").length;
        const warns = findings.filter((f) => f.level === "warn").length;
        console.log(`\nplugin check: ${ok ? "passed" : "FAILED"} (${errors} error, ${warns} warn)`);
        return ok ? 0 : 1;
      }
      if (sub === "new") {
        const seam = positionals[1];
        const name = positionals[2];
        if (seam === undefined || name === undefined) {
          throw new Error("usage: loom plugin new <seam> <name> [--first-party] [--dir .]");
        }
        const firstParty = flags["first-party"] === "true" || flags["1p"] === "true";
        const dir = flags.dir ?? ".";
        const { dir: root, written, skipped } = cmdPluginNew(seam, name, { firstParty, dir });
        const lines = [
          `plugin: ${firstParty ? "@loom/plugin-" : "loom-plugin-"}${name} (${seam}) → ${root}`,
          ...written.map((p) => `  created ${p}`),
          ...skipped.map((p) => `  skipped ${p} (already exists)`),
        ];
        if (written.length > 0) {
          lines.push(
            "",
            `next: implement the SPI in ${root}/src/index.ts, un-comment the conformance`,
            "      test, and run your formatter (e.g. biome/prettier) to tidy the scaffold."
          );
        }
        console.log(lines.join("\n"));
        return written.length > 0 ? 0 : 1;
      }
      throw new Error("usage: loom plugin <new|check|try|search|seams> … (see `loom help`)");
    }
    case "appgen": {
      // For appgen, `dir` is the PROJECT ROOT (scaffold paths are already `app/…`-relative):
      // a new dir gets a full project; an existing app gets flows + surgical edits.
      const dir = flags.dir ?? ".";
      const dryRun = flags["dry-run"] === "true";
      const fromSpec = flags["from-spec"];
      const check = flags.check === "true";
      const offline = flags.offline === "true";
      // `--model <spec>` plans with a model of your choice: anthropic:<model> / openai:<model>
      // / gemini:<model> (API key from env), or a local .gguf path (optional @loom/appgen-model).
      // `--model-big <spec>` is a stronger tier the reasoning ladder elevates to.
      const model =
        flags.model !== undefined && flags.model !== "true"
          ? {
              spec: flags.model,
              ...(flags["model-big"] !== undefined && { bigSpec: flags["model-big"] }),
              ...(flags["model-tier"] !== undefined && { tier: flags["model-tier"] }),
            }
          : undefined;
      // `--from-spec` carries its own intent; otherwise resolve one from args / `--from`.
      const intent = fromSpec !== undefined ? "" : resolveIntent(flags, positionals);
      // On a TTY (and not `--yes`/`--dry-run`), show the plan and ask before writing.
      const interactive = flags.yes !== "true" && !dryRun && process.stdin.isTTY === true;
      const r = await cmdAppgen({
        intent,
        dir,
        dryRun,
        check,
        offline,
        ...(model !== undefined && { model }),
        ...(fromSpec !== undefined && { fromSpec }),
        ...(interactive && {
          confirm: (plan, planner, elevations) => confirmPlan(plan, dir, planner, elevations),
        }),
      });
      if (r.dryRun) {
        console.log(
          renderPlan(r.plan, dir, {
            planner: r.planner,
            ...(r.elevations && { elevations: r.elevations }),
          })
        );
        return 0;
      }
      if (r.aborted) {
        console.log("appgen: aborted — nothing written");
        return 0;
      }
      const lines = [
        `appgen: ${r.specName} → ${dir} ${plannerTag(r.planner, r.elevations)}`,
        ...r.written.map((p) => `  wrote ${p}`),
        ...r.overwritten.map((p) => `  overwrote ${p}`),
        ...r.deleted.map((p) => `  deleted ${p}`),
        ...r.skipped.map((p) => `  skipped ${p}`),
      ];
      if (r.lockfile !== undefined) lines.push(`  spec  ${r.lockfile}`);
      if (r.typecheck !== undefined && !r.typecheck.skipped) {
        lines.push(
          r.typecheck.ok
            ? "  check ✓ typecheck clean"
            : `  check ✗ ${r.typecheck.diagnostics.length} error(s):`
        );
        for (const d of r.typecheck.diagnostics) {
          lines.push(`    ${d.file ?? "?"}:${d.line ?? "?"} ${d.message}`);
        }
      }
      console.log(lines.join("\n"));
      return r.typecheck !== undefined && !r.typecheck.ok ? 1 : 0;
    }
    case "deploy": {
      if (positionals[0] !== "check") {
        throw new Error("usage: loom deploy check --logs <dir> --config <module>");
      }
      requireFlag(flags, "logs");
      requireFlag(flags, "config");
      const { text, report } = cmdDeployCheck(flags.logs!, flags.config!);
      console.log(text);
      return report.ok ? 0 : 1;
    }
    case "inspect":
    case "dev": {
      requireFlag(flags, "db");
      const store = new SqliteEventStore(flags.db!);
      const server = serveInspector(
        store,
        flags.port !== undefined ? { port: Number.parseInt(flags.port, 10) } : {}
      );
      await server.start();
      console.log(`loom inspector on ${server.url}  (Ctrl-C to stop)`);
      // Graceful shutdown: on Ctrl-C, stop the server and close the DB handle instead
      // of letting the process die with them open.
      const shutdown = () => {
        void server.stop().then(() => store.close());
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      return 0; // the listening socket keeps the process alive
    }
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

/**
 * Resolve the `appgen` intent from a `--from <file>` flag or the joined positional words.
 * `--from` takes precedence; an empty result is an error. Extracted from the dispatcher so
 * the source selection and empty guard are unit-testable without invoking `main`.
 */
export function resolveIntent(flags: Record<string, string>, positionals: string[]): string {
  const intent =
    flags.from !== undefined ? fs.readFileSync(flags.from, "utf8") : positionals.join(" ");
  if (intent.trim() === "") {
    throw new Error("provide an intent string or --from <file>");
  }
  return intent;
}

/** Show the plan (with diffs) and ask whether to apply it. Used only on a TTY. */
function confirmPlan(
  plan: FilePlan,
  dir: string,
  planner: Planner,
  elevations?: Elevation[]
): Promise<boolean> {
  console.log(renderPlan(plan, dir, { planner, ...(elevations && { elevations }) }));
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\nApply these changes? [y/N] ", (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function requireFlag(flags: Record<string, string>, name: string): void {
  if (flags[name] === undefined) {
    throw new Error(`missing required --${name}`);
  }
}
function requirePositional(positionals: string[], name: string): string {
  const value = positionals[0];
  if (value === undefined) throw new Error(`missing required <${name}>`);
  return value;
}

// Run only as a CLI, not when imported by tests.
if (process.argv[1]?.endsWith("cli.js")) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(String(err instanceof Error ? err.message : err));
      process.exitCode = 1;
    });
}
