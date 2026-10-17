import * as fs from "node:fs";
import * as path from "node:path";

import type { EventEnvelope } from "@loom/core";
import { type EventStore, headOf, readRangeOf } from "@loom/event-runtime";
import { UsageError } from "./args";
import {
  type EvalReport,
  type Golden,
  createVerboseFormatter,
  describeState,
  evaluateGoldens,
  eventLine,
  foldAt,
  formatLog,
  makeRedactor,
  redactEvents,
} from "./core";
import { type StoreFlags, noSuchExecution, resolveStores } from "./stores";

/** What of an execution's log `loom logs` shows (all optional; none = the whole log). */
export interface LogsView {
  /** `-v`: timestamps, gaps, step durations, actor, truncated payloads. */
  verbose?: boolean;
  /** Only these event types. */
  types?: readonly string[];
  /** Inclusive sequence bounds. */
  from?: number;
  to?: number;
}

/** `--type A,B` → ["A","B"]. */
export function parseTypes(flag: string | undefined): string[] {
  return flag === undefined
    ? []
    : flag
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
}

function checkView(view: LogsView): void {
  if (view.from !== undefined && view.to !== undefined && view.from > view.to) {
    throw new UsageError(`--from ${view.from} is after --to ${view.to}`);
  }
}

const matchesType = (view: LogsView) => {
  const types = view.types;
  return (e: EventEnvelope) =>
    types === undefined || types.length === 0 || types.includes(e.eventType);
};

/** Read the window `view` names. An empty log for the execution is "no such execution". */
async function readView(
  store: EventStore,
  executionId: string,
  view: LogsView
): Promise<EventEnvelope[]> {
  checkView(view);
  const bounded = view.from !== undefined || view.to !== undefined;
  const events = bounded
    ? await readRangeOf(store, executionId, view.from ?? 0, view.to ?? Number.MAX_SAFE_INTEGER)
    : await store.read(executionId);
  if (events.length === 0 && (!bounded || (await headOf(store, executionId)) === null)) {
    throw await noSuchExecution(store, executionId);
  }
  return events.filter(matchesType(view));
}

function emptyViewNote(view: LogsView): string {
  const bits: string[] = [];
  if (view.types !== undefined && view.types.length > 0)
    bits.push(`--type ${view.types.join(",")}`);
  if (view.from !== undefined) bits.push(`--from ${view.from}`);
  if (view.to !== undefined) bits.push(`--to ${view.to}`);
  return bits.length === 0 ? "(no events)" : `(no events match ${bits.join(" ")})`;
}

/** The text renderer for a view: one row per event, or the verbose two/three-line form. */
function textRenderer(view: LogsView): (e: EventEnvelope) => string {
  return view.verbose === true ? createVerboseFormatter() : eventLine;
}

/**
 * `loom logs <store> <executionId> [--redact a,b] [-v] [--type A,B] [--from N] [--to N]` — the
 * durable event stream.
 */
export async function cmdLogs(
  flags: StoreFlags,
  executionId: string,
  redact: readonly string[] = [],
  view: LogsView = {}
): Promise<string> {
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    const events = await readView(store, executionId, view);
    if (events.length === 0) return emptyViewNote(view);
    return redactEvents(events, redact).map(textRenderer(view)).join("\n");
  } finally {
    await resolved.close();
  }
}

/**
 * `loom debug --db <path> <executionId> [--at <seq>] [--redact a,b]` — time-travel over the
 * log. With `--at`, prints the folded state at that sequence; otherwise the full timeline plus
 * the final state. `--redact` masks the listed output dot-paths from the printout (K10-R6).
 */
export async function cmdDebug(
  flags: StoreFlags,
  executionId: string,
  at?: number,
  redact: readonly string[] = []
): Promise<string> {
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    const events = await store.read(executionId);
    if (events.length === 0) throw await noSuchExecution(store, executionId);
    if (at !== undefined) {
      requireSequenceInLog(events, at);
      return describeState(foldAt(events, at), redact);
    }
    return `${formatLog(events, redact)}\n\n${describeState(foldAt(events), redact)}`;
  } finally {
    await resolved.close();
  }
}

/**
 * `--at N` past the last event used to fold the whole log and print the FINAL state as if it
 * were the state at N — a wrong answer that reads as a right one. Refuse (exit 2) instead.
 */
function requireSequenceInLog(events: EventEnvelope[], at: number): void {
  const last = (events[events.length - 1] as EventEnvelope).sequence;
  if (at > last) throw new UsageError(`--at ${at}: sequence ${at} > last (${last})`);
}

