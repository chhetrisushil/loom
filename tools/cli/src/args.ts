import { parseArgs as nodeParseArgs } from "node:util";
import { parseDuration } from "./duration";

// ── The command-line grammar: a data-only flag table + a strict parser ─────────
//
// Every command declares the flags it accepts and what kind each is. That is what makes the
// parser safe: a boolean flag never swallows the positional after it (`repair terminal-event
// --apply <id>`), an unknown flag is an error rather than a silently-ignored typo (`--aply`
// would otherwise run the DRY-RUN path of a destructive command), and a number is validated
// where it is typed, not three layers down as NaN.
//
// The table is plain data on purpose: per-command `--help` and shell completion read it too.

/** What a flag's value must look like. `boolean` flags take no value. */
export type FlagKind = "boolean" | "string" | "int" | "duration";

export interface CommandSpec {
  /** One line: what the command does (shown by `loom help <cmd>` and in shell completion). */
  summary: string;
  /** Synopsis lines, one invocation each (shown by `loom <cmd> --help`). */
  usage: readonly string[];
  /** flag name (no leading dashes) → kind */
  flags: Readonly<Record<string, FlagKind>>;
  /** First positional words that select a mode, e.g. `plugin new|check|…` (for completion). */
  subcommands?: readonly string[];
  /**
   * Positionals beyond this many are free text (an intent, a search query), so a later
   * `--help` / `-h` is a literal word, not a request for help. Absent: help anywhere.
   */
  literalAfter?: number;
  /** One-letter aliases → the long flag they stand for (`{ v: "verbose" }` makes `-v` work). */
  short?: Readonly<Record<string, string>>;
}

/** Exit code 2: bad usage or a refusal. Exit 1 is reserved for a failed verdict / runtime error. */
export const EXIT_USAGE = 2;

/** An error that carries the exit code the CLI should end with. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Bad arguments or a refused invocation (exit 2). */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT_USAGE);
    this.name = "UsageError";
  }
}

/** Where a storage-backed command reads from (see stores.ts). */
const STORE = {
  config: "string",
  db: "string",
  snap: "string",
  branches: "string",
  leases: "string",
  // Prints the stack of a failed config load (also `LOOM_DEBUG=1`); `logs` reads it as detail.
  verbose: "boolean",
} as const satisfies Record<string, FlagKind>;

const LIFECYCLE = {
  ...STORE,
  as: "string",
  tenant: "string",
  apply: "boolean",
  redact: "string",
  json: "boolean",
} as const satisfies Record<string, FlagKind>;

const inspector: CommandSpec = {
  summary: "web inspector (timeline + slider) over a store",
  usage: ["loom inspect <store-flags> [--port N]"],
  flags: { ...STORE, port: "int" },
};

