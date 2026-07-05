// ── Cooperative yielding ──────────────────────────────────────────────────────
//
// Yield the current task back to the host so higher-priority work (and, in a
// browser, paint/input) can run before continuing. Used by CPU-bound loops that
// want to stay responsive — e.g. an interruptible tree walk. This is a macrotask
// boundary (not a microtask), so the event loop genuinely drains between chunks.
export function yieldControl(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 0);
    (timer as { unref?: () => void }).unref?.();
  });
}
