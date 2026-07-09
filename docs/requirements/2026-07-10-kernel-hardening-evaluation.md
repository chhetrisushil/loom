# Kernel-Hardening K7–K12 / T1–T2 — Critical Evaluation & Amendments

> **Status:** Adopted — this evaluation amends the [recorded requirements](2026-07-10-kernel-hardening-k7-k12-t1-t2.md) and ADRs [0019](../adr/0019-k7-data-plane-isolation-and-egress-control.md)–[0026](../adr/0026-t2-wire-level-kernel-abi.md)
> **Date:** 2026-07-10
> **Method:** every factual premise in the requirements was verified against the actual source
> (effect path, durable core, stores, DX surface, benchmarks), then each item was evaluated —
> and adversarially re-reviewed — against the four non-negotiables below. The original
> requirements doc stays verbatim (it is the historical record); the **normative deltas live
> here** and in each ADR's Amendments section.

## The four non-negotiables

Every requirement was tested against these; a requirement that could not be amended to pass
all four would have been rejected. None had to be.

1. **Kernel genericity** — Loom remains a generic execution kernel for *any* intelligent
   system. The kernel carries mechanisms; policy content (which egress hosts, which tenants,
   which schedules) always lives above it (P10).
2. **Developer experience is THE priority** — every new capability surfaces through an
   existing idiom: one optional `defineConfig` key, one `tool$`/`flow$` option, one `ctx.*`
   method. The bar is loom-starter's ~10-line wiring. No new ceremony, no cascading setup.
3. **Performance** — Loom's own hot path is not compromised unless ROI > trade-off.
   Zero-overhead-when-unwired (G2) stays *benchmark-provable* (`pnpm bench`, committed
   baselines in [benchmarks.md](../benchmarks.md)); every landed item ships an
   unwired-vs-wired bench.
4. **Safety & security for apps on Loom** — enforcement sits where it cannot be bypassed.
   Anything that *looks* like a guarantee but is forgeable or evadable from userland is
   security theater and was amended out.

## Verdict summary

| Item | Verdict | Priority | The one-line amendment that mattered most |
|---|---|---|---|
| K7 isolation & egress | **Accept with amendments** | P1 | Boundary is *innermost* (meter/validate kernel-side); egress enforced kernel-side with resolve-and-pin |
| K8 cancellation & deadlines | **Accept with amendments** | P0 | Premise corrected (local cancel exists); metering-on-abort closes a budget-evasion loophole |
| K9 idempotency & fencing | **Accept with amendments** | P0 | Key = `executionId:stepId` (attempt-based key breaks in exactly the crash case it exists for); undeclared tools keep today's behavior (G2) |
| K10 log lifecycle | **Accept with amendments** | P2 | Shredding must cover **snapshots** (folded plaintext) or erasure is theater; decoupled from K7 via `SecretResolver` |
| K11 flow versioning | **Accept with amendments** | P1 | Hash check must guard the **recovery** path too (silent old-log/new-code folding happens today without any operator action) |
| K12 identity & tenancy | **Accept with amendments** | P2 | Kernel carries the principal chain *opaquely*; delegation must be verifiable at the callee or K12.4 is forgeable |
| T1 durable timers | **Accept with amendments** | P1 | `wakeAt` enters the log exactly once; cron dedupe = deterministic executionId, not "K9 keys" |
| T2 wire ABI | **Accept as staged (P3), with amendments** | P3 | Wire protocol is a *projection* of the K1 ABI, normative for wire clients only — the shipped TS surface stays authoritative |

