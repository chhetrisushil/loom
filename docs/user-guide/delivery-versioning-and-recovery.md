# Effect delivery, flow versioning, timers & recovery

> Part of the [Loom User Guide](../user-guide.md), [section 17](../user-guide.md#17-kernel-grants-quotas--supervision) (Loom 2.0 kernel hardening). Keeping executions correct across crashes, deploys and time: at-least-once delivery and idempotency (K9), flow-code versioning (K11.1), editing a flow body under a running execution (ADR 0113), durable timers (T1), and recovering executions whose supervisor died (ADR 0004).

## Effect delivery: at-least-once & idempotency (K9)

**The contract:** *effects are at-least-once; steps are exactly-once only with respect to the
log.* If a worker crashes after performing a side effect but before its `STEP_COMPLETED`
reaches the log, recovery re-executes the in-flight step — completed steps never re-run, but
the one in-flight effect can. (Metered `RESOURCE_METERED` facts are at-least-once too: budgets
may over-count after a crash — they never under-count.)

Two opt-in tools manage this window:

**1. Idempotency key (K9.2).** Every effect invocation receives a deterministic
`ctx.idempotencyKey` — `executionId:stepId` — that is **stable across crash-recovery re-runs
of the same logical attempt**. (Under `AgentRunner`, each nested tool call gets a derived key,
`<outer>:t<turn>:c<position>:<hash of tool name + canonical input>`: the same call at the same position
re-runs with the same key, a different call, even at the same position, gets a different one.) Pass it to your provider so a re-run deduplicates:

```ts
const charge = new ToolEffect(async (input, ctx) => {
  return stripe.charges.create({ amount: input.amountUsd }, { idempotencyKey: ctx.idempotencyKey });
});
```

**2. In-doubt parking (K9.3).** A mutating tool that **cannot** be made idempotent declares
it, and recovery refuses to silently re-run an attempt in an unknown state — it records a
durable `EFFECT_INDOUBT` fact and suspends for an operator verdict:

```ts
const wireTransfer = new ToolEffect(sendWire, { idempotent: false }); // park, never silently re-run
// (declare the same on the definition: tool$({ id: "wire", …, idempotent: false }))

// The execution suspends with { on: "EffectInDoubtResolved", correlationKey: stepId }.
// An operator checks the provider, then settles it with a standard resume:
await runtime.resume(executionId, {
  eventType: EFFECT_INDOUBT_RESOLVED, // from @loom/workflow-runtime
  payload: { stepId: "wire", resolution: "completed-with-result", output: { txId: "…" } },
  // or { stepId: "wire", resolution: "retry-fresh" }   → re-run as a NEW logical attempt (fresh key `…:r1`)
  // or { stepId: "wire", resolution: "fail", error: "…" } → settle the step as failed
});
```

Undeclared tools keep the legacy automatic re-run byte-identically. Prove your tools' semantics
in CI with the crash-injection harness — `crashingEventStore` in `@loom/testing` kills the
execution exactly between the effect and its completion append.

**3. Fencing tokens (K9.4).** On a multi-node store, a re-dispatched execution must be safe
from its *zombie* predecessor — a partitioned worker that wakes up and writes after the
execution moved elsewhere. Fencing stores (in-memory, Postgres) expose
`acquireFence(executionId)` — a monotonic token the worker's lease carries and every appended
event is stamped with; the **store append rejects** a stale or missing token
(`StaleFenceError`), so exactly one version of history can land. `LocalWorkerRuntime.allocate`
acquires it automatically; hand-driven runs pass `{ fence }` via `RunOptions`. Executions that
never fence — and single-node SQLite, where the process is the failure domain — are entirely
untouched (G2).

**Acquire-if-parked (R8k, [ADR 0118](../adr/0118-acquire-if-parked-fence.md)).** `acquireFence` is
unconditional, so two resumers of one parked execution could fence each other out — one of them,
after its resume was already recorded, superseding the holder of the *running* body. A fencing
store may also offer `acquireFenceIf(id, { fence, parkSeq })`: one atomic step that takes the token
only if it has not moved **and** nothing has answered the park since (`EXECUTION_RESUMED`, a later
park or a terminal event; audit appends like `EXECUTION_DENIED` do not count). `resume` /
`resumeAs` use it when given `{ fenceIfParkedAt: await runtime.parkedAtSequence(id) }`; a dead
acquirer is retried on the token the store returns, an answered park is `ResumeRefusedError`
`not-suspended`, and a resume that keeps losing is a retryable `ResumeContendedError`
(`kernel.features.redrive` turns that into a backed-off timer row, so it completes without
`recover()`). A store without the method falls back to `acquireFence` and its residual.

## Flow-code versioning (K11.1)

Long-lived executions outlive deploys. Every execution records the **content hash** of the
flow code it started under (`flowContentHash` — the fold-relevant structure: step graph,
effect bindings, durable policies; cosmetic renames and rebuilds don't change it). On
resume — **and on crash-recovery, which needs no operator action** — the kernel compares the
recorded hash against the registered flow and refuses a mismatch loudly:

```text
FlowCodeMismatchError: flow code changed under in-flight execution "…":
Exits: (1) PIN — deploy/register the original flow code and resume on it;
       (2) MIGRATE — resume with { allowFlowCodeMismatch: true } after verifying
           fold-compatibility (loom deploy check / @loom/deploy-sim);
       (3) DRAIN — cancel() the execution and restart it on the new code.
```

Logs that predate hashing resume exactly as before (G2). The full K11 toolkit:

```ts
// PINNED RESUMPTION (K11.2): register BOTH versions — the registry is
// version-aware, and an in-flight execution automatically resumes on the
// version whose hash matches its recorded one. Register the live version last.
runtime.registerFlow(flowV1.definition, flowV1.runner); // pinned for in-flight runs
runtime.registerFlow(flowV2.definition, flowV2.runner); // current for new starts
// Same id+version re-registered with different content is a hard error (bump the
// version); identical content is idempotent (dev watch-mode stays quiet).

// EXPLICIT MIGRATION (K11.3): move an execution onto new code, durably.
await runtime.resumeAs(executionId, "my-flow", { eventType: "Approval", payload }, {
  strategy: "replay-check", // proves every recorded step still exists in the target
  // strategy: "operator-ack" — you vouch (e.g. after renaming steps deliberately)
});
// Records EXECUTION_MIGRATED: audit trail + re-points the execution's recorded
// hash, so all later resumes check against the NEW code.

// CI GATE (K11.4): `loom deploy check` now reports breaking `flow-code-drift`
// for LIVE executions whose recorded hash the new deployment would change —
// "drain or pin before deploy" is enforceable. Export your EffectRuntime from
// the check config to also get the K9 idempotency advisory (undeclared tools).
```

## Editing a flow body under a running execution (ADR 0113, R7)

The structural hash above is **body-blind**: a flow is a function re-run from the top on every
resume, and an edit that changes which step ids it asks for (a changed branch condition, an inserted
or dropped `ctx.run`) leaves the hash unchanged while the new body walks a different id sequence
over the old log. Old frames are orphaned and an effect that already ran under one id runs again
under another. Three things close that, none of which hashes `toString()`:

1. **The hash can be SHA-256** (`sha256:<hex>`, a small pure-JS digest in `@loom/core`; no
   `node:crypto`). Both forms are always read: a log that recorded the old 32-bit `fnv1a:` value is
   compared against the legacy hash of the registered code. New starts keep recording `fnv1a:` until
   `kernel.features.sha256FlowHash` is on (a node that predates ADR 0113 refuses a `sha256:`
   recording), so turn it on once every node reads both; `security.strict` does not.
2. **An opt-in body fingerprint.** `flow$({ codeFingerprint })` takes a content hash of the flow
   body *as built*, supplied by your toolchain or by you; it is recorded as
   `EXECUTION_STARTED.codeHash` (folded as `_codeHash`). On resume or recovery a different value is
   a `FlowCodeMismatchError` (`kind: "code"`) unless the registered flow lists the recorded one in
   `compatibleWith: ["…"]`, your explicit assertion, reviewed in the diff that adds it, that the
   edit is replay-compatible. Absent on either side means "no fingerprint": nothing changes.
   (`@loom/compiler` does not produce one yet.) A migration records the target's fingerprint
   (`toCodeHash`), so a migrated execution is held to the code it now runs, and a continuation's
   successor records the fingerprint of the code registered *now*, so `continueAsNew` is the clean
   re-version point.
3. **A replay-divergence detector.** Before a step starts, a park, a continuation, and at
   completion, every step the log records as completed must have been asked for by the re-run
   (flow-level emits and a decision's record are not gated; a decider is transient and may run). If
   not, the code changed shape under the execution. `kernel.divergence` (or
   `WorkflowRuntimeDeps.divergence`) picks the reaction: `"warn"` (default) reports once per run
   through `onWarn` and proceeds; `"fail"` raises `FlowDivergenceError` (a
   `FlowReplayDivergenceError` naming the skipped steps) **before** the step's effect, and
   **parks the execution on the reserved gate `__loom_diverged__`** (no `EXECUTION_FAILED`; recovery
   and timers leave it alone; `onWarn` is called, `recoverAbandoned` reports it as `failed` through
   `onError`). After you fix the code, pin the original, list the fingerprint in `compatibleWith`,
   or migrate with `resumeAs`, call `runtime.retryDiverged(id)` (a `resume` at that gate: same
   authorization; the answer is status-only). **Upgrade note:** do not call it, or answer that gate,
   until every node runs R7: an older node folds the null resume into `_resumePayloads`. `"off"` is
   silent. `security.strict` defaults it to `"fail"`. The check is **membership only**: a pure
   reorder is fine; a step whose frame the log already holds (an untyped failure re-run live) is
   judged only against the frames recorded before it; a step that starts inside an open
   `ctx.parallel` scope is judged against the recorded frames outside the scope that precede it (the
   scope's own frames compare as a set at close; with `kernel.features.scopes` on the kernel records
   each step's scope path, otherwise a lower-rank floor applies); a decision served from the log
   exempts exactly the steps its decider ran (recorded as `innerSteps`, always written; only a
   record WITHOUT the field, a pre-R7 log, falls back to the `<decisionId>:` / `<decisionId>#`
   naming convention). A decider must await the steps it runs: one it detaches is not recorded and
   will be reported as skipped on resume. Known limits: scope paths are positional, so a
   function-branch `parallel` inserted before a recorded one can run a new step before the refusal;
   an execution with any frame lacking a scope path (scopes turned on mid-life) uses the weaker
   floor; past 4096 inner steps or 64 KiB of their ids a served decision also exempts the frames
   first started during it. frames before an `EXECUTION_MIGRATED` are exempt. After a migration, a
   snapshot hides *when* it happened, so the detector then checks only the frames completed since
   that snapshot (fail-open). The cost is O(1) amortised per append.

`resumeAs(…, { strategy: "replay-check" })` also understands **step families**: a recorded id
`base#suffix` (every ADR 0061 `id#n` mint, `agentLoop$`'s `<loop>#turn:<n>:tool:<j>`) passes when
`base` is a declared step, and `flow$({ stepFamilies: ["x", /^tool\./] })` covers ids that do not
follow the `#` convention. A vanished family still fails, reported once per family with a frame
count rather than one name per dynamic frame.

## Durable timers (T1)

`ctx.sleep(ms)` / `ctx.sleepUntil(ts)` are **durable** suspensions: the absolute wake time is
recorded once in the log (the only place wall clock enters the fold, P9), survives restarts
and store failover, and wakes exactly once as a governed `TIMER_FIRED` fact — replay is
bit-identical whenever it happens.

```ts
// Flow code — new kernel syscalls (ABI 1.1.0):
await ctx.sleep(48 * 60 * 60 * 1000);          // wake in 48h, even across process kills
await ctx.sleepUntil(Date.parse("2026-08-01")); // or at an absolute time

// Wiring — one config key (timer rows live beside your event store, so one
// backup captures the full kernel state):
const app = defineConfig({
  storage: sqliteStorage({ dir: ".data" }),
  timers: { store: new SqliteTimerStore(".data/events.db") }, // or InMemoryTimerStore
});
// suspend({ on, timeout }) is unified too: with timers wired, the timeout becomes
// a durable wake (fired as TIMER_FIRED); unwired it stays no-fire metadata (G2).
```

Firing mirrors K9's delivery contract: at-least-once delivery, idempotent wakes (a timer only
fires while its execution is still suspended on exactly that `wakeAt` — a manual resume just
retires it), so the effective wake is exactly-once.

**Cron schedules (T1.2).** `schedule$` statically binds a cron expression (5-field, UTC unless `timeZone` is set) to a
flow; each due occurrence starts with the deterministic executionId
`{scheduleId}@{occurrenceMs}` — every node computes the same id, so starts are idempotent
without coordination (durable-state check + the store's uniqueness backstop settles races):

```ts
const nightlyAudit = schedule$({
  id: "nightly-audit",
  cron: "30 3 * * *",          // 03:30 UTC daily (*, */n, lists, ranges supported)
  flowId: "audit-flow",
  input: { scope: "all" },
});
const app = defineConfig({
  storage: postgresStorage({ url }),
  timers: {
    store: new PostgresTimerStore(url), // same DB as the log — one backup, full kernel state
    schedules: [nightlyAudit],
    fenced: true,                       // multi-node: K9.4 token per fire (starts are never fenced, ADR 0103 L12)
  },
});
```

**Time zones (R19).** Add `timeZone: "Europe/Berlin"` (any IANA name; default UTC) and the five
fields are read on that zone's wall clock, computed with `Intl.DateTimeFormat` (no dependency). An
unknown zone throws when `schedule$` is called (and `parseCron`/`TimerService` re-check it). The zone
is data on the schedule, not the node's, so every node still computes the same occurrences, and the
occurrence id stays the UTC epoch ms. A fixed wall time runs once per day it matches, through DST:

- **spring forward** (a matched time inside the skipped hour does not exist): it runs once, shifted
  forward by the gap. `30 2 * * *` in `America/New_York` on 2026-03-08 runs at 03:30 EDT.
- **fall back** (a matched time in the repeated hour): it runs once, at its FIRST occurrence.
  `30 1 * * *` on 2026-11-01 runs at 01:30 EDT and not again at 01:30 EST.

So an hourly or sub-hourly expression (`0 * * * *`) skips the repeated hour's second pass; keep
fixed-interval schedules in UTC. `sentinelPreset({ timeZone })` passes it through.

Occurrences that passed while no service was running are skipped (no catch-up — a durable
catch-up policy can layer on later). Cross-node duplicate fires settle at the shared store:
the idempotent-wake guard, the `UNIQUE(execution_id, sequence)` backstop, and fencing (when
`fenced`) guarantee exactly one durable history.

## Recovering executions whose supervisor died (ADR 0004)

A dead or wedged **worker** is already handled: the dispatcher's `executeTimeoutMs` turns a
hung attempt into a failed one and redispatches it, and the worker resumes idempotently from
durable state — completed steps are served from the log, only the interrupted tail re-runs.
You get that for free.

The case it cannot cover is the **supervisor** itself dying. Detection lives in the
dispatcher's process memory, so if that process is killed nothing survives that knows an
execution was in flight: it sits `running` in the log with no owner.

Loom cannot resolve this from the log alone, and does not pretend to. A `running` execution
owned by a healthy node elsewhere is byte-identical to an orphaned one — the difference is a
fact about your cluster, not about the execution. So the pass takes the decision from you:

```ts
import { recoverAbandoned } from "@loom/workflow-runtime";

// Run this from a cron, a Kubernetes Job, or a leader-elected ticker — it is a
// maintenance pass you schedule, not a service that runs itself.
const STALE_MS = 15 * 60_000;
const app = defineConfig({ /* … */ });
const summary = await recoverAbandoned(app.runtime, {
  source: app.stores.eventStore,
  isAbandoned: (c) => Date.now() - c.updatedAt > STALE_MS, // YOUR policy
  fenced: true,        // K9.4 — a predecessor that isn't really dead loses at the store
  limit: 50,
});
// → { scanned, candidates, recovered, failed }
```

`isAbandoned` is **required and has no default**. Defaulting it either way would be wrong:
`true` preempts live work on other nodes, and `false` would be a pass that silently recovers
nothing while looking like it works.

> **Be generous with the threshold.** A predicate that wrongly claims a *live* execution
> cannot corrupt the log (fencing), but the preempted worker's in-flight effect may still
> land — so the step runs twice. That is the same at-least-once a genuine crash already
> incurs; you just don't want to pay it for a step that was never interrupted. Prefer a real
> liveness signal from your orchestrator over a timeout where you have one.

**A lease is that liveness signal, and loom ships one.** Configure `timers.leases` and each
node claims an execution before waking it, renewing while the wake is in flight; `expired()`
then answers "who stopped saying they were alive" as a *fact*, not a guess about a clock:

```ts
import { SqliteLeaseStore } from "@loom/plugin-sqlite"; // PostgresLeaseStore for multi-node

const app = defineConfig({
  storage: { /* … */ },
  timers: {
    store: timerStore,
    // This node's identity — a pod name, a process uuid, whatever already means "this process".
    leases: { store: leaseStore, owner: process.env.HOSTNAME ?? "node-1", ttlMs: 60_000 },
  },
});

// With leases wired, `isAbandoned` becomes optional: the candidates are the EXPIRED leases.
const summary = await recoverAbandoned(app.runtime, {
  source: app.stores.eventStore,
  leases: { store: app.stores.leaseStore!, owner: "recovery-pass", ttlMs: 60_000 },
  fenced: true,
  limit: 50,
});
```

The ttl is your tolerance for a node that **died**, not a bound on how long a run may take —
the claim is held and renewed across the whole resumed execution, which for a branch
simulation may be minutes.

> **A lease narrows the question; it does not close it.** An execution that never had a lease
> is invisible to `expired()` — it is not orphaned, it is unwatched, and the two are different
> answers. `loom census` reports that population separately (`no lease at all`) precisely so a
> gap in coverage cannot read as a clean bill of health.

---

Back to [User Guide section 17](../user-guide.md#17-kernel-grants-quotas--supervision).
