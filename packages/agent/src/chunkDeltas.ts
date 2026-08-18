/**
 * Batch provider deltas up to a semantic boundary before handing them on.
 *
 * The advice in `docs/usage.md` — chunk at a sentence, not a token — is only
 * advice until something makes it easy to follow. This is that something.
 *
 * It matters because a sink is not always transient. `ctx.stream` appends a
 * DURABLE event per call, so a 4,000-token generation streamed per token is
 * 4,000 permanently load-bearing events: the same fold economics ST-R rejected
 * when chunks-as-events was proposed as a kernel feature, arriving instead
 * through the sanctioned door. Wrapping the sink turns the delta count from a
 * property of the provider's tokenizer into a choice the author makes.
 *
 * Purely transient sinks (`@loom/live-query`, `progressHub`) do not need this —
 * there, per-token is free and smoother.
 *
 * ```ts
 * const sink = chunkDeltas((text) => ctx.stream("answer", text), { minChars: 40 });
 * createAgentModelEffect(provider, { stream: true, onDelta: sink.push });
 * // …after the turn:
 * sink.flush();
 * ```
 */
export interface ChunkedSink {
  /** Feed one provider delta. Emits only when a boundary is crossed. */
  push(delta: string): void;
  /** Emit whatever is buffered. Call at the end of a turn, or the tail is lost. */
  flush(): void;
}

export interface ChunkDeltasOptions {
  /**
   * Emit only once the buffer is at least this long AND a boundary is reached.
   * Guards against one-word sentences producing one event each. Default 1.
   */
  minChars?: number;
  /**
   * What counts as a boundary. Default: sentence-ending punctuation followed by
   * a space or the end of the delta, plus a hard newline.
   */
  isBoundary?: (buffer: string) => boolean;
}

const DEFAULT_BOUNDARY = /[.!?]["')\]]?\s$|\n/;

export function chunkDeltas(
  emit: (text: string) => void,
  options: ChunkDeltasOptions = {}
): ChunkedSink {
  const minChars = options.minChars ?? 1;
  const isBoundary = options.isBoundary ?? ((buffer: string) => DEFAULT_BOUNDARY.test(buffer));
  let buffer = "";

  return {
    push(delta: string): void {
      buffer += delta;
      if (buffer.length >= minChars && isBoundary(buffer)) {
        emit(buffer);
        buffer = "";
      }
    },
    flush(): void {
      // An empty flush emits NOTHING rather than an empty event: a durable sink
      // would otherwise get a meaningless append at the end of every turn.
      if (buffer === "") return;
      emit(buffer);
      buffer = "";
    },
  };
}
