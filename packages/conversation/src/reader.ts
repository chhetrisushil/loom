import type { EventEnvelope } from "@loom/core";
import { type EventStore, headOf, readRangeOf } from "@loom/event-runtime";
import { type Identity, parseIdentity } from "./access";
import { generationId } from "./ids";
import { type HistoryEntry, type MessageRecord, RECORD_SOURCE } from "./types";

// ── Reading a conversation back out of the log (ADR 0122 D4) ──────────────────────────────────────
//
// A conversation's transcript is the `conversation.message` events its flow emitted, spread over the
// generations of one chain (`<id>`, `<id>~1`, ...). The reader walks them with BOUNDED range reads: a
// call scans at most `maxScan` events and returns a cursor even when the page is not full, so one
// request costs O(maxScan) however long the conversation or however much model/tool traffic sits
// between two messages. It never folds state and never reads a whole log.
//
// THE READER DOES NOT AUTHORIZE. Whoever calls it has already decided the caller may read this
// conversation (`createConversations` does, against the runtime's execution authorizer).

/** `<generation>.<sequence>`: a position in the chain's log. */
export interface Position {
  g: number;
  seq: number;
}

const CURSOR = /^(\d{1,9})\.(\d{1,15})$/;

export function formatCursor(p: Position): string {
  return `${p.g}.${p.seq}`;
}

export function parseCursor(cursor: string | undefined): Position | undefined {
  if (cursor === undefined) return undefined;
  const m = CURSOR.exec(cursor);
  if (m === null) return undefined;
  return { g: Number(m[1]), seq: Number(m[2]) };
}

/** A malformed cursor is a caller error, not "start over". */
export class InvalidCursorError extends Error {
  readonly code = "INVALID_CURSOR";
  constructor() {
    super("invalid cursor");
    this.name = "InvalidCursorError";
  }
}

export interface ReadOptions {
  /** Messages to return at most. Default 50, capped at 500. */
  limit?: number;
  /**
   * Events to SCAN at most (the cost bound). Default 2 000. A page may return fewer than `limit`
   * messages with `done: false`: call again with `nextCursor`.
   */
  maxScan?: number;
  /** Where to continue: forward = after this position, backward = before it. */
  cursor?: string;
  /** `"forward"` (oldest first, default) or `"backward"` (newest first). */
  direction?: "forward" | "backward";
  /** Stop reading (the caller went away): the call returns what it has with `done: false`. */
  signal?: AbortSignal;
}

