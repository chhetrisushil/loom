import {
  type BlankStreamCensus,
  LogLifecycle,
  type RehomeAssignment,
} from "@loom/workflow-runtime";
import { type StoreFlags, resolveStores } from "./stores";

// ── `loom repair blank-stream` — the pre-0106 compaction bug's misfiled events (ADR 0107) ─
//
// Before ADR 0106, every resume that followed a compaction wrote its events to execution `""`.
// This command is the operator half of the library repair: it censuses that stream, re-homes
// what a snapshot PROVES belongs to an execution, and lists what nothing proves together with
// the executions that could have written it. Dry by default, like every command that writes.
//
// It never attributes by guesswork. A range the operator knows the owner of (from the app's
// own records) is asserted with `--assign`, and even then the repair checks that it folds onto
// that execution's snapshot before writing it.

/** `e1:13-15,e7:20-22` → assignments. */
export function parseAssignments(spec: string): RehomeAssignment[] {
  return spec
    .split(",")
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const m = /^(.+):(\d+)-(\d+)$/.exec(raw);
      if (m === null) {
        throw new Error(`invalid --assign "${raw}" (expected <executionId>:<from>-<through>)`);
      }
      return {
        executionId: m[1]!,
        fromSequence: Number(m[2]),
        throughSequence: Number(m[3]),
      };
    });
}

export function renderBlankStream(
  census: BlankStreamCensus,
  apply: boolean,
  rehomed: number,
  failed: ReadonlyArray<{ executionId: string; error: string }> = []
): string {
  const lines = [
    `repair blank-stream ${apply ? "run" : "DRY RUN (pass --apply to re-home)"} — ${census.strayEvents} event(s) in execution "", ${census.scanned} execution(s) scanned, ${census.affected.length} resumed after a pre-0106 compaction`,
  ];
  if (census.strayEvents === 0) {
    lines.push("  (nothing to repair)");
    return lines.join("\n");
  }
  for (const s of census.segments) {
    const verdict = s.status === "rehomable" ? "would re-home" : s.status;
    lines.push(
      `  ${`${s.fromSequence}..${s.throughSequence}`.padEnd(12)} → ${s.executionId.padEnd(28)} ${verdict} (${s.proof === "snapshot" ? "proven by snapshot" : "operator-assigned"})${s.detail !== undefined ? ` — ${s.detail}` : ""}`
    );
  }
  for (const u of census.unattributed) {
    const who =
      u.candidates.length === 0
        ? "no candidate"
        : `candidate${u.candidates.length > 1 ? "s" : ""}: ${u.candidates.join(", ")}`;
    lines.push(
      `  ${`${u.fromSequence}..${u.throughSequence}`.padEnd(12)} → ?  UNATTRIBUTED (${u.eventTypes.join(", ")}) — ${who}`
    );
  }
  if (census.unattributed.length > 0) {
    lines.push(
      "  Unattributed events have no surviving proof of their writer, and loom will not guess.",
      "  If your own records name the owner, assert it: --assign <executionId>:<from>-<through>",
      "  (checked: the execution must hold a pre-0106 snapshot at <from − 1>, parked at the gate",
      "   the range's first event answers, with nothing of its own above it)."
    );
  }
  if (census.ciphertext) {
    lines.push(
      "  ⚠ these events still carry ciphertext: this store is the raw one under an encrypting store,",
      "    and re-homing through it would copy ciphertext under the wrong key. Use --config."
    );
  }
  for (const f of failed) lines.push(`  ✗ ${f.executionId}: ${f.error}`);
  if (apply) {
    lines.push(
      `re-homed now: ${rehomed} segment(s)${failed.length > 0 ? `, failed: ${failed.length}` : ""}`
    );
    if (rehomed > 0) {
      lines.push(
        "After a repair:",
        '  • read models and projections never saw these events: purge their "" rows and rebuild them;',
        "  • the blank stream is kept as evidence, so if your stores encrypt, the re-homed payloads",
        '    still sit there under the key of subject "" — once nothing is left to re-home, destroy',
        '    that key (shredSubject(keys, raw, "", { executionIds: [] }) or keys.destroy("")).'
      );
    }
  }
  return lines.join("\n");
}

/**
 * `loom repair blank-stream <store> [--assign <id>:<from>-<through>,…] [--apply]`
 *
 * Needs the snapshot store (the proof lives there) and an enumerable event store.
 */
export async function cmdRepairBlankStream(
  flags: StoreFlags & { assign?: string; apply: boolean }
): Promise<string> {
  const assign = flags.assign === undefined ? [] : parseAssignments(flags.assign);
  const stores = await resolveStores(flags);
  try {
    const events = stores.eventStore;
    if (events.listExecutions === undefined && events.listExecutionsPage === undefined) {
      return `loom repair blank-stream needs to enumerate executions, and the configured ${events.constructor.name} implements neither listExecutions nor listExecutionsPage.`;
    }
    if (stores.snapshotStore === undefined) {
      return "loom repair blank-stream needs the snapshot store — the proof of whose events these are lives there: pass --snap <snap.db>, or use --config.";
    }
    const lifecycle = new LogLifecycle(events, stores.snapshotStore);
    let result: Awaited<ReturnType<LogLifecycle["rehomeBlankStream"]>>;
    try {
      result = await lifecycle.rehomeBlankStream({ assign, apply: flags.apply });
    } catch (err) {
      // The library refuses, before writing, to copy events it cannot decrypt.
      if (err instanceof TypeError && /ciphertext/.test(err.message)) {
        return `loom repair blank-stream refused --apply (nothing written): the events in "" are still encrypted as this store reads them. Re-run with --config <module>, whose stores decrypt them.`;
      }
      throw err;
    }
    return renderBlankStream(result, flags.apply, result.rehomed.length, result.failed);
  } finally {
    await stores.close();
  }
}
