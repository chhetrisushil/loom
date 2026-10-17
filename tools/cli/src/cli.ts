#!/usr/bin/env node
import * as fs from "node:fs";
import * as readline from "node:readline";
import type { FilePlan } from "@loom/appgen";

// Everything below is imported on demand (`await import`) inside the command that needs it.
// `loom help`, `loom --version` and `loom completion` must start in roughly node's own startup
// time, not after loading the model clients, the SQLite driver and every runtime package.
// Only type imports and the dependency-light modules (args, help, storeFlags) are static.
import type { Elevation, Planner } from "./appgen";
import { CliError, UsageError, parseArgs, specOf } from "./args";
import {
  cliVersion,
  commandHelp,
  completionScript,
  helpSubcommand,
  unknownCommandMessage,
  wantsHelp,
} from "./help";
import { STORE_FLAG_HELP, hasStoreFlags, storeFlagsOf } from "./storeFlags";

export { parseArgs };

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
 * `loom <command> --help` prints one command's section (from the command table).
 */
export const USAGE = `loom — project-local commands for a Loom app

scaffold
  loom gen   [--dir app]                          regenerate loom.gen.ts from app/flows
  loom new   <flow|agent|tool|skill|schedule|memory|projection|sentinel> <name> [--dir app] scaffold a file
  loom appgen <intent> | --from <file> [--dir .] [--dry-run] [--check]  NL → new project or edits
                                                  (--dry-run previews; --check typechecks after apply)
  loom appgen ... --model <spec> [--model-big <spec>]  plan with a model of your choice
                                                  (anthropic:<m> / openai:<m> / gemini:<m> / a .gguf path)
  loom appgen --from-spec <file> [--dir .]        replay a .loom/appgen/<ts>.spec.json (no model)

validate
  loom doctor [--dir .] [--config <module>] [--manifest <path>] [--strict] [--require <check,check>] [--json]
                                                  run every pre-flight check that can run, and report
                                                  which ones could NOT (--strict: those fail; --require:
                                                  the named ones must have run)
  loom check --manifest <path> [--json]           static flow-graph checks (compiler manifest)
  loom lint claim-check [--dir .] [--json]        CC-5: flag claim-check reach-through inside flows
  loom verify --config <module> [--manifest <path>] [--json]  pre-flight runtime verification (@loom/verify)
                                                  (auto-reads loom-manifest.json loopIdentity findings, ADR 0061)
  loom kernel-manifest [--json] [--emit-docs <dir>]  kernel version + maturity manifest
  loom compat --abi <v> --event-schema <v> [...] [--json]  validate a deployment's contract versions
  loom eval  --dir <path> [--json]                replay golden logs vs expectations

observe
  loom ls    <store> [--status running|suspended|failed|completed|cancelled] [--workflow <id>] [--since <dur>] [--limit N] [--keys] [--json]
                                                  list executions: status, last activity, and what a
                                                  suspended one waits on (read-only; --leases adds owners)
  loom logs  <store> <executionId> [--redact a,b] [--json]  print the event timeline (--json: ndjson)
  loom logs  <store> <executionId> [-v] [--type A,B] [--from N] [--to N]  detail (timestamps, gaps, payloads) / filter
  loom logs  <store> <executionId> --follow [--interval <dur>]  tail it until it finishes (Ctrl-C stops)
  loom debug <store> <executionId> [--at N] [--redact a,b] [--json]  time-travel: state at sequence N
  loom profile <store> <executionId> [--json]     flame graph + latency breakdown
  loom introspect <store> <executionId> [--graph N] [--json]  execution/task/decision/resource graphs
  loom optimize <store> <executionId>             advisory optimization report (recommendations)
  loom census <store> [--buckets 5m,1h,6h,24h] [--json]  what is stuck, and is anything watching it
                                                  (read-only; takes no predicate)
  loom learn report <store> [executionId]         trajectories, per-arm rewards, learning coverage
  loom learn eval <store> --policy <module> [--min-steps N] [executionId]
                                                  shadow-evaluate a candidate policy on real logs
  loom compliance report <store> --subject-path <p> [--tenant-path <p>]  data-subject inventory
  loom inspect <store> [--port N]                 web inspector (timeline + slider)

operate
  loom recover <store> [--stale 15m] [--owner <id>] [--limit N] [--max-recoveries N] [--apply]
                                                  re-drive executions whose supervisor died
                                                  (--max-recoveries: skip + list those whose
                                                   last N re-drives made no progress)
                                                  (needs \`timers.leases\` or --stale; --apply
                                                   needs --config: re-driving runs the flow)
  loom branches retire <store> --parent <id> --stale <d> [--limit N] [--apply]
                                                  cancel branches nobody is coming back to
                                                  (they keep the parent uncollectable)
  loom branches prune <store> [--protect main,rel] [--limit N] [--apply]
                                                  delete refs that name nothing (main protected)
  loom knowledge sync --config <mod> --scope <s> --dir <path> [--ext md,txt] [--source <s>] [--apply]
                                                  reconcile a directory into a corpus
                                                  (dry run by default; --apply also REMOVES
                                                   documents the directory no longer has —
                                                   but never another writer's, see --source)
  loom knowledge list --config <mod> --scope <s>  what the corpus holds
  loom knowledge search --config <mod> --scope <s> "<query>" [--limit N]
                                                  ask the corpus (operator query — not recorded)

maintain
  loom repair blank-stream <store> [--assign <id>:<from>-<through>,…] [--apply]
                                                  re-home what the pre-0106 compaction bug
                                                  wrote to execution "" (ADR 0107): proven
                                                  segments only; the rest is listed with its
                                                  candidates, never guessed
  loom repair terminal-event <store> [executionId] [--apply] [--force]
                                                  give an execution a pre-0116 compaction left
                                                  as [0]+checkpoint its terminal event back, so
                                                  it can take a late outcome (ADR 0116)
  loom retention run <store> --ttl <dur|ms> [--apply]  reclaim aged terminal executions
                                                  (a branchRegistry enables the live-descendant
                                                   guard; without one a parent with live
                                                   branches is NOT protected)
  loom sweep content <store> --content <path> [--archive-db <path> [--archive-snap <path>]] [--pin KIND,KIND] [--ttl ms] [--orphans [--no-archive] [--snapshots-touch-content]] [--apply]  K10.6 pinned blob sweep
                                                  (--orphans also erases blobs NOTHING scanned
                                                   cites, so it needs the snapshot store and
                                                   every archive; with --apply and no archive
                                                   it refuses unless --no-archive;
                                                   it also needs --snapshots-touch-content)

plugin
  loom plugin new <seam> <name> [--first-party] [--dir .]  scaffold a plugin package
  loom plugin check [--dir .] [--publish]         validate a plugin (--publish adds npm-readiness)
  loom plugin try --module <path> [--preset <name>] [--options <json>]  run a store plugin end-to-end
  loom plugin search <term>                       find plugins on npm (keyword loom-plugin)
  loom plugin seams                               list the seams a plugin can target

deploy
  loom deploy check --logs <dir> --config <module>  simulate deploy vs new flow defs

help
  loom help [command]                             this summary, or one command's usage
  loom <command> --help                           same as \`loom help <command>\`
  loom version                                    print the @loom/cli version (also --version)
  loom completion <zsh|bash|fish>                 print a shell completion script

  <store>  where a command reads storage. Either half works for every command above:
    --config <module>    the stores YOUR app wired (defineConfig) — SQLite, Postgres, or any
                         conforming backend; importing it starts nothing
    --db <events.db> [--snap <s.db>] [--branches <b.db>] [--leases <l.db>]
                         SQLite shorthand, one file per store — for a dev machine with loose
                         files. Flags you omit are stores the command cannot consult, and it
                         says so rather than reporting them as empty.

New project?  →  create-loom-app <dir> --loom-path <loom>   (unpublished: see getting-started)
`;

