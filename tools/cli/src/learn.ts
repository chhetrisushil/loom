import path from "node:path";
import type { EventEnvelope } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import {
  evaluatePolicy,
  formatEvalReport,
  promotionGate,
  steps,
  trajectories,
} from "@loom/learning";
import type { Policy, Trajectory } from "@loom/learning";
import { evidenceEvents } from "@loom/learning";
import { ReplayVM, normalizeSnapshotState } from "@loom/replay-vm";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import { type StoreFlags, resolveStores } from "./stores";

/**
 * `loom learn …` — the offline half of the learning loop (ADR 0080).
 *
 * Both commands are read-only over the log and run out of band; nothing here ever
 * touches a live execution. Adopting a policy remains an explicit wiring change in
 * application code, and the choice it then makes is still a logged `ctx.decide`.
 */

/** What the learner could read, and what it knows it could NOT. */
interface Evidence {
  events: EventEnvelope[];
  /** Executions whose evidence came from a checkpoint's fold (compacted logs, read correctly). */
  folded: number;
  /** Executions whose log looks compacted while no snapshot store is configured: evidence LOST. */
  unreadable: string[];
}

/** A log with a hole in its sequences was compacted: events below the checkpoint are gone. */
const looksCompacted = (log: readonly EventEnvelope[]): boolean =>
  log.some((e, i) => e.sequence !== i);

/**
 * ADR 0116 — a compacted execution's decisions and outcomes live in its checkpoint, not its log,
 * so a log read alone silently loses them. With a snapshot store the evidence is rebuilt from the
 * folded state (`evidenceEvents`); without one a compacted log is reported, never read quietly.
 */
async function evidenceOf(
  store: EventStore,
  snapshots: SnapshotStore | undefined,
  id: string
): Promise<{ events: EventEnvelope[]; folded: boolean; unreadable: boolean }> {
  const log = await store.read(id);
  const compacted = looksCompacted(log);
  if (snapshots === undefined) {
    return { events: log, folded: false, unreadable: compacted };
  }
  const snapshot = await snapshots.loadLatest(id);
  const first = log[0];
  if (snapshot === null || first === undefined) {
    return { events: log, folded: false, unreadable: compacted };
  }
  const tail = await store.readFrom(id, snapshot.sequence + 1);
  const state = new ReplayVM(tail, {
    ...normalizeSnapshotState(snapshot.state),
    executionId: id,
    workflowId: first.workflowId,
  }).getState();
  return { events: evidenceEvents(state, log), folded: compacted, unreadable: false };
}

async function readAll(flags: StoreFlags, executionId?: string): Promise<Evidence> {
  const resolved = await resolveStores(flags);
  const store = resolved.eventStore;
  try {
    let ids: string[];
    if (executionId !== undefined) ids = [executionId];
    else {
      // listExecutions is OPTIONAL on the EventStore SPI (1.1.0) — a store without it
      // can still be asked for one execution, so say that rather than crashing.
      if (store.listExecutions === undefined) {
        throw new Error(
          "this event store cannot enumerate executions — pass an explicit <executionId>"
        );
      }
      ids = await store.listExecutions();
    }
    const out: Evidence = { events: [], folded: 0, unreadable: [] };
    for (const id of ids) {
      const got = await evidenceOf(store, resolved.snapshotStore, id);
      out.events.push(...got.events);
      if (got.folded) out.folded++;
      if (got.unreadable) out.unreadable.push(id);
    }
    return out;
  } finally {
    await resolved.close();
  }
}

/** The warning a learner must not miss: evidence that is GONE from what it just read. */
export function compactionNotice(e: Evidence): string[] {
  if (e.unreadable.length === 0) return [];
  const shown = e.unreadable.slice(0, 5).join(", ");
  return [
    "",
    `  ! ${e.unreadable.length} execution(s) look compacted and no snapshot store is configured, so their decisions and outcomes (folded into the checkpoint) are NOT in this report: ${shown}${e.unreadable.length > 5 ? ", …" : ""}`,
    "    pass --snap <snap.db> (or --config <module>) so the learner reads them from the folded state (ADR 0116)",
  ];
}

