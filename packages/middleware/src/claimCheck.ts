import type { EffectMiddleware } from "@loom/effect-runtime";

// ── ADR 0051 D3 / ADR 0054 — claim-check: the reference IS the recorded value ─
//
// Effect results over an inline cap are stored in a content-addressed store and
// the log records `{ ref, size, digest }` AS the step output. Deliberately NOT
// ADR 0046 externalization: there is no resolving decorator on this path — the
// fold never touches the content store, replay never resolves, and erasing an
// unpinned blob is invisible to replay. Orchestration logic may branch only on
// the recorded envelope (in practice: the digest — the tool's declared
// deterministic projection). Reaching through the ref from flow control
// reintroduces nondeterminism and is lintable (CC-5, tools/*).

/** Write-side view of the content store (structural — no plugin dependency). */
export interface ClaimCheckStore {
  /** Content-addressed, idempotent by hash — the `ContentStore.put` contract (ADR 0046). */
  put(bytes: Uint8Array): Promise<{ __loomContent: string }>;
  /** OPTIONAL (ST-1, ADR 0059) — streaming ingestion; required only for stream-typed results. */
  putStream?(stream: AsyncIterable<Uint8Array>): Promise<{ __loomContent: string }>;
}

/** Read-side view, for {@link resolveClaimCheck} OUTSIDE the determinism boundary. */
export interface ClaimCheckReader {
  get(ref: { __loomContent: string }): Promise<Uint8Array | null>;
}

/** What STEP_COMPLETED records in place of an over-cap effect result. */
export interface ClaimCheckEnvelope {
  readonly __loomClaimCheck: true;
  readonly ref: { readonly __loomContent: string };
  /** Byte length of the offloaded payload. */
  readonly size: number;
  /** The tool's declared deterministic projection of the result (CC-2), if any. */
  readonly digest?: unknown;
  /**
   * How the offloaded bytes decode. Absent = JSON (the classic offload path);
   * stream-typed results record their declared codec ("bytes" default) —
   * resolve those with {@link resolveClaimCheckBytes}, not JSON parsing.
   */
  readonly codec?: string;
}

// ── ST-2 (ADR 0059) — stream-typed tool results ───────────────────────────────
//
// A tool whose result is too large to hold in memory returns
// `streamResult(stream, { digest })` instead of the payload: the middleware
// streams it into the content store INSIDE the effect (transient side of the
// determinism boundary) and the recorded value is still the small envelope.
// The digest MUST come from the tool (computed while producing) — the bytes
// are consumed by the upload, so no post-hoc projection is possible.

export interface StreamedResult {
  readonly __loomStreamResult: true;
  readonly stream: AsyncIterable<Uint8Array>;
  /** The declared deterministic projection (CC-2). Pure w.r.t. the streamed content. */
  readonly digest?: unknown;
  /** Recorded on the envelope; default "bytes". */
  readonly codec?: string;
}

/** Wrap a byte stream as a tool result; Node `Readable`s satisfy the iterable directly. */
export function streamResult(
  stream: AsyncIterable<Uint8Array>,
  opts: { digest?: unknown; codec?: string } = {}
): StreamedResult {
  return {
    __loomStreamResult: true,
    stream,
    ...(opts.digest !== undefined && { digest: opts.digest }),
    ...(opts.codec !== undefined && { codec: opts.codec }),
  };
}

export function isStreamResult(value: unknown): value is StreamedResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __loomStreamResult?: unknown }).__loomStreamResult === true &&
    typeof (value as { stream?: unknown }).stream === "object"
  );
}

export function isClaimCheck(value: unknown): value is ClaimCheckEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __loomClaimCheck?: unknown }).__loomClaimCheck === true &&
    typeof (value as { ref?: { __loomContent?: unknown } }).ref?.__loomContent === "string"
  );
}

/** CC-3 — offload observability: what, where, how big. */
export interface ClaimCheckInfo {
  toolId?: string;
  stepId: string;
  executionId: string;
  workflowId: string;
  size: number;
  contentAddress: string;
}

export interface ClaimCheckOptions {
  store: ClaimCheckStore;
  /**
   * Inline cap in bytes for the JSON-encoded effect result; results at or under
   * the cap are recorded inline, untouched. Default 16 KiB.
   */
  inlineCapBytes?: number;
  /**
   * CC-2 — `toolId → digest` declarations. A digest is the tool's DETERMINISTIC
   * projection of its result: the one part of an offloaded payload that
   * orchestration may branch on, recorded inline in the envelope. MUST be a pure
   * function of the result. Tools without a declared digest record `{ ref, size }`
   * only — their orchestration can branch on nothing but existence.
   */
  digests?: Readonly<Record<string, (result: unknown) => unknown>>;
  /** CC-3 — called after each offload (metrics/log-budget regression tracking). */
  onOffload?: (info: ClaimCheckInfo) => void;
}