/** The spec for `name`, or undefined — own keys only (`toString`, `__proto__` are not commands). */
export function specOf(name: string | undefined): CommandSpec | undefined {
  return name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
}

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  ls: {
    summary: "list executions: status, last activity, what each suspended one waits on (read-only)",
    usage: [
      "loom ls <store-flags> [--status running|suspended|failed|completed|cancelled] [--workflow <id>] [--since <dur>] [--limit N] [--keys] [--json]",
    ],
    flags: {
      ...STORE,
      keys: "boolean",
      status: "string",
      workflow: "string",
      since: "duration",
      limit: "int",
      json: "boolean",
    },
  },
  logs: {
    summary: "print an execution's event timeline (--follow tails it; --json: one event per line)",
    usage: [
      "loom logs <store-flags> <executionId> [--redact a,b] [--json] [-v] [--type A,B] [--from N] [--to N]",
      "loom logs <store-flags> <executionId> --follow [--interval <dur>] [--redact a,b] [--json]",
    ],
    flags: {
      ...STORE,
      redact: "string",
      json: "boolean",
      follow: "boolean",
      interval: "duration",
      type: "string",
      from: "int",
      to: "int",
    },
    short: { v: "verbose" },
  },
  debug: {
    summary: "time-travel: the folded state of an execution at sequence N",
    usage: ["loom debug <store-flags> <executionId> [--at N] [--redact a,b] [--json]"],
    flags: { ...STORE, at: "int", redact: "string", json: "boolean" },
  },
  resume: {
    summary:
      "answer a suspended execution's gate through your app's runtime (dry run unless --apply)",
    usage: [
      "loom resume <executionId> --config <module> --as <principal> [--tenant <t>] --event <type> (--payload <json> | --payload-file <path>) [--wait-id <id>] [--show-payload] [--redact a,b] [--force] [--allow-local-controls] [--skip-effect-check] [--apply] [--json]",
    ],
    flags: {
      ...LIFECYCLE,
      event: "string",
      payload: "string",
      "payload-file": "string",
      "show-payload": "boolean",
      "wait-id": "string",
      force: "boolean",
      "allow-local-controls": "boolean",
      "skip-effect-check": "boolean",
    },
  },
  cancel: {
    summary: "cancel an execution through your app's runtime (dry run unless --apply)",
    usage: [
      "loom cancel <executionId> --config <module> --as <principal> [--tenant <t>] [--reason <text>] [--redact a,b] [--force] [--apply] [--json]",
    ],
    flags: { ...LIFECYCLE, reason: "string", force: "boolean" },
  },
  start: {
    summary: "start a flow through your app's runtime (dry run unless --apply)",
    usage: [
      "loom start <flowId> --config <module> --as <principal> [--tenant <t>] (--input <json> | --input-file <path>) [--id <executionId> | --idempotency-key <k>] [--show-payload] [--redact a,b] [--allow-local-controls] [--skip-effect-check] [--apply] [--json]",
    ],
    flags: {
      ...LIFECYCLE,
      input: "string",
      "input-file": "string",
      id: "string",
      "idempotency-key": "string",
      "show-payload": "boolean",
      "allow-local-controls": "boolean",
      "skip-effect-check": "boolean",
    },
  },
  recover: {
    summary: "re-drive executions whose supervisor died (dry run unless --apply)",
    usage: [
      "loom recover <store-flags> (--stale 15m | --config <module> with timers.leases) [--owner <id>] [--limit N] [--max-recoveries N] [--apply]",
    ],
    flags: {
      ...STORE,
      stale: "duration",
      owner: "string",
      limit: "int",
      "max-recoveries": "int",
      apply: "boolean",
    },
  },
  branches: {
    summary: "retire or prune execution branches (dry run unless --apply)",
    usage: [
      "loom branches retire <store-flags> (--branches <b.db> | --config <module>) --parent <id> --stale <d> [--limit N] [--apply]",
      "loom branches prune <store-flags> (--branches <b.db> | --config <module>) [--protect main,rel] [--limit N] [--apply]",
    ],
    subcommands: ["retire", "prune"],
    flags: {
      ...STORE,
      limit: "int",
      apply: "boolean",
      parent: "string",
      stale: "duration",
      protect: "string",
    },
  },
  census: {
    summary: "what is stuck, and is anything watching it (read-only)",
    usage: ["loom census <store-flags> [--buckets 5m,1h,6h,24h] [--sample N] [--json]"],
    flags: { ...STORE, buckets: "string", sample: "int", json: "boolean" },
  },
  repair: {
    summary: "repair known log damage (dry run unless --apply)",
    usage: [
      "loom repair blank-stream <store-flags> (--snap <s.db> | --config <module>) [--assign <id>:<from>-<through>,…] [--apply]",
      "loom repair terminal-event <store-flags> (--snap <s.db> | --config <module>) [executionId] [--apply] [--force]",
    ],
    subcommands: ["blank-stream", "terminal-event"],
    flags: { ...STORE, apply: "boolean", force: "boolean", assign: "string" },
  },
  retention: {
    summary: "reclaim aged terminal executions (needs --ttl; dry run unless --apply)",
    usage: ["loom retention run <store-flags> --ttl <dur|ms> [--apply]"],
    subcommands: ["run"],
    flags: { ...STORE, ttl: "duration", apply: "boolean" },
  },
  sweep: {
    summary: "pinned blob sweep over content stores (dry run unless --apply)",
    usage: [
      "loom sweep content <store-flags> --content <path> [--archive-db <path> [--archive-snap <path>]] [--pin KIND,KIND] [--ttl ms] [--compaction-archive <archive.db> | --no-compaction-archive] [--acknowledge-unarchived] [--orphans [--no-archive] [--snapshots-touch-content]] [--apply]",
    ],
    subcommands: ["content"],
    flags: {
      ...STORE,
      content: "string",
      "archive-db": "string",
      "archive-snap": "string",
      "compaction-archive": "string",
      "no-compaction-archive": "boolean",
      "acknowledge-unarchived": "boolean",
      pin: "string",
      ttl: "duration",
      apply: "boolean",
      orphans: "boolean",
      "no-archive": "boolean",
      "snapshots-touch-content": "boolean",
    },
  },
  compliance: {
    summary: "data-subject inventory over a store",
    usage: ["loom compliance report <store-flags> --subject-path <p> [--tenant-path <p>]"],
    subcommands: ["report"],
    flags: { ...STORE, "subject-path": "string", "tenant-path": "string" },
  },
  eval: {
    summary: "replay golden logs against expectations (CI gate)",
    usage: ["loom eval --dir <path> [--json]"],
    flags: { dir: "string", json: "boolean" },
  },
  lint: {
    summary: "CC-5: flag claim-check reach-through inside flows",
    usage: ["loom lint claim-check [--dir .] [--json]"],
    subcommands: ["claim-check"],
    flags: { dir: "string", json: "boolean" },
  },
  check: {
    summary: "static flow-graph checks over the compiler manifest",
    usage: ["loom check --manifest <path> [--json]"],
    flags: { manifest: "string", json: "boolean" },
  },
  doctor: {
    summary: "run every pre-flight check that can run, and report which could not",
    usage: [
      "loom doctor [--dir .] [--config <module>] [--manifest <path>] [--strict] [--require <check,check>] [--json]",
      "  --strict    every check that could not run becomes a failure (exit 1)",
      "  --require   the named checks must have run; ids: flow-graph, verify, memory-store, timers, timer-ownership, heartbeat-leases, encryption-keys, plaintext-snapshot, archive-snapshot, claim-check",
    ],
    flags: {
      dir: "string",
      config: "string",
      manifest: "string",
      strict: "boolean",
      require: "string",
      json: "boolean",
    },
  },
  "migrate-config": {
    summary:
      "rewrite flat defineConfig options into their groups (dry run unless --apply; never runs the config)",
    usage: ["loom migrate-config [<file>...] [--config <file>] [--apply] [--json]"],
    flags: { config: "string", apply: "boolean", json: "boolean" },
  },
  verify: {
    summary: "pre-flight runtime verification (@loom/verify)",
    usage: ["loom verify --config <module> [--manifest <path>] [--json]"],
    flags: { config: "string", manifest: "string", json: "boolean" },
  },
  profile: {
    summary: "flame graph + latency breakdown of an execution",
    usage: ["loom profile <store-flags> <executionId> [--json]"],
    flags: { ...STORE, json: "boolean" },
  },
  introspect: {
    summary: "execution/task/decision/resource graphs of an execution",
    usage: ["loom introspect <store-flags> <executionId> [--graph N] [--json]"],
    flags: { ...STORE, graph: "string", json: "boolean" },
  },
  optimize: {
    summary: "advisory optimization report (recommendations) for an execution",
    usage: ["loom optimize <store-flags> <executionId>"],
    flags: { ...STORE },
  },
  snapshot: {
    summary: "print a stored snapshot, decoded (zstd frame or JSON)",
    usage: ["loom snapshot show <store-flags> <executionId> [--at SEQ] [--redact a,b]"],
    subcommands: ["show"],
    flags: { ...STORE, at: "int", redact: "string" },
  },
  learn: {
    summary: "learning coverage report; shadow-evaluate a candidate policy on real logs",
    usage: [
      "loom learn report <store-flags> [executionId]",
      "loom learn eval <store-flags> --policy <module> [--min-steps N] [executionId]",
    ],
    subcommands: ["report", "eval"],
    flags: { ...STORE, policy: "string", "min-steps": "int" },
  },
  knowledge: {
    summary: "reconcile, list and search a knowledge corpus",
    usage: [
      "loom knowledge sync --config <mod> --scope <s> --dir <path> [--ext md,txt] [--source <s>] [--max-bytes N] [--apply]",
      "loom knowledge list --config <mod> --scope <s>",
      'loom knowledge search --config <mod> --scope <s> "<query>" [--limit N]',
    ],
    subcommands: ["sync", "list", "search"],
    literalAfter: 1,
    flags: {
      config: "string",
      scope: "string",
      dir: "string",
      ext: "string",
      "max-bytes": "int",
      source: "string",
      apply: "boolean",
      limit: "int",
    },
  },
  "kernel-manifest": {
    summary: "kernel version + maturity manifest",
    usage: ["loom kernel-manifest [--json] [--emit-docs <dir>]"],
    flags: { json: "boolean", "emit-docs": "string" },
  },
  compat: {
    summary: "validate a deployment's declared contract versions against this kernel",
    usage: [
      "loom compat --abi <v> --event-schema <v> [--wire <v>] [--event-store-spi <v>] [--snapshot-store-spi <v>] [--branch-registry-spi <v>] [--dispatcher-spi <v>] [--compiler-manifest <v>] [--json]",
    ],
    flags: {
      abi: "string",
      "event-schema": "string",
      wire: "string",
      "event-store-spi": "string",
      "snapshot-store-spi": "string",
      "branch-registry-spi": "string",
      "dispatcher-spi": "string",
      "compiler-manifest": "string",
      json: "boolean",
    },
  },
  gen: {
    summary: "regenerate loom.gen.ts from app/flows (--watch keeps it current)",
    usage: ["loom gen [--dir app] [--watch]"],
    flags: { dir: "string", watch: "boolean" },
  },
  new: {
    summary: "scaffold a flow, agent, tool, skill, schedule, memory, projection or sentinel",
    usage: [
      "loom new <flow|agent|tool|skill|schedule|memory|projection|sentinel> <name> [--dir app] [--no-gen]",
      "loom new flow <name> --template echo|approval|timer|saga [--dir app] [--no-gen]",
    ],
    flags: { dir: "string", template: "string", "no-gen": "boolean" },
  },
  plugin: {
    summary: "scaffold, validate, try and search plugins",
    usage: [
      "loom plugin new <seam> <name> [--first-party | --1p] [--dir .]",
      "loom plugin check [--dir .] [--publish]",
      "loom plugin try --module <path> [--preset <name>] [--options <json>] [--verbose]",
      "loom plugin search <term>",
      "loom plugin seams",
    ],
    subcommands: ["new", "check", "try", "search", "seams"],
    flags: {
      dir: "string",
      publish: "boolean",
      "first-party": "boolean",
      "1p": "boolean",
      module: "string",
      preset: "string",
      options: "string",
      // The stack of a module that will not load (`plugin try`); also `LOOM_DEBUG=1`.
      verbose: "boolean",
    },
    short: { v: "verbose" },
  },
  appgen: {
    summary: "natural language to a new project or edits (dry run with --dry-run)",
    literalAfter: 0,
    usage: [
      "loom appgen <intent> | --from <file> [--dir .] [--dry-run] [--check] [--yes] [--offline]",
      "loom appgen ... --model <spec> [--model-big <spec>] [--model-tier <tier>]",
      "loom appgen --from-spec <file> [--dir .]",
    ],
    flags: {
      dir: "string",
      "dry-run": "boolean",
      from: "string",
      "from-spec": "string",
      check: "boolean",
      offline: "boolean",
      model: "string",
      "model-big": "string",
      "model-tier": "string",
      yes: "boolean",
    },
  },
  deploy: {
    summary: "simulate a deploy against new flow definitions",
    usage: ["loom deploy check --logs <dir> --config <module>"],
    subcommands: ["check"],
    flags: { logs: "string", config: "string" },
  },
  inspect: inspector,
  dev: {
    summary: "dev loop: gen --watch + run the app (restart on change) + the inspector",
    usage: ["loom dev --config <module> [--dir app] [--run <command>] [--port N] [--verbose]"],
    flags: { config: "string", dir: "string", run: "string", port: "int", verbose: "boolean" },
  },
  help: {
    summary: "show the usage of every command, or of one",
    usage: ["loom help [command]"],
    flags: {},
  },
  version: {
    summary: "print the @loom/cli version",
    usage: ["loom version", "loom --version"],
    flags: {},
  },
  completion: {
    summary: "print a shell completion script",
    usage: ["loom completion <zsh|bash|fish>"],
    subcommands: ["zsh", "bash", "fish"],
    flags: {},
  },
};

