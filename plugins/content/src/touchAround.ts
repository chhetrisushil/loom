import type { ContentStore } from "./ContentStore";
import { visitCitedAddresses } from "./citations";
import { ContentMissingError } from "./errors";

/** What a {@link TouchErrorHook} is told about a touch that did not do its job. */
export interface TouchReport {
  /** Which touch: the one BEFORE the write (a failure there aborts it) or the one AFTER it. */
  phase: "before" | "after";
  /** The write the touch guards. */
  operation: "append" | "appendBatch" | "appendIfUnchanged" | "copyPrefix" | "snapshotSave";
  executionId?: string;
  /** Every address the write cites. */
  addresses: readonly string[];
  /**
   * The BARE refs among {@link addresses} that the store reported missing (non-empty only for a
   * missing-blob report): the write cites a blob that is already gone, so the data loss has
   * already happened and replay of that execution will throw `ContentMissingError`. A claim-check
   * envelope's own `ref` is excluded: it may be reclaimed on a TTL by design (ADR 0055 D4).
   */
  missing: readonly string[];
}

/**
 * Observer for touches that failed or found a cited blob gone. `err` is whatever `touch()`
 * threw (the AFTER touch, which is best-effort), or a {@link ContentMissingError} naming the
 * first missing address. It is called synchronously, must not throw (a throw is swallowed, so a
 * broken logger cannot fail a durable write), and is never called when the touch succeeded and
 * every cited blob was present.
 */
export type TouchErrorHook = (err: unknown, info: TouchReport) => void;

let warnedTouch = false;
/**
 * No `onTouchError` hook: a failed after-touch or a missing bare ref would be invisible, so say it
 * ONCE per process (loom's other advisories are per process too, e.g. `LOOM_AGENT_RING`). Per
 * process, not per instance: a failing content store fails on every write, and one warning per
 * write or per store instance would flood stderr; the hook is the way to see each occurrence.
 */
function warnTouchOnce(err: unknown, info: TouchReport): void {
  if (warnedTouch) return;
  warnedTouch = true;
  const proc = (globalThis as { process?: { emitWarning?: (m: string, o?: object) => void } })
    .process;
  const what =
    info.missing.length > 0
      ? `a cited blob is already gone (${info.missing[0]}); replay of ${info.executionId ?? "that execution"} will throw ContentMissingError`
      : `the ${info.phase}-write touch failed (${err instanceof Error ? err.message : String(err)})`;
  proc?.emitWarning?.(
    `ContentResolvingEventStore/ContentTouchingSnapshotStore (${info.operation}): ${what}. Further touch problems in this process are not repeated; pass onTouchError to observe each one.`,
    { code: "LOOM_CONTENT_TOUCH" }
  );
}

function report(hook: TouchErrorHook | undefined, err: unknown, info: TouchReport): void {
  try {
    if (hook === undefined) {
      warnTouchOnce(err, info);
      return;
    }
    const result: unknown = hook(err, info);
    // An async hook's rejection is not ours to surface, and must not become an unhandled one.
    if (
      typeof result === "object" &&
      result !== null &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      (result as PromiseLike<unknown>).then(undefined, () => {});
    }
  } catch {
    /* an observer must never change a write's outcome */
  }
}

/**
 * Touch every blob the `payloads` cite around `write` (ADR 0055 D6 amendment 2): BEFORE the
 * write (an error aborts it; nothing landed), and AFTER it (best-effort: the write is durable, so
 * its outcome must not turn into a failure, but an error is reported through `hook`).
 *
 * The guarantee is D5's, not this function's: the cutoff of a sweep is
 * `touchClock() - olderThanMs`, so the BEFORE touch protects a write whose touch-to-commit window
 * is shorter than that margin (an erasing orphan pass enforces a minimum margin). The AFTER touch
 * only extends that window for a write slower than the margin; it is not what closes the race.
 *
 * A non-empty `missing` result from either touch is reported through the hook, never thrown: a
 * cited blob that is gone cannot be restored by failing this write, and a fork of a log with
 * a reclaimed claim-check envelope is legitimate. Nothing is touched, and no walk beyond the
 * payloads' own, when the store has no `touch` or the payloads cite nothing.
 */
export async function touchAround<T>(
  content: Pick<ContentStore, "touch">,
  payloads: readonly unknown[],
  ctx: { operation: TouchReport["operation"]; executionId?: string | undefined },
  hook: TouchErrorHook | undefined,
  write: () => Promise<T>
): Promise<T> {
  const touch = content.touch;
  if (touch === undefined) return write();
  const cited = new Set<string>();
  const bare = new Set<string>();
  for (const payload of payloads) {
    if (typeof payload === "object" && payload !== null) {
      visitCitedAddresses(payload, (address, inEnvelope) => {
        cited.add(address);
        if (!inEnvelope) bare.add(address);
      });
    }
  }
  if (cited.size === 0) return write();
  const addresses = [...cited];
  const info = (phase: TouchReport["phase"], missing: readonly string[]): TouchReport => ({
    phase,
    operation: ctx.operation,
    ...(ctx.executionId !== undefined && { executionId: ctx.executionId }),
    addresses,
    missing,
  });
  const reportMissing = (phase: TouchReport["phase"], missing: readonly string[]): void => {
    const lost = missing.filter((a) => bare.has(a));
    if (lost.length > 0) {
      report(hook, new ContentMissingError(lost[0] as string, ctx.executionId), info(phase, lost));
    }
  };
  reportMissing("before", await touch.call(content, addresses));
  const result = await write();
  try {
    reportMissing("after", await touch.call(content, addresses));
  } catch (err) {
    report(hook, err, info("after", []));
  }
  return result;
}
