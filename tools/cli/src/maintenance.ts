import { EffectRuntime } from "@loom/effect-runtime";
import { isReservedStream } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  WorkflowRuntime,
  pruneBranchRefs,
  recoverAbandoned,
  retireAbandonedBranches,
} from "@loom/workflow-runtime";
import { parseDuration } from "./duration";
import { type ResolvedStores, type StoreFlags, resolveStores } from "./stores";

// ── The maintenance passes, as operator commands ─────────────────────────────
//
// Three passes shipped as library functions with no front door: recovering executions whose
// supervisor died, retiring branches nobody is coming back to, and pruning refs that name
// nothing. Each one is a scheduled job somebody has to write TypeScript to run, which is the
// same half-delivered shape the census had before `loom census`.
//
// All three WRITE, so all three are dry by default and act only under `--apply` — the
// vocabulary `retention` and `sweep content` already use. The preview comes from the pass
// itself (`dryRun`), never from a second implementation beside it.

/** A read-only runtime for previews: folding state needs the log, not the flows. */
function foldingRuntime(stores: ResolvedStores): WorkflowRuntime {
  return new WorkflowRuntime({
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore ?? new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    onWarn: () => {},
  });
}

function head(action: string, apply: boolean, detail: string): string {
  return `${action} ${apply ? "run" : "DRY RUN (pass --apply to act)"} — ${detail}`;
}

/**
 * `loom recover (--config <module> | --db <events.db>) [--stale 15m] [--owner <id>]
 *   [--limit N] [--max-recoveries N] [--apply]`
 *
 * Re-drives executions whose supervisor died. Two ways to decide what counts as abandoned,
 * and the command insists on one of them:
 *
 * - the app wires `timers.leases`, and an EXPIRED lease is the evidence; or
 * - `--stale <duration>`, which makes the operator's staleness rule explicit at the prompt.
 *
 * Neither is defaulted, for the reason `recoverAbandoned` refuses to default it: a running
 * execution owned by a healthy node elsewhere looks exactly like an orphaned one.
 */
export async function cmdRecover(
  flags: StoreFlags & {
    stale?: string;
    owner?: string;
    limit?: number;
    /** ADR 0105 — skip executions whose last N re-drives made no progress (≥ 1). */
    maxRecoveries?: number;
    apply: boolean;
  }
): Promise<string> {
  if (
    flags.maxRecoveries !== undefined &&
    (!Number.isSafeInteger(flags.maxRecoveries) || flags.maxRecoveries < 1)
  ) {
    return "loom recover: --max-recoveries must be an integer ≥ 1 (0 would skip every execution).";
  }
  const stores = await resolveStores(flags);
  try {
    const staleMs = flags.stale === undefined ? undefined : parseDuration(flags.stale);
    if (stores.leaseStore === undefined && staleMs === undefined) {
      return [
        "loom recover needs to know what counts as abandoned, and will not guess:",
        "  • wire `timers.leases` in your app — an expired lease is evidence, not a guess; or",
        "  • pass --stale <duration> to state your rule explicitly (e.g. --stale 15m).",
        "A running execution owned by a healthy node is byte-identical to an orphaned one.",
      ].join("\n");
    }

    // Without leases the candidate set comes from enumerating the log, which is an OPTIONAL
    // capability. Name it and the store, rather than letting the library throw.
    if (stores.leaseStore === undefined && stores.eventStore.listExecutions === undefined) {
      return `loom recover has no --stale candidates to scan: the configured ${stores.eventStore.constructor.name} does not implement listExecutions. Wire \`timers.leases\` — expired leases enumerate themselves.`;
    }

    // Re-driving runs the flow's steps, so it needs the app's registered flows and effects.
    // The shorthand can only ever LOOK.
    if (flags.apply && stores.runtime === undefined) {
      return [
        "loom recover --apply needs --config <module>: re-driving an execution runs its steps,",
        "and only your app has the flows and effects registered. The --db shorthand can preview",
        "(drop --apply), but recovering through it would fail every execution it touched.",
      ].join("\n");
    }

    const runtime = stores.runtime ?? foldingRuntime(stores);
    const found: string[] = [];
    const failed: string[] = [];
    const exhausted: string[] = [];
    const summary = await recoverAbandoned(runtime, {
      ...(stores.eventStore.listExecutions !== undefined && {
        source: {
          listExecutions: async () =>
            (await stores.eventStore.listExecutions!()).filter((id) => !isReservedStream(id)),
        },
      }),
      ...(stores.leaseStore !== undefined && {
        leases: { store: stores.leaseStore, owner: flags.owner ?? "loom-recover", ttlMs: 60_000 },
      }),
      ...(staleMs !== undefined && {
        isAbandoned: (c) => Date.now() - c.updatedAt > staleMs,
      }),
      ...(flags.limit !== undefined && { limit: flags.limit }),
      ...(flags.maxRecoveries !== undefined && {
        maxRecoveries: flags.maxRecoveries,
        onExhausted: (id: string, n: number) => exhausted.push(`${id} (${n})`),
      }),
      dryRun: !flags.apply,
      fenced: true,
      onCandidate: (id) => found.push(id),
      onError: (id) => failed.push(id),
    });

    const evidence =
      stores.leaseStore !== undefined
        ? staleMs === undefined
          ? "expired leases"
          : `expired leases, narrowed by --stale ${flags.stale}`
        : `--stale ${flags.stale} (your rule, not loom's)`;
    const lines = [
      head("recover", flags.apply, `${summary.scanned} scanned — evidence: ${evidence}`),
    ];
    // Exhausted executions are reported whatever else happened: they are the ones an operator
    // must act on (cancel, or fix and re-drive), because no pass will touch them again.
    const exhaustedLines =
      exhausted.length > 0
        ? [
            `exhausted: ${summary.exhausted} (no progress in the last ${flags.maxRecoveries} re-drives; left for you)`,
            ...exhausted.map((id) => `  ${id}`),
          ]
        : [];
    if (found.length === 0) {
      return [`${lines[0]}`, "  (nothing abandoned)", ...exhaustedLines].join("\n");
    }
    lines.push(
      ...found.map((id) => `  ${id.padEnd(28)} ${flags.apply ? "recovered" : "would recover"}`)
    );
    if (flags.apply) lines.push(`recovered: ${summary.recovered}  failed: ${summary.failed}`);
    else lines.push(`would recover: ${found.length}`);
    if (failed.length > 0) lines.push(`  failed: ${failed.join(", ")}`);
    lines.push(...exhaustedLines);
    return lines.join("\n");
  } finally {
    await stores.close();
  }
}

