#!/usr/bin/env node
import * as fs from "node:fs";
import { SqliteEventStore } from "@loom/event-runtime";
import { cmdAppgen, renderPlan } from "./appgen";
import { cmdCheck } from "./check";
import { cmdDebug, cmdEval, cmdLogs } from "./commands";
import { cmdDeployCheck } from "./deploy";
import { cmdGen, cmdNew } from "./gen";
import { serveInspector } from "./inspector";
import { cmdIntrospect } from "./introspect";
import { cmdCompat, cmdKernelManifest } from "./kernel";
import { cmdOptimize } from "./optimize";
import { cmdProfile } from "./profile";
import { cmdVerify } from "./verify";

interface Parsed {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
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

const USAGE = `loom — project-local commands for a Loom app

  loom gen   [--dir app]                          regenerate loom.gen.ts from app/flows
  loom new   <flow|agent|tool> <name> [--dir app] scaffold a file (folder convention)
  loom appgen <intent> | --from <file> [--dir .] [--dry-run] [--check]  NL → new project or edits
                                                  (--dry-run previews; --check typechecks after apply)
  loom appgen ... --model <gguf> [--model-big <gguf>]  plan with a local Gemma model
                                                  (needs @loom/appgen-model + node-llama-cpp)
  loom appgen --from-spec <file> [--dir .]        replay a .loom/appgen/<ts>.spec.json (no model)
  loom check --manifest <path>                    static flow-graph checks (compiler manifest)
  loom verify --config <module>                   pre-flight runtime verification (@loom/verify)
  loom logs  --db <path> <executionId>            print the event timeline
  loom profile --db <path> <executionId>          flame graph + latency breakdown
  loom introspect --db <path> <executionId> [--graph N]  execution/task/decision/resource graphs
  loom optimize --db <path> <executionId>         advisory optimization report (recommendations)
  loom kernel-manifest [--json] [--emit-docs <dir>]  kernel version + maturity manifest
  loom compat --abi <v> --event-schema <v> [...]  validate a deployment's contract versions
  loom debug --db <path> <executionId> [--at N]   time-travel: state at sequence N
  loom eval  --dir <path>                         replay golden logs vs expectations
  loom deploy check --logs <dir> --config <mod>   simulate deploy vs new flow defs
  loom inspect --db <path> [--port N]             web inspector (timeline + slider)

New project?  →  npm create loom-app
`;

async function main(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);

  switch (command) {
    case "logs": {
      requireFlag(flags, "db");
      const executionId = requirePositional(positionals, "executionId");
      console.log(await cmdLogs(flags.db!, executionId));
      return 0;
    }
    case "debug": {
      requireFlag(flags, "db");
      const executionId = requirePositional(positionals, "executionId");
      const at = flags.at !== undefined ? Number.parseInt(flags.at, 10) : undefined;
      console.log(await cmdDebug(flags.db!, executionId, at));
      return 0;
    }
    case "eval": {
      requireFlag(flags, "dir");
      const { text, report } = cmdEval(flags.dir!);
      console.log(text);
      return report.ok ? 0 : 1;
    }
    case "check": {
      requireFlag(flags, "manifest");
      const { text, result } = cmdCheck(flags.manifest!);
      console.log(text);
      return result.ok ? 0 : 1;
    }
    case "verify": {
      requireFlag(flags, "config");
      const { text, result } = await cmdVerify(flags.config!);
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
      const { out, count } = cmdGen(dir);
      console.log(`wrote ${out} (${count} flow${count === 1 ? "" : "s"})`);
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
    case "appgen": {
      // For appgen, `dir` is the PROJECT ROOT (scaffold paths are already `app/…`-relative):
      // a new dir gets a full project; an existing app gets flows + surgical edits.
      const dir = flags.dir ?? ".";
      const dryRun = flags["dry-run"] === "true";
      const fromSpec = flags["from-spec"];
      const check = flags.check === "true";
      const offline = flags.offline === "true";
      // `--model <gguf>` enables the local-model planner (optional @loom/appgen-model);
      // `--model-big <gguf>` is a stronger tier to elevate to.
      const model =
        flags.model !== undefined && flags.model !== "true"
          ? {
              path: flags.model,
              ...(flags["model-big"] !== undefined && { bigPath: flags["model-big"] }),
              ...(flags["model-tier"] !== undefined && { tier: flags["model-tier"] }),
            }
          : undefined;
      // `--from-spec` carries its own intent; otherwise resolve one from args / `--from`.
      const intent = fromSpec !== undefined ? "" : resolveIntent(flags, positionals);
      const r = await cmdAppgen({
        intent,
        dir,
        dryRun,
        check,
        offline,
        ...(model !== undefined && { model }),
        ...(fromSpec !== undefined && { fromSpec }),
      });
      if (r.dryRun) {
        console.log(renderPlan(r.plan, dir));
        return 0;
      }
      const lines = [
        `appgen: ${r.specName} → ${dir}`,
        ...r.written.map((p) => `  wrote ${p}`),
        ...r.overwritten.map((p) => `  overwrote ${p}`),
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