Priority ordering (K9/K8 → K7/K11/T1 → K10/K12 → T2) is **endorsed unchanged**, with the
sequencing annotations in [§ Sequencing](#sequencing-annotations).

## Factual corrections (requirements vs. actual code)

The requirements were written against an assumed codebase; these premises are corrected
before any implementation planning:

| Requirements claim | Reality | Consequence |
|---|---|---|
| K11.1: "`RUN_STARTED` MUST record…" | The event is **`EXECUTION_STARTED`** and its payload is `{ input }` only (`WorkflowRuntime.ts:152`) — no `RUN_STARTED` exists | K11.1 re-targets `EXECUTION_STARTED`; hash is a **payload extension** to a pinned type (see K5 rule below) |
| K11.1: "the `@loom/compiler` manifest hash already exists" | The manifest has `version` + per-step chunk hashes only — **no flow content hash exists** | The hash must be *built* — over compiler-normalized manifest content, not bundler output (see K11 amendments) |
| K8 gap: "Nothing can terminate an in-flight effect or execution" | `ExecutionHandle.cancel(reason)` **exists** and emits `EXECUTION_CANCELLED` (`WorkflowRuntime.ts:464-472`); `STEP_CANCELLED` is emitted on an aborted signal; `EffectContext` already carries `signal?: AbortSignal` | K8 *completes* an existing seam. Real gaps: provider signal forwarding, cancel-by-`executionId` cross-process, enforced deadlines, mid-flight budget, cross-dispatch propagation |
| K8.4: abort "a streaming LLM effect" mid-stream | **No streaming effects exist** — no provider streams; `ctx.stream` is a side-channel emit; middleware sees only final results | K8.4 becomes conditional: it binds when streaming effects land, and cannot be middleware (see K8 amendments) |
| K9.2: key "`executionId:stepId:attempt`-derived, stable across recovery replays of the same attempt" | `attempts` increments on **every** `STEP_STARTED` fold (`eventHandlers.ts:38`); crash-recovery re-execution appends a new `STEP_STARTED` | An attempt-suffixed key **changes in exactly the crash case idempotency exists for** — unimplementable as written; corrected in K9 amendments |
| K9.4: "extends D3 single-writer" | `WorkerLease` exists but is a **correlation token only**; no fencing anywhere; Postgres `UNIQUE(execution_id, sequence)` is a partial same-sequence backstop | Fencing is genuinely new; enforcement point is the **store append** (see K9 amendments) |
| K11.2: "a registry MAY hold multiple versions" | The registry is `Map<flowId, RegisteredFlow>` — same-id registration **silently overwrites** | K11.2 requires a registry change; overwrite semantics amended (dev watch-mode carve-out) |
| T1 gap: "`ctx.suspend` supports a timeout" | `SuspendConfig.timeout` is recorded metadata that **never fires** across a restart | T1 also fixes this latent gap — `suspend({timeout})` unifies with the durable timer service (gated on wiring, G2) |
| K12.2 / DoD fact list | `approvedBy` is indeed an unverified string in a *custom* resume event `"ApprovalGranted"` — but a kernel `APPROVAL_GRANTED` fact **does not exist** and is **missing from the requirements' own new-facts list**, while `EXECUTION_CANCELLED` is listed as new but is **already pinned** in schema 1.2.0 | Corrected fact list below |

Premises verified **true**: recovery re-executes the in-flight tail (at-least-once is real —
`recovery.test.ts:128-129`); `flow$` already requires `version`; `fold(snapshot, suffix)` is
already how resume works; `EventStore` has the optional-method precedent (`readRange?`,
`copyPrefix?`) for additive SPI growth; deploy-sim is a pure fold gate reusable as K11.3's
replay-check engine; `@loom/testing` has no crash injection (K9.5 is genuinely new); the A2A
server is ~112 LOC of HTTP and a plausible T2 carrier.

---

## Per-item evaluation & normative amendments

### K7 — Data-plane isolation & egress control — Accept with amendments

*Genericity ✅ (SPI + reference impl; egress policy is app content). DX ⚠️ amended. Perf ⚠️
amended. Security ⚠️ amended — two theater risks removed.*

- **K7-A1 (corrects K7.5 — ring order).** The requirement's chain "authorize → schedule →
  isolate → meter → validate" is wrong for the real middleware topology and would put
  metering *inside* the sandbox, where the isolate can forge it. The isolation boundary is
  **innermost**: authorize → schedule → meter → validate(input) → **[boundary]** → tool →
  validate(output). K2/K3/K6 MUST execute on the kernel side of the boundary.
- **K7-A2 (egress enforcement point).** Egress MUST be enforced kernel-side — a broker/proxy
  the isolate's sockets are forced through, or WASM host functions — never by in-process
  patching of `fetch`/`net` inside the tool's own domain (bypassable = theater). Hostname
  allowlists MUST use resolve-and-pin semantics (DNS rebinding, IP-literal bypass).
- **K7-A3 (the `ctx` shim).** `EffectContext` closures do not cross a process boundary. The
  SPI MUST define a marshaled host-function subset (`emit`, `signal`, the K9 idempotency
  key) with emit-forwarding semantics specified (synchronous-ack or
  at-least-once-with-journal-dedupe), so `tool$` authoring is genuinely preserved and a
  child dying mid-flush cannot silently drop durable facts.
- **K7-A4 (reference implementation & perf).** Reference impl is a **child process** with
  dropped privileges (WASM cannot run arbitrary npm tool deps — promising it first would be
  DX vaporware; it remains a second implementation for pure-compute tools). Executors MUST
  be poolable/warm; the landed item ships a latency benchmark including cold-start-per-tool,
  plus the standard unwired bench (G2).
- **K7-A5 (cross-reference).** K7 provides K8's only *non-cooperative* kill path (kill the
  child); in-process `AbortSignal` is cooperative and ignorable. Recorded in both ADRs.

