// ── useFiber configuration ────────────────────────────────────────────────────
//
// Opt-in render-side capabilities that leverage React's own fiber scheduler
// rather than adding a second reconciler. All default OFF — when `fiber` is
// falsy the renderer takes the exact current code path (byte-identical output).

export interface FiberConfigObject {
  /** Each widget subscribes to its own binding path; only the widget whose
   *  slice changed re-renders (instead of the whole blueprint). */
  granularUpdates?: boolean;
  /** Wrap each widget in a <Suspense> boundary so an async BYOC component can
   *  suspend without blanking its siblings. */
  suspense?: boolean;
  /** Feed high-frequency (streaming) widgets via startTransition so their
   *  updates never block urgent work. */
  deferStreaming?: boolean;
}

/** `true` turns on all three capabilities; an object opts into individual ones. */
export type FiberConfig = boolean | FiberConfigObject;

export interface ResolvedFiberConfig {
  granularUpdates: boolean;
  suspense: boolean;
  deferStreaming: boolean;
}

// Any requested capability implies per-widget mounting (the structure path is
// fiber-mode), which inherently gives granular subscription — so `granularUpdates`
// in the resolved config means "are we in fiber mode at all".
export function resolveFiberConfig(config: FiberConfig | undefined): ResolvedFiberConfig {
  if (config === true) {
    return { granularUpdates: true, suspense: true, deferStreaming: true };
  }
  if (!config) {
    return { granularUpdates: false, suspense: false, deferStreaming: false };
  }
  const suspense = config.suspense ?? false;
  const deferStreaming = config.deferStreaming ?? false;
  const granularUpdates = (config.granularUpdates ?? false) || suspense || deferStreaming;
  return { granularUpdates, suspense, deferStreaming };
}

export function isFiberMode(config: ResolvedFiberConfig): boolean {
  return config.granularUpdates;
}