/** `loom logs --json` — ndjson, one event envelope per line. */
export async function cmdLogsJson(
  flags: StoreFlags,
  executionId: string,
  redact: readonly string[] = [],
  view: LogsView = {}
): Promise<string> {
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    const events = await readView(store, executionId, view);
    return redactEvents(events, redact)
      .map((e) => JSON.stringify(e))
      .join("\n");
  } finally {
    await resolved.close();
  }
}

const TERMINAL_EVENTS = new Set([
  "EXECUTION_COMPLETED",
  "EXECUTION_FAILED",
  "EXECUTION_CANCELLED",
  "EXECUTION_CONTINUED",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "continued"]);

export interface FollowOptions {
  redact?: readonly string[];
  view?: LogsView;
  /** ndjson (one envelope per line) instead of the timeline. */
  json?: boolean;
  /** Poll period; default 500ms. */
  intervalMs?: number;
  /** Where a printed event goes (one string per event, no trailing newline). */
  write: (line: string) => void;
  /** Where the terminal-state note goes (stderr under --json so stdout stays ndjson). */
  note: (line: string) => void;
  /** Abort = stop following (SIGINT). */
  signal?: AbortSignal;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * `loom logs --follow`: print what is already in the log, then poll from the last sequence and
 * print each new event until the execution reaches a terminal state (or `signal` aborts).
 * Read-only — `readFrom` past the tip, nothing else. One redactor lives for the whole follow,
 * so a secret met in a later batch scrubs everything printed AFTER it (earlier lines are
 * already out; mask by path with `--redact` when the value matters from the first event).
 * Resolves 0 on both a terminal state and an abort.
 */
export async function cmdLogsFollow(
  flags: StoreFlags,
  executionId: string,
  options: FollowOptions
): Promise<number> {
  const view = options.view ?? {};
  checkView(view);
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  const redactor = makeRedactor(options.redact ?? []);
  const render = options.json === true ? JSON.stringify : textRenderer(view);
  const accept = matchesType(view);
  try {
    let last = -1;
    let first = true;
    const emit = (batch: EventEnvelope[]): void => {
      for (const e of batch) {
        last = Math.max(last, e.sequence);
        if (view.from !== undefined && e.sequence < view.from) continue;
        if (view.to !== undefined && e.sequence > view.to) continue;
        if (!accept(e)) continue;
        options.write(render(redactor.scrub(redactor.mask(e))));
      }
    };
    const finish = async (): Promise<boolean> => {
      const all = await store.read(executionId);
      const status = foldAt(all).status;
      if (!TERMINAL_STATUSES.has(status)) return false;
      options.note(`-- execution ${executionId} ${status} (seq ${last}) --`);
      return true;
    };
    for (;;) {
      if (options.signal?.aborted) return 0;
      const batch = await store.readFrom(executionId, last + 1);
      if (first && batch.length === 0) throw await noSuchExecution(store, executionId);
      first = false;
      emit(batch);
      if (view.to !== undefined && last >= view.to) return 0;
      if (batch.some((e) => TERMINAL_EVENTS.has(e.eventType)) && (await finish())) return 0;
      await abortableSleep(options.intervalMs ?? 500, options.signal);
    }
  } finally {
    await resolved.close();
  }
}

/** `loom debug --json` — `{ ok, executionId, at?, eventCount, state }`. */
export async function cmdDebugJson(
  flags: StoreFlags,
  executionId: string,
  at?: number,
  redact: readonly string[] = []
): Promise<unknown> {
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    const events = await store.read(executionId);
    if (events.length === 0) throw await noSuchExecution(store, executionId);
    if (at !== undefined) requireSequenceInLog(events, at);
    const r = makeRedactor(redact);
    r.mask(events); // learn every secret the log holds, then scrub the folded state with them
    const state = r.scrub(r.mask(foldAt(events, at)));
    return {
      ok: true,
      executionId,
      ...(at !== undefined && { at }),
      eventCount: events.length,
      state,
    };
  } finally {
    await resolved.close();
  }
}

/** Load `*.json` golden files from a directory. */
export function loadGoldens(dir: string): Golden[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Partial<Golden>;
      return { name: parsed.name ?? f, log: parsed.log ?? [], expect: parsed.expect } as Golden;
    });
}

/** `loom eval --dir <path>` — replay golden logs against expectations. */
export function cmdEval(dir: string): { text: string; report: EvalReport } {
  const report = evaluateGoldens(loadGoldens(dir));
  const lines = report.results.map((r) =>
    r.passed ? `  ✓ ${r.name}` : `  ✗ ${r.name}\n${r.failures.map((x) => `      ${x}`).join("\n")}`
  );
  const summary = `\n${report.passed} passed, ${report.failed} failed`;
  return { text: `${lines.join("\n")}${summary}`, report };
}