export interface ReadResult {
  entries: HistoryEntry[];
  /** Pass back as `cursor` to continue in the same direction. Absent when nothing was scanned. */
  nextCursor?: string;
  /** True when the scan reached the end of the log in its direction (forward: the live tip; backward: the start). */
  done: boolean;
  /** True when the conversation has a `conversation.closed` event (forward scans only). */
  closed?: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_MAX_SCAN = 2000;
const BLOCK = 256;

/** The conversation fact a `DECISION_RECORDED` carries, if it is one of ours. */
function factOf(ev: EventEnvelope): unknown {
  if (ev.eventType !== "DECISION_RECORDED") return undefined;
  const d = ev.payload as { source?: unknown; choice?: unknown } | null;
  return d !== null && typeof d === "object" && d.source === RECORD_SOURCE ? d.choice : undefined;
}

const isOrd = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** The message record a `conversation.message` decision event carries, or `undefined` if it is not one. */
export function recordOf(ev: EventEnvelope): MessageRecord | undefined {
  const p = factOf(ev) as Partial<MessageRecord> | null | undefined;
  if (p === undefined) return undefined;
  if (
    typeof p !== "object" ||
    p === null ||
    typeof p.turn !== "number" ||
    (p.role !== "user" && p.role !== "assistant") ||
    typeof p.text !== "string" ||
    typeof p.status !== "string"
  ) {
    return undefined;
  }
  return {
    turn: p.turn,
    ...(isOrd(p.ord) && { ord: p.ord }),
    ...(isOrd(p.editOf) && { editOf: p.editOf }),
    ...(isOrd(p.editOfTurn) && { editOfTurn: p.editOfTurn }),
    role: p.role,
    text: p.text,
    status: p.status,
    ...(typeof p.reason === "string" && { reason: p.reason }),
    ...(typeof p.errorId === "string" && { errorId: p.errorId }),
    ...(parseIdentity(p.asker) !== undefined && { asker: parseIdentity(p.asker) as Identity }),
    ...(Array.isArray(p.classes) &&
      p.classes.length > 0 && {
        classes: p.classes.filter((x): x is string => typeof x === "string"),
      }),
    ...(typeof p.turnExecutionId === "string" && { turnExecutionId: p.turnExecutionId }),
  };
}

function entryOf(g: number, ev: EventEnvelope, rec: MessageRecord): HistoryEntry {
  return {
    ...rec,
    cursor: formatCursor({ g, seq: ev.sequence }),
    executionId: ev.executionId,
    at: ev.timestamp,
  };
}

/** Whether an execution (generation) has any events. One indexed point read. */
async function exists(store: EventStore, id: string): Promise<boolean> {
  return (await headOf(store, id)) !== null;
}

/**
 * The newest generation of a chain, by galloping then bisecting over `exists` (generations are
 * consecutive from 0): O(log G) point reads, not a walk. `hint` is a generation known to exist.
 */
export async function findHeadGeneration(
  store: EventStore,
  conversationId: string,
  hint = 0
): Promise<number | undefined> {
  if (!(await exists(store, generationId(conversationId, hint)))) {
    if (hint === 0) return undefined;
    return findHeadGeneration(store, conversationId, 0);
  }
  let lo = hint; // exists
  let step = 1;
  let hi = lo + step; // find a missing one
  while (await exists(store, generationId(conversationId, hi))) {
    lo = hi;
    step *= 2;
    hi = lo + step;
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await exists(store, generationId(conversationId, mid))) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface ConversationReader {
  read(conversationId: string, options?: ReadOptions): Promise<ReadResult>;
  /** The newest generation that has events, or `undefined` when the conversation has none. */
  headGeneration(conversationId: string, hint?: number): Promise<number | undefined>;
}

export function createConversationReader(store: EventStore): ConversationReader {
  async function forward(conversationId: string, opts: ReadOptions): Promise<ReadResult> {
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const maxScan = Math.max(1, opts.maxScan ?? DEFAULT_MAX_SCAN);
    const after = parseCursor(opts.cursor);
    if (opts.cursor !== undefined && after === undefined) throw new InvalidCursorError();
    let g = after?.g ?? 0;
    let next = after !== undefined ? after.seq + 1 : 0;
    let last: Position | undefined = after;
    let scanned = 0;
    let closed = false;
    const entries: HistoryEntry[] = [];
    for (;;) {
      if (entries.length >= limit || scanned >= maxScan || opts.signal?.aborted === true) {
        return { entries, ...(last && { nextCursor: formatCursor(last) }), done: false, closed };
      }
      const evs = await readRangeOf(
        store,
        generationId(conversationId, g),
        next,
        next + Math.min(BLOCK, maxScan - scanned) - 1
      );
      if (evs.length === 0) {
        // This generation has nothing more: a successor means keep going, none means we are at the tip.
        if (await exists(store, generationId(conversationId, g + 1))) {
          g++;
          next = 0;
          scanned++; // a generation hop is work: it counts against the scan budget
          continue;
        }
        return { entries, ...(last && { nextCursor: formatCursor(last) }), done: true, closed };
      }
      for (const ev of evs) {
        scanned++;
        last = { g, seq: ev.sequence };
        if ((factOf(ev) as { kind?: unknown } | undefined)?.kind === "closed") closed = true;
        const rec = recordOf(ev);
        if (rec !== undefined) entries.push(entryOf(g, ev, rec));
        if (entries.length >= limit) break;
      }
      next = (last as Position).seq + 1;
    }
  }

  async function backward(conversationId: string, opts: ReadOptions): Promise<ReadResult> {
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const maxScan = Math.max(1, opts.maxScan ?? DEFAULT_MAX_SCAN);
    const before = parseCursor(opts.cursor);
    if (opts.cursor !== undefined && before === undefined) throw new InvalidCursorError();
    // The cursor is UNTRUSTED input: it is clamped to what exists. A generation past the head, or a
    // sequence past a generation's tip, means "from the end", never a walk through nothing.
    const head = await findHeadGeneration(store, conversationId);
    if (head === undefined) return { entries: [], done: true };
    const tipOf = async (gen: number): Promise<number> =>
      ((await headOf(store, generationId(conversationId, gen))) ?? -1) + 1;
    let g = before === undefined ? head : Math.min(before.g, head);
    let upper = await tipOf(g); // exclusive upper bound within generation g
    if (before !== undefined && before.g <= head) upper = Math.min(before.seq, upper);
    let last: Position | undefined = before;
    let scanned = 0;
    const entries: HistoryEntry[] = [];
    for (;;) {
      if (entries.length >= limit || scanned >= maxScan || opts.signal?.aborted === true) {
        return { entries, ...(last && { nextCursor: formatCursor(last) }), done: false };
      }
      if (upper <= 0) {
        if (g === 0)
          return { entries, ...(last && { nextCursor: formatCursor(last) }), done: true };
        g--;
        upper = await tipOf(g);
        scanned++; // a generation hop is work: it counts against the scan budget
        last = { g, seq: upper };
        continue;
      }
      const take = Math.min(BLOCK, maxScan - scanned, upper);
      const evs = await readRangeOf(
        store,
        generationId(conversationId, g),
        upper - take,
        upper - 1
      );
      if (evs.length === 0) {
        // The range is gone (retention): treat the rest of this generation as exhausted.
        upper = 0;
        continue;
      }
      for (let i = evs.length - 1; i >= 0; i--) {
        const ev = evs[i] as EventEnvelope;
        scanned++;
        last = { g, seq: ev.sequence };
        const rec = recordOf(ev);
        if (rec !== undefined) entries.push(entryOf(g, ev, rec));
        if (entries.length >= limit) break;
      }
      upper = (last as Position).seq;
    }
  }

  return {
    read: (conversationId, options = {}) =>
      (options.direction ?? "forward") === "backward"
        ? backward(conversationId, options)
        : forward(conversationId, options),
    headGeneration: (conversationId, hint) => findHeadGeneration(store, conversationId, hint),
  };
}
