import type { ExecutionState, ExecutionStatus, SuspendCondition } from "@loom/core";
import {
  type EventStore,
  type LeaseStore,
  isReservedStream,
  iterateExecutionIds,
} from "@loom/event-runtime";
import { UsageError } from "./args";
import { foldAt } from "./core";
import { humanizeDuration } from "./duration";
import { type StoreFlags, resolveStores } from "./stores";

// ── `loom ls` — which executions exist, and what is each one waiting on ───────
//
// Read-only. One paged pass over the store's enumeration (`iterateExecutionIds`, bounded
// memory), one read + fold per execution scanned: O(executions scanned), each fold linear in
// that execution's own log. It stops at `--limit` matches, and at a scan cap when a filter
// matches little, and says which — a silently partial list reads as a complete one.

export const LS_STATUSES = [
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
  "continued",
] as const satisfies readonly ExecutionStatus[];

/** Default `--limit`. */
export const LS_DEFAULT_LIMIT = 50;
/** Executions folded before the scan gives up (so a filter that matches nothing is bounded). */
export const LS_MAX_SCAN = 5000;

export interface ExecutionRow {
  executionId: string;
  workflowId: string;
  status: ExecutionStatus;
  /** Sequence of the last event in the log. */
  sequence: number;
  /** Epoch ms of the last event. */
  lastActivityAt: number;
  /** What a suspended execution waits on. */
  waiting?: { on: string; wakeAt?: number; timeoutMs?: number; correlationKey?: string };
  /** Present only when a lease store was given and the execution holds an unexpired lease. */
  lease?: { owner: string; expiresAt: number; expired: boolean };
}

export interface LsOptions {
  status?: ExecutionStatus;
  workflow?: string;
  /** Only executions with activity within this many ms of `now`. */
  sinceMs?: number;
  limit?: number;
  maxScan?: number;
  now?: number;
  leases?: LeaseStore;
}

export interface LsResult {
  rows: ExecutionRow[];
  /** Executions read and folded (reserved control streams excluded). */
  scanned: number;
  /** Why the list ended early, if it did. */
  truncated?: "limit" | "scan-cap";
  /** Executions whose log could not be folded (counted, not listed). */
  unreadable: number;
}

/** The refusal for a store that cannot enumerate — the same wording as `loom census`. */
export function requireEnumerable(events: EventStore, command: string): void {
  if (events.listExecutions === undefined && events.listExecutionsPage === undefined) {
    throw new UsageError(
      `loom ${command} needs to enumerate executions, and the configured ${events.constructor.name} implements neither listExecutions nor listExecutionsPage.`
    );
  }
}

/**
 * When a parked execution's timer fires: the condition's own `wakeAt` (`ctx.sleep`, a gate
 * timeout), else the earliest timer arm of a multi-wait park (`ctx.select`).
 */
export function wakeAtOf(s: SuspendCondition | undefined): number | undefined {
  if (s === undefined) return undefined;
  if (s.wakeAt !== undefined) return s.wakeAt;
  let min: number | undefined;
  for (const w of s.waits ?? []) {
    if (
      w.kind === "timer" &&
      typeof w.wakeAt === "number" &&
      (min === undefined || w.wakeAt < min)
    ) {
      min = w.wakeAt;
    }
  }
  return min;
}

export function rowOf(
  executionId: string,
  state: ExecutionState,
  last: { sequence: number; timestamp: number }
): ExecutionRow {
  const s = state.suspendedOn;
  const wakeAt = wakeAtOf(s);
  return {
    executionId,
    workflowId: state.workflowId,
    status: state.status,
    sequence: last.sequence,
    lastActivityAt: last.timestamp,
    ...(state.status === "suspended" &&
      s !== undefined && {
        waiting: {
          on: s.on,
          ...(wakeAt !== undefined && { wakeAt }),
          ...(s.timeout !== undefined && { timeoutMs: s.timeout }),
          ...(s.correlationKey !== undefined && { correlationKey: s.correlationKey }),
        },
      }),
  };
}

