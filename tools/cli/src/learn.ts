import path from "node:path";
import {
  evaluatePolicy,
  formatEvalReport,
  promotionGate,
  steps,
  trajectories,
} from "@loom/learning";
import type { Policy, Trajectory } from "@loom/learning";
import { SqliteEventStore } from "@loom/plugin-sqlite";

/**
 * `loom learn …` — the offline half of the learning loop (ADR 0080).
 *
 * Both commands are read-only over the log and run out of band; nothing here ever
 * touches a live execution. Adopting a policy remains an explicit wiring change in
 * application code, and the choice it then makes is still a logged `ctx.decide`.
 */

async function readAll(db: string, executionId?: string) {
  const store = new SqliteEventStore(db);
  try {
    if (executionId !== undefined) return await store.read(executionId);
    // listExecutions is OPTIONAL on the EventStore SPI (1.1.0) — a store without it
    // can still be asked for one execution, so say that rather than crashing.
    if (store.listExecutions === undefined) {
      throw new Error(
        "this event store cannot enumerate executions — pass an explicit <executionId>"
      );
    }
    const ids = await store.listExecutions();
    const logs = await Promise.all(ids.map((id) => store.read(id)));
    return logs.flat();
  } finally {
    await store.close();
  }
}

/** `loom learn report --db <path> [executionId]` — what the log can and cannot teach. */
export async function cmdLearnReport(db: string, executionId?: string): Promise<string> {
  const events = await readAll(db, executionId);
  if (events.length === 0) return "(no events)";

  const ts = trajectories(events);
  const all = steps(ts);
  if (all.length === 0) return "(no decisions recorded — nothing to learn from)";

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
    `Learning report — ${ts.length} execution(s), ${all.length} decision(s)`,
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
  return lines.join("\n");
}

/**
 * `loom learn eval --db <path> --policy <module> [--min-steps N]` — shadow-evaluate a
 * candidate against historical traffic. The module must export a `Policy` (default
 * export, or a named `policy`). Exit code is non-zero when the promotion gate refuses.
 */
export async function cmdLearnEval(
  db: string,
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

  const events = await readAll(db, opts.executionId);
  const ts = trajectories(events) as Trajectory<unknown>[];
  const report = evaluatePolicy(ts, candidate);
  const verdict = promotionGate(
    report,
    opts.minSteps !== undefined ? { minSteps: opts.minSteps } : {}
  );

  const lines = [formatEvalReport(report), ""];
  lines.push(verdict.ok ? "  GATE: pass" : "  GATE: refused");
  for (const r of verdict.reasons) lines.push(`    - ${r}`);
  return { text: lines.join("\n"), ok: verdict.ok };
}
