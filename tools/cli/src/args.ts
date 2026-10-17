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
  /** flag name (no leading dashes) → kind */
  flags: Readonly<Record<string, FlagKind>>;
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
} as const satisfies Record<string, FlagKind>;

const inspector: CommandSpec = { flags: { ...STORE, port: "int" } };

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  // `json` is accepted-and-warned (it was always swallowed here); real output lands with F11.
  logs: { flags: { ...STORE, redact: "string", json: "boolean" } },
  debug: { flags: { ...STORE, at: "int", redact: "string" } },
  recover: {
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
    flags: {
      ...STORE,
      limit: "int",
      apply: "boolean",
      parent: "string",
      stale: "duration",
      protect: "string",
    },
  },
  census: { flags: { ...STORE, buckets: "string", sample: "int", json: "boolean" } },
  repair: { flags: { ...STORE, apply: "boolean", force: "boolean", assign: "string" } },
  retention: { flags: { ...STORE, ttl: "duration", apply: "boolean" } },
  sweep: {
    flags: {
      ...STORE,
      content: "string",
      "archive-db": "string",
      "archive-snap": "string",
      pin: "string",
      ttl: "duration",
      apply: "boolean",
      orphans: "boolean",
      "no-archive": "boolean",
      "snapshots-touch-content": "boolean",
    },
  },
  compliance: { flags: { ...STORE, "subject-path": "string", "tenant-path": "string" } },
  eval: { flags: { dir: "string" } },
  lint: { flags: { dir: "string" } },
  check: { flags: { manifest: "string" } },
  doctor: { flags: { dir: "string", config: "string", manifest: "string" } },
  verify: { flags: { config: "string", manifest: "string" } },
  profile: { flags: { ...STORE } },
  introspect: { flags: { ...STORE, graph: "string" } },
  optimize: { flags: { ...STORE } },
  learn: { flags: { ...STORE, policy: "string", "min-steps": "int" } },
  knowledge: {
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
  "kernel-manifest": { flags: { json: "boolean", "emit-docs": "string" } },
  compat: {
    flags: {
      abi: "string",
      "event-schema": "string",
      wire: "string",
      "event-store-spi": "string",
      "snapshot-store-spi": "string",
      "branch-registry-spi": "string",
      "dispatcher-spi": "string",
      "compiler-manifest": "string",
    },
  },
  gen: { flags: { dir: "string" } },
  new: { flags: { dir: "string" } },
  plugin: {
    flags: {
      dir: "string",
      publish: "boolean",
      "first-party": "boolean",
      "1p": "boolean",
      module: "string",
      preset: "string",
      options: "string",
    },
  },
  appgen: {
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
  deploy: { flags: { logs: "string", config: "string" } },
  inspect: inspector,
  dev: inspector,
  help: { flags: {} },
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
  const [command, ...rest] = argv;
  // No prototype: with one, `flags["valueOf"] ?? fallback` answers with a FUNCTION for a
  // flag nobody passed. Every option is read out of this bag by name.
  const flags: Record<string, string> = Object.create(null);
  const spec = command === undefined ? undefined : COMMANDS[command];
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
      if (t.name === "help" || t.name === "h") {
        throw new UsageError(
          `loom ${command}: ${shown} is not a flag — per-command help is not available yet; run \`loom help\` for the usage of every command`
        );
      }
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
