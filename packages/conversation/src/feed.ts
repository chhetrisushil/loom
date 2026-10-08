import type { EventStore } from "@loom/event-runtime";
import { generationId } from "./ids";
import { type ConversationReader, parseCursor } from "./reader";
import type { HistoryEntry } from "./types";

// ── Following a conversation as it is written (ADR 0122 D6) ────────────────────────────────────────
//
// The durable half of a live view: every recorded message after a cursor, in order, then new ones as
// they are recorded, across rotations. DATA comes from bounded reads only. The store's subscription
// is used as a WAKE-UP (something was appended, go read), never as a source of events, so there is one
// ordering and one cursor, a missed notification costs latency (the poll interval) and never a
// message, and resuming from `Last-Event-ID` is the same code path as following.

export type FeedItem = { type: "message"; entry: HistoryEntry } | { type: "closed" };

export interface FollowOptions {
  /** Continue after this cursor (a `HistoryEntry.cursor`, or a `nextCursor`). Absent: from the start. */
  cursor?: string;
  /** Stop following (the consumer went away). */
  signal?: AbortSignal;
  /** Safety-net poll when no notification arrives, ms. Default 2 000. */
  pollMs?: number;
  /** Messages per read. Default 100. */
  pageLimit?: number;
  /** Events one read may scan. Default 2 000. */
  maxScan?: number;
}

export interface FollowDeps {
  reader: ConversationReader;
  eventStore: EventStore;
}

/**
 * Yields each recorded message after `options.cursor`, then waits for more. Ends after yielding
 * `closed` (the conversation was closed) or when `signal` aborts. Throws `InvalidCursorError` for a
 * malformed cursor. AUTHORIZE BEFORE CALLING: this reads the log directly.
 */
export async function* followConversation(
  deps: FollowDeps,
  conversationId: string,
  options: FollowOptions = {}
): AsyncGenerator<FeedItem> {
  const { reader, eventStore } = deps;
  const signal = options.signal;
  const pollMs = options.pollMs ?? 2000;
  let cursor = options.cursor;
  parseCursor(cursor); // validated by the first read; a bad one throws there

  // Wake-ups: subscribe to the generation we are reading and the next one (a rotation appends to a
  // NEW execution), moving the pair forward as the cursor advances.
  let wake: (() => void) | undefined;
  let woken = false;
  const poke = (): void => {
    woken = true;
    wake?.();
  };
  const subs = new Map<number, () => void>();
  const watch = async (g: number): Promise<void> => {
    for (const want of [g, g + 1]) {
      if (subs.has(want)) continue;
      subs.set(want, await eventStore.subscribe(generationId(conversationId, want), poke));
    }
    for (const [have, off] of subs) {
      if (have < g) {
        off();
        subs.delete(have);
      }
    }
  };
  const idle = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (woken || signal?.aborted === true) return resolve();
      const timer = setTimeout(done, pollMs);
      timer.unref?.();
      function done(): void {
        clearTimeout(timer);
        wake = undefined;
        signal?.removeEventListener("abort", done);
        resolve();
      }
      wake = done;
      signal?.addEventListener("abort", done, { once: true });
    });

  try {
    await watch(parseCursor(cursor)?.g ?? 0);
    while (signal?.aborted !== true) {
      woken = false;
      const page = await reader.read(conversationId, {
        ...(cursor !== undefined && { cursor }),
        limit: options.pageLimit ?? 100,
        ...(options.maxScan !== undefined && { maxScan: options.maxScan }),
      });
      for (const entry of page.entries) {
        yield { type: "message", entry };
      }
      if (page.nextCursor !== undefined) {
        cursor = page.nextCursor;
        await watch(parseCursor(cursor)?.g ?? 0);
      }
      if (page.closed === true) {
        yield { type: "closed" };
        return;
      }
      if (!page.done) continue; // more is already waiting
      await idle();
    }
  } finally {
    for (const off of subs.values()) off();
  }
}
