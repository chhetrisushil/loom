#!/usr/bin/env node
import { cmdDebug, cmdEval, cmdLogs } from "./commands";

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

const USAGE = `loom — project-local commands over the durable event log

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