/** `loom learn report --db <path> [executionId]` — what the log can and cannot teach. */
export async function cmdLearnReport(flags: StoreFlags, executionId?: string): Promise<string> {
  const evidence = await readAll(flags, executionId);
  const { events } = evidence;
  const notice = compactionNotice(evidence);
  if (events.length === 0) return ["(no events)", ...notice].join("\n");

  const ts = trajectories(events);
  const all = steps(ts);
  if (all.length === 0) {
    return ["(no decisions recorded — nothing to learn from)", ...notice].join("\n");
  }

  const withContext = all.filter((s) => s.context !== undefined).length;
  const withPropensity = all.filter((s) => s.policy?.propensity !== undefined).length;
  const scored = all.filter((s) => s.rewardSource === "direct").length;
  const terminal = all.filter((s) => s.rewardSource === "terminal").length;
  const unscored = all.filter((s) => s.rewardSource === "none").length;

  // Per-arm evidence, best-first — the same shape @loom/reasoning's ucb1 consumes.
  const arms = new Map<string, { n: number; sum: number }>();
  for (const s of all) {
    if (s.reward === undefined) continue;
    const key = typeof s.action === "string" ? s.action : JSON.stringify(s.action);
    const cur = arms.get(key) ?? { n: 0, sum: 0 };
    cur.n += 1;
    cur.sum += s.reward;
    arms.set(key, cur);
  }
  const ranked = [...arms.entries()]
    .map(([key, v]) => ({ key, count: v.n, rank: v.sum / v.n }))
    .sort((a, b) => b.rank - a.rank);

  const pct = (n: number) => `${((n / all.length) * 100).toFixed(0)}%`;
  const lines = [
    `Learning report — ${ts.length} execution(s), ${all.length} decision(s)${evidence.folded > 0 ? ` (${evidence.folded} compacted execution(s) read from their checkpoints)` : ""}`,
    "",
    "  Coverage",
    `    with context      ${withContext} (${pct(withContext)})`,
    `    with propensity   ${withPropensity} (${pct(withPropensity)})`,
    `    scored directly   ${scored} (${pct(scored)})`,
    `    terminal credit   ${terminal} (${pct(terminal)})`,
    `    unscored          ${unscored} (${pct(unscored)})`,
    "",
    "  Arms (mean reward, best first)",
  ];
  for (const a of ranked) {
    lines.push(`    ${a.key.padEnd(24)} ${a.rank.toFixed(4)}  n=${a.count}`);
  }
  if (ranked.length === 0) lines.push("    (nothing scored)");

  const blockers: string[] = [];
  if (withContext === 0) {
    blockers.push(
      "no decision recorded a context — pass one via decideWithPolicy (or ctx.decide's `context`) or no contextual policy is learnable"
    );
  }
  if (withPropensity === 0) {
    blockers.push(
      "no decision recorded a propensity — off-policy evaluation will be agreement-only until one does"
    );
  }
  if (scored === 0) {
    blockers.push(
      "no outcome names a decisionId — rewards are being aggregated globally, not per decision"
    );
  }
  if (blockers.length > 0) {
    lines.push("", "  Blocking gaps:");
    for (const b of blockers) lines.push(`    ! ${b}`);
  }
  lines.push(...notice);
  return lines.join("\n");
}

/**
 * `loom learn eval --db <path> --policy <module> [--min-steps N]` — shadow-evaluate a
 * candidate against historical traffic. The module must export a `Policy` (default
 * export, or a named `policy`). Exit code is non-zero when the promotion gate refuses.
 */
export async function cmdLearnEval(
  flags: StoreFlags,
  policyModule: string,
  opts: { executionId?: string; minSteps?: number } = {}
): Promise<{ text: string; ok: boolean }> {
  const resolved = path.isAbsolute(policyModule)
    ? policyModule
    : path.resolve(process.cwd(), policyModule);
  const loaded = (await import(resolved)) as Record<string, unknown>;
  const candidate = (loaded.policy ?? loaded.default) as Policy<unknown> | undefined;
  if (
    candidate === undefined ||
    typeof candidate.select !== "function" ||
    typeof candidate.id !== "string"
  ) {
    return {
      text: `${policyModule} does not export a Policy (expected \`policy\` or a default export with id/version/select)`,
      ok: false,
    };
  }

  const evidence = await readAll(flags, opts.executionId);
  const ts = trajectories(evidence.events) as Trajectory<unknown>[];
  const report = evaluatePolicy(ts, candidate);
  const verdict = promotionGate(
    report,
    opts.minSteps !== undefined ? { minSteps: opts.minSteps } : {}
  );

  const lines = [formatEvalReport(report), ""];
  lines.push(verdict.ok ? "  GATE: pass" : "  GATE: refused");
  for (const r of verdict.reasons) lines.push(`    - ${r}`);
  lines.push(...compactionNotice(evidence));
  return { text: lines.join("\n"), ok: verdict.ok };
}
