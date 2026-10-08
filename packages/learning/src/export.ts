import { isTainted, taintOf } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import { stableKey, trajectories } from "./trajectories";
import type { Trajectory, TrajectoryOptions, TrajectoryStep } from "./types";
import { canonicalJson } from "./versions";

// ── Trajectory and preference export (R18, ADR 0124) ─────────────────────────
//
// Fine-tuning, reward modelling and offline RL all start from the same artifact: a flat file of
// (context, action, reward) trajectories and (prompt, chosen, rejected) preference pairs. The
// log already holds the raw material; what it cannot do for itself is leave the building safely.
// Four things must hold of anything written out, and each is enforced here rather than left to
// the caller:
//
//  - **Scoped.** Only executions of ONE tenant (and optionally one principal) are read. The
//    source reports each execution's tenant; an execution that does not match is never loaded,
//    and one with no tenant is treated as not matching - fail closed.
//  - **Untrusted content stays marked (ADR 0085).** A step whose context, action or alternatives
//    carry tainted content is dropped by default; `taint: "mark"` keeps it with `tainted: true`
//    and the origins, so a trainer can filter. It is never emitted as if it were operator text.
//  - **Erasure holds.** A step carrying a `{ $shredded }` placeholder (crypto-shredded payload,
//    read through a tolerant store) and any execution whose log records `PAYLOAD_SHREDDED` are
//    excluded - an export must not resurrect what was erased. There is no option to include them.
//  - **Bounded and deterministic.** Executions are pulled page by page over a cursor and loaded one
//    at a time; the preference index is capped; output is canonical JSON in source order with no
//    clock, so the same log yields the same bytes.

/** One execution as the source lists it. */
export interface ExportExecutionRef {
  executionId: string;
  /** REQUIRED for the execution to be exportable: an unlabelled execution is never exported. */
  tenant?: string;
  principal?: string;
}

/**
 * Where the export reads from. `EventStore` has no global scan, so the application supplies the
 * listing (its subject index, a read model, a table of executions) and a loader. For executions
 * that may have been compacted, `load` should return `evidenceEvents(state, log)`.
 */
export interface ExportSource {
  list(
    cursor: string | undefined,
    limit: number
  ): Promise<{ executions: ExportExecutionRef[]; next?: string }>;
  load(executionId: string): Promise<EventEnvelope[]>;
}

export interface ExportOptions {
  source: ExportSource;
  /** Only this tenant's executions are exported. Required. */
  tenant: string;
  /** Further restrict to one principal. */
  principal?: string;
  /** Which record kinds to emit. Default both. */
  kinds?: ("trajectory" | "preference")[];
  /** `exclude` (default): drop any record carrying tainted content. `mark`: keep, flagged. */
  taint?: "exclude" | "mark";
  /** Pass the observation (`context`) through. Default true. */
  includeContext?: boolean;
  /** Resume point from a previous run's `stats.nextCursor`. */
  cursor?: string;
  /** Executions listed per page. Default 100, max 1000. */
  pageSize?: number;
  /** Stop after this many executions. Default 100_000. */
  maxExecutions?: number;
  /** Stop after this many emitted records. Default 1_000_000. */
  maxRecords?: number;
  /** Skip (and count) an execution whose log is longer than this. Default 50_000 events. */
  maxEventsPerExecution?: number;
  /** Skip (and count) a record whose JSON line is longer than this. Default 1 MiB. */
  maxLineBytes?: number;
  /** Cap on distinct (decision, context) groups tracked for preference pairs. Default 50_000. */
  maxPreferenceGroups?: number;
  /** A preference pair needs at least this reward gap. Default 0 (any strict difference). */
  minMargin?: number;
  trajectory?: TrajectoryOptions;
}

/** What an export did and, as importantly, what it refused to do. */
export interface ExportStats {
  executionsListed: number;
  executionsExported: number;
  records: { trajectory: number; preference: number };
  skipped: {
    otherTenant: number;
    otherPrincipal: number;
    shreddedExecution: number;
    shreddedStep: number;
    taintedStep: number;
    tooManyEvents: number;
    lineTooLong: number;
    emptyOrMismatched: number;
    preferenceGroupsDropped: number;
    /** A record that could not be built (too deep, stack overflow): skipped alone, the export goes on. */
    recordError: number;
    /** A step whose context was too large to scan for shred placeholders and taint: skipped in every mode. */
    scanOverflow: number;
  };
  /** Preference pairs not emitted because `maxRecords` was reached (pairs are not resumable). */
  preferencesTruncated?: boolean;
  /** Set when a bound stopped the run early; pass it back as `cursor` to continue. */
  nextCursor?: string;
  truncated: boolean;
}