/** Scan, fold and filter. Never writes. */
export async function scanExecutions(
  events: EventStore,
  options: LsOptions = {}
): Promise<LsResult> {
  requireEnumerable(events, "ls");
  const limit = options.limit ?? LS_DEFAULT_LIMIT;
  const maxScan = options.maxScan ?? LS_MAX_SCAN;
  const now = options.now ?? Date.now();
  const result: LsResult = { rows: [], scanned: 0, unreadable: 0 };
  // Judged on the lease store's own clock when it has one (a shared database stamps its own).
  const leaseNow =
    options.leases === undefined ? now : ((await options.leases.storeNow?.()) ?? now);
  if (limit === 0) {
    result.truncated = "limit";
    return result;
  }
  for await (const executionId of iterateExecutionIds(events, 500)) {
    if (isReservedStream(executionId)) continue;
    if (result.scanned >= maxScan) {
      result.truncated = "scan-cap";
      break;
    }
    result.scanned++;
    let log: Awaited<ReturnType<EventStore["read"]>>;
    let state: ExecutionState;
    try {
      log = await events.read(executionId);
      if (log.length === 0) continue;
      state = foldAt(log);
    } catch {
      result.unreadable++;
      continue;
    }
    const tip = log[log.length - 1] as (typeof log)[number];
    const row = rowOf(executionId, state, tip);
    if (options.status !== undefined && row.status !== options.status) continue;
    if (options.workflow !== undefined && row.workflowId !== options.workflow) continue;
    if (options.sinceMs !== undefined && now - row.lastActivityAt > options.sinceMs) continue;
    if (options.leases?.get !== undefined) {
      const lease = await options.leases.get(executionId);
      if (lease !== null) {
        row.lease = {
          owner: lease.owner,
          expiresAt: lease.expiresAt,
          expired: lease.expiresAt <= leaseNow,
        };
      }
    }
    result.rows.push(row);
    if (result.rows.length >= limit) {
      result.truncated = "limit";
      break;
    }
  }
  return result;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** `3m ago` / `in 3m` — a human anchor next to an absolute time. */
export function relative(ms: number, now: number): string {
  const delta = ms - now;
  const abs = Math.abs(delta);
  const span =
    abs < 1000
      ? "now"
      : humanizeDuration(
          abs >= 86_400_000
            ? Math.round(abs / 86_400_000) * 86_400_000
            : abs >= 3_600_000
              ? Math.round(abs / 3_600_000) * 3_600_000
              : abs >= 60_000
                ? Math.round(abs / 60_000) * 60_000
                : Math.round(abs / 1000) * 1000
        );
  if (span === "now") return "now";
  return delta < 0 ? `${span} ago` : `in ${span}`;
}

/** What a row waits on, in one phrase. */
export function describeWaiting(row: ExecutionRow, now: number): string {
  const w = row.waiting;
  if (w === undefined) return "";
  const parts: string[] = [];
  if (w.wakeAt !== undefined) {
    const overdue = w.wakeAt < now;
    parts.push(
      `timer wakeAt ${iso(w.wakeAt)} (${relative(w.wakeAt, now)}${overdue ? ", overdue" : ""})`
    );
    if (w.on !== "" && w.on !== "timer") parts.push(`or event ${w.on}`);
  } else parts.push(`event ${w.on}`);
  return parts.join(" ");
}

function leaseText(row: ExecutionRow, now: number): string {
  if (row.lease === undefined) return "";
  return `lease ${row.lease.owner} (${row.lease.expired ? "expired" : "expires"} ${relative(row.lease.expiresAt, now)})`;
}

export function renderLs(result: LsResult, options: { limit: number; now?: number }): string {
  const now = options.now ?? Date.now();
  const lines: string[] = [];
  if (result.rows.length === 0) lines.push("(no executions match)");
  else {
    const rows = result.rows.map((r) => ({
      id: r.executionId,
      wf: r.workflowId,
      status: r.status,
      seq: `#${r.sequence}`,
      at: `${iso(r.lastActivityAt)} (${relative(r.lastActivityAt, now)})`,
      extra: [describeWaiting(r, now), leaseText(r, now)].filter((x) => x !== "").join("; "),
    }));
    const w = (k: "id" | "wf" | "status" | "seq" | "at", head: string) =>
      Math.max(head.length, ...rows.map((r) => r[k].length));
    const [wi, ww, ws, wq, wa] = [
      w("id", "ID"),
      w("wf", "WORKFLOW"),
      w("status", "STATUS"),
      w("seq", "LAST"),
      w("at", "LAST ACTIVITY"),
    ];
    lines.push(
      `${"ID".padEnd(wi)}  ${"WORKFLOW".padEnd(ww)}  ${"STATUS".padEnd(ws)}  ${"LAST".padEnd(wq)}  ${"LAST ACTIVITY".padEnd(wa)}  WAITING ON`
    );
    for (const r of rows) {
      lines.push(
        `${r.id.padEnd(wi)}  ${r.wf.padEnd(ww)}  ${r.status.padEnd(ws)}  ${r.seq.padEnd(wq)}  ${r.at.padEnd(wa)}  ${r.extra}`.trimEnd()
      );
    }
  }
  lines.push(
    "",
    `${result.rows.length} shown, ${result.scanned} execution(s) scanned${
      result.unreadable > 0 ? `, ${result.unreadable} unreadable (skipped)` : ""
    }`
  );
  if (result.truncated === "limit") {
    lines.push(`truncated at --limit ${options.limit}: more may match (raise --limit).`);
  } else if (result.truncated === "scan-cap") {
    lines.push(
      `stopped after scanning ${result.scanned} executions: the store holds more. Narrow with --status/--workflow/--since or use \`loom census\`.`
    );
  }
  return lines.join("\n");
}

export interface LsFlags extends StoreFlags {
  status?: ExecutionStatus;
  workflow?: string;
  sinceMs?: number;
  limit?: number;
}

/** `loom ls`: the structured result plus whether leases were consultable. */
export async function lsReport(
  flags: LsFlags
): Promise<{ result: LsResult; limit: number; hasLeases: boolean }> {
  const stores = await resolveStores(flags);
  try {
    const limit = flags.limit ?? LS_DEFAULT_LIMIT;
    const result = await scanExecutions(stores.eventStore, {
      limit,
      ...(flags.status !== undefined && { status: flags.status }),
      ...(flags.workflow !== undefined && { workflow: flags.workflow }),
      ...(flags.sinceMs !== undefined && { sinceMs: flags.sinceMs }),
      ...(stores.leaseStore !== undefined && { leases: stores.leaseStore }),
    });
    return { result, limit, hasLeases: stores.leaseStore !== undefined };
  } finally {
    await stores.close();
  }
}

export async function cmdLs(flags: LsFlags): Promise<string> {
  const { result, limit } = await lsReport(flags);
  return renderLs(result, { limit });
}