/**
 * CC-1 — claim-check middleware on the ADR 0006 seam. Runs only when the effect
 * actually executes (replayed/completed steps short-circuit upstream), so replay
 * determinism is automatic: the envelope is the recorded value. Crash-recovery
 * re-runs re-offload the same bytes to the same content address (`put` is
 * idempotent by hash), reproducing an identical envelope.
 *
 * Results that JSON cannot encode (circular, undefined) pass through untouched —
 * offload is impossible for what the journal could not record anyway.
 */
export function claimCheckMiddleware(options: ClaimCheckOptions): EffectMiddleware {
  const cap = options.inlineCapBytes ?? 16 * 1024;
  const encoder = new TextEncoder();
  return async (ctx, _input, next): Promise<unknown> => {
    const result = await next();
    if (isClaimCheck(result)) return result; // already an envelope (stacked wiring) — never double-wrap

    // ST-2 — stream-typed result: ALWAYS offloads (a stream is a declared-big
    // payload), never buffered by the middleware (a counting wrapper is the only
    // thing between the tool and the store).
    if (isStreamResult(result)) {
      if (options.store.putStream === undefined) {
        throw new TypeError(
          `claim-check: tool "${ctx.toolId ?? ctx.stepId}" returned a streamed result but the content store does not implement putStream() (ST-1, ADR 0059)`
        );
      }
      let size = 0;
      const source = result.stream;
      const counted = (async function* () {
        for await (const chunk of source) {
          size += chunk.byteLength;
          yield chunk;
        }
      })();
      let streamedRef: { __loomContent: string };
      try {
        streamedRef = await options.store.putStream(counted);
      } finally {
        // W-audit leak fix: if putStream threw mid-consumption, `counted` is
        // suspended at a yield and nobody would ever finalize it — resuming it
        // with a return completion propagates through its for-await to the
        // SOURCE iterator's return(), closing whatever the tool handed us
        // (file handle, socket). A no-op when the stream was fully consumed.
        await counted.return(undefined).then(
          () => {},
          () => {} // the offload is already failing; source cleanup errors don't mask it
        );
      }
      const envelope: ClaimCheckEnvelope = {
        __loomClaimCheck: true,
        ref: { __loomContent: streamedRef.__loomContent },
        size,
        codec: result.codec ?? "bytes",
        ...(result.digest !== undefined && { digest: result.digest }),
      };
      options.onOffload?.({
        ...(ctx.toolId !== undefined && { toolId: ctx.toolId }),
        stepId: ctx.stepId,
        executionId: ctx.executionId,
        workflowId: ctx.workflowId,
        size,
        contentAddress: streamedRef.__loomContent,
      });
      return envelope;
    }

    let json: string | undefined;
    try {
      json = JSON.stringify(result);
    } catch {
      return result;
    }
    if (json === undefined) return result;
    const bytes = encoder.encode(json);
    if (bytes.byteLength <= cap) return result;

    const ref = await options.store.put(bytes);
    const digest = ctx.toolId === undefined ? undefined : options.digests?.[ctx.toolId];
    const envelope: ClaimCheckEnvelope = {
      __loomClaimCheck: true,
      ref: { __loomContent: ref.__loomContent },
      size: bytes.byteLength,
      ...(digest !== undefined && { digest: digest(result) }),
    };
    options.onOffload?.({
      ...(ctx.toolId !== undefined && { toolId: ctx.toolId }),
      stepId: ctx.stepId,
      executionId: ctx.executionId,
      workflowId: ctx.workflowId,
      size: bytes.byteLength,
      contentAddress: ref.__loomContent,
    });
    return envelope;
  };
}

/**
 * CC-4 — resolve an envelope back to its payload, for use OUTSIDE the
 * determinism boundary (rendering evidence in a UI, exporting a report).
 * Returns `null` when the bytes were erased/never stored — the store's
 * null-on-absence contract, surfaced as-is so callers decide loudness.
 * Flow control must NOT branch on the resolved payload (CC-5 lint).
 */
export async function resolveClaimCheck<T = unknown>(
  reader: ClaimCheckReader,
  envelope: ClaimCheckEnvelope
): Promise<T | null> {
  if (envelope.codec !== undefined && envelope.codec !== "json") {
    throw new TypeError(
      `resolveClaimCheck: envelope codec is "${envelope.codec}", not JSON — use resolveClaimCheckBytes for stream-offloaded content`
    );
  }
  const bytes = await reader.get(envelope.ref);
  if (bytes === null) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * CC-4 for stream-offloaded content (ST-2): the raw bytes, `null` on absence.
 * Same boundary rule as {@link resolveClaimCheck}: OUTSIDE the determinism
 * boundary only.
 */
export async function resolveClaimCheckBytes(
  reader: ClaimCheckReader,
  envelope: ClaimCheckEnvelope
): Promise<Uint8Array | null> {
  return reader.get(envelope.ref);
}
