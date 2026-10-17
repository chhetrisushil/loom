import * as fs from "node:fs";
import * as path from "node:path";

import { maskPaths } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import {
  type EvalReport,
  type Golden,
  describeState,
  evaluateGoldens,
  foldAt,
  formatLog,
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

/**
 * `--redact` for machine output: the same dot-paths the text view masks, applied to the payload
 * root AND to `payload.output` (the text view's only echo of step/flow output). Machine output
 * carries the whole payload, so the mask must not be narrower than the operator's flag.
 */
function redactedEnvelope(e: EventEnvelope, redact: readonly string[]): EventEnvelope {
  if (redact.length === 0) return e;
  const payload = maskPaths(e.payload ?? {}, redact) as Record<string, unknown>;
  if (payload.output !== undefined) payload.output = maskPaths(payload.output, redact);
  return { ...e, payload } as EventEnvelope;
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
    return events.map((e) => JSON.stringify(redactedEnvelope(e, redact))).join("\n");
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
    const state = foldAt(events, at);
    const out = state.variables._output;
    const masked =
      out === undefined
        ? state
        : { ...state, variables: { ...state.variables, _output: maskPaths(out, redact) } };
    return {
      ok: true,
      executionId,
      ...(at !== undefined && { at }),
      eventCount: events.length,
      state: masked,
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