### K8 — Cancellation, deadlines & bounded effects — Accept with amendments

*Genericity ✅. DX ✅ (`cancel(id)`; `step$` already has a `timeoutMs` field — K8.3 largely
enforces an existing declared surface). Perf ✅ (signal threading negligible). Security ⚠️
one budget-evasion loophole closed.*

- **K8-A1 (corrected scope).** Local-handle cancel exists. K8's scope is: forward
  `ctx.signal` into provider interfaces (additive optional `{ signal }` argument);
  `cancel(executionId, reason)` addressable cross-process; kernel-enforced deadlines;
  mid-flight budget (conditional, below); cross-dispatch propagation.
- **K8-A2 (metering on abort — closes a K3 loophole).** Today metering emits after
  `next()`; an aborted effect throws through unmetered, so start-expensive-call → cancel →
  repeat evades budgets forever. On abort/deadline the kernel MUST meter partial or
  estimated cost (at minimum wall-time) before rethrowing.
- **K8-A3 (retry × abort).** The retry middleware MUST treat abort as terminally
  non-retryable and MUST check `signal.aborted` before re-attempt and during backoff sleep —
  otherwise an app-configured `isRetryable` makes cancel a no-op.
- **K8-A4 (deadline base time).** Remaining time after recovery MUST be computed from the
  *logged* `STEP_STARTED` timestamp, never wall clock at re-run — else every crash silently
  resets the deadline.
- **K8-A5 (K8.4 conditional).** Mid-stream budget enforcement binds when streaming effects
  exist (none do today) and CANNOT be middleware (middleware cannot observe stream
  progress); it requires a usage-reporter hook on `EffectContext` or the provider stream
  adapter.
- **K8-A6 (ordering).** K8.5 (cross-seam cancel) sequences **after K9.4**: fence the lease
  first, then append `EXECUTION_CANCELLED` — otherwise a zombie's late `STEP_COMPLETED`
  races the cancel fact.
- **K8-A7 (settlement truth).** Provider forwarding is best-effort; the kernel guarantee is
  durable-fact settlement, not physical termination of arbitrary third-party I/O. The
  acceptance criterion's "<1 s" binds for built-in effects and the test suite, not for
  providers that ignore the signal.

### K9 — Effect delivery contract: idempotency & fencing — Accept with amendments

*Genericity ✅. DX ✅ (`tool$({ idempotent })`; crash harness fits `@loom/testing`). Perf ✅
(key = string concat; fencing = one predicate on append; SQLite exempt). Security ✅ —
highest-ROI item; P0 endorsed.*

- **K9-A1 (corrects K9.2 — the key).** The idempotency key is **`executionId:stepId`** — no
  attempt component. Rationale: the folded `attempts` counter increments on every
  `STEP_STARTED`, including crash-recovery re-execution, so an attempt-suffixed key changes
  in precisely the case idempotency exists for. In-memory middleware retries naturally share
  the key (`ctx.attempt` is fixed for one `EffectRuntime.execute` call) — that is the
  desired provider-dedup behavior. A **new** key is minted only by an explicit durable
  new-logical-attempt fact (a produced `STEP_RETRYING`, or an in-doubt resolution verdict of
  "retry-fresh").
- **K9-A2 (corrects K9.3 — the G2 default).** Tools with **no** `idempotent` declaration
  keep today's recovery behavior (automatic re-run). `EFFECT_INDOUBT` parking applies only
  to tools explicitly declared `idempotent: false`. The requirement's undifferentiated
  "safe-by-default" would park every existing app's crash recovery — a G2 violation.
  Mitigation for the forgotten-flag risk: `loom deploy check` emits an advisory listing
  tool-kind effects with no declaration (one warning, zero API surface).
