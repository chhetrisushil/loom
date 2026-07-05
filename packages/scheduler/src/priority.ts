// ── Priority lanes ────────────────────────────────────────────────────────────
//
// Fiber-inspired priority ORDERING for I/O-bound async work. Unlike React's
// scheduler these lanes do NOT drive a frame-deadline time-slicer (yielding to a
// frame budget is meaningless while awaiting a socket). They only decide the
// order in which queued tasks acquire a slot when the scheduler runs at a finite
// concurrency cap. Lower numeric value == more urgent (dequeued first).
export enum Priority {
  /** Interactive, must-run-now work (e.g. a user-triggered cancel/approval). */
  Immediate = 0,
  /** Foreground work a user is waiting on (a live agent turn). */
  UserBlocking = 1,
  /** Default. Ordinary flow/effect work. */
  Normal = 2,
  /** Background/pre-fetch work that should yield to everything else (planning). */
  Idle = 3,
}
