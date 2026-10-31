import * as fs from "node:fs";
import * as path from "node:path";
import { COMMANDS, type CommandSpec, UsageError, specOf, suggest } from "./args";

// ── help, version, completion — all derived from the COMMANDS table ──────────
//
// This module is deliberately dependency-light (args + node builtins): `loom help`,
// `loom --version` and `loom completion` must not pay to load the command implementations.

export const SHELLS = ["zsh", "bash", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

/** The @loom/cli package version (read from package.json next to `dist/` or `src/`). */
export function cliVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "unknown";
}

/** The one-line error for an unknown command: did-you-mean plus a pointer, never the dump. */
export function unknownCommandMessage(name: string): string {
  const hint = suggest(name, Object.keys(COMMANDS));
  return `loom: unknown command "${name}"${hint !== undefined ? ` (did you mean "${hint}"?)` : ""} — see \`loom help\``;
}

const STORE_FLAG_NAMES = new Set(["config", "db", "snap", "branches", "leases"]);

function flagLine(name: string, kind: string, short?: string): string {
  const flag = short === undefined ? `--${name}` : `-${short}, --${name}`;
  return kind === "boolean" ? `  ${flag}` : `  ${flag} <${kind}>`;
}

/** `loom <cmd> --help` / `loom help <cmd>`: the command's section of the reference. */
export function commandHelp(name: string, sub?: string): string {
  const spec: CommandSpec | undefined = specOf(name);
  if (spec === undefined) throw new UsageError(unknownCommandMessage(name));
  // `loom branches retire --help`: just that subcommand's usage line(s) and the flags they
  // name (plus the store flags when the line takes a <store-flags>); the whole section otherwise.
  const own =
    sub !== undefined && spec.subcommands?.includes(sub)
      ? spec.usage.filter((u) => u.startsWith(`loom ${name} ${sub}`))
      : [];
  const narrowed = own.length > 0;
  const lines = [
    `loom ${name}${narrowed ? ` ${sub}` : ""} — ${spec.summary}`,
    "",
    "usage:",
    ...(narrowed ? own : spec.usage).map((u) => `  ${u}`),
  ];
  const mentioned = (f: string) =>
    own.some(
      (u) => u.includes(`--${f}`) || (u.includes("<store-flags>") && STORE_FLAG_NAMES.has(f))
    );
  const flags = Object.entries(spec.flags).filter(([f]) => !narrowed || mentioned(f));
  if (flags.length > 0) {
    lines.push(
      "",
      "flags:",
      ...flags.map(([f, k]) =>
        flagLine(f, k, Object.entries(spec.short ?? {}).find(([, long]) => long === f)?.[0])
      )
    );
  }
  if ((narrowed ? own : spec.usage).some((u) => u.includes("<store-flags>"))) {
    lines.push(
      "",
      "<store-flags> are flags, never a positional path: --config <module> | --db <events.db> [--snap <s.db>] [--branches <b.db>] [--leases <l.db>]"
    );
  }
  lines.push("", "`loom help` lists every command.");
  return lines.join("\n");
}

/**
 * True when the args ask for help (before any `--` terminator). For commands whose later
 * positionals are free text (`appgen make a cli with -h flag`), a `-h` past the allowed
 * positionals is a literal word. Values of value flags are skipped, not counted.
 */
export function wantsHelp(args: readonly string[], command?: string): boolean {
  const spec = specOf(command);
  const limit = spec?.literalAfter ?? Number.POSITIVE_INFINITY;
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") return false;
    if (a === "--help" || a === "-h") return positionals <= limit;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!a.includes("=") && spec !== undefined && Object.hasOwn(spec.flags, name)) {
        if (spec.flags[name] !== "boolean") i++; // its value is not a positional
      }
    } else if (!a.startsWith("-")) positionals++;
  }
  return false;
}