export interface Parsed {
  command: string | undefined;
  positionals: string[];
  /** Booleans are recorded as the string "true"; values as typed. Prototype-free. */
  flags: Record<string, string>;
}

/** Levenshtein distance — small, for did-you-mean on a handful of flag names. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** The closest candidate within a small edit distance, if any. */
export function suggest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = editDistance(name, c);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

function validate(command: string, name: string, kind: FlagKind, value: string): void {
  if (kind === "int" && !/^\d+$/.test(value)) {
    throw new UsageError(
      `loom ${command}: --${name} expects a non-negative integer, got "${value}"`
    );
  }
  if (kind === "duration") {
    try {
      parseDuration(value);
    } catch {
      throw new UsageError(
        `loom ${command}: --${name} expects a duration (30s, 5m, 6h, 2d, or milliseconds), got "${value}"`
      );
    }
  }
}

/**
 * Parse `argv` (command first) against the command's flag table. Throws {@link UsageError}
 * for an unknown flag (with a did-you-mean), a flag missing its value, a value given to a
 * boolean, or a malformed number / duration. Supports `--flag value`, `--flag=value` and `--`.
 * An unknown COMMAND parses loosely — the dispatcher reports it.
 */
export function parseArgs(argv: string[]): Parsed {
  const [command, ...restRaw] = argv;
  const spec = specOf(command);
  // `-v` style aliases become their long flag up front (only before a bare `--`).
  const dd = restRaw.indexOf("--");
  const rest =
    spec?.short === undefined
      ? restRaw
      : restRaw.map((a, i) =>
          (dd === -1 || i < dd) && /^-[A-Za-z]$/.test(a) && Object.hasOwn(spec.short!, a[1]!)
            ? `--${spec.short![a[1]!]}`
            : a
        );
  // No prototype: with one, `flags["valueOf"] ?? fallback` answers with a FUNCTION for a
  // flag nobody passed. Every option is read out of this bag by name.
  const flags: Record<string, string> = Object.create(null);
  if (spec === undefined) {
    // Unknown (or absent) command: loose reading so the dispatcher can name it.
    const positionals: string[] = [];
    for (const arg of rest) {
      if (arg.startsWith("--")) flags[arg.slice(2)] = "true";
      else positionals.push(arg);
    }
    return { command, positionals, flags };
  }
  const known = Object.keys(spec.flags);

  // Pass 1 (lenient, with tokens): find unknown and repeated flags and report them our way.
  const loose = nodeParseArgs({ args: rest, strict: false, allowPositionals: true, tokens: true });
  const seen = new Set<string>();
  for (const t of loose.tokens ?? []) {
    if (t.kind === "option" && !Object.hasOwn(spec.flags, t.name)) {
      const shown = t.rawName ?? `--${t.name}`;
      const shortOrNumeric = !shown.startsWith("--");
      const hint = suggest(t.name, known);
      const closeEnough =
        hint !== undefined && (t.name.length > 2 || editDistance(t.name, hint) <= 1);
      throw new UsageError(
        `loom ${command}: unknown flag ${shown}${closeEnough ? ` (did you mean --${hint}?)` : ""}${
          shortOrNumeric || /^-\d/.test(shown)
            ? " (if this is a value that starts with -, put -- before it)"
            : ""
        }`
      );
    }
    if (t.kind === "option" && spec.flags[t.name] !== "boolean") {
      // Silently taking the last of two values is how a stale flag in a shell alias wins.
      if (seen.has(t.name)) {
        throw new UsageError(
          `loom ${command}: --${t.name} given more than once (use one value${
            spec.flags[t.name] === "string" ? "; lists are comma-separated" : ""
          })`
        );
      }
      seen.add(t.name);
    }
  }

  // Pass 2 (strict): booleans take no value, value flags require one.
  const options: Record<string, { type: "boolean" | "string" }> = Object.create(null);
  for (const [name, kind] of Object.entries(spec.flags)) {
    options[name] = { type: kind === "boolean" ? "boolean" : "string" };
  }
  let parsed: ReturnType<typeof nodeParseArgs>;
  try {
    parsed = nodeParseArgs({ args: rest, options, strict: true, allowPositionals: true });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code.startsWith("ERR_PARSE_ARGS")) {
      throw new UsageError(
        `loom ${command}: ${(err as Error).message.replace(/\. To specify.*$/, "")}`
      );
    }
    throw err;
  }
  for (const [name, value] of Object.entries(parsed.values)) {
    if (value === undefined) continue;
    const kind = spec.flags[name] as FlagKind;
    if (kind === "boolean") {
      if (value === true) flags[name] = "true";
      continue;
    }
    validate(command as string, name, kind, value as string);
    flags[name] = value as string;
  }
  return { command, positionals: parsed.positionals as string[], flags };
}
