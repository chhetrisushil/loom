// ADR 0152 D1 (S2c) - adoption and upgrade rescan of `_seenOrigins`. A driver site calls `adoptSeenOrigins` AFTER it holds
// the lease: with the gate on, a run whose state has no key (started before the gate, a 1.26 snapshot, a restored state) or
// an unproven one is folded from sequence 0 (paged, archive included) and the key is REPLACED on the vm, `through` = its
// sequence. Nothing is appended: the key becomes durable with the next snapshot, and the result is memoized so a later
// resume folds only the tail. A pre-1.27 channel event is scanned over its JSON view; a run stamped from the start folds its
// recorded lists natively. A permanent read error is a STICKY overflow, a transient one a retryable failure persisting nothing.
import type { EventEnvelope, ExecutionState } from "@loomwork/core";
import { type EventStore, isPayloadShredded, readRangeOf } from "@loomwork/event-runtime";
import {
  CHANNELS,
  ReplayVM,
  SEEN_ORIGINS_KEY,
  type SeenOriginsKey,
  type SeenOriginsLimits,
  seenOriginsRecord,
  startKey,
  trackSeenOrigins,
  validKey,
} from "@loomwork/replay-vm";
import { isSealedUnreadable } from "./sealGuard";

const PAGE = 500;
const MEMO_MAX = 256;
const PERMANENT = new Set([
  "ArchiveIncompleteError",
  "ArchiveGapError",
  "ArchiveDigestError",
  "ArchiveIncarnationError",
  "ArchiveLogMismatchError",
  "ArchiveUnserializableError",
  "ArchiveTenantMismatchError",
  "PlaintextArchiveError",
]);

/** A transient read failure during adoption: the resume fails, nothing is persisted or memoized, the next attempt rescans. */
export class SeenOriginsRescanUnavailableError extends Error {
  readonly retryable = true;
  constructor(
    readonly executionId: string,
    cause: unknown
  ) {
    super(
      `seen-origins rescan of "${executionId}" could not read its history (${String((cause as Error)?.message ?? cause)}); retry`,
      { cause }
    );
    this.name = "SeenOriginsRescanUnavailableError";
  }
}

class IncompleteLog extends Error {}

export interface SeenOriginsSeedDeps {
  enabled: boolean;
  limits: SeenOriginsLimits;
  events: Pick<EventStore, "read" | "readFrom" | "readRange">;
  /** The archived envelopes of `[from..through]` (guarded: incarnation, digests); absent = no compaction archive. */
  archive?: (id: string, range: { from: number; through: number }) => Promise<EventEnvelope[]>;
  memo: Map<string, { key: SeenOriginsKey; atId: string }>;
}

const permanent = (e: unknown): boolean =>
  e instanceof IncompleteLog ||
  isPayloadShredded(e) ||
  isSealedUnreadable(e) ||
  PERMANENT.has((e as Error | undefined)?.name ?? "");

/** Fold `[0..through]` (live pages, archived gaps) into a key; throws on any read problem. */
async function scan(
  d: SeenOriginsSeedDeps,
  id: string,
  through: number,
  limits: SeenOriginsLimits
): Promise<{ key: SeenOriginsKey; atId: string }> {
  let scratch: ReplayVM | undefined;
  let stamped = true;
  let next = 0;
  let atId = "";
  const feed = (e: EventEnvelope): void => {
    if (e.sequence !== next) throw new IncompleteLog(`hole at ${next}`);
    let ev = e;
    if (next === 0) {
      const p = e.payload;
      if (e.eventType !== "EXECUTION_STARTED" || p === null || typeof p !== "object") {
        throw new IncompleteLog("no start event");
      }
      scratch = new ReplayVM([], {
        executionId: id,
        workflowId: e.workflowId,
        workflowVersion: "",
      });
      stamped = startKey(e) !== undefined;
      if (!stamped) ev = { ...e, payload: { ...p, seenOriginsLimits: limits } };
    }
    if (!stamped && CHANNELS.has(e.eventType)) {
      // pre-1.27 history: a recorded list could be app metadata, so it is dropped and the JSON view scanned
      const { origins: _o, originsOverflow: _f, ...meta } = e.metadata ?? {};
      const rec = seenOriginsRecord(
        next === 0 ? undefined : scratch?.peekState(),
        ev.eventType,
        ev.payload,
        meta,
        "json"
      );
      ev = { ...ev, metadata: { ...meta, ...rec } };
    }
    scratch?.applyEvent(ev);
    atId = e.id;
    next++;
  };
  const fill = async (from: number, to: number): Promise<void> => {
    if (d.archive === undefined) throw new IncompleteLog("compacted, no archive configured");
    for (const e of await d.archive(id, { from, through: to })) feed(e);
    if (next <= to) throw new IncompleteLog(`archive does not cover ${next}`);
  };
  while (next <= through) {
    const end = Math.min(through, next + PAGE - 1);
    for (const e of await readRangeOf(d.events, id, next, end)) {
      if (e.sequence > next) await fill(next, e.sequence - 1);
      feed(e);
    }
    if (next <= end) await fill(next, end); // the page ended short: the rest is archived or missing
    if (next <= end) throw new IncompleteLog(`no events at ${next}`);
  }
  const key = scratch?.peekState().variables[SEEN_ORIGINS_KEY];
  if (!validKey(key) || key.through !== through) throw new IncompleteLog("no key folded");
  return { key, atId };
}

/** Adopt or rebuild the key of `vm` (see the file header). A no-op with the gate off, for a trusted key and for a sticky overflow. */
export async function adoptSeenOrigins(d: SeenOriginsSeedDeps, vm: ReplayVM): Promise<void> {
  if (!d.enabled) return;
  const st: ExecutionState = vm.peekState();
  const cur = st.variables[SEEN_ORIGINS_KEY];
  if (validKey(cur) && cur.through !== undefined) return;
  const id = st.executionId;
  const S = st.sequence;
  const limits = validKey(cur) ? cur.limits : d.limits;
  let got: { key: SeenOriginsKey; atId: string };
  try {
    got = await memoOrScan(d, id, S, limits);
  } catch (err) {
    if (!permanent(err)) throw new SeenOriginsRescanUnavailableError(id, err);
    const at = (await readRangeOf(d.events, id, S, S).catch(() => []))[0];
    got = { key: { v: 1, limits, origins: [], overflow: true, through: S }, atId: at?.id ?? "" };
  }
  d.memo.delete(id);
  d.memo.set(id, got);
  if (d.memo.size > MEMO_MAX) d.memo.delete(d.memo.keys().next().value as string);
  vm.replaceSeenOrigins(got.key);
}

/** A memoized key folds the events appended since (recorded lists; a gate-off writer's unrecorded event is overflow). */
async function memoOrScan(
  d: SeenOriginsSeedDeps,
  id: string,
  S: number,
  limits: SeenOriginsLimits
) {
  const m = d.memo.get(id);
  const T = m?.key.through;
  if (m !== undefined && T !== undefined && T <= S) {
    const seen = await readRangeOf(d.events, id, T, S);
    if (seen[0]?.sequence === T && seen[0].id === m.atId && seen.length === S - T + 1) {
      let s = {
        sequence: T,
        variables: { [SEEN_ORIGINS_KEY]: m.key },
      } as unknown as ExecutionState;
      for (const e of seen.slice(1)) s = { ...trackSeenOrigins(s, e), sequence: e.sequence };
      const key = s.variables[SEEN_ORIGINS_KEY] as SeenOriginsKey;
      return { key, atId: seen[seen.length - 1]?.id ?? m.atId };
    }
  }
  return scan(d, id, S, limits);
}
