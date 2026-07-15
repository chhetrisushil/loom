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
}

/** Read-side view, for {@link resolveClaimCheck} OUTSIDE the determinism boundary. */
export interface ClaimCheckReader {
  get(ref: { __loomContent: string }): Promise<Uint8Array | null>;
}

/** What STEP_COMPLETED records in place of an over-cap effect result. */
export interface ClaimCheckEnvelope {
  readonly __loomClaimCheck: true;
  readonly ref: { readonly __loomContent: string };
  /** Byte length of the offloaded JSON payload. */
  readonly size: number;
  /** The tool's declared deterministic projection of the result (CC-2), if any. */
  readonly digest?: unknown;
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
  const bytes = await reader.get(envelope.ref);
  if (bytes === null) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