- **K9-A3 (un-parking).** Parking reuses the suspend machinery: `EFFECT_INDOUBT` +
  `EXECUTION_SUSPENDED { reason: "effect-indoubt" }`; resolution is a standard `resume()`
  with a verdict payload (`completed-with-result` / `retry-fresh` / `fail`). No new resume
  machinery. Note: parking triggers on any `STEP_STARTED`-without-completion, which includes
  crash-*before*-the-effect-ran — conservative and correct; documented false-positive rate;
  no pre-effect durable marker (an extra append per effect is a hot-path cost with negative
  ROI).
- **K9-A4 (fencing enforcement point).** The fence is checked where writes converge: the
  **store append** (`append(envelope, { fence })` rejects stale tokens), following the
  optional-SPI-method precedent. Postgres `UNIQUE(execution_id, sequence)` remains the
  same-sequence backstop. Single-node SQLite is exempt (zero overhead, G2).
- **K9-A5 (contract completeness).** K9.1's documented contract MUST also state: *metered
  facts are at-least-once under recovery* (a re-run step re-meters; budgets may over-count
  after crashes — conservative direction, never under-counts).

### K10 — Log lifecycle: retention, redaction & encryption — Accept with amendments

*Genericity ✅ (mechanism in kernel, erasure policy above). DX ✅ (`defineConfig({retention})`,
schema markers). Perf ⚠️ amended. Security ⚠️ two erasure-theater holes closed.*