export function newExportStats(): ExportStats {
  return {
    executionsListed: 0,
    executionsExported: 0,
    records: { trajectory: 0, preference: 0 },
    skipped: {
      otherTenant: 0,
      otherPrincipal: 0,
      shreddedExecution: 0,
      shreddedStep: 0,
      taintedStep: 0,
      tooManyEvents: 0,
      lineTooLong: 0,
      emptyOrMismatched: 0,
      preferenceGroupsDropped: 0,
      recordError: 0,
      scanOverflow: 0,
    },
    truncated: false,
  };
}

export const EXPORT_FORMAT = "loom-learning-export/1";
const MAX_SCAN_NODES = 10_000;
const MAX_SCAN_DEPTH = 64;
const MAX_PAGES = 100_000;

/** A resume position: the source's cursor for a page, plus how many of its executions are done. */
function encodePosition(cursor: string | undefined, skip: number): string {
  return `lx1:${JSON.stringify({ c: cursor ?? null, s: skip })}`;
}
function decodePosition(raw: string | undefined): { cursor: string | undefined; skip: number } {
  if (raw === undefined) return { cursor: undefined, skip: 0 };
  // Our envelope is recognised STRICTLY (exactly `{c, s}` with a string-or-null `c` and a
  // non-negative integer `s`); anything else - including a source cursor that merely begins with
  // `lx1:` - is the source's own cursor and is passed through untouched. The residual ambiguity is
  // a source whose cursors are themselves valid `lx1:{"c":...,"s":...}` envelopes; none should be.
  if (raw.startsWith("lx1:")) {
    try {
      const v = JSON.parse(raw.slice(4)) as Record<string, unknown>;
      const keys = Object.keys(v);
      if (
        v !== null &&
        typeof v === "object" &&
        keys.length === 2 &&
        "c" in v &&
        "s" in v &&
        (typeof v.c === "string" || v.c === null) &&
        Number.isSafeInteger(v.s) &&
        (v.s as number) >= 0
      ) {
        return { cursor: (v.c as string | null) ?? undefined, skip: v.s as number };
      }
    } catch {
      /* a bare cursor that happens to start with the prefix */
    }
  }
  return { cursor: raw, skip: 0 };
}

interface Scan {
  shredded: boolean;
  tainted: boolean;
  origins: Set<string>;
  /** The walk hit its bound: treat the value as unsafe rather than assume it is clean. */
  overflow: boolean;
}

/** Walk a value for shred placeholders and taint, bounded; an overflow FAILS CLOSED. */
function scan(value: unknown, into: Scan): void {
  let nodes = 0;
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop() as [unknown, number];
    if (v === null || typeof v !== "object") continue;
    nodes += 1;
    if (nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) {
      into.overflow = true;
      return;
    }
    if ((v as { $shredded?: unknown }).$shredded === true) into.shredded = true;
    if (isTainted(v)) {
      into.tainted = true;
      into.origins.add(taintOf(v)?.origin ?? "unknown");
    }
    const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    for (const c of children) stack.push([c, depth + 1]);
  }
}

function stepScan(s: TrajectoryStep): Scan {
  const out: Scan = { shredded: false, tainted: false, origins: new Set(), overflow: false };
  scan(s.context, out);
  scan(s.action, out);
  scan(s.actions, out);
  scan(s.policy, out);
  if (out.overflow) {
    // The walk gave up: whatever it did not reach is unknown, so the step is treated as tainted
    // (excluded by default, flagged - never emitted unmarked - when the caller keeps tainted steps).
    out.tainted = true;
    out.origins.add("scan-overflow");
  }
  return out;
}

function pageSizeOf(n: number | undefined): number {
  const v = n ?? 100;
  if (!Number.isInteger(v) || v < 1 || v > 1000) {
    throw new Error(`exportJsonl: pageSize must be an integer in [1,1000], got ${n}`);
  }
  return v;
}

interface Group {
  prompt: unknown;
  best: { step: TrajectoryStep; reward: number };
  worst: { step: TrajectoryStep; reward: number };
  tainted: Set<string>;
}

/**
 * Stream a scoped, bounded, deterministic JSONL export. Each yielded string is one line WITHOUT a
 * trailing newline; join with "\n". Pass a `stats` object to read what was skipped and the
 * `nextCursor` when a bound stopped the run.
 *
 * Preference pairs are formed across executions: steps that made the same decision (`decisionId`)
 * in the same observation (`context`) but chose differently and scored differently give a pair
 * (best chosen, worst rejected). The grouping index is bounded, and is NOT carried across a
 * resumed cursor: pairs are formed within one run.
 */