/**
 * The READ-ONLY commands that may default to `./loom.config.{js,ts}`. Discovery IMPORTS and
 * executes that file, so it is offered only where the command can do no harm beyond reading;
 * anything else (recover, repair, retention, sweep, branches, learn, optimize, dev, ...)
 * must be told its store.
 */
const DISCOVERY_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "logs",
  "debug",
  "census",
  "profile",
  "introspect",
  "inspect",
]);

/**
 * Neither `--config` nor `--db` given: for a read-only command, use `./loom.config.js` (or
 * `.ts`) when the working directory has one, and say so on stderr. Otherwise the caller
 * refuses as before. `--db` given alone is never overridden, and a write never guesses a store.
 */
function hasStoreFlagsOrDiscover(flags: Record<string, string>, command: string): boolean {
  if (hasStoreFlags(flags)) return true;
  if (!DISCOVERY_COMMANDS.has(command.split(" ")[0] as string)) return false;
  // Belt and braces: a write is never aimed at a store the operator did not name.
  if (flags.apply === "true") return false;
  for (const name of ["loom.config.js", "loom.config.ts"]) {
    if (fs.existsSync(name)) {
      flags.config = `./${name}`;
      console.error(`loom: using ./${name} (pass --config or --db to choose another store)`);
      return true;
    }
  }
  return false;
}

