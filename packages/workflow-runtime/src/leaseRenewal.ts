import type { LeaseStore } from "@loom/event-runtime";

// ── Holding a claim for as long as the work takes (#380 L5a) ─────────────────
//
// Both paths that claim an execution — a timer fire and a recovery re-drive — hold the claim
// across the whole resumed run, because both await it settling. That is minutes for the kind
// of work a branch is placed on its own compute for.
//
// Unrenewed, the lease expires UNDER a healthy holder. A recovery pass then sees evidence of
// an orphan that is not one, takes over, and acquires a newer fence — at which point the
// original's next append is rejected and a live execution dies mid-run. The log stays
// correct, which is fencing doing its job; the run does not, which is this doing its job.

export interface HeldLease {
  /** Stop renewing. Safe to call more than once. */
  stop(): void;
}

/**
 * Renew a held lease until told to stop.
 *
 * `onLost` fires if renewal reports that ownership is gone — another node recovered this
 * execution while we were working on it. Correctness from that point is fencing's problem;
 * being told is ours, because two nodes running one execution is worth knowing about.
 *
 * Renewal runs on the calling process's event loop, so synchronous CPU work in a handler can
 * starve it. That is a real limit and it belongs in the open: heavy CPU goes off the main
 * thread (the sandbox worker pool exists for exactly this), or the TTL goes up.
 */
export function renewWhileHeld(
  store: LeaseStore,
  executionId: string,
  owner: string,
  ttlMs: number,
  everyMs: number,
  onLost: (err: unknown) => void
): HeldLease {
  const timer = setInterval(() => {
    void store
      .renew(executionId, owner, ttlMs)
      .then((held) => {
        if (held) return;
        clearInterval(timer);
        onLost(
          new Error(
            `lease lost while working: "${owner}" no longer owns "${executionId}" — another node may have recovered it`
          )
        );
      })
      .catch(onLost);
  }, everyMs);
  // Never hold the process open just to renew.
  timer.unref?.();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

/** Renew twice per TTL at minimum, so a single lost renewal never costs ownership. */
export function defaultRenewEvery(ttlMs: number): number {
  return Math.max(Math.floor(ttlMs / 3), 1);
}