export async function* exportJsonl(
  opts: ExportOptions,
  stats: ExportStats = newExportStats()
): AsyncGenerator<string, void, void> {
  if (typeof opts.tenant !== "string" || opts.tenant === "") {
    throw new Error("exportJsonl: tenant is required - an export is always scoped");
  }
  const kinds = new Set(opts.kinds ?? ["trajectory", "preference"]);
  const taintMode = opts.taint ?? "exclude";
  const includeContext = opts.includeContext ?? true;
  const pageSize = pageSizeOf(opts.pageSize);
  const maxExecutions = opts.maxExecutions ?? 100_000;
  const maxRecords = opts.maxRecords ?? 1_000_000;
  const maxEvents = opts.maxEventsPerExecution ?? 50_000;
  const maxLine = opts.maxLineBytes ?? 1024 * 1024;
  const maxGroups = opts.maxPreferenceGroups ?? 50_000;
  const minMargin = opts.minMargin ?? 0;
  for (const [name, v] of [
    ["maxExecutions", maxExecutions],
    ["maxRecords", maxRecords],
  ] as const) {
    // A bound of zero could never make progress, and a resumable export must always advance.
    if (!Number.isInteger(v) || v < 1)
      throw new Error(`exportJsonl: ${name} must be an integer >= 1`);
  }

  const emit = (record: Record<string, unknown>): string | undefined => {
    const line = canonicalJson(record);
    if (Buffer.byteLength(line, "utf8") > maxLine) {
      stats.skipped.lineTooLong += 1;
      return undefined;
    }
    return line;
  };

  yield canonicalJson({
    type: "header",
    format: EXPORT_FORMAT,
    tenant: opts.tenant,
    ...(opts.principal !== undefined && { principal: opts.principal }),
    kinds: [...kinds].sort(),
    taint: taintMode,
  });

  const groups = new Map<string, Group>();
  const start = decodePosition(opts.cursor);
  let pageCursor = start.cursor;
  let skip = start.skip;
  let done = false;
  let records = 0;
  const seenCursors = new Set<string>();

  outer: while (!done) {
    const page = await opts.source.list(pageCursor, pageSize);
    if (page.executions.length > pageSize) {
      throw new Error("exportJsonl: the source returned more executions than the page limit");
    }
    for (let idx = 0; idx < page.executions.length; idx++) {
      if (idx < skip) continue; // already exported by the run that produced this position
      const ref = page.executions[idx] as ExportExecutionRef;
      if (stats.executionsListed >= maxExecutions || records >= maxRecords) {
        // A resumable position INSIDE the page: (the page's own cursor, how many to skip). Resuming
        // from the page start alone would re-export the same rows forever whenever a bound is
        // smaller than a page.
        stats.truncated = true;
        stats.nextCursor = encodePosition(pageCursor, idx);
        break outer;
      }
      stats.executionsListed += 1;
      if (ref.tenant !== opts.tenant) {
        stats.skipped.otherTenant += 1;
        continue;
      }
      if (opts.principal !== undefined && ref.principal !== opts.principal) {
        stats.skipped.otherPrincipal += 1;
        continue;
      }
      const events = await opts.source.load(ref.executionId);
      if (events.length === 0 || events.some((e) => e.executionId !== ref.executionId)) {
        // Nothing there, or the loader handed back another execution's events: refuse to guess.
        stats.skipped.emptyOrMismatched += 1;
        continue;
      }
      if (events.length > maxEvents) {
        stats.skipped.tooManyEvents += 1;
        continue;
      }
      if (events.some((e) => e.eventType === "PAYLOAD_SHREDDED")) {
        stats.skipped.shreddedExecution += 1;
        continue;
      }
      // One pathological record (a context nested past the canonical-JSON bound, a value that
      // overflows the stack) must cost that record, not the export. Lines are collected and yielded
      // after the guarded section so a consumer's own throw is never swallowed here.
      const lines: string[] = [];
      try {
        const ts = trajectories(events, opts.trajectory ?? {});
        let exportedHere = false;
        for (const t of ts) {
          const kept: { step: TrajectoryStep; origins: string[] }[] = [];
          for (const s of t.steps) {
            const sc = stepScan(s);
            if (sc.overflow) {
              // The walk gave up, so a shred placeholder or taint past its bound cannot be ruled
              // out. Erasure has no "keep" option and a mark could not say what is unmarked: the
              // step is skipped in EVERY mode.
              stats.skipped.scanOverflow += 1;
              continue;
            }
            if (sc.shredded) {
              stats.skipped.shreddedStep += 1;
              continue;
            }
            if (sc.tainted && taintMode === "exclude") {
              stats.skipped.taintedStep += 1;
              continue;
            }
            kept.push({ step: s, origins: [...sc.origins].sort() });
          }
          if (kept.length === 0) continue;
          if (kinds.has("trajectory")) {
            const line = emit(trajectoryRecord(t, kept, includeContext));
            if (line !== undefined) {
              exportedHere = true;
              records += 1;
              stats.records.trajectory += 1;
              lines.push(line);
            }
          }
          if (kinds.has("preference")) {
            for (const k of kept) indexPreference(groups, k.step, k.origins, maxGroups, stats);
          }
        }
        if (exportedHere || kinds.has("preference")) stats.executionsExported += 1;
      } catch {
        stats.skipped.recordError += 1;
        lines.length = 0;
      }
      for (const l of lines) yield l;
    }
    skip = 0;
    if (page.next === undefined) {
      done = true;
    } else {
      // The next cursor must be one we have not been to: an empty page that repeats it (or a
      // source whose cursors cycle) would otherwise loop forever.
      if (page.next === pageCursor || seenCursors.has(page.next) || seenCursors.size >= MAX_PAGES) {
        throw new Error("exportJsonl: the source's cursor did not advance");
      }
      if (pageCursor !== undefined) seenCursors.add(pageCursor);
      pageCursor = page.next;
    }
  }

  if (kinds.has("preference")) {
    for (const g of groups.values()) {
      const margin = g.best.reward - g.worst.reward;
      if (!(margin > minMargin)) continue;
      if (stableKey(g.best.step.action) === stableKey(g.worst.step.action)) continue;
      if (records >= maxRecords) {
        stats.preferencesTruncated = true;
        break;
      }
      let line: string | undefined;
      try {
        line = emit({
          type: "preference",
          ...(includeContext && { prompt: g.prompt }),
          chosen: g.best.step.action,
          rejected: g.worst.step.action,
          margin,
          chosenRef: ref(g.best.step),
          rejectedRef: ref(g.worst.step),
          ...(g.tainted.size > 0 && { tainted: true, taintOrigins: [...g.tainted].sort() }),
        });
      } catch {
        stats.skipped.recordError += 1;
        continue;
      }
      if (line !== undefined) {
        records += 1;
        stats.records.preference += 1;
        yield line;
      }
    }
  }
  yield canonicalJson({ type: "summary", ...stats });
}