- **K10-A1 (shred × snapshots — closes the acceptance-criterion hole).** Snapshots store
  *folded plaintext*. Shredding event payloads while snapshots survive is erasure theater —
  and compaction (K10.4) would institutionalize it: replay-from-snapshot would *succeed
  silently with the erased data*, the exact "third behavior" the requirement forbids.
  Shredding MUST cover snapshots (delete or re-encrypt affected executions' snapshots), and
  the conformance suite MUST test shred × snapshot × compaction jointly.
- **K10-A2 (fork lineage).** `fork()`/`copyPrefix` copies a parent prefix into a child
  execution. Key management MUST define lineage: either keys are per-subject (shared
  ciphertext stays jointly shredded *by design*) or fork registers key lineage so shredding
  a parent is a declared, visible effect on children — never an undocumented one.
- **K10-A3 (when the tombstone is written).** `PAYLOAD_SHREDDED` is appended **at shred
  time** by the lifecycle service (a tombstone into the affected execution's log) — never at
  replay time. Replay stays pure/read-only (P2) and deterministically *encounters* the
  tombstone.
- **K10-A4 (perf guardrails).** Encryption is field-level and opt-in per marked field only;
  envelope encryption with cached data keys; the landed item ships an append-path benchmark
  (marked vs unmarked fields) plus the unwired bench (G2: no markers ⇒ byte-identical
  append).
- **K10-A5 (decouple from K7).** K10.3's deterministic secret references resolve through a
  `SecretResolver` seam at effect execution — inside the K7 boundary when isolation is
  wired, in-process otherwise. The MUST is "secrets never enter the log", not "K7 is a
  prerequisite". (This decoupling is what makes K10's P2 slot safely parallelizable.)
- **K10-A6 (retention posture).** Archive-before-delete is the documented default: naive
  deletion starves the advisory/learning plane (`OUTCOME_RECORDED` mining, ADR 0018) and the
  deploy-sim historical corpus.

### K11 — Flow-code versioning for in-flight executions — Accept with amendments

*Genericity ✅. DX ⚠️ two flap risks amended. Perf ✅ (one hash compare on resume). Safety ✅ —
and the risk is worse than the requirement states.*

- **K11-A1 (corrects K11.1 — event + hash).** Target event is `EXECUTION_STARTED` (payload
  extension per the K5 rule below). The flow content hash does not exist and MUST be built —
  computed over **compiler-normalized manifest content** (step graph + step chunk hashes),
  never raw bundler output: non-reproducible builds would flap the hash on every rebuild,
  refuse every resume, teach operators to override, and reduce the check to theater. The
  mismatch error MUST present the three exits (pin / `resumeAs` / drain) in its message.
- **K11-A2 (recovery path — scope extension, pulled forward).** The hash check MUST also
  guard the **crash-recovery/rehydration** path, not just operator `resume()`: today a
  restart-after-deploy folds an old log with new code *silently, with no operator action*.
  This slice (record hash at start, compare on recovery+resume) is the first K11 work and is
  P0-adjacent in risk.
- **K11-A3 (registry semantics).** The registry becomes version-aware
  (`flowId → version → flow`). Re-registering the *same* id+version+hash stays silent
  (idempotent — dev watch-mode would otherwise spam warnings); same id+version with a
  *different* hash is an error. Legacy logs that recorded no hash resume exactly as today
  (G2).

### K12 — Identity, tenancy & delegated authority — Accept with amendments

*Genericity ⚠️ amended (opaque chain). DX ✅ (optional field + pluggable authenticator). Perf
⚠️ amended (RLS optional). Security ⚠️ one forgeability hole closed, one purity boundary
named.*

- **K12-A1 (opaque principal chain).** `CapabilityRequest` gains an optional
  `principal?: PrincipalChain` field that the kernel **carries opaquely and never
  interprets** — authorizers, budget scopes, and stores interpret it. The kernel gets no
  tenant model of its own; that is what keeps Loom generic (P10).
- **K12-A2 (corrects K12.4 — verifiable delegation).** An attenuated grant set carried as a
  plain request field is forgeable by any caller or middlebox — theater. Delegation MUST be
  verifiable at the callee's trust boundary (signed grant sets / macaroon-style attenuation
  caveats), verified *before* intersection is computed.
- **K12-A3 (identity × K10).** Principal chains land in durable payloads and are PII.
  Resolution: tenant/actor identifiers in events are **opaque pseudonymous IDs** (needed
  forever for K12.5 scoping — never shredded); human-readable identity lives in payload
  fields eligible for K10.2/K10.3 erasure.
- **K12-A4 (tenancy × fork).** `fork()`/`copyPrefix` across tenants MUST be denied or
  explicitly re-scoped — conformance-tested with the cross-tenant leakage suite.
- **K12-A5 (nested budgets are projections).** A tenant-level budget aggregates across many
  executions' logs — it is admission control over a *projection* (eventually consistent),
  not a replay-pure per-execution fold like K3 today. This category change is stated
  explicitly; the verdict remains durable and logged (P9-admissible), but implementers MUST
  NOT contort it into a pure fold (impossible) or skip logging it (unauditable).
- **K12-A6 (facts).** `APPROVAL_GRANTED { actor, verifiedBy }` is a **new durable fact**
  (today approval is a custom `"ApprovalGranted"` resume event with an unverified string) —
  added to the corrected fact list below. Unwired remains today's spoofable behavior,
  documented as such.
- **K12-A7 (store scoping perf).** Tenant-column + index (or key-prefixing) is the default
  scoping mechanism; Postgres row-level security is an optional hardening layer —
  benchmarked before it is recommended, since RLS predicates tax every query.

### T1 — Durable timers & scheduled executions — Accept with amendments

*Genericity ✅. DX ✅ (`ctx.sleep` is the ideal shape; `schedule$` fits the builder idiom).
Perf ✅ (poller only when wired; zero timers ⇒ zero overhead). Safety ✅.*

- **T1-A1 (determinism of `wakeAt`).** The absolute `wakeAt` is computed **once** and
  recorded in the `EXECUTION_SUSPENDED` payload — wall clock enters the log exactly once
  (P9). Resume replay serves it via the existing suspend-passthrough; it is never recomputed
  on re-fold (recomputation = replay divergence).
- **T1-A2 (corrects T1.2 — cron dedupe mechanism).** "Reuses K9 keys" is the concept, not
  the machinery: a cron occurrence has no `executionId` yet. The mechanism is a
  **deterministic executionId derived from `scheduleId + occurrenceTime`**, with the store's
  uniqueness backstop preventing double-start.
- **T1-A3 (suspend-timeout unification).** T1 also makes the existing `suspend({ timeout })`
  fire durably — fixing the latent gap where a declared timeout is dead metadata. Firing is
  **gated on the timer service being wired**: unwired = today's no-fire behavior
  (byte-identical, G2).
- **T1-A4 (ABI).** `ctx.sleep`/`ctx.sleepUntil` are new K1 syscalls — MINOR ABI bump,
  conformance test extended. Sequenced after K9 (leases/fencing for multi-node firing).

### T2 — Wire-level kernel ABI — Accept as staged (P3), with amendments

*Genericity ✅✅ (this is THE genericity item). DX ⚠️ authority inversion removed. Perf ✅
(amended to guarantee it). Security ✅ (rings kernel-side of the wire).*

- **T2-A1 (corrects T2.1 — authority).** The wire protocol is a versioned **projection** of
  the K1 ABI, normative **for wire clients only**. The shipped TypeScript `ctx` surface
  (ABI 1.0.0, pinned) remains authoritative for in-process userland — re-deriving it from a
  wire spec would churn a stable surface and degrade the hand-written DX for zero user
  benefit. In-process callers keep the serialization-free fast path (no wire tax when
  unwired — G2 stated explicitly).
- **T2-A2 (syscall semantics partition).** Before choosing JSON-RPC vs gRPC, the spec MUST
  partition the eight syscalls into unary (`execute/run/decide/parallel/suspend/emit`) vs
  channel (`stream`, `ui`) semantics — the channel pair drives the transport decision.
- **T2-A3 (who re-drives).** The spec MUST answer resumption ownership for wire clients: the
  kernel folds and stays authoritative for state; the *client* re-drives flow logic after
  resume. Suspended wire executions therefore need a client-reconnect contract (and its
  failure mode: a resume with no connected driver parks, durably visible). This is the hard
  problem; the A2A staging (T2.4) is the right first carrier precisely because its
  task-shaped surface avoids it initially.

---

## Cross-cutting rulings (stated once; ADRs link here)

### Corrected new-facts list (replaces the requirements' DoD list)

New durable facts introduced by this series — each additive, each a MINOR
`EVENT_SCHEMA_VERSION` bump with a pinned fold handler and a
[fold-reference](../loom-2.0/10-event-schema-reference.md) entry:

`EGRESS_DENIED` (K7) · `EFFECT_INDOUBT` (K9) · `PAYLOAD_SHREDDED` (K10) ·
`EXECUTION_MIGRATED` (K11) · `APPROVAL_GRANTED` (K12) · `TIMER_FIRED` (T1)

Corrections vs the requirements doc: **`EXECUTION_CANCELLED` removed** (already pinned in
schema 1.2.0 with a fold handler — K8 adds producers, not the type);
**`APPROVAL_GRANTED` added** (named in K12.2 but omitted from the requirements' own list).

### K5 payload-extension rule (new governance rule)

Several items extend the payloads of *already-pinned* event types (K11: `flowHash` on
`EXECUTION_STARTED`; K12: principal chain on trust-boundary events; K9: logical-attempt
epoch). K5 gains an explicit rule: **an additive optional payload field on a pinned event
type is a MINOR bump; fold handlers MUST treat absence as legacy** (old logs fold
identically). Removing or re-typing a payload field remains MAJOR. The fold reference
documents fields per version.

### Schema-version choreography

One MINOR bump per landed item (the `SAFETY_BLOCKED` 1.1.0 / `OUTCOME_RECORDED` 1.2.0
precedent), never batched — so any stored log identifies exactly which facts it can contain.
Downstream conformance consumers (deploy-sim fixtures, T2.3 test vectors) re-pin per bump.

### Middleware ordering contract

One canonical statement, replacing per-item scatter:

1. **The K7 boundary is innermost** — authorize → schedule → meter → validate(input) →
   [isolation boundary] → tool → validate(output). Everything enforcing MUST be kernel-side.
2. **Metering wraps retry** (meter-per-attempt) unless the app deliberately inverts it
   (meter-once); the recommended default is metering outermost of the two, so budget sees
   every real attempt.
3. **Abort is terminally non-retryable** — retry middleware checks `signal.aborted` before
   any re-attempt and during backoff.
4. **Abort is metered** — on abort/deadline, partial or wall-time cost is emitted before the
   error propagates (K8-A2).

### Sequencing annotations

The P0/P1/P2/P3 table stands; within it:

- **P0 internals:** K9.1+K9.2 (contract + key) and K8.1+K8.3 (signal forwarding + deadline
  enforcement) proceed in parallel; **K8.5 lands after K9.4** (fence-then-cancel).
- **K11.1's recovery-path slice is pulled forward** (first K11 work; P0-adjacent risk —
  silent wrong-code folding requires no operator action to occur).
- **T1 lands after K9** (deterministic occurrence ids + fencing for multi-node firing).
- **K10 is parallelizable at P2** because K10-A5 removed its only K7 dependency.

## Conclusion

All eight items are adopted **as amended**. No item, once amended, compromises the four
non-negotiables: every ring/service is opt-in and byte-identical when unwired (with the
benchmark obligation to prove it), every new surface is one config key / one builder option /
one syscall, every enforcement point sits where userland cannot bypass it, and the kernel
carries mechanisms — never policy. The amendments exist precisely because five requirement
premises did not survive contact with the code and four mechanisms as-written would have been
theater; what remains is implementable against the codebase as it actually is.
