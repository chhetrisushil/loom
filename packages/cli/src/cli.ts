#!/usr/bin/env node
import { cmdCheck } from "./check";
import { cmdDebug, cmdEval, cmdLogs } from "./commands";
import { cmdGen, cmdNew } from "./gen";

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
  loom check --manifest <path>                    static flow-graph checks (compiler manifest)
  loom logs  --db <path> <executionId>            print the event timeline
  loom debug --db <path> <executionId> [--at N]   time-travel: state at sequence N
  loom eval  --dir <path>                         replay golden logs vs expectations

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
