import type * as http from "node:http";

// ── SSE framing and per-connection backpressure ───────────────────────────────────────────────────
//
// A socket that cannot keep up must not make the server buffer without bound. `write` returning false
// means the kernel buffer is full: from then on frames queue here, up to `maxPendingBytes`, and a
// connection that exceeds it is CLOSED (the client reconnects with Last-Event-ID and the log supplies
// what it missed — durable messages lose nothing). Live reply deltas are lossy by design, so while
// blocked they are COALESCED (one growing delta per turn) instead of queued frame by frame.

/** One SSE frame. `data` is JSON on one line (JSON.stringify escapes every newline). */
export function frame(event: string, data: unknown, id?: string): string {
  return `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class SseSink {
  private queue: string[] = [];
  private pending = 0;
  private blocked = false;
  private coalesced: { turn: number; text: string } | undefined;
  private closed = false;

  constructor(
    private readonly res: http.ServerResponse,
    private readonly maxPendingBytes: number,
    private readonly onOverflow: () => void
  ) {
    res.on("drain", () => this.flush());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    this.coalesced = undefined;
  }

  /** A durable frame: ordered, never dropped (a slow client is closed instead). */
  send(text: string): void {
    if (this.closed) return;
    if (!this.blocked) {
      this.write(text);
      return;
    }
    this.enqueue(text);
  }

  /** A live reply delta: coalesced while the socket is backed up. */
  delta(turn: number, text: string, build: (turn: number, text: string) => string): void {
    if (this.closed) return;
    if (!this.blocked) {
      this.write(build(turn, text));
      return;
    }
    if (this.coalesced !== undefined && this.coalesced.turn !== turn) this.settleCoalesced(build);
    this.coalesced = { turn, text: (this.coalesced?.text ?? "") + text };
    this.pending += text.length;
    if (this.pending > this.maxPendingBytes) this.overflow();
    this.build = build;
  }
  private build: ((turn: number, text: string) => string) | undefined;

  private settleCoalesced(build: (turn: number, text: string) => string): void {
    if (this.coalesced === undefined) return;
    const c = this.coalesced;
    this.coalesced = undefined;
    this.pending -= c.text.length;
    this.enqueue(build(c.turn, c.text));
  }

  private enqueue(text: string): void {
    this.queue.push(text);
    this.pending += text.length;
    if (this.pending > this.maxPendingBytes) this.overflow();
  }

  private overflow(): void {
    if (this.closed) return;
    this.close();
    this.onOverflow();
  }

  private write(text: string): void {
    if (!this.res.write(text)) this.blocked = true;
  }

  private flush(): void {
    if (this.closed) return;
    this.blocked = false;
    while (this.queue.length > 0 && !this.blocked) {
      const next = this.queue.shift() as string;
      this.pending -= next.length;
      this.write(next);
    }
    if (!this.blocked && this.coalesced !== undefined && this.build !== undefined) {
      const c = this.coalesced;
      this.coalesced = undefined;
      this.pending -= c.text.length;
      this.write(this.build(c.turn, c.text));
    }
  }
}