/**
 * `loom branches retire <store> --parent <executionId> --stale <duration> [--limit N] [--apply]`
 *
 * Cancels branches nobody is coming back to, so the parent they pin stops being uncollectable.
 * `--stale` is required and has no default: a branch parked on a human gate is someone's open
 * question, and only the deployment knows whether that person is still coming.
 */
export async function cmdBranchesRetire(
  flags: StoreFlags & { parent: string; stale?: string; limit?: number; apply: boolean }
): Promise<string> {
  const stores = await resolveStores(flags);
  try {
    if (stores.branchRegistry === undefined) {
      return stores.origin === "config"
        ? "loom branches retire needs a branchRegistry, and this app wires none (so nothing has been forked)."
        : "loom branches retire needs --branches <branches.db> (or --config, where the app supplies it).";
    }
    if (flags.stale === undefined) {
      return "loom branches retire needs --stale <duration> (e.g. --stale 7d): a branch parked on a gate is an open question, not garbage, and loom will not decide that for you.";
    }
    const staleMs = parseDuration(flags.stale);

    const runtime = stores.runtime ?? foldingRuntime(stores);
    const found: string[] = [];
    const summary = await retireAbandonedBranches(runtime, stores.branchRegistry, flags.parent, {
      isAbandoned: (c) => Date.now() - c.updatedAt > staleMs,
      ...(flags.limit !== undefined && { limit: flags.limit }),
      dryRun: !flags.apply,
      onCandidate: (c) => found.push(c.executionId),
    });

    const lines = [
      head(
        "branches retire",
        flags.apply,
        `parent ${flags.parent} — ${summary.scanned} branch(es)`
      ),
    ];
    if (found.length === 0) lines.push("  (none older than --stale)");
    else
      lines.push(
        ...found.map((id) => `  ${id.padEnd(28)} ${flags.apply ? "retired" : "would retire"}`)
      );
    // What stays open is the answer to "why is the parent still not collectable?", so it is
    // part of the report rather than something to infer from a smaller number.
    for (const r of summary.remaining) {
      lines.push(
        `  ${r.executionId.padEnd(28)} still open${r.suspendedOn ? ` (${r.suspendedOn})` : ""}`
      );
    }
    return lines.join("\n");
  } finally {
    await stores.close();
  }
}

/**
 * `loom branches prune <store> [--protect main,release] [--limit N] [--apply]`
 *
 * Deletes refs that name executions the log no longer has. `main` is protected by default:
 * deleting it turns "main names a ghost" into "there is no main", which is harder to
 * diagnose, not easier.
 */
export async function cmdBranchesPrune(
  flags: StoreFlags & { protect?: string; limit?: number; apply: boolean }
): Promise<string> {
  const stores = await resolveStores(flags);
  try {
    if (stores.branchRegistry === undefined) {
      return stores.origin === "config"
        ? "loom branches prune needs a branchRegistry, and this app wires none (so there are no refs to prune)."
        : "loom branches prune needs --branches <branches.db> (or --config, where the app supplies it).";
    }
    const protect =
      flags.protect === undefined
        ? undefined
        : flags.protect
            .split(",")
            .map((n) => n.trim())
            .filter((n) => n.length > 0);

    const found: string[] = [];
    const summary = await pruneBranchRefs(stores.eventStore, stores.branchRegistry, {
      ...(protect !== undefined && { protect }),
      ...(flags.limit !== undefined && { limit: flags.limit }),
      dryRun: !flags.apply,
      onCandidate: (name) => found.push(name),
    });

    const lines = [
      head(
        "branches prune",
        flags.apply,
        `${summary.scanned} ref(s), ${summary.dangling} dangling`
      ),
    ];
    if (found.length === 0) lines.push("  (nothing dangling that is not protected)");
    else
      lines.push(
        ...found.map((name) => `  ${name.padEnd(28)} ${flags.apply ? "deleted" : "would delete"}`)
      );
    if (summary.protectedDangling.length > 0) {
      lines.push(
        `  ⚠ protected but dangling: ${summary.protectedDangling.join(", ")} — these name executions that no longer exist`
      );
    }
    return lines.join("\n");
  } finally {
    await stores.close();
  }
}
