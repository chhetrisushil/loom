// ADR 0152 D1 (S2c) - adoption and upgrade rescan of `_seenOrigins`. A driver site calls `adoptSeenOrigins` AFTER it holds
// the lease: with the gate on, a run whose state has no key (started before the gate, a 1.26 snapshot, a restored state) or
// an unproven one is folded from sequence 0 (paged, archive included) and the key is REPLACED on the vm, `through` = its
// sequence. Nothing is appended: the key becomes durable with the next snapshot, and the result is memoized so a later
// resume folds only the tail. A pre-1.27 channel event is scanned over its JSON view; a run stamped from the start folds its
// recorded lists natively. A permanent read error is a STICKY overflow, a transient one a retryable failure persisting nothing.
import type { EventEnvelope, ExecutionState } from "@loomwork/core";
import {
  type ArchiveSegmentHeader,
  type EventStore,
  isPayloadShredded,
  readRangeOf,
  segmentDigest,
} from "@loomwork/event-runtime";
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
import { isSealedUnreadable, sealedDetailOf } from "./sealGuard";
import { QuarantineHeldError } from "./types";

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
  "PayloadUndecryptableError",
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
  /** The compaction archive, read ONE SEGMENT at a time (guarded: incarnation, digests); absent = none configured. */
  archive?: {
    headers(id: string): Promise<ArchiveSegmentHeader[]>;
    read(id: string, range: { from: number; through: number }): Promise<EventEnvelope[]>;
  };
  memo: Map<string, SeenOriginsMemo>;
}

/** A memoized key, bound to the log it came from: digests of sequence 0 (incarnation) and of the envelope at `through` (event ids are `<id>-<seq>`, so reuse of an id repeats them). */
export interface SeenOriginsMemo {
  key: SeenOriginsKey;
  e0: string;
  at: string;
}

const dig = (e: EventEnvelope): string => segmentDigest([e]);
// A sealed refusal for a key that is merely unavailable, or a quarantine hold, is recoverable: the resume retries.
const recoverable = (e: unknown): boolean =>
  sealedDetailOf(e)?.reason === "key-unavailable" || e instanceof QuarantineHeldError;
const permanent = (e: unknown): boolean =>
  e instanceof IncompleteLog ||
  (!recoverable(e) &&
    (isPayloadShredded(e) ||
      isSealedUnreadable(e) ||
      PERMANENT.has((e as Error | undefined)?.name ?? "")));

/** Fold `[0..through]` (live pages, archived gaps) into a key; throws on any read problem. */
async function scan(
  d: SeenOriginsSeedDeps,
  id: string,
  through: number,
  limits: SeenOriginsLimits
): Promise<SeenOriginsMemo> {
  let scratch: ReplayVM | undefined;
  let stamped = true;
  let next = 0;
  let first: EventEnvelope | undefined;
  let last: EventEnvelope | undefined;
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
      // pre-1.27 history is scanned over its JSON view, and a list recorded AFTER an adoption (or forged as app metadata)
      // is unioned in: only the fail-closed direction, since a recorded origin can add to the set, never hide one.
      const { origins: rec0, originsOverflow: over0, ...meta } = e.metadata ?? {};
      const rec = seenOriginsRecord(
        next === 0 ? undefined : scratch?.peekState(),
        ev.eventType,
        ev.payload,
        meta,
        "json"
      );
      const bad =
        over0 === true || (Array.isArray(rec0) && !rec0.every((o) => typeof o === "string"));
      const merged =
        rec === undefined
          ? undefined
          : rec.originsOverflow === true || bad
            ? { originsOverflow: true }
            : {
                origins: [
                  ...new Set([...(rec.origins ?? []), ...((rec0 as string[] | undefined) ?? [])]),
                ].sort(),
              };
      ev = { ...ev, metadata: { ...meta, ...merged } };
    }
    scratch?.applyEvent(ev);
    first ??= e;
    last = e;
    next++;
  };
  const fill = async (from: number, to: number): Promise<void> => {
    if (d.archive === undefined) throw new IncompleteLog("compacted, no archive configured");
    // one segment at a time, each fed and dropped: memory is O(segment), never O(archived history)
    for (const h of await d.archive.headers(id)) {
      if (h.through < next || h.from > to || h.kind === "legacy-checkpoint") continue;
      const lo = Math.max(h.from, next);
      for (const e of await d.archive.read(id, { from: lo, through: Math.min(h.through, to) }))
        feed(e);
    }
    if (next <= to) throw new IncompleteLog(`archive does not cover ${next}`);
  };
  while (next <= through) {
    const end = Math.min(through, next + PAGE - 1);
    // NOTE: a store without `readRange` falls back to `readFrom`, which returns the whole tail per page.
    for (const e of await readRangeOf(d.events, id, next, end)) {
      if (e.sequence > next) await fill(next, e.sequence - 1);
      feed(e);
    }
    if (next <= end) await fill(next, end); // the page ended short: the rest is archived or missing
    if (next <= end) throw new IncompleteLog(`no events at ${next}`);
  }
  const key = scratch?.peekState().variables[SEEN_ORIGINS_KEY];
  if (!validKey(key) || key.through !== through) throw new IncompleteLog("no key folded");
  if (first === undefined || last === undefined) throw new IncompleteLog("empty");
  return { key, e0: dig(first), at: dig(last) };
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
  let got: SeenOriginsMemo | undefined;
  try {
    got = await memoOrScan(d, id, S, limits);
  } catch (err) {
    if (!permanent(err)) throw new SeenOriginsRescanUnavailableError(id, err);
    const key = { v: 1 as const, limits, origins: [], overflow: true as const, through: S };
    try {
      const [a, b] = [await readRangeOf(d.events, id, 0, 0), await readRangeOf(d.events, id, S, S)];
      got = a[0] && b[0] ? { key, e0: dig(a[0]), at: dig(b[0]) } : undefined;
    } catch {
      got = undefined; // unreadable now: the sticky key is used but not memoized
    }
    d.memo.delete(id);
    if (got === undefined) return vm.replaceSeenOrigins(key);
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
): Promise<SeenOriginsMemo> {
  const m = d.memo.get(id);
  const T = m?.key.through;
  if (m !== undefined && T !== undefined && T <= S) {
    const seen = await readRangeOf(d.events, id, T, S);
    const e0 = (await readRangeOf(d.events, id, 0, 0))[0];
    // a hit must be THIS log: the same incarnation (sequence 0) and the same envelope at `through`
    if (
      e0 !== undefined &&
      seen[0]?.sequence === T &&
      seen.length === S - T + 1 &&
      dig(e0) === m.e0 &&
      dig(seen[0]) === m.at
    ) {
      let s = {
        sequence: T,
        variables: { [SEEN_ORIGINS_KEY]: m.key },
      } as unknown as ExecutionState;
      for (const e of seen.slice(1)) s = { ...trackSeenOrigins(s, e), sequence: e.sequence };
      const key = s.variables[SEEN_ORIGINS_KEY] as SeenOriginsKey;
      return { key, e0: m.e0, at: dig(seen[seen.length - 1] as EventEnvelope) };
    }
  }
  return scan(d, id, S, limits);
}
