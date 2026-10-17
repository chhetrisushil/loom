import * as fs from "node:fs";
import * as path from "node:path";

import {
  type EvalReport,
  type Golden,
  describeState,
  evaluateGoldens,
  foldAt,
  formatLog,
  makeRedactor,
  redactEvents,
} from "./core";
import { type StoreFlags, noSuchExecution, resolveStores } from "./stores";

/** `loom logs --db <path> <executionId> [--redact a,b]` — the durable event stream. */
export async function cmdLogs(
  flags: StoreFlags,
  executionId: string,
  redact: readonly string[] = []
): Promise<string> {
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    const events = await store.read(executionId);
    if (events.length === 0) throw await noSuchExecution(store, executionId);
    return formatLog(events, redact);
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
      return describeState(foldAt(events, at), redact);
    }
    return `${formatLog(events, redact)}\n\n${describeState(foldAt(events), redact)}`;
  } finally {
    await resolved.close();
  }
}

/** `loom logs --json` — ndjson, one event envelope per line. */
export async function cmdLogsJson(
  flags: StoreFlags,
  executionId: string,
  redact: readonly string[] = []
): Promise<string> {
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    const events = await store.read(executionId);
    if (events.length === 0) throw await noSuchExecution(store, executionId);
    return redactEvents(events, redact)
      .map((e) => JSON.stringify(e))
      .join("\n");
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