/** The subcommand word a `--help` was asked about, if any (`branches retire --help`). */
export function helpSubcommand(args: readonly string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

// ── completion ────────────────────────────────────────────────────────────────

function sortedCommands(): [string, CommandSpec][] {
  return Object.entries(COMMANDS).sort(([a], [b]) => a.localeCompare(b));
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Flags whose value is a filesystem path: completed with files, not left blank. */
const PATH_FLAGS = new Set([
  "db",
  "config",
  "snap",
  "branches",
  "leases",
  "dir",
  "manifest",
  "from",
  "from-spec",
  "content",
  "archive-db",
  "archive-snap",
  "compaction-archive",
  "module",
  "policy",
  "logs",
  "emit-docs",
]);

/** Flag names that take a value in some command and are boolean in none. */
function valueFlagNames(): { path: string[]; other: string[] } {
  const bool = new Set<string>();
  const val = new Set<string>();
  for (const [, spec] of sortedCommands()) {
    for (const [f, k] of Object.entries(spec.flags)) (k === "boolean" ? bool : val).add(f);
  }
  const names = [...val].filter((f) => !bool.has(f)).sort();
  return {
    path: names.filter((f) => PATH_FLAGS.has(f)),
    other: names.filter((f) => !PATH_FLAGS.has(f)),
  };
}

function bashScript(): string {
  const cmds = sortedCommands();
  const { path: pathFlags, other } = valueFlagNames();
  const cases = cmds
    .map(([name, spec]) => {
      const words = [
        ...(spec.subcommands ?? []),
        ...Object.keys(spec.flags).map((f) => `--${f}`),
        "--help",
      ];
      return `    ${name}) opts="${words.join(" ")}" ;;`;
    })
    .join("\n");
  const alt = (xs: string[]) => xs.map((f) => `--${f}`).join("|");
  return `# bash completion for loom — generated by \`loom completion bash\`
# install: eval "$(loom completion bash)"   (or save to a file under bash-completion.d)
_loom() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" opts=""
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${cmds.map(([n]) => n).join(" ")} --help --version" -- "$cur") )
    return 0
  fi
  # A value flag takes the next word as its value: files for path flags, nothing otherwise.
  case "$prev" in
    ${alt(pathFlags)}) COMPREPLY=( $(compgen -f -- "$cur") ); return 0 ;;
    ${alt(other)}) COMPREPLY=(); return 0 ;;
  esac
  case "\${COMP_WORDS[1]}" in
${cases}
  esac
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _loom loom
`;
}

function zshScript(): string {
  const cmds = sortedCommands();
  const described = cmds
    .map(([n, s]) => `    ${shq(`${n}:${s.summary.replace(/:/g, "\\:")}`)}`)
    .join("\n");
  const cases = cmds
    .map(([name, spec]) => {
      const specs = [
        ...(spec.subcommands !== undefined && spec.subcommands.length > 0
          ? [shq(`1:subcommand:(${spec.subcommands.join(" ")})`)]
          : []),
        ...Object.entries(spec.flags).map(([f, k]) =>
          k === "boolean"
            ? shq(`--${f}[${f}]`)
            : shq(`--${f}=[${f}]:${PATH_FLAGS.has(f) ? "file:_files" : `${k}: `}`)
        ),
        shq("--help[show help]"),
        shq("*:argument:_files"),
      ];
      return `    ${name}) _arguments ${specs.join(" ")} ;;`;
    })
    .join("\n");
  return `#compdef loom
# zsh completion for loom — generated by \`loom completion zsh\`
# install: loom completion zsh > "\${fpath[1]}/_loom"   (or: source <(loom completion zsh))
_loom() {
  local -a commands
  commands=(
${described}
  )
  if (( CURRENT == 2 )); then
    _describe -t commands 'loom command' commands
    return
  fi
  case $words[2] in
${cases}
  esac
}
if [ "$funcstack[1]" = "_loom" ]; then _loom "$@"; else compdef _loom loom; fi
`;
}

function fishScript(): string {
  const cmds = sortedCommands();
  const lines = [
    "# fish completion for loom — generated by `loom completion fish`",
    "# install: loom completion fish > ~/.config/fish/completions/loom.fish",
    "complete -c loom -f",
    ...cmds.map(
      ([n, s]) => `complete -c loom -n '__fish_use_subcommand' -a ${n} -d ${shq(s.summary)}`
    ),
  ];
  for (const [name, spec] of cmds) {
    const inCmd = `__fish_seen_subcommand_from ${name}`;
    // Subcommand words only directly after the command (`loom <cmd> |`), never further along.
    const justAfter = `${inCmd}; and test (count (commandline -opc)) -eq 2`;
    for (const sub of spec.subcommands ?? []) {
      lines.push(`complete -c loom -n '${justAfter}' -a ${sub}`);
    }
    for (const [flag, kind] of Object.entries(spec.flags)) {
      // `-r`: the flag requires a value; `-F`: that value is a path, so offer files again.
      const value = kind === "boolean" ? "" : PATH_FLAGS.has(flag) ? " -r -F" : " -r";
      lines.push(`complete -c loom -n '${inCmd}' -l ${flag}${value}`);
    }
    lines.push(`complete -c loom -n '${inCmd}' -l help`);
  }
  return `${lines.join("\n")}\n`;
}

/** The completion script for `shell`, generated from the command table. */
export function completionScript(shell: string | undefined): string {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
    default:
      throw new UsageError(
        `loom completion: expected one of ${SHELLS.join(" | ")}${
          shell === undefined ? "" : `, got "${shell}"`
        } — e.g. eval "$(loom completion bash)"`
      );
  }
}
