import { SubjectIndex } from "@loom/compliance";
import type { EventEnvelope } from "@loom/core";
import { isReservedStream, readRangeOf } from "@loom/event-runtime";
import { SqliteEventStore } from "@loom/plugin-sqlite";

// ── `loom compliance report` — data-subject inventory over cold storage (T3) ────
//
// Answers "who has data, and how much?" over a stored log: enumerate every execution (via the
// listExecutions SPI), attribute each to a data subject (and optionally a tenant) by reading a
// dot-path off EXECUTION_STARTED input, and report the subject→executions inventory. A cold
// log has no flow code, so the operator names the subject/tenant paths explicitly (like
// `--redact`), e.g. `--subject-path input.userId --tenant-path input.tenant`.

function getAtPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const seg of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/** Coerce a resolved subject/tenant value to a string id, or undefined if not stringy. */
function asId(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

/**
 * `loom compliance report --db <path> --subject-path <dotpath> [--tenant-path <dotpath>]` —
 * a subject inventory (per tenant) over the whole store.
 */
export async function cmdComplianceReport(
  db: string,
  subjectPath: string,
  tenantPath?: string
): Promise<string> {
  const store = new SqliteEventStore(db);
  try {
    if (store.listExecutions === undefined) {
      return "this event store does not support listExecutions (cannot enumerate subjects)";
    }
    const ids = (await store.listExecutions()).filter((id) => !isReservedStream(id));

    const subjectOf = (e: EventEnvelope): string | undefined =>
      e.eventType === "EXECUTION_STARTED" ? asId(getAtPath(e.payload, subjectPath)) : undefined;
    const tenantOf =
      tenantPath === undefined
        ? undefined
        : (e: EventEnvelope): string | undefined =>
            e.eventType === "EXECUTION_STARTED"
              ? asId(getAtPath(e.payload, tenantPath))
              : undefined;

    const index = new SubjectIndex(subjectOf, tenantOf !== undefined ? { tenantOf } : {});
    for (const id of ids) {
      // The subject/tenant live in EXECUTION_STARTED (sequence 0), so read ONLY the bootstrap
      // event — not the whole log. O(executions) reads instead of O(total events).
      for (const event of await readRangeOf(store, id, 0, 0)) index.handleEvent(event);
    }

    const lines: string[] = [];
    let subjectCount = 0;
    let attributedExecutions = 0;
    for (const tenant of index.tenants()) {
      lines.push(tenant === "" ? "(default tenant):" : `tenant ${tenant}:`);
      for (const subject of index.subjects(tenant)) {
        const n = index.executionsOf(subject, tenant).length;
        subjectCount += 1;
        attributedExecutions += n;
        lines.push(`  ${subject.padEnd(28)} ${n} execution${n === 1 ? "" : "s"}`);
      }
    }
    const header = `compliance report — ${subjectCount} subject(s), ${attributedExecutions} attributed / ${ids.length} total execution(s)`;
    return subjectCount === 0
      ? `${header}\n  (no subjects resolved)`
      : `${header}\n${lines.join("\n")}`;
  } finally {
    await store.close();
  }
}