/** Every storage-backed command refuses the same way, naming both front doors. */
function storeFlagError(command: string): never {
  throw new UsageError(`loom ${command}: ${STORE_FLAG_HELP}`);
}

// ── Output: text by default, one JSON document on stdout under --json ─────────
//
// In --json mode stdout carries ONLY the JSON: `console.log`/`info` (banners from an imported
// config, progress lines) are diverted to stderr for the duration of the command, and the
// result is written straight to the real stdout. Errors become `{"error":{code,message}}` on
// stderr (see `run`).
let jsonStdout = false;
let jsonWrite: ((s: string) => unknown) | undefined;

function out(text: string): void {
  if (jsonStdout && jsonWrite !== undefined) jsonWrite(`${text}\n`);
  else console.log(text);
}
function outJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

/** True when this invocation asked for `--json` on a command that supports it. */
function jsonRequested(argv: readonly string[]): boolean {
  const spec = specOf(argv[0]);
  if (spec === undefined || spec.flags.json === undefined) return false;
  const dd = argv.indexOf("--");
  return argv.slice(1, dd === -1 ? undefined : dd).includes("--json");
}

export async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (first === "--version" || first === "-V") {
    console.log(cliVersion());
    return 0;
  }
  if (specOf(first) !== undefined && wantsHelp(rest, first)) {
    console.log(commandHelp(first, helpSubcommand(rest)));
    return 0;
  }

  const { command, positionals, flags } = parseArgs(argv);
  const json = flags.json === "true" && specOf(command)?.flags.json !== undefined;
  const realLog = console.log;
  const realInfo = console.info;
  const realWrite = process.stdout.write;
  if (json) {
    // Divert `process.stdout.write` itself (console.debug/table/dir and any direct write go
    // through it); the result alone is emitted via the saved original.
    jsonWrite = (s) => realWrite.call(process.stdout, s);
    process.stdout.write = ((chunk: unknown, ...more: unknown[]) =>
      (process.stderr.write as (...a: unknown[]) => boolean).call(
        process.stderr,
        chunk,
        ...more
      )) as typeof process.stdout.write;
    jsonStdout = true;
    console.log = (...a: unknown[]) => console.error(...a);
    console.info = (...a: unknown[]) => console.error(...a);
  }
  try {
    return await dispatch(command, positionals, flags, json);
  } finally {
    if (json) {
      jsonStdout = false;
      jsonWrite = undefined;
      process.stdout.write = realWrite;
      console.log = realLog;
      console.info = realInfo;
    }
  }
}