const ref = (s: TrajectoryStep) => ({
  executionId: s.executionId,
  decisionId: s.decisionId,
  ...(s.policy !== undefined && { policy: `${s.policy.id}@${s.policy.version}` }),
});

function trajectoryRecord(
  t: Trajectory,
  kept: { step: TrajectoryStep; origins: string[] }[],
  includeContext: boolean
): Record<string, unknown> {
  const origins = new Set<string>();
  for (const k of kept) for (const o of k.origins) origins.add(o);
  return {
    type: "trajectory",
    executionId: t.executionId,
    ...(t.unit !== undefined && { unit: t.unit }),
    outcome: t.outcome,
    ...(t.terminalReward !== undefined && { terminalReward: t.terminalReward }),
    steps: kept.map(({ step: s, origins: o }) => ({
      decisionId: s.decisionId,
      sequence: s.sequence,
      timestamp: s.timestamp,
      ...(includeContext && s.context !== undefined && { context: s.context }),
      action: s.action,
      actions: s.actions,
      ...(s.policy !== undefined && { policy: s.policy }),
      ...(s.refs !== undefined && { refs: s.refs }),
      ...(s.reward !== undefined && { reward: s.reward }),
      rewardSource: s.rewardSource,
      ...(o.length > 0 && { tainted: true, taintOrigins: o }),
    })),
    ...(origins.size > 0 && { tainted: true, taintOrigins: [...origins].sort() }),
  };
}

function indexPreference(
  groups: Map<string, Group>,
  step: TrajectoryStep,
  origins: string[],
  maxGroups: number,
  stats: ExportStats
): void {
  if (step.reward === undefined || step.context === undefined || !Number.isFinite(step.reward)) {
    return;
  }
  const key = `${step.decisionId}\u0000${stableKey(step.context)}`;
  let g = groups.get(key);
  if (g === undefined) {
    if (groups.size >= maxGroups) {
      stats.skipped.preferenceGroupsDropped += 1;
      return;
    }
    g = {
      prompt: step.context,
      best: { step, reward: step.reward },
      worst: { step, reward: step.reward },
      tainted: new Set(),
    };
    groups.set(key, g);
  } else {
    // Strict comparisons: a tie keeps the EARLIER step, so the output does not depend on anything
    // but source order.
    if (step.reward > g.best.reward) g.best = { step, reward: step.reward };
    if (step.reward < g.worst.reward) g.worst = { step, reward: step.reward };
  }
  for (const o of origins) g.tainted.add(o);
}