async function dispatch(
  command: string | undefined,
  positionals: string[],
  flags: Record<string, string>,
  json: boolean
): Promise<number> {
  switch (command) {
    case "ls": {
      if (!hasStoreFlagsOrDiscover(flags, "ls")) return storeFlagError("ls");
      const { LS_STATUSES, lsReport, renderLs } = await import("./ls");
      if (
        flags.status !== undefined &&
        !(LS_STATUSES as readonly string[]).includes(flags.status)
      ) {
        throw new UsageError(
          `loom ls: --status expects one of ${LS_STATUSES.join("|")}, got "${flags.status}"`
        );
      }
      const { parseDuration } = await import("./duration");
      const { result, limit } = await lsReport({
        ...storeFlagsOf(flags),
        ...(flags.keys === "true" && { keys: true }),
        ...(flags.status !== undefined && { status: flags.status as (typeof LS_STATUSES)[number] }),
        ...(flags.workflow !== undefined && { workflow: flags.workflow }),
        ...(flags.since !== undefined && { sinceMs: parseDuration(flags.since) }),
        ...(flags.limit !== undefined && { limit: Number.parseInt(flags.limit, 10) }),
      });
      if (json) {
        outJson({
          ok: true,
          executions: result.rows,
          matched: result.matched,
          scanned: result.scanned,
          limit,
          ...(result.truncated !== undefined && { truncated: result.truncated }),
          ...(result.unreadable > 0 && { unreadable: result.unreadable }),
        });
      } else out(renderLs(result, { limit, ...(flags.keys === "true" && { keys: true }) }));
      return 0;
    }
    case "logs": {
      if (!hasStoreFlagsOrDiscover(flags, "logs")) return storeFlagError("logs");
      const executionId = requirePositional(positionals, "executionId");
      const commands = await import("./commands");
      const redact = parseRedact(flags.redact);
      const view: import("./commands").LogsView = {
        ...(flags.verbose === "true" && { verbose: true }),
        ...(flags.type !== undefined && { types: commands.parseTypes(flags.type) }),
        ...(flags.from !== undefined && { from: Number.parseInt(flags.from, 10) }),
        ...(flags.to !== undefined && { to: Number.parseInt(flags.to, 10) }),
      };
      if (flags.follow === "true") {
        const { parseDuration } = await import("./duration");
        const intervalMs = flags.interval !== undefined ? parseDuration(flags.interval) : undefined;
        if (intervalMs !== undefined && intervalMs < commands.FOLLOW_MIN_INTERVAL_MS) {
          throw new UsageError(
            `loom logs: --interval ${flags.interval} is below the ${commands.FOLLOW_MIN_INTERVAL_MS}ms floor (a tighter poll would busy-loop the store)`
          );
        }
        const ac = new AbortController();
        const onSigint = () => ac.abort();
        process.once("SIGINT", onSigint);
        try {
          return await commands.cmdLogsFollow(storeFlagsOf(flags), executionId, {
            redact,
            view,
            json,
            ...(intervalMs !== undefined && { intervalMs }),
            write: out,
            // stdout stays pure ndjson under --json; the "finished" note is a human aside.
            note: (line) => (json ? console.error(line) : out(line)),
            signal: ac.signal,
          });
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
      }
      out(
        json
          ? await commands.cmdLogsJson(storeFlagsOf(flags), executionId, redact, view)
          : await commands.cmdLogs(storeFlagsOf(flags), executionId, redact, view)
      );
      return 0;
    }
    case "debug": {
      if (!hasStoreFlagsOrDiscover(flags, "debug")) return storeFlagError("debug");
      const executionId = requirePositional(positionals, "executionId");
      const at = flags.at !== undefined ? Number.parseInt(flags.at, 10) : undefined;
      const { cmdDebug, cmdDebugJson } = await import("./commands");
      const redact = parseRedact(flags.redact);
      if (json) outJson(await cmdDebugJson(storeFlagsOf(flags), executionId, at, redact));
      else out(await cmdDebug(storeFlagsOf(flags), executionId, at, redact));
      return 0;
    }
    case "recover": {
      if (!hasStoreFlagsOrDiscover(flags, "recover")) return storeFlagError("recover");
      const { cmdRecover } = await import("./maintenance");
      out(
        await cmdRecover({
          ...storeFlagsOf(flags),
          ...(flags.stale !== undefined && { stale: flags.stale }),
          ...(flags.owner !== undefined && { owner: flags.owner }),
          ...(flags.limit !== undefined && { limit: Number.parseInt(flags.limit, 10) }),
          ...(flags["max-recoveries"] !== undefined && {
            maxRecoveries: Number(flags["max-recoveries"]),
          }),
          apply: flags.apply === "true",
        })
      );
      return 0;
    }
    case "branches": {
      const sub = requirePositional(positionals, "retire|prune");
      if (!hasStoreFlagsOrDiscover(flags, `branches ${sub}`))
        return storeFlagError(`branches ${sub}`);
      const shared = {
        ...storeFlagsOf(flags),
        ...(flags.limit !== undefined && { limit: Number.parseInt(flags.limit, 10) }),
        apply: flags.apply === "true",
      };
      if (sub === "retire") {
        requireFlag(flags, "parent");
        const { cmdBranchesRetire } = await import("./maintenance");
        out(
          await cmdBranchesRetire({
            ...shared,
            parent: flags.parent!,
            ...(flags.stale !== undefined && { stale: flags.stale }),
          })
        );
        return 0;
      }
      if (sub === "prune") {
        const { cmdBranchesPrune } = await import("./maintenance");
        out(
          await cmdBranchesPrune({
            ...shared,
            ...(flags.protect !== undefined && { protect: flags.protect }),
          })
        );
        return 0;
      }
      throw new UsageError(`unknown branches subcommand "${sub}" (expected retire|prune)`);
    }
    case "census": {
      if (!hasStoreFlagsOrDiscover(flags, "census")) return storeFlagError("census");
      const { censusReport, renderCensus } = await import("./census");
      const { census, note, suspended } = await censusReport({
        ...storeFlagsOf(flags),
        ...(flags.buckets !== undefined && { buckets: flags.buckets }),
        ...(flags.sample !== undefined && { sampleSize: Number(flags.sample) }),
      });
      if (json) outJson({ ok: true, census, suspended, ...(note !== undefined && { note }) });
      else out(renderCensus(census, note, suspended));
      return 0;
    }

    case "repair": {
      const sub = requirePositional(positionals, "blank-stream | terminal-event");
      if (sub === "terminal-event") {
        if (!hasStoreFlagsOrDiscover(flags, "repair terminal-event"))
          return storeFlagError("repair terminal-event");
        const { cmdRepairTerminalEvent } = await import("./repair");
        out(
          await cmdRepairTerminalEvent(
            {
              ...storeFlagsOf(flags),
              apply: flags.apply === "true",
              force: flags.force === "true",
            },
            positionals[1]
          )
        );
        return 0;
      }
      if (sub !== "blank-stream") {
        throw new UsageError(
          `unknown repair subcommand "${sub}" (expected blank-stream | terminal-event)`
        );
      }
      if (!hasStoreFlagsOrDiscover(flags, "repair blank-stream"))
        return storeFlagError("repair blank-stream");
      const { cmdRepairBlankStream } = await import("./repair");
      out(
        await cmdRepairBlankStream({
          ...storeFlagsOf(flags),
          ...(flags.assign !== undefined && { assign: flags.assign }),
          apply: flags.apply === "true",
        })
      );
      return 0;
    }
    case "retention": {
      requirePositional(positionals, "run"); // `loom retention run`
      if (!hasStoreFlagsOrDiscover(flags, "retention")) return storeFlagError("retention");
      // No default: an omitted --ttl used to mean 0, i.e. "every terminal execution is aged
      // enough" — a destructive sweep chosen by forgetting a flag.
      if (flags.ttl === undefined) {
        throw new UsageError(
          "loom retention run needs an explicit --ttl <duration> (e.g. --ttl 30d, or milliseconds): there is no default, and --ttl 0 reclaims every terminal execution."
        );
      }
      const { parseDuration } = await import("./duration");
      const { cmdRetentionRun } = await import("./retention");
      const ttl = parseDuration(flags.ttl);
      out(
        await cmdRetentionRun({
          ...storeFlagsOf(flags),
          ttlMs: ttl,
          apply: flags.apply === "true",
        })
      );
      return 0;
    }
    case "sweep": {
      requirePositional(positionals, "content"); // `loom sweep content`
      if (!hasStoreFlagsOrDiscover(flags, "sweep content")) return storeFlagError("sweep content");
      requireFlag(flags, "content");
      const { parseDuration } = await import("./duration");
      const { cmdSweepContent } = await import("./sweepContent");
      const ttl = flags.ttl !== undefined ? parseDuration(flags.ttl) : 30 * 24 * 3_600_000;
      out(
        await cmdSweepContent({
          ...storeFlagsOf(flags),
          content: flags.content!,
          ...(flags["archive-db"] !== undefined && { archiveDb: flags["archive-db"] }),
          ...(flags.pin !== undefined && { pin: flags.pin }),
          ttlMs: ttl,
          apply: flags.apply === "true",
          orphans: flags.orphans === "true",
          noArchive: flags["no-archive"] === "true",
          snapshotsTouchContent: flags["snapshots-touch-content"] === "true",
          ...(flags["archive-snap"] !== undefined && { archiveSnap: flags["archive-snap"] }),
        })
      );
      return 0;
    }
    case "compliance": {
      requirePositional(positionals, "report"); // `loom compliance report`
      if (!hasStoreFlagsOrDiscover(flags, "compliance report"))
        return storeFlagError("compliance report");
      requireFlag(flags, "subject-path");
      const { cmdComplianceReport } = await import("./compliance");
      out(
        await cmdComplianceReport(storeFlagsOf(flags), flags["subject-path"]!, flags["tenant-path"])
      );
      return 0;
    }
    case "eval": {
      requireFlag(flags, "dir");
      const { cmdEval } = await import("./commands");
      const { text, report } = cmdEval(flags.dir!);
      if (json) outJson({ ...report, ok: report.ok });
      else out(text);
      return report.ok ? 0 : 1;
    }
    case "lint": {
      requirePositional(positionals, "claim-check"); // `loom lint claim-check`
      const { cmdLintClaimCheck } = await import("./lintClaimCheck");
      const { text, findings } = cmdLintClaimCheck(flags.dir ?? ".");
      const ok = findings.length === 0;
      if (json) outJson({ ok, findings });
      else out(text);
      return ok ? 0 : 1;
    }
    case "check": {
      requireFlag(flags, "manifest");
      const { cmdCheck } = await import("./check");
      const { text, result } = cmdCheck(flags.manifest!);
      if (json) outJson({ ok: result.ok, issues: result.issues });
      else out(text);
      return result.ok ? 0 : 1;
    }
    case "doctor": {
      const { cmdDoctor } = await import("./doctor");
      const required =
        flags.require !== undefined
          ? flags.require
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean)
          : [];
      const { text, result } = await cmdDoctor({
        ...(flags.dir !== undefined && { dir: flags.dir }),
        ...(flags.config !== undefined && { config: flags.config }),
        ...(flags.manifest !== undefined && { manifest: flags.manifest }),
        ...(flags.strict === "true" && { strict: true }),
        ...(required.length > 0 && { require: required }),
      });
      if (json) outJson({ ok: result.ok, checks: result.checks });
      else out(text);
      return result.ok ? 0 : 1;
    }
    case "verify": {
      requireFlag(flags, "config");
      const { cmdVerify } = await import("./verify");
      const { text, result, banner } = await cmdVerify(flags.config!, flags.manifest);
      if (json) outJson({ ...result, ok: result.ok, ...(banner !== "" && { banner }) });
      else out(text);
      return result.ok ? 0 : 1;
    }
    case "profile": {
      if (!hasStoreFlagsOrDiscover(flags, "profile")) return storeFlagError("profile");
      const executionId = requirePositional(positionals, "executionId");
      const { cmdProfile, profileOf } = await import("./profile");
      if (json) outJson({ ok: true, profile: await profileOf(storeFlagsOf(flags), executionId) });
      else out(await cmdProfile(storeFlagsOf(flags), executionId));
      return 0;
    }
    case "introspect": {
      if (!hasStoreFlagsOrDiscover(flags, "introspect")) return storeFlagError("introspect");
      const executionId = requirePositional(positionals, "executionId");
      const { cmdIntrospect, introspectionOf } = await import("./introspect");
      if (json) {
        const all = await introspectionOf(storeFlagsOf(flags), executionId, flags.graph);
        const introspection =
          flags.graph !== undefined
            ? { [flags.graph]: (all as unknown as Record<string, unknown>)[flags.graph] }
            : all;
        outJson({ ok: true, introspection });
      } else {
        out(await cmdIntrospect(storeFlagsOf(flags), executionId, flags.graph));
      }
      return 0;
    }
    case "optimize": {
      if (!hasStoreFlagsOrDiscover(flags, "optimize")) return storeFlagError("optimize");
      const executionId = requirePositional(positionals, "executionId");
      const { cmdOptimize } = await import("./optimize");
      out(await cmdOptimize(storeFlagsOf(flags), executionId));
      return 0;
    }
    case "learn": {
      const sub = requirePositional(positionals, "report|eval");
      if (!hasStoreFlagsOrDiscover(flags, "learn")) return storeFlagError("learn");
      if (sub === "report") {
        const { cmdLearnReport } = await import("./learn");
        out(await cmdLearnReport(storeFlagsOf(flags), positionals[1]));
        return 0;
      }
      if (sub === "eval") {
        requireFlag(flags, "policy");
        const { cmdLearnEval } = await import("./learn");
        const { text, ok } = await cmdLearnEval(storeFlagsOf(flags), flags.policy!, {
          ...(positionals[1] !== undefined && { executionId: positionals[1] }),
          ...(flags["min-steps"] !== undefined && {
            minSteps: Number.parseInt(flags["min-steps"], 10),
          }),
        });
        out(text);
        return ok ? 0 : 1;
      }
      throw new UsageError(`unknown subcommand "learn ${sub}" — expected report|eval`);
    }
    case "knowledge": {
      const sub = requirePositional(positionals, "sync | list | search");
      requireFlag(flags, "config");
      requireFlag(flags, "scope");
      const k = await import("./knowledge");
      if (sub === "sync") {
        requireFlag(flags, "dir");
        const { text } = await k.cmdKnowledgeSync({
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
        out(text);
        return 0;
      }
      if (sub === "list") {
        out((await k.cmdKnowledgeList({ config: flags.config!, scope: flags.scope! })).text);
        return 0;
      }
      if (sub === "search") {
        const query = positionals[1];
        if (query === undefined || query.length === 0) {
          throw new UsageError(
            'knowledge search: pass the query as a positional — loom knowledge search --config <mod> --scope <s> "replica lag"'
          );
        }
        const { text } = await k.cmdKnowledgeSearch({
          config: flags.config!,
          scope: flags.scope!,
          query,
          ...(flags.limit !== undefined && { limit: Number.parseInt(flags.limit, 10) }),
        });
        out(text);
        return 0;
      }
      throw new UsageError(`unknown subcommand "${sub}" — expected sync | list | search`);
    }
    case "kernel-manifest": {
      const { cmdKernelManifest } = await import("./kernel");
      out(
        cmdKernelManifest({
          json: flags.json === "true",
          ...(flags["emit-docs"] !== undefined && { emitDocs: flags["emit-docs"] }),
        })
      );
      return 0;
    }
    case "compat": {
      const { cmdCompat } = await import("./kernel");
      const { text, ok, report } = cmdCompat(flags);
      if (json) outJson({ ...report, ok });
      else out(text);
      return ok ? 0 : 1;
    }
    case "gen": {
      const { cmdGen } = await import("./gen");
      const dir = flags.dir ?? "app";
      const {
        out: file,
        flows,
        agents,
        tools,
        skills,
        schedules,
        memories,
        projections,
      } = cmdGen(dir);
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
      out(`wrote ${file} (${parts.join(", ")})`);
      return 0;
    }
    case "new": {
      const kind = requirePositional(positionals, "kind");
      const name = positionals[1];
      if (name === undefined) throw new UsageError("missing required <name>");
      const dir = flags.dir ?? "app";
      const { cmdNew } = await import("./gen");
      const { path: dest, created, extras, missingDeps } = cmdNew(kind, name, dir);
      for (const f of [{ path: dest, created }, ...extras]) {
        out(f.created ? `created ${f.path}` : `skipped ${f.path} (already exists)`);
      }
      if (missingDeps.length > 0) {
        out(
          `\nthese files import packages your package.json does not declare — add to its dependencies/devDependencies, then install:\n${missingDeps.map((l) => `  ${l}`).join("\n")}`
        );
      }
      return created ? 0 : 1;
    }
    case "plugin": {
      const sub = positionals[0];
      if (sub === "seams") {
        const { cmdPluginSeams } = await import("./plugin");
        out(cmdPluginSeams());
        return 0;
      }
      if (sub === "try") {
        requireFlag(flags, "module");
        const { cmdPluginTry } = await import("./pluginTry");
        const r = await cmdPluginTry({
          module: flags.module!,
          ...(flags.preset !== undefined && { preset: flags.preset }),
          ...(flags.options !== undefined && { options: flags.options }),
        });
        const mark = (ok: boolean, msg: string) => `  ${ok ? "✓" : "✗"} ${msg}`;
        out(mark(r.completed, `smoke flow completed (preset ${r.preset})`));
        out(mark(r.eventsPersisted > 0, `persisted ${r.eventsPersisted} events`));
        out(mark(r.replayOk, "replays from the durable store"));
        out(`\nplugin try: ${r.ok ? "passed" : "FAILED"}`);
        return r.ok ? 0 : 1;
      }
      if (sub === "search") {
        const term = positionals.slice(1).join(" ");
        const { cmdPluginSearch } = await import("./pluginSearch");
        out(await cmdPluginSearch(term));
        return 0;
      }
      if (sub === "check") {
        const dir = flags.dir ?? positionals[1] ?? ".";
        const { cmdPluginCheck } = await import("./plugin");
        const { findings, ok } = cmdPluginCheck(dir, { publish: flags.publish === "true" });
        const glyph = { ok: "✓", warn: "⚠", error: "✗" } as const;
        for (const f of findings) out(`  ${glyph[f.level]} ${f.message}`);
        const errors = findings.filter((f) => f.level === "error").length;
        const warns = findings.filter((f) => f.level === "warn").length;
        out(`\nplugin check: ${ok ? "passed" : "FAILED"} (${errors} error, ${warns} warn)`);
        return ok ? 0 : 1;
      }
      if (sub === "new") {
        const seam = positionals[1];
        const name = positionals[2];
        if (seam === undefined || name === undefined) {
          throw new UsageError("usage: loom plugin new <seam> <name> [--first-party] [--dir .]");
        }
        const firstParty = flags["first-party"] === "true" || flags["1p"] === "true";
        const dir = flags.dir ?? ".";
        const { cmdPluginNew } = await import("./plugin");
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
        out(lines.join("\n"));
        return written.length > 0 ? 0 : 1;
      }
      throw new UsageError("usage: loom plugin <new|check|try|search|seams> … (see `loom help`)");
    }
    case "appgen": {
      const { cmdAppgen, plannerTag, renderPlan } = await import("./appgen");
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
        out(
          renderPlan(r.plan, dir, {
            planner: r.planner,
            ...(r.elevations && { elevations: r.elevations }),
          })
        );
        return 0;
      }
      if (r.aborted) {
        out("appgen: aborted — nothing written");
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
      out(lines.join("\n"));
      return r.typecheck !== undefined && !r.typecheck.ok ? 1 : 0;
    }
    case "deploy": {
      if (positionals[0] !== "check") {
        throw new UsageError("usage: loom deploy check --logs <dir> --config <module>");
      }
      requireFlag(flags, "logs");
      requireFlag(flags, "config");
      const { cmdDeployCheck } = await import("./deploy");
      const { text, report } = cmdDeployCheck(flags.logs!, flags.config!);
      out(text);
      return report.ok ? 0 : 1;
    }
    case "inspect":
    case "dev": {
      if (!hasStoreFlagsOrDiscover(flags, command)) return storeFlagError(command);
      const { resolveStores } = await import("./stores");
      const { serveInspector } = await import("./inspector");
      const stores = await resolveStores(storeFlagsOf(flags));
      const server = serveInspector(
        stores.eventStore,
        flags.port !== undefined ? { port: Number.parseInt(flags.port, 10) } : {}
      );
      await server.start();
      out(`loom inspector on ${server.url}  (Ctrl-C to stop)`);
      // Graceful shutdown: on Ctrl-C, stop the server and close the stores instead
      // of letting the process die with them open.
      const shutdown = () => {
        void server.stop().then(() => stores.close());
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      return 0; // the listening socket keeps the process alive
    }
    case "version":
      out(cliVersion());
      return 0;
    case "completion":
      out(completionScript(positionals[0]).trimEnd());
      return 0;
    case "help":
      out(positionals[0] !== undefined ? commandHelp(positionals[0]) : USAGE);
      return 0;
    case undefined:
      out(USAGE);
      return 0;
    default:
      throw new UsageError(unknownCommandMessage(command));
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
    throw new UsageError("provide an intent string or --from <file>");
  }
  return intent;
}

/** Show the plan (with diffs) and ask whether to apply it. Used only on a TTY. */
async function confirmPlan(
  plan: FilePlan,
  dir: string,
  planner: Planner,
  elevations?: Elevation[]
): Promise<boolean> {
  const { renderPlan } = await import("./appgen");
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
    throw new UsageError(`missing required --${name}`);
  }
}
function requirePositional(positionals: string[], name: string): string {
  const value = positionals[0];
  if (value === undefined) throw new UsageError(`missing required <${name}>`);
  return value;
}

/** `--verbose` or its `-v` alias, as parsed (not a substring scan of argv). */
function verboseRequested(argv: readonly string[]): boolean {
  try {
    return parseArgs([...argv]).flags.verbose === "true";
  } catch {
    return argv.includes("--verbose") || argv.includes("-v");
  }
}

/**
 * Run the CLI and return its exit code: a verdict failure is 1, a refusal or bad usage is 2
 * (see {@link CliError}). Never throws — the message goes to stderr (under `--json`, as
 * `{"error":{"code":<exit>,"message":…}}`, so stdout stays parseable and stderr too).
 */
export async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    const code = err instanceof CliError ? err.exitCode : 1;
    console.error(jsonRequested(argv) ? JSON.stringify({ error: { code, message } }) : message);
    // A failed config load keeps the original error as `cause`; its stack is for --verbose /
    // LOOM_DEBUG=1 (stderr only — never stdout, never inside the --json error object).
    if (
      err instanceof Error &&
      err.cause instanceof Error &&
      (process.env.LOOM_DEBUG === "1" || verboseRequested(argv))
    ) {
      console.error(err.cause.stack ?? String(err.cause));
    }
    return code;
  }
}

// Run only as a CLI, not when imported by tests.
//
// `require.main === module`, NOT a check on argv[1]'s filename: a global install puts a
// symlink named `loom` on PATH, so argv[1] is ".../bin/loom" and a filename check is false —
// the binary then exits 0 having done nothing, which is the worst way for a CLI to fail.
// pnpm's global link hid this because it writes a shim that execs cli.js by name.
if (require.main === module) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
